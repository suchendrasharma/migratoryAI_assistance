const { analyzeDocuments } = require('./analyzer');

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_RETRIES = 3;
const RETRYABLE_ERROR_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
]);

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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isRetryableError(error) {
  return RETRYABLE_ERROR_CODES.has(error.code);
}

function chunkRows(rows, batchSize) {
  const chunks = [];

  for (let index = 0; index < rows.length; index += batchSize) {
    chunks.push(rows.slice(index, index + batchSize));
  }

  return chunks;
}

function buildColumnGroups(rows, table) {
  const groups = new Map();

  rows.forEach((row) => {
    const columns = table.columns
      .map((column) => column.name)
      .filter((columnName) => row[columnName] !== undefined);
    const key = columns.join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        columns,
        rows: [],
      });
    }

    groups.get(key).rows.push(row);
  });

  return Array.from(groups.values());
}

function buildBatchInsertStatement(tableName, columns, rows) {
  const values = [];
  const valueGroups = rows.map((row, rowIndex) => {
    const placeholders = columns.map((columnName, columnIndex) => {
      values.push(row[columnName]);
      return `$${rowIndex * columns.length + columnIndex + 1}`;
    });

    return `(${placeholders.join(', ')})`;
  });

  return {
    text: `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')}`,
    values,
  };
}

async function createSchema(client, analysis) {
  for (const statement of analysis.sqlStatements) {
    await client.query(withIfNotExists(statement));
  }

  for (const indexSuggestion of analysis.indexSuggestions) {
    await client.query(withIndexIfNotExists(indexSuggestion.sql));
  }
}

async function runBatchWithRetry({
  client,
  tableName,
  batchRows,
  columns,
  batchNumber,
  batchCount,
  maxRetries,
  onProgress,
}) {
  const statement = buildBatchInsertStatement(tableName, columns, batchRows);

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const savepointName = `sp_${tableName}_${batchNumber}_${attempt}`;

    await client.query(`SAVEPOINT ${savepointName}`);

    try {
      await client.query(statement.text, statement.values);
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);

      if (!isRetryableError(error) || attempt === maxRetries) {
        const enhancedError = new Error(
          `Batch insert failed for "${tableName}" on batch ${batchNumber}/${batchCount}: ${error.message}`
        );
        enhancedError.cause = error;
        throw enhancedError;
      }

      if (onProgress) {
        onProgress({
          phase: 'retry',
          tableName,
          batchNumber,
          batchCount,
          attempt,
          maxRetries,
          errorCode: error.code || 'UNKNOWN',
        });
      }

      await sleep(150 * attempt);
    }
  }
}

async function insertRows(client, analysis, rowBuckets, options = {}) {
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  const onProgress = options.onProgress;
  const totalRows = Array.from(rowBuckets.values()).reduce((sum, rows) => sum + rows.length, 0);
  let insertedRowCount = 0;

  for (const table of analysis.tables) {
    const rows = rowBuckets.get(table.tableName) || [];

    if (rows.length === 0) {
      continue;
    }

    const columnGroups = buildColumnGroups(rows, table);
    const totalBatches = columnGroups.reduce((sum, group) => {
      return sum + chunkRows(group.rows, batchSize).length;
    }, 0);
    let processedTableRows = 0;
    let batchNumber = 0;

    if (onProgress) {
      onProgress({
        phase: 'table-start',
        tableName: table.tableName,
        tableRowCount: rows.length,
        totalRows,
        insertedRows: insertedRowCount,
        batchCount: totalBatches,
      });
    }

    for (const group of columnGroups) {
      const batches = chunkRows(group.rows, batchSize);

      for (const batchRows of batches) {
        batchNumber += 1;

        await runBatchWithRetry({
          client,
          tableName: table.tableName,
          batchRows,
          columns: group.columns,
          batchNumber,
          batchCount: totalBatches,
          maxRetries,
          onProgress,
        });

        insertedRowCount += batchRows.length;
        processedTableRows += batchRows.length;

        if (onProgress) {
          onProgress({
            phase: 'batch-complete',
            tableName: table.tableName,
            batchNumber,
            batchCount: totalBatches,
            batchSize: batchRows.length,
            insertedRows: insertedRowCount,
            totalRows,
            processedTableRows,
            tableRowCount: rows.length,
          });
        }
      }
    }
  }

  return insertedRowCount;
}

async function migrateDocuments({
  documents,
  collectionName,
  queryExecutor,
  batchSize = DEFAULT_BATCH_SIZE,
  maxRetries = DEFAULT_MAX_RETRIES,
  onProgress,
}) {
  const analysis = analyzeDocuments(documents, collectionName);
  const rowBuckets = buildRowsFromDocuments(documents, collectionName);
  const totalRows = Array.from(rowBuckets.values()).reduce((sum, rows) => sum + rows.length, 0);

  if (onProgress) {
    onProgress({
      phase: 'planning-complete',
      totalRows,
      tableCount: analysis.tables.length,
      batchSize,
    });
  }

  const insertedRowCount = await queryExecutor(async (client) => {
    await createSchema(client, analysis);
    return insertRows(client, analysis, rowBuckets, {
      batchSize,
      maxRetries,
      onProgress,
    });
  });

  return {
    analysis,
    insertedRowCount,
    migratedTables: analysis.tables.length,
    totalRows,
    batchSize,
    maxRetries,
  };
}

module.exports = {
  buildRowsFromDocuments,
  migrateDocuments,
};
