const {
  closeCouchConnection,
  fetchCouchDocuments,
  fetchSampleCouchDocuments,
} = require('../../db/couchConnector');

const couchDbSourceAdapter = {
  id: 'couchdb',
  kind: 'source',
  displayName: 'CouchDB Source Adapter',

  async fetchSampleRecords(config, options = {}) {
    const result = await fetchSampleCouchDocuments(config, options);

    return {
      sourceEntityName: result.collectionName,
      records: result.documents,
      metadata: {
        adapter: 'couchdb',
        collectionName: result.collectionName,
        recordCount: result.documents.length,
      },
    };
  },

  async fetchRecords(config, options = {}) {
    const result = await fetchCouchDocuments(config, options);

    return {
      sourceEntityName: result.collectionName,
      records: result.documents,
      metadata: {
        adapter: 'couchdb',
        collectionName: result.collectionName,
        recordCount: result.documents.length,
      },
    };
  },

  async close() {
    await closeCouchConnection();
  },
};

module.exports = {
  couchDbSourceAdapter,
};
