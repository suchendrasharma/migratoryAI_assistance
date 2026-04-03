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

function buildChildTableName(parentTableName, fieldName, pathSegments) {
  if (pathSegments.length <= 1) {
    return normalizeTableName(fieldName);
  }

  return normalizeTableName(`${toSingular(parentTableName)}_${fieldName}`);
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
    documentCount: 0,
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
      explicitNullable: false,
      presentCount: 0,
      forceNotNull: false,
      sampleValues: [],
      ...metadata,
    });
  }

  return table.columns.get(columnName);
}

function markColumnSeen(column, seenColumns) {
  if (seenColumns.has(column.name)) {
    return;
  }

  column.presentCount += 1;
  seenColumns.add(column.name);
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

function registerScalarField(table, fieldName, value, metadata = {}, seenColumns = new Set()) {
  const columnName = normalizeColumnName(fieldName);
  const column = ensureColumn(table, columnName, metadata);
  const kind = getValueKind(value);

  markColumnSeen(column, seenColumns);

  if (kind === 'null') {
    column.explicitNullable = true;
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

  if (scalarKinds.includes('float') && scalarKinds.includes('integer')) {
    return 'DECIMAL(12,2)';
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

function ensureRelationship(childTable, childTableName, parentTableName, parentKeyName) {
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
}

function analyzeArrayField({
  tables,
  parentTableName,
  fieldName,
  values,
  pathSegments,
}) {
  const nonNullValues = values.filter((value) => value !== null && value !== undefined);

  if (nonNullValues.length === 0) {
    return;
  }

  const childTableName = buildChildTableName(parentTableName, fieldName, pathSegments);
  const childTable = ensureTable(tables, childTableName, parentTableName);
  const parentKeyName = `${toSingular(parentTableName)}_id`;

  ensureColumn(childTable, 'id', {
    inferredSqlType: 'INTEGER',
    isPrimaryKey: true,
    sourcePath: `${childTableName}.id`,
    forceNotNull: true,
  });
  ensureColumn(childTable, parentKeyName, {
    inferredSqlType: 'INTEGER',
    isForeignKey: true,
    references: `${parentTableName}(id)`,
    sourcePath: `${childTableName}.${parentKeyName}`,
    forceNotNull: true,
  });

  ensureRelationship(childTable, childTableName, parentTableName, parentKeyName);

  nonNullValues.forEach((item) => {
    if (Array.isArray(item)) {
      analyzeArrayField({
        tables,
        parentTableName: childTableName,
        fieldName: 'value',
        values: item,
        pathSegments: pathSegments.concat('value'),
      });
      return;
    }

    if (typeof item === 'object' && item !== null) {
      analyzeDocument({
        document: item,
        tableName: childTableName,
        tables,
        basePathSegments: pathSegments,
      });
      return;
    }

    const seenColumns = new Set();
    childTable.documentCount += 1;
    markColumnSeen(ensureColumn(childTable, 'id', {
      inferredSqlType: 'INTEGER',
      isPrimaryKey: true,
      sourcePath: `${childTableName}.id`,
      forceNotNull: true,
    }), seenColumns);
    markColumnSeen(ensureColumn(childTable, parentKeyName, {
      inferredSqlType: 'INTEGER',
      isForeignKey: true,
      references: `${parentTableName}(id)`,
      sourcePath: `${childTableName}.${parentKeyName}`,
      forceNotNull: true,
    }), seenColumns);
    registerScalarField(childTable, 'value', item, {
      sourcePath: `${childTableName}.value`,
    }, seenColumns);
  });
}

function analyzeField({
  table,
  fieldName,
  value,
  tables,
  tableName,
  pathSegments,
  seenColumns,
}) {
  const kind = getValueKind(value);

  if (kind === 'array') {
    analyzeArrayField({
      tables,
      parentTableName: tableName,
      fieldName,
      values: value,
      pathSegments,
    });
    return;
  }

  if (kind === 'object') {
    Object.entries(value).forEach(([nestedKey, nestedValue]) => {
      analyzeField({
        table,
        fieldName: `${fieldName}_${nestedKey}`,
        value: nestedValue,
        tables,
        tableName,
        pathSegments: pathSegments.concat(nestedKey),
        seenColumns,
      });
    });
    return;
  }

  registerScalarField(table, fieldName, value, {
    sourcePath: `${tableName}.${normalizeColumnName(fieldName)}`,
  }, seenColumns);
}

function analyzeDocument({ document, tableName, tables, basePathSegments = [] }) {
  const table = ensureTable(tables, tableName);
  const seenColumns = new Set();

  table.documentCount += 1;

  markColumnSeen(ensureColumn(table, 'id', {
    inferredSqlType: 'INTEGER',
    isPrimaryKey: true,
    sourcePath: `${tableName}.id`,
    forceNotNull: true,
  }), seenColumns);

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
      pathSegments: basePathSegments.concat(fieldName),
      seenColumns,
    });
  });
}

