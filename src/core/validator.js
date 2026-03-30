const { analyzeDocuments } = require('./analyzer');
const { buildRowsFromDocuments } = require('./migrator');

function buildValidationSummary(analysis, rowBuckets, targetCounts) {
  const tableComparisons = analysis.tables.map((table) => {
    const expectedRows = (rowBuckets.get(table.tableName) || []).length;
    const actualRows = targetCounts[table.tableName] || 0;

    return {
      tableName: table.tableName,
      expectedRows,
      actualRows,
      matches: expectedRows === actualRows,
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
      const result = await client.query(`SELECT COUNT(*)::int AS count FROM ${tableName}`);
      counts[tableName] = result.rows[0].count;
    }

    return counts;
  });

  return buildValidationSummary(analysis, rowBuckets, targetCounts);
}

module.exports = {
  validateMigration,
};
