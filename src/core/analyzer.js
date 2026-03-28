function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toSingular(value) {
  if (value.endsWith('ies')) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith('ses')) {
    return value.slice(0, -2);
  }

  if (value.endsWith('s') && !value.endsWith('ss')) {
    return value.slice(0, -1);
  }

  return value;
}

function normalizeTableName(name) {
  const normalized = toSnakeCase(name || 'records');
  return normalized || 'records';
}

function normalizeColumnName(name) {
  const normalized = toSnakeCase(name);
  return normalized || 'value';
}

function getValueKind(value) {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (value instanceof Date) {
    return 'date';
  }

  if (typeof value === 'number') {
    return Number.isInteger(value) ? 'integer' : 'float';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  return typeof value;
}

function getEmptyTable(tableName, parentTableName) {
  return {
    tableName,
    parentTableName,
    columns: new Map(),
    relationships: [],
  };
}

function ensureTable(tables, tableName, parentTableName) {
  if (!tables.has(tableName)) {
    tables.set(tableName, getEmptyTable(tableName, parentTableName));
  }

  return tables.get(tableName);
}

function ensureColumn(table, columnName, metadata) {
  if (!table.columns.has(columnName)) {
    table.columns.set(columnName, {
      name: columnName,
      kinds: new Set(),
      nullable: false,
      sampleValues: [],
      ...metadata,
    });
  }

  return table.columns.get(columnName);
}

function addSampleValue(column, value) {
  if (value === null || value === undefined) {
    return;
  }

  if (column.sampleValues.length >= 3) {
    return;
  }

  const preview = typeof value === 'object' ? JSON.stringify(value) : String(value);

  if (!column.sampleValues.includes(preview)) {
    column.sampleValues.push(preview);
  }
}

function registerScalarField(table, fieldName, value, metadata = {}) {
  const columnName = normalizeColumnName(fieldName);
  const column = ensureColumn(table, columnName, metadata);
  const kind = getValueKind(value);

  if (kind === 'null') {
    column.nullable = true;
    return;
  }

  column.kinds.add(kind);
  addSampleValue(column, value);
}

function mergeScalarKinds(kinds) {
  const scalarKinds = Array.from(kinds).sort();

  if (scalarKinds.length === 0) {
    return 'TEXT';
  }

  if (scalarKinds.includes('string')) {
    return 'TEXT';
  }

  if (scalarKinds.includes('float')) {
    return 'FLOAT';
  }

  if (scalarKinds.includes('integer')) {
    return 'INTEGER';
  }

  if (scalarKinds.includes('boolean')) {
    return 'BOOLEAN';
  }

  if (scalarKinds.includes('date')) {
    return 'TIMESTAMP';
  }

  return 'TEXT';
}

function analyzeArrayField({
  tables,
  parentTable,
  parentTableName,
  fieldName,
  values,
}) {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);

  if (nonNullValues.length === 0) {
    return;
  }

  const childTableName = normalizeTableName(fieldName);
  const childTable = ensureTable(tables, childTableName, parentTableName);
  const parentKeyName = `${toSingular(parentTableName)}_id`;

  ensureColumn(childTable, 'id', {
    inferredSqlType: 'INTEGER',
    isPrimaryKey: true,
    sourcePath: `${childTableName}.id`,
  });
  ensureColumn(childTable, parentKeyName, {
    inferredSqlType: 'INTEGER',
    isForeignKey: true,
    references: `${parentTableName}(id)`,
    sourcePath: `${childTableName}.${parentKeyName}`,
  });

  const relationshipExists = childTable.relationships.some((relationship) => {
    return (
      relationship.fromTable === childTableName &&
      relationship.fromColumn === parentKeyName &&
      relationship.toTable === parentTableName &&
      relationship.toColumn === 'id'
    );
  });

  if (!relationshipExists) {
    childTable.relationships.push({
      fromTable: childTableName,
      fromColumn: parentKeyName,
      toTable: parentTableName,
      toColumn: 'id',
    });
  }

  nonNullValues.forEach((item) => {
    if (Array.isArray(item)) {
      return;
    }

    if (typeof item === 'object' && item !== null) {
      analyzeDocument({
        document: item,
        tableName: childTableName,
        tables,
      });
      return;
    }

    registerScalarField(childTable, 'value', item, {
      sourcePath: `${childTableName}.value`,
    });
  });
}

