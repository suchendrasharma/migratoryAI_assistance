const { analyzeDocuments } = require('./analyzer');
const { buildRowsFromDocuments } = require('./migrator');

function buildValidationSummary(analysis, rowBuckets, targetCounts) {
  const tableComparisons = analysis.tables.map((table) => {
    const expectedRows = (rowBuckets.get(table.tableName) || []).length;
    const target = targetCounts[table.tableName] || {
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
      tableName: table.tableName,
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
  queryExecutor,
}) {
  const analysis = analyzeDocuments(documents, collectionName);
  const rowBuckets = buildRowsFromDocuments(documents, collectionName);
  const tableNames = analysis.tables.map((table) => table.tableName);

  const targetCounts = await queryExecutor(async (client) => {
    const counts = {};

    for (const tableName of tableNames) {
      const result = await client.query(
        `SELECT COUNT(*)::int AS actual_rows, COUNT(DISTINCT source_fingerprint)::int AS distinct_fingerprints, (COUNT(*) - COUNT(DISTINCT source_fingerprint))::int AS duplicate_rows, COUNT(source_fingerprint)::int AS fingerprint_coverage FROM ${tableName}`
      );
      counts[tableName] = {
        actualRows: result.rows[0].actual_rows,
        distinctFingerprints: result.rows[0].distinct_fingerprints,
        duplicateRows: result.rows[0].duplicate_rows,
        fingerprintCoverage: result.rows[0].fingerprint_coverage,
      };
    }

    return counts;
  });

  return buildValidationSummary(analysis, rowBuckets, targetCounts);
}

module.exports = {
  validateMigration,
};
