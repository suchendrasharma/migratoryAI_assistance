const path = require('path');
const dotenv = require('dotenv');

dotenv.config({
  path: path.resolve(process.cwd(), '.env'),
  quiet: true,
});

function readRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function readPositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    throw new Error(`Expected a positive integer but received "${value}"`);
  }

  return parsedValue;
}

function getMongoConfig() {
  return {
    uri: readRequiredEnv('MONGODB_URI'),
    dbName: readRequiredEnv('MONGODB_DB'),
    collectionName: process.env.MONGODB_COLLECTION || '',
    sampleLimit: readPositiveInteger(process.env.MONGODB_SAMPLE_LIMIT, 5),
  };
}

module.exports = {
  getMongoConfig,
};
