const {
  closeMongoConnection,
  fetchDocuments,
  fetchSampleDocuments,
} = require('../../db/mongoConnector');

const mongoDbSourceAdapter = {
  id: 'mongodb',
  kind: 'source',
  displayName: 'MongoDB Source Adapter',

  async fetchSampleRecords(config, options = {}) {
    const result = await fetchSampleDocuments(config, options);

    return {
      sourceEntityName: result.collectionName,
      records: result.documents,
      metadata: {
        adapter: 'mongodb',
        collectionName: result.collectionName,
        recordCount: result.documents.length,
      },
    };
  },

  async fetchRecords(config, options = {}) {
    const result = await fetchDocuments(config, options);

    return {
      sourceEntityName: result.collectionName,
      records: result.documents,
      metadata: {
        adapter: 'mongodb',
        collectionName: result.collectionName,
        recordCount: result.documents.length,
      },
    };
  },

  async close() {
    await closeMongoConnection();
  },
};

module.exports = {
  mongoDbSourceAdapter,
};
