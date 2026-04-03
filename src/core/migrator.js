const crypto = require('crypto');

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

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(',')}}`;
  }

  return JSON.stringify(value);
}

function hashValue(value) {
  return crypto.createHash('sha1').update(stableStringify(value)).digest('hex');
}

function stableIntegerId(value) {
  const numericValue = Number.parseInt(hashValue(value).slice(0, 8), 16) & 0x7fffffff;
  return numericValue === 0 ? 1 : numericValue;
}

function buildRowFingerprint(parts) {
  return parts.join('::');
}

function resolveObjectIdentity(item) {
  if (!item || typeof item !== 'object') {
    return hashValue(item);
  }

  if (item._id !== undefined) {
    return String(item._id);
  }

  if (item.id !== undefined) {
    return String(item.id);
  }

  if (item.orderId !== undefined) {
    return String(item.orderId);
  }

  if (item.externalId !== undefined) {
    return String(item.externalId);
  }

  return hashValue(item);
}

function buildRowsFromDocuments(documents, collectionName) {
  const rootTableName = normalizeTableName(collectionName);
  const rowBuckets = new Map();

  function processDocument({
    document,
    tableName,
    parentTableName,
    parentFingerprint,
    parentForeignKeyName,
    documentFingerprint,
    basePathSegments = [],
  }) {
    const row = {
      id: stableIntegerId(documentFingerprint),
      source_fingerprint: documentFingerprint,
    };

    if (parentTableName && parentFingerprint && parentForeignKeyName) {
      row.__parentFingerprint = parentFingerprint;
      row.__parentTableName = parentTableName;
      row[parentForeignKeyName] = null;
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
        parentFingerprint: documentFingerprint,
        pathSegments: basePathSegments.concat(fieldName),
      });
    });

    ensureRowBucket(rowBuckets, tableName).push(row);
  }

  function processArray({
    parentTableName,
    parentFingerprint,
    fieldName,
    values,
    pathSegments,
  }) {
    const childTableName = buildChildTableName(parentTableName, fieldName, pathSegments);
    const parentForeignKeyName = `${toSingular(parentTableName)}_id`;

    values
      .filter((value) => value !== null && value !== undefined)
      .forEach((item, index) => {
        const itemIdentity = resolveObjectIdentity(item);
        const childFingerprint = buildRowFingerprint([
          parentFingerprint,
          fieldName,
          index,
          itemIdentity,
        ]);

        if (Array.isArray(item)) {
          processArray({
            parentTableName: childTableName,
            parentFingerprint: childFingerprint,
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
            parentFingerprint,
            parentForeignKeyName,
            documentFingerprint: childFingerprint,
            basePathSegments: pathSegments,
          });
          return;
        }

        const row = {
          id: stableIntegerId(childFingerprint),
          source_fingerprint: childFingerprint,
          __parentFingerprint: parentFingerprint,
          __parentTableName: parentTableName,
          [parentForeignKeyName]: null,
          value: convertScalarValue(item),
        };

        ensureRowBucket(rowBuckets, childTableName).push(row);
      });
  }

  function processNestedObject({ prefix, value, row, tableName, parentFingerprint, pathSegments }) {
    Object.entries(value).forEach(([nestedKey, nestedValue]) => {
      processField({
        fieldName: `${prefix}_${nestedKey}`,
        value: nestedValue,
        row,
        tableName,
        parentFingerprint,
        pathSegments: pathSegments.concat(nestedKey),
      });
    });
  }

  function processField({ fieldName, value, row, tableName, parentFingerprint, pathSegments }) {
    const kind = getScalarKind(value);

    if (kind === 'array') {
      processArray({
        parentTableName: tableName,
        parentFingerprint,
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
        parentFingerprint,
        pathSegments,
      });
      return;
    }

    row[normalizeColumnName(fieldName)] = convertScalarValue(value);
  }

  documents.forEach((document, index) => {
    const rootIdentity = document && document._id !== undefined
      ? String(document._id)
      : hashValue({ index, document });
    const documentFingerprint = buildRowFingerprint([
      rootTableName,
      rootIdentity,
    ]);

    processDocument({
      document,
      tableName: rootTableName,
      documentFingerprint,
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
      .filter((columnName) => row[columnName] !== undefined)
      .concat('source_fingerprint')
      .filter((columnName, index, items) => items.indexOf(columnName) === index);
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

  const updatableColumns = columns.filter(
    (column) => column !== 'id' && column !== 'source_fingerprint'
  );
  const updateClause = updatableColumns.length > 0
    ? updatableColumns
      .map((column) => `${column} = EXCLUDED.${column}`)
      .join(', ')
    : 'source_fingerprint = EXCLUDED.source_fingerprint';

  return {
    text: `INSERT INTO ${tableName} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')} ON CONFLICT (source_fingerprint) DO UPDATE SET ${updateClause} RETURNING id, source_fingerprint`,
    values,
  };
}

