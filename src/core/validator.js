const { analyzeDocuments } = require('./analyzer');
const { buildRowsFromDocuments } = require('./migrator');
const { assertValidUnifiedSchemaModel } = require('./unifiedSchemaModel');
const { getTargetAdapter } = require('../plugins/registry');

function buildValidationSummary(unifiedSchemaModel, rowBuckets, targetCounts) {
  const tableComparisons = unifiedSchemaModel.entities.map((entity) => {
    const expectedRows = (rowBuckets.get(entity.name) || []).length;
    const target = targetCounts[entity.name] || {
      actualRows: 0,
      distinctFingerprints: 0,
      duplicateRows: 0,
      fingerprintCoverage: 0,
    };
    const actualRows = target.actualRows;
    const distinctFingerprints = target.distinctFingerprints;
    const duplicateRows = target.duplicateRows;
    const fingerprintCoverage = target.fingerprintCoverage;

    return {
      tableName: entity.name,
      expectedRows,
      actualRows,
      distinctFingerprints,
      duplicateRows,
      fingerprintCoverage,
      matches:
        expectedRows === actualRows &&
        expectedRows === distinctFingerprints &&
        duplicateRows === 0,
    };
  });

  return {
    matches: tableComparisons.every((comparison) => comparison.matches),
    tableComparisons,
  };
}

async function validateMigration({
  documents,
  collectionName,
  sourceAdapterType = 'mongodb',
  targetAdapterType = 'postgres',
  queryExecutor,
}) {
  const targetAdapter = getTargetAdapter(targetAdapterType);
  const analysis = analyzeDocuments(documents, collectionName, {
    sourceAdapter: sourceAdapterType,
    targetAdapter: targetAdapterType,
  });
  const unifiedSchemaModel = assertValidUnifiedSchemaModel(analysis.unifiedSchemaModel);
  const rowBuckets = buildRowsFromDocuments(documents, unifiedSchemaModel);

  const targetCounts = await queryExecutor((client) => {
    return targetAdapter.readEntityCounts(client, unifiedSchemaModel);
  });

  return {
    ...buildValidationSummary(unifiedSchemaModel, rowBuckets, targetCounts),
    unifiedSchemaModel,
  };
}

module.exports = {
  validateMigration,
};
