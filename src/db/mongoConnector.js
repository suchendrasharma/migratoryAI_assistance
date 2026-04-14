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
  return fetchDocuments(config, {
    ...options,
    limit: options.limit || config.sampleLimit,
  });
}

async function fetchDocuments(config, options = {}) {
  const { db } = await connectMongo(config);
  const collectionName = await resolveCollection(
    db,
    options.collectionName || config.collectionName
  );
  const cursor = db.collection(collectionName).find({});

  if (options.limit) {
    cursor.limit(options.limit);
  }

  const documents = await cursor.toArray();

  return {
    collectionName,
    documents,
  };
}

async function saveDocuments(config, documents, options = {}) {
  const { db } = await connectMongo(config);
  const collectionName = options.collectionName || config.collectionName;

  if (!collectionName) {
    throw new Error('Missing MongoDB collection name for saving documents.');
  }

  if (!documents || documents.length === 0) {
    return {
      collectionName,
      insertedCount: 0,
    };
  }

  const result = await db.collection(collectionName).insertMany(documents);

  return {
    collectionName,
    insertedCount: result.insertedCount,
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
  saveDocuments,
  fetchDocuments,
  fetchSampleDocuments,
  closeMongoConnection,
};