function analyzeNestedObject({
  document,
  table,
  prefix,
}) {
  Object.entries(document).forEach(([key, value]) => {
    analyzeField({
      table,
      fieldName: `${prefix}_${key}`,
      value,
    });
  });
}

function analyzeField({ table, fieldName, value, tables, tableName }) {
  const kind = getValueKind(value);

  if (kind === 'array') {
    analyzeArrayField({
      tables,
      parentTable: table,
      parentTableName: tableName,
      fieldName,
      values: value,
    });
    return;
  }

  if (kind === 'object') {
    analyzeNestedObject({
      document: value,
      table,
      prefix: fieldName,
      tables,
      tableName,
    });
    return;
  }

  registerScalarField(table, fieldName, value, {
    sourcePath: `${tableName}.${normalizeColumnName(fieldName)}`,
  });
}

function analyzeDocument({ document, tableName, tables }) {
  const table = ensureTable(tables, tableName);

  ensureColumn(table, 'id', {
    inferredSqlType: 'INTEGER',
    isPrimaryKey: true,
    sourcePath: `${tableName}.id`,
  });

  Object.entries(document).forEach(([fieldName, value]) => {
    if (fieldName === '_id') {
      return;
    }

    analyzeField({
      table,
      fieldName,
      value,
      tables,
      tableName,
    });
  });
}

function finalizeTable(table) {
  const columns = Array.from(table.columns.values()).map((column) => {
    const inferredSqlType = column.inferredSqlType || mergeScalarKinds(column.kinds);

    return {
      name: column.name,
      inferredSqlType,
      detectedKinds: Array.from(column.kinds).sort(),
      nullable: column.isPrimaryKey ? false : column.nullable,
      isPrimaryKey: Boolean(column.isPrimaryKey),
      isForeignKey: Boolean(column.isForeignKey),
      references: column.references || null,
      sourcePath: column.sourcePath || null,
      note: column.note || null,
      sampleValues: column.sampleValues,
    };
  });

  return {
    tableName: table.tableName,
    parentTableName: table.parentTableName || null,
    columns,
    relationships: table.relationships,
  };
}

function buildCreateTableStatement(table) {
  const columnDefinitions = table.columns.map((column) => {
    if (column.isPrimaryKey) {
      return `  ${column.name} ${column.inferredSqlType} PRIMARY KEY`;
    }

    const nullableClause = column.nullable ? '' : ' NOT NULL';
    return `  ${column.name} ${column.inferredSqlType}${nullableClause}`;
  });

  const foreignKeys = table.columns
    .filter((column) => column.isForeignKey && column.references)
    .map((column) => `  FOREIGN KEY (${column.name}) REFERENCES ${column.references}`);

  return `CREATE TABLE ${table.tableName} (\n${columnDefinitions
    .concat(foreignKeys)
    .join(',\n')}\n);`;
}

function analyzeDocuments(documents, collectionName) {
  const rootTableName = normalizeTableName(collectionName);
  const tables = new Map();

  documents.forEach((document) => {
    analyzeDocument({
      document,
      tableName: rootTableName,
      tables,
    });
  });

  const finalizedTables = Array.from(tables.values()).map(finalizeTable);
  const sqlStatements = finalizedTables.map(buildCreateTableStatement);

  return {
    rootTableName,
    tables: finalizedTables,
    sqlStatements,
  };
}

module.exports = {
  analyzeDocuments,
};
