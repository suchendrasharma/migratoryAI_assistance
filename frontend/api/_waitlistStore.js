const { MongoClient } = require('mongodb');

const DEFAULT_DB_NAME = 'migratoryai_site';
const DEFAULT_COLLECTION_NAME = 'waitlist_signups';

let cachedClientPromise = null;

function getMongoUri() {
  const mongoUri = process.env.MONGODB_URI || process.env.WAITLIST_MONGODB_URI;

  if (!mongoUri) {
    throw new Error('Missing MONGODB_URI or WAITLIST_MONGODB_URI for waitlist storage.');
  }

  return mongoUri;
}

async function getWaitlistCollection() {
  if (!cachedClientPromise) {
    const client = new MongoClient(getMongoUri());
    cachedClientPromise = client.connect();
  }

  const client = await cachedClientPromise;
  const dbName = process.env.WAITLIST_DB_NAME || DEFAULT_DB_NAME;
  const collectionName = process.env.WAITLIST_COLLECTION_NAME || DEFAULT_COLLECTION_NAME;

  return client.db(dbName).collection(collectionName);
}

async function saveWaitlistSignup(email) {
  const collection = await getWaitlistCollection();
  const normalizedEmail = email.trim().toLowerCase();
  const now = new Date();

  await collection.updateOne(
    { email: normalizedEmail },
    {
      $setOnInsert: {
        email: normalizedEmail,
        createdAt: now,
      },
      $set: {
        updatedAt: now,
      },
    },
    { upsert: true }
  );

  return collection.countDocuments();
}

async function countWaitlistSignups() {
  const collection = await getWaitlistCollection();
  return collection.countDocuments();
}

module.exports = {
  saveWaitlistSignup,
  countWaitlistSignups,
};
