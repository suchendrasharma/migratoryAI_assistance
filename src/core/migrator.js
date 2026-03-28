const { analyzeDocuments } = require('./analyzer');

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
  return toSnakeCase(name || 'records') || 'records';
}

function normalizeColumnName(name) {
  return toSnakeCase(name) || 'value';
}

function buildChildTableName(parentTableName, fieldName, pathSegments) {
  if (pathSegments.length <= 1) {
    return normalizeTableName(fieldName);
  }

  return normalizeTableName(`${toSingular(parentTableName)}_${fieldName}`);
}

function createIdGenerator() {
  const counters = new Map();

  return {
    next(tableName) {
      const nextValue = (counters.get(tableName) || 0) + 1;
      counters.set(tableName, nextValue);
      return nextValue;
    },
  };
}

function getScalarKind(value) {
  if (value === null || value === undefined) {
    return 'null';
  }

  if (Array.isArray(value)) {
    return 'array';
  }

  if (value instanceof Date) {
    return 'date';
  }

  if (typeof value === 'object') {
    return 'object';
  }

  return typeof value;
}

function convertScalarValue(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }

  return value;
}

function ensureRowBucket(rowBuckets, tableName) {
  if (!rowBuckets.has(tableName)) {
    rowBuckets.set(tableName, []);
  }

  return rowBuckets.get(tableName);
}

function buildRowsFromDocuments(documents, collectionName) {
  const rootTableName = normalizeTableName(collectionName);
  const rowBuckets = new Map();
  const ids = createIdGenerator();

  function processDocument({
    document,
    tableName,
    parentTableName,
    parentRowId,
    basePathSegments = [],
  }) {
    const row = {
      id: ids.next(tableName),
    };

    if (parentTableName && parentRowId !== undefined) {
      row[`${toSingular(parentTableName)}_id`] = parentRowId;
    }

    Object.entries(document).forEach(([fieldName, value]) => {
      if (fieldName === '_id') {
        return;
      }

      processField({
        fieldName,
        value,
        row,
        tableName,
        parentRowId: row.id,
        pathSegments: basePathSegments.concat(fieldName),
      });
    });

    ensureRowBucket(rowBuckets, tableName).push(row);
  }

  function processArray({ parentTableName, parentRowId, fieldName, values, pathSegments }) {
    const childTableName = buildChildTableName(parentTableName, fieldName, pathSegments);

    values
      .filter((value) => value !== null && value !== undefined)
      .forEach((item) => {
        if (Array.isArray(item)) {
          processArray({
            parentTableName: childTableName,
            parentRowId,
            fieldName: 'value',
            values: item,
            pathSegments: pathSegments.concat('value'),
          });
          return;
        }

        if (typeof item === 'object') {
          processDocument({
            document: item,
            tableName: childTableName,
            parentTableName,
            parentRowId,
            basePathSegments: pathSegments,
          });
          return;
        }

        const row = {
          id: ids.next(childTableName),
          [`${toSingular(parentTableName)}_id`]: parentRowId,
          value: convertScalarValue(item),
        };

        ensureRowBucket(rowBuckets, childTableName).push(row);
      });
  }

  function processNestedObject({ prefix, value, row, tableName, parentRowId, pathSegments }) {
    Object.entries(value).forEach(([nestedKey, nestedValue]) => {
      processField({
        fieldName: `${prefix}_${nestedKey}`,
        value: nestedValue,
        row,
        tableName,
        parentRowId,
        pathSegments: pathSegments.concat(nestedKey),
      });
    });
  }

  function processField({ fieldName, value, row, tableName, parentRowId, pathSegments }) {
    const kind = getScalarKind(value);

    if (kind === 'array') {
      processArray({
        parentTableName: tableName,
        parentRowId,
        fieldName,
        values: value,
        pathSegments,
      });
      return;
    }

    if (kind === 'object') {
      processNestedObject({
        prefix: fieldName,
        value,
        row,
        tableName,
        parentRowId,
        pathSegments,
      });
      return;
    }

    row[normalizeColumnName(fieldName)] = convertScalarValue(value);
  }

  documents.forEach((document) => {
    processDocument({
      document,
      tableName: rootTableName,
    });
  });

  return rowBuckets;
}

function withIfNotExists(statement) {
  return statement.replace(/^CREATE TABLE /, 'CREATE TABLE IF NOT EXISTS ');
}

function withIndexIfNotExists(statement) {
  return statement.replace(/^CREATE INDEX /, 'CREATE INDEX IF NOT EXISTS ');
}

async function createSchema(client, analysis) {
  for (const statement of analysis.sqlStatements) {
    await client.query(withIfNotExists(statement));
  }

  for (const indexSuggestion of analysis.indexSuggestions) {
    await client.query(withIndexIfNotExists(indexSuggestion.sql));
  }
}

async function insertRows(client, analysis, rowBuckets) {
  let insertedRowCount = 0;

  for (const table of analysis.tables) {
    const rows = rowBuckets.get(table.tableName) || [];

    for (const row of rows) {
      const columns = table.columns
        .map((column) => column.name)
        .filter((columnName) => row[columnName] !== undefined);

      const placeholders = columns.map((_, index) => `$${index + 1}`);
      const values = columns.map((columnName) => row[columnName]);

      await client.query(
        `INSERT INTO ${table.tableName} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
        values
      );
      insertedRowCount += 1;
    }
  }

  return insertedRowCount;
}

async function migrateDocuments({
  documents,
  collectionName,
  queryExecutor,
}) {
  const analysis = analyzeDocuments(documents, collectionName);
  const rowBuckets = buildRowsFromDocuments(documents, collectionName);
  const insertedRowCount = await queryExecutor(async (client) => {
    await createSchema(client, analysis);
    return insertRows(client, analysis, rowBuckets);
  });

  return {
    analysis,
    insertedRowCount,
    migratedTables: analysis.tables.length,
  };
}

module.exports = {
  buildRowsFromDocuments,
  migrateDocuments,
};
