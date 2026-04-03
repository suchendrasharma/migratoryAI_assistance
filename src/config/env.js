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

function readOptionalInteger(value, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (Number.isNaN(parsedValue)) {
    throw new Error(`Expected an integer but received "${value}"`);
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

function getPostgresConfig() {
  const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL || '';
  const database = process.env.PGDATABASE || '';

  if (!connectionString && !database) {
    throw new Error(
      'Missing PostgreSQL connection settings. Set POSTGRES_URL or PGDATABASE in your .env.'
    );
  }

  return {
    connectionString: connectionString || undefined,
    host: process.env.PGHOST || '127.0.0.1',
    port: readOptionalInteger(process.env.PGPORT, 5432),
    user: process.env.PGUSER || 'postgres',
    password: process.env.PGPASSWORD || undefined,
    database: database || undefined,
  };
}

function mergeMongoConfig(overrides = {}) {
  const baseConfig = getMongoConfig();

  return {
    ...baseConfig,
    ...overrides,
    collectionName:
      overrides.collectionName !== undefined ? overrides.collectionName : baseConfig.collectionName,
    sampleLimit:
      overrides.sampleLimit !== undefined ? overrides.sampleLimit : baseConfig.sampleLimit,
  };
}

function mergePostgresConfig(overrides = {}) {
  const baseConfig = getPostgresConfig();

  return {
    ...baseConfig,
    ...overrides,
  };
}

module.exports = {
  getMongoConfig,
  getPostgresConfig,
  mergeMongoConfig,
  mergePostgresConfig,
};
