const { MongoClient } = require('mongodb');

let client;

async function connectMongo(config) {
  if (!client) {
    client = new MongoClient(config.uri, {
      appName: 'migratoryAI',
    });
  }

  await client.connect();

  return {
    client,
    db: client.db(config.dbName),
  };
}

async function resolveCollection(db, requestedCollectionName) {
  if (requestedCollectionName) {
    return requestedCollectionName;
  }

  const collections = await db.listCollections({}, { nameOnly: true }).toArray();

  if (collections.length === 0) {
    throw new Error(`No collections found in database "${db.databaseName}"`);
  }

  return collections[0].name;
}

async function fetchSampleDocuments(config, options = {}) {
  const { db } = await connectMongo(config);
  const collectionName = await resolveCollection(
    db,
    options.collectionName || config.collectionName
  );
  const limit = options.limit || config.sampleLimit;
  const documents = await db.collection(collectionName).find({}).limit(limit).toArray();

  return {
    collectionName,
    documents,
  };
}

async function closeMongoConnection() {
  if (client) {
    await client.close();
    client = undefined;
  }
}

module.exports = {
  connectMongo,
  fetchSampleDocuments,
  closeMongoConnection,
};