async function ensureMigrationMetadataColumns(client, tableName) {
  await client.query(
    `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS source_fingerprint TEXT`
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${tableName}_source_fingerprint ON ${tableName} (source_fingerprint)`
  );
}

async function createSchema(client, analysis) {
  for (const statement of analysis.sqlStatements) {
    await client.query(withIfNotExists(statement));
  }

  for (const table of analysis.tables) {
    await ensureMigrationMetadataColumns(client, table.tableName);
  }

  for (const indexSuggestion of analysis.indexSuggestions) {
    await client.query(withIndexIfNotExists(indexSuggestion.sql));
  }
}

async function assertTablesReadyForIdempotentMigration(client, analysis) {
  for (const table of analysis.tables) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS total_rows, COUNT(source_fingerprint)::int AS fingerprinted_rows FROM ${table.tableName}`
    );
    const totalRows = result.rows[0].total_rows;
    const fingerprintedRows = result.rows[0].fingerprinted_rows;

    if (totalRows > 0 && totalRows !== fingerprintedRows) {
      throw new Error(
        `Target table "${table.tableName}" contains ${totalRows - fingerprintedRows} legacy row(s) without migration fingerprints. Clean or backfill that table before running idempotent migration.`
      );
    }
  }
}

function buildIdMap() {
  return new Map();
}

function getTableForeignKeyColumn(table) {
  const foreignKeyColumn = table.columns.find((column) => column.isForeignKey);
  return foreignKeyColumn ? foreignKeyColumn.name : null;
}

function hydrateParentReferences(table, rows, idMaps) {
  const foreignKeyColumn = getTableForeignKeyColumn(table);

  if (!foreignKeyColumn || !table.parentTableName) {
    return rows;
  }

  const parentMap = idMaps.get(table.parentTableName) || new Map();

  return rows.map((row) => {
    const parentFingerprint = row.__parentFingerprint;

    if (!parentFingerprint) {
      return row;
    }

    if (!parentMap.has(parentFingerprint)) {
      throw new Error(
        `Missing parent mapping for table "${table.tableName}" with parent fingerprint "${parentFingerprint}".`
      );
    }

    return {
      ...row,
      [foreignKeyColumn]: parentMap.get(parentFingerprint),
    };
  });
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
      const result = await client.query(statement.text, statement.values);
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result.rows;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);

      if (!isRetryableError(error) || attempt === maxRetries) {
        const enhancedError = new Error(
          `Batch upsert failed for "${tableName}" on batch ${batchNumber}/${batchCount}: ${error.message}`
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

  return [];
}

async function upsertRows(client, analysis, rowBuckets, options = {}) {
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  const onProgress = options.onProgress;
  const totalRows = Array.from(rowBuckets.values()).reduce((sum, rows) => sum + rows.length, 0);
  const idMaps = new Map();
  let insertedRowCount = 0;

  for (const table of analysis.tables) {
    const rawRows = rowBuckets.get(table.tableName) || [];

    if (rawRows.length === 0) {
      continue;
    }

    const rows = hydrateParentReferences(table, rawRows, idMaps);
    const columnGroups = buildColumnGroups(rows, table);
    const totalBatches = columnGroups.reduce((sum, group) => {
      return sum + chunkRows(group.rows, batchSize).length;
    }, 0);
    const tableIdMap = buildIdMap();
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

        const returnedRows = await runBatchWithRetry({
          client,
          tableName: table.tableName,
          batchRows,
          columns: group.columns,
          batchNumber,
          batchCount: totalBatches,
          maxRetries,
          onProgress,
        });

        returnedRows.forEach((returnedRow) => {
          tableIdMap.set(returnedRow.source_fingerprint, returnedRow.id);
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

    idMaps.set(table.tableName, tableIdMap);
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
    await assertTablesReadyForIdempotentMigration(client, analysis);
    return upsertRows(client, analysis, rowBuckets, {
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
