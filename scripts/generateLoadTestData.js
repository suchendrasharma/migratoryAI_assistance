#!/usr/bin/env node

const { MongoClient } = require('mongodb');

const DEFAULT_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017';
const DEFAULT_DB_NAME = 'load_test_db';
const DEFAULT_COLLECTION_NAME = 'users';
const DEFAULT_COUNT = 5000;

const FIRST_NAMES = [
  'Aarav',
  'Diya',
  'Rohan',
  'Meera',
  'Kabir',
  'Anaya',
  'Vihaan',
  'Ishita',
  'Arjun',
  'Sana',
];

const CITIES = ['Delhi', 'Mumbai', 'Bengaluru', 'Pune', 'Chennai', 'Hyderabad'];
const TIERS = ['free', 'silver', 'gold', 'platinum'];
const PRODUCTS = ['shoes', 'watch', 'bag', 'headphones', 'keyboard', 'mouse'];
const PAYMENT_METHODS = ['card', 'upi', 'netbanking', 'wallet'];

function parseIntegerArg(flag, fallback) {
  const index = process.argv.indexOf(flag);

  if (index === -1 || index === process.argv.length - 1) {
    return fallback;
  }

  const value = Number.parseInt(process.argv[index + 1], 10);

  if (Number.isNaN(value) || value <= 0) {
    throw new Error(`Expected a positive integer for ${flag}`);
  }

  return value;
}

function hasFlag(flag) {
  return process.argv.includes(flag);
}

function randomFrom(list) {
  return list[Math.floor(Math.random() * list.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function buildOrder(userIndex, orderIndex) {
  const quantity = randomInt(1, 4);
  const price = randomInt(200, 5000);

  return {
    orderId: `order-${userIndex}-${orderIndex}`,
    product: randomFrom(PRODUCTS),
    price,
    quantity,
    paymentMethod: randomFrom(PAYMENT_METHODS),
    placedAt: new Date(Date.now() - randomInt(1, 90) * 24 * 60 * 60 * 1000),
  };
}

function buildUser(index) {
  const orderCount = randomInt(1, 5);
  const orders = [];

  for (let orderIndex = 1; orderIndex <= orderCount; orderIndex += 1) {
    orders.push(buildOrder(index, orderIndex));
  }

  return {
    loadTestRun: 'load-test-db-seed',
    externalId: `user-${index}`,
    name: `${randomFrom(FIRST_NAMES)} ${index}`,
    age: randomInt(18, 65),
    email: `user${index}@example.com`,
    isActive: index % 4 !== 0,
    profile: {
      city: randomFrom(CITIES),
      tier: randomFrom(TIERS),
      signupSource: index % 2 === 0 ? 'mobile' : 'web',
    },
    orders,
  };
}

async function main() {
  const count = parseIntegerArg('--count', DEFAULT_COUNT);
  const batchSize = parseIntegerArg('--batch-size', 1000);
  const reset = hasFlag('--reset');

  const client = new MongoClient(DEFAULT_URI, {
    appName: 'migratoryAI-load-test-seed',
  });

  await client.connect();

  try {
    const db = client.db(DEFAULT_DB_NAME);
    const collection = db.collection(DEFAULT_COLLECTION_NAME);

    if (reset) {
      await collection.deleteMany({});
    }

    for (let start = 1; start <= count; start += batchSize) {
      const batch = [];
      const end = Math.min(start + batchSize - 1, count);

      for (let index = start; index <= end; index += 1) {
        batch.push(buildUser(index));
      }

      await collection.insertMany(batch, { ordered: false });
      console.log(`Inserted users ${start}-${end} into ${DEFAULT_DB_NAME}.${DEFAULT_COLLECTION_NAME}`);
    }

    const totalCount = await collection.countDocuments();

    console.log(`Seed complete. Database: ${DEFAULT_DB_NAME}, collection: ${DEFAULT_COLLECTION_NAME}, total documents: ${totalCount}`);
  } finally {
    await client.close();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