function sortColumns(columns) {
  return columns.sort((left, right) => {
    if (left.isPrimaryKey !== right.isPrimaryKey) {
      return left.isPrimaryKey ? -1 : 1;
    }

    if (left.isForeignKey !== right.isForeignKey) {
      return left.isForeignKey ? -1 : 1;
    }

    return left.name.localeCompare(right.name);
  });
}

function finalizeTable(table) {
  const columns = Array.from(table.columns.values()).map((column) => {
    const inferredSqlType = column.inferredSqlType || mergeScalarKinds(column.kinds);
    const nullable = column.isPrimaryKey
      ? false
      : column.forceNotNull
        ? false
        : column.explicitNullable || column.presentCount < table.documentCount;

    return {
      name: column.name,
      inferredSqlType,
      detectedKinds: Array.from(column.kinds).sort(),
      nullable,
      isPrimaryKey: Boolean(column.isPrimaryKey),
      isForeignKey: Boolean(column.isForeignKey),
      references: column.references || null,
      sourcePath: column.sourcePath || null,
      note: column.note || null,
      sampleValues: column.sampleValues,
      presentCount: column.presentCount,
      documentCount: table.documentCount,
    };
  });

  return {
    tableName: table.tableName,
    parentTableName: table.parentTableName || null,
    columns: sortColumns(columns),
    relationships: table.relationships,
    documentCount: table.documentCount,
  };
}

function buildCreateTableStatement(table) {
  const columnDefinitions = table.columns.map((column) => {
    if (column.isPrimaryKey) {
      return `  ${column.name} ${column.inferredSqlType} PRIMARY KEY`;
    }

    const constraints = [];

    if (!column.nullable) {
      constraints.push('NOT NULL');
    }

    return `  ${column.name} ${column.inferredSqlType}${constraints.length > 0 ? ` ${constraints.join(' ')}` : ''}`;
  });

  const foreignKeys = table.columns
    .filter((column) => column.isForeignKey && column.references)
    .map((column) => `  FOREIGN KEY (${column.name}) REFERENCES ${column.references} ON DELETE CASCADE`);

  return `CREATE TABLE ${table.tableName} (\n${columnDefinitions
    .concat(foreignKeys)
    .join(',\n')}\n);`;
}

function buildIndexName(tableName, columnNames, unique = false) {
  const prefix = unique ? 'ux' : 'ix';
  return `${prefix}_${tableName}_${columnNames.join('_')}`;
}

function buildIndexSuggestions(tables) {
  const suggestions = [];
  const seenIndexes = new Set();

  tables.forEach((table) => {
    table.columns.forEach((column) => {
      if (column.isPrimaryKey) {
        return;
      }

      const columnNames = [column.name];
      const key = `${table.tableName}:${columnNames.join(',')}`;

      if (seenIndexes.has(key)) {
        return;
      }

      if (column.isForeignKey) {
        suggestions.push({
          tableName: table.tableName,
          columnNames,
          unique: false,
          reason: `Speeds up joins to ${column.references}`,
          sql: `CREATE INDEX ${buildIndexName(table.tableName, columnNames)} ON ${table.tableName} (${columnNames.join(', ')});`,
        });
        seenIndexes.add(key);
        return;
      }

      const isReferenceLike = column.name.endsWith('_id');
      const isFrequent = column.presentCount === table.documentCount && table.documentCount > 1;

      if (isReferenceLike || isFrequent) {
        suggestions.push({
          tableName: table.tableName,
          columnNames,
          unique: false,
          reason: isReferenceLike
            ? 'Looks like a reference field carried over from the Mongo documents'
            : 'Present on every sampled row and a likely filter/sort candidate',
          sql: `CREATE INDEX ${buildIndexName(table.tableName, columnNames)} ON ${table.tableName} (${columnNames.join(', ')});`,
        });
        seenIndexes.add(key);
      }
    });
  });

  return suggestions;
}

function sortTables(tables, rootTableName) {
  return tables.sort((left, right) => {
    if (left.tableName === rootTableName) {
      return -1;
    }

    if (right.tableName === rootTableName) {
      return 1;
    }

    if (left.parentTableName === right.tableName) {
      return 1;
    }

    if (right.parentTableName === left.tableName) {
      return -1;
    }

    return left.tableName.localeCompare(right.tableName);
  });
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

  const finalizedTables = sortTables(
    Array.from(tables.values()).map(finalizeTable),
    rootTableName
  );
  const sqlStatements = finalizedTables.map(buildCreateTableStatement);
  const indexSuggestions = buildIndexSuggestions(finalizedTables);

  return {
    rootTableName,
    tables: finalizedTables,
    sqlStatements,
    indexSuggestions,
  };
}

module.exports = {
  analyzeDocuments,
};
