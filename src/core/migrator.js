const crypto = require('crypto');

const { analyzeDocuments } = require('./analyzer');
const { assertValidUnifiedSchemaModel } = require('./unifiedSchemaModel');
const { getTargetAdapter } = require('../plugins/registry');

const DEFAULT_BATCH_SIZE = 250;
const DEFAULT_MAX_RETRIES = 3;

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

function buildRowsFromDocuments(documents, collectionNameOrModel) {
  const unifiedSchemaModel = collectionNameOrModel && typeof collectionNameOrModel === 'object'
    ? assertValidUnifiedSchemaModel(collectionNameOrModel)
    : null;
  const rootTableName = unifiedSchemaModel
    ? unifiedSchemaModel.rootEntity
    : normalizeTableName(collectionNameOrModel);
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

async function migrateDocuments({
  documents,
  collectionName,
  sourceAdapterType = 'mongodb',
  targetAdapterType = 'postgres',
  queryExecutor,
  batchSize = DEFAULT_BATCH_SIZE,
  maxRetries = DEFAULT_MAX_RETRIES,
  onProgress,
}) {
  const targetAdapter = getTargetAdapter(targetAdapterType);
  const analysis = analyzeDocuments(documents, collectionName, {
    sourceAdapter: sourceAdapterType,
    targetAdapter: targetAdapterType,
  });
  const unifiedSchemaModel = assertValidUnifiedSchemaModel(analysis.unifiedSchemaModel);
  const rowBuckets = buildRowsFromDocuments(documents, unifiedSchemaModel);
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
    await targetAdapter.createSchema(client, unifiedSchemaModel);
    await targetAdapter.assertReadyForIdempotentMigration(client, unifiedSchemaModel);
    return targetAdapter.upsertRows(client, unifiedSchemaModel, rowBuckets, {
      batchSize,
      maxRetries,
      onProgress,
    });
  });

  return {
    analysis,
    unifiedSchemaModel,
    insertedRowCount,
    migratedTables: unifiedSchemaModel.entities.length,
    totalRows,
    batchSize,
    maxRetries,
  };
}

module.exports = {
  buildRowsFromDocuments,
  migrateDocuments,
};
