const assert = require('node:assert/strict');

const { analyzeDocuments } = require('../src/core/analyzer');
const { couchDbSourceAdapter } = require('../src/plugins/source/couchdbAdapter');

async function runScenario() {
  const originalFetch = global.fetch;

  global.fetch = async (url) => {
    assert.equal(
      String(url),
      'http://127.0.0.1:5984/users/_all_docs?include_docs=true&limit=2'
    );

    return {
      ok: true,
      status: 200,
      async json() {
        return {
          rows: [
            {
              doc: {
                _id: 'user-1',
                name: 'Samael',
                age: 25,
                orders: [{ product: 'shoes', price: 2000 }],
              },
            },
            {
              doc: {
                _id: '_design/users-view',
                language: 'javascript',
              },
            },
          ],
        };
      },
    };
  };

  try {
    const result = await couchDbSourceAdapter.fetchSampleRecords(
      {
        uri: 'http://127.0.0.1:5984',
        dbName: 'users',
        sampleLimit: 2,
      },
      { limit: 2 }
    );

    assert.equal(result.sourceEntityName, 'users');
    assert.deepEqual(Object.keys(result).sort(), ['metadata', 'records', 'sourceEntityName']);
    assert.deepEqual(result.metadata, {
      adapter: 'couchdb',
      collectionName: 'users',
      recordCount: 1,
    });
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0], {
      _id: 'user-1',
      name: 'Samael',
      age: 25,
      orders: [{ product: 'shoes', price: 2000 }],
    });

    const analysis = analyzeDocuments(result.records, result.sourceEntityName, {
      sourceAdapter: 'couchdb',
      targetAdapter: 'postgres',
    });

    assert.equal(analysis.unifiedSchemaModel.sourceAdapter, 'couchdb');
    assert.equal(analysis.unifiedSchemaModel.rootEntity, 'users');
    assert.deepEqual(
      analysis.unifiedSchemaModel.entities.map((entity) => entity.name),
      ['users', 'orders']
    );
  } finally {
    global.fetch = originalFetch;
  }
}

runScenario()
  .then(() => {
    console.log('CouchDB source adapter shape test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
