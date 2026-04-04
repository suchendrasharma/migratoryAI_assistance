const {
  closePostgresConnection,
  connectPostgres,
  withPostgresTransaction,
} = require('../../db/pgConnector');

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

function mapLogicalTypeToSqlType(logicalType, field = {}) {
  if (field.metadata && field.metadata.sqlType) {
    return field.metadata.sqlType;
  }

  switch (logicalType) {
    case 'integer':
      return 'INTEGER';
    case 'decimal':
      return 'DECIMAL(12,2)';
    case 'float':
      return 'FLOAT';
    case 'boolean':
      return 'BOOLEAN';
    case 'datetime':
      return 'TIMESTAMP';
    default:
      return 'TEXT';
  }
}

function renderCreateEntityStatement(entity) {
  const columnDefinitions = entity.fields.map((field) => {
    const sqlType = mapLogicalTypeToSqlType(field.logicalType, field);

    if (field.role === 'primary-key') {
      return `  ${field.name} ${sqlType} PRIMARY KEY`;
    }

    const nullability = field.nullable ? '' : ' NOT NULL';
    return `  ${field.name} ${sqlType}${nullability}`;
  });

  const foreignKeys = entity.fields
    .filter((field) => field.role === 'foreign-key' && field.references)
    .map((field) => `  FOREIGN KEY (${field.name}) REFERENCES ${field.references} ON DELETE CASCADE`);

  return `CREATE TABLE ${entity.name} (\n${columnDefinitions.concat(foreignKeys).join(',\n')}\n);`;
}

function renderCreateIndexStatement(indexSuggestion) {
  const prefix = indexSuggestion.unique ? 'ux' : 'ix';
  const indexName = `${prefix}_${indexSuggestion.tableName}_${indexSuggestion.columnNames.join('_')}`;

  return `CREATE INDEX ${indexName} ON ${indexSuggestion.tableName} (${indexSuggestion.columnNames.join(', ')});`;
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

function buildColumnGroups(rows, entity) {
  const groups = new Map();

  rows.forEach((row) => {
    const columns = entity.fields
      .map((field) => field.name)
      .filter((fieldName) => row[fieldName] !== undefined)
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

function buildBatchInsertStatement(entityName, columns, rows) {
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
    text: `INSERT INTO ${entityName} (${columns.join(', ')}) VALUES ${valueGroups.join(', ')} ON CONFLICT (source_fingerprint) DO UPDATE SET ${updateClause} RETURNING id, source_fingerprint`,
    values,
  };
}

async function ensureMigrationMetadataColumns(client, entityName) {
  await client.query(
    `ALTER TABLE ${entityName} ADD COLUMN IF NOT EXISTS source_fingerprint TEXT`
  );
  await client.query(
    `CREATE UNIQUE INDEX IF NOT EXISTS ux_${entityName}_source_fingerprint ON ${entityName} (source_fingerprint)`
  );
}

async function createSchema(client, unifiedSchemaModel) {
  for (const entity of unifiedSchemaModel.entities) {
    await client.query(withIfNotExists(renderCreateEntityStatement(entity)));
  }

  for (const entity of unifiedSchemaModel.entities) {
    await ensureMigrationMetadataColumns(client, entity.name);
  }

  for (const indexSuggestion of unifiedSchemaModel.indexes || []) {
    const statement = indexSuggestion.sql || renderCreateIndexStatement(indexSuggestion);
    await client.query(withIndexIfNotExists(statement));
  }
}

async function assertReadyForIdempotentMigration(client, unifiedSchemaModel) {
  for (const entity of unifiedSchemaModel.entities) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS total_rows, COUNT(source_fingerprint)::int AS fingerprinted_rows FROM ${entity.name}`
    );
    const totalRows = result.rows[0].total_rows;
    const fingerprintedRows = result.rows[0].fingerprinted_rows;

    if (totalRows > 0 && totalRows !== fingerprintedRows) {
      throw new Error(
        `Target entity "${entity.name}" contains ${totalRows - fingerprintedRows} legacy row(s) without migration fingerprints. Clean or backfill that entity before running idempotent migration.`
      );
    }
  }
}

function getEntityForeignKeyField(entity) {
  const foreignKeyField = entity.fields.find((field) => field.role === 'foreign-key');
  return foreignKeyField ? foreignKeyField.name : null;
}

function hydrateParentReferences(entity, rows, idMaps) {
  const foreignKeyField = getEntityForeignKeyField(entity);

  if (!foreignKeyField || !entity.parentEntity) {
    return rows;
  }

  const parentMap = idMaps.get(entity.parentEntity) || new Map();

  return rows.map((row) => {
    const parentFingerprint = row.__parentFingerprint;

    if (!parentFingerprint) {
      return row;
    }

    if (!parentMap.has(parentFingerprint)) {
      throw new Error(
        `Missing parent mapping for entity "${entity.name}" with parent fingerprint "${parentFingerprint}".`
      );
    }

    return {
      ...row,
      [foreignKeyField]: parentMap.get(parentFingerprint),
    };
  });
}

async function runBatchWithRetry({
  client,
  entityName,
  batchRows,
  columns,
  batchNumber,
  batchCount,
  maxRetries,
  onProgress,
}) {
  const statement = buildBatchInsertStatement(entityName, columns, batchRows);

  for (let attempt = 1; attempt <= maxRetries; attempt += 1) {
    const savepointName = `sp_${entityName}_${batchNumber}_${attempt}`;

    await client.query(`SAVEPOINT ${savepointName}`);

    try {
      const result = await client.query(statement.text, statement.values);
      await client.query(`RELEASE SAVEPOINT ${savepointName}`);
      return result.rows;
    } catch (error) {
      await client.query(`ROLLBACK TO SAVEPOINT ${savepointName}`);

      if (!isRetryableError(error) || attempt === maxRetries) {
        const enhancedError = new Error(
          `Batch upsert failed for "${entityName}" on batch ${batchNumber}/${batchCount}: ${error.message}`
        );
        enhancedError.cause = error;
        throw enhancedError;
      }

      if (onProgress) {
        onProgress({
          phase: 'retry',
          tableName: entityName,
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

async function upsertRows(client, unifiedSchemaModel, rowBuckets, options = {}) {
  const batchSize = options.batchSize || DEFAULT_BATCH_SIZE;
  const maxRetries = options.maxRetries || DEFAULT_MAX_RETRIES;
  const onProgress = options.onProgress;
  const totalRows = Array.from(rowBuckets.values()).reduce((sum, rows) => sum + rows.length, 0);
  const idMaps = new Map();
  let insertedRowCount = 0;

  for (const entity of unifiedSchemaModel.entities) {
    const rawRows = rowBuckets.get(entity.name) || [];

    if (rawRows.length === 0) {
      continue;
    }

    const rows = hydrateParentReferences(entity, rawRows, idMaps);
    const columnGroups = buildColumnGroups(rows, entity);
    const totalBatches = columnGroups.reduce((sum, group) => {
      return sum + chunkRows(group.rows, batchSize).length;
    }, 0);
    const entityIdMap = new Map();
    let processedTableRows = 0;
    let batchNumber = 0;

    if (onProgress) {
      onProgress({
        phase: 'table-start',
        tableName: entity.name,
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
          entityName: entity.name,
          batchRows,
          columns: group.columns,
          batchNumber,
          batchCount: totalBatches,
          maxRetries,
          onProgress,
        });

        returnedRows.forEach((returnedRow) => {
          entityIdMap.set(returnedRow.source_fingerprint, returnedRow.id);
        });

        insertedRowCount += batchRows.length;
        processedTableRows += batchRows.length;

        if (onProgress) {
          onProgress({
            phase: 'batch-complete',
            tableName: entity.name,
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

    idMaps.set(entity.name, entityIdMap);
  }

  return insertedRowCount;
}

async function readEntityCounts(client, unifiedSchemaModel) {
  const counts = {};

  for (const entity of unifiedSchemaModel.entities) {
    const result = await client.query(
      `SELECT COUNT(*)::int AS actual_rows, COUNT(DISTINCT source_fingerprint)::int AS distinct_fingerprints, (COUNT(*) - COUNT(DISTINCT source_fingerprint))::int AS duplicate_rows, COUNT(source_fingerprint)::int AS fingerprint_coverage FROM ${entity.name}`
    );
    counts[entity.name] = {
      actualRows: result.rows[0].actual_rows,
      distinctFingerprints: result.rows[0].distinct_fingerprints,
      duplicateRows: result.rows[0].duplicate_rows,
      fingerprintCoverage: result.rows[0].fingerprint_coverage,
    };
  }

  return counts;
}

const postgresTargetAdapter = {
  id: 'postgres',
  kind: 'target',
  displayName: 'PostgreSQL Target Adapter',

  async checkConnection(config) {
    await connectPostgres(config);
    return {
      adapter: 'postgres',
      status: 'connected',
    };
  },

  async runInTransaction(config, callback, options = {}) {
    return withPostgresTransaction(config, callback, options);
  },

  renderSchemaStatements(unifiedSchemaModel) {
    return unifiedSchemaModel.entities.map(renderCreateEntityStatement);
  },

  renderIndexSuggestions(unifiedSchemaModel) {
    return (unifiedSchemaModel.indexes || []).map((indexSuggestion) => ({
      ...indexSuggestion,
      sql: indexSuggestion.sql || renderCreateIndexStatement(indexSuggestion),
    }));
  },

  async createSchema(client, unifiedSchemaModel) {
    await createSchema(client, unifiedSchemaModel);
  },

  async assertReadyForIdempotentMigration(client, unifiedSchemaModel) {
    await assertReadyForIdempotentMigration(client, unifiedSchemaModel);
  },

  async upsertRows(client, unifiedSchemaModel, rowBuckets, options = {}) {
    return upsertRows(client, unifiedSchemaModel, rowBuckets, options);
  },

  async readEntityCounts(client, unifiedSchemaModel) {
    return readEntityCounts(client, unifiedSchemaModel);
  },

  async close() {
    await closePostgresConnection();
  },
};

module.exports = {
  postgresTargetAdapter,
};
