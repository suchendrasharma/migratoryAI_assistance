const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_FILENAME = 'migrate.config.json';

function resolveConfigPath(configPath) {
  if (!configPath) {
    return path.resolve(process.cwd(), DEFAULT_CONFIG_FILENAME);
  }

  return path.resolve(process.cwd(), configPath);
}

function loadMigrationConfig(configPath) {
  const resolvedPath = resolveConfigPath(configPath);

  if (!fs.existsSync(resolvedPath)) {
    return {
      configPath: resolvedPath,
      exists: false,
      config: null,
    };
  }

  const fileContents = fs.readFileSync(resolvedPath, 'utf8');
  const parsedConfig = JSON.parse(fileContents);

  return {
    configPath: resolvedPath,
    exists: true,
    config: normalizeMigrationConfig(parsedConfig),
  };
}

function normalizeMigrationConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Migration config must be a JSON object.');
  }

  return {
    source: normalizeSourceConfig(config.source || {}),
    target: normalizeTargetConfig(config.target || {}),
    options: normalizeOptionsConfig(config.options || {}),
  };
}

function normalizeSourceConfig(source) {
  return {
    type: source.type || 'mongodb',
    uri: source.uri,
    dbName: source.dbName || source.database,
    collectionName: source.collectionName || source.collection,
    sampleLimit: source.sampleLimit,
  };
}

function normalizeTargetConfig(target) {
  return {
    type: target.type || 'postgres',
    connectionString: target.connectionString || target.url,
    host: target.host,
    port: target.port,
    user: target.user,
    password: target.password,
    database: target.database || target.dbName,
  };
}

function normalizeOptionsConfig(options) {
  return {
    collectionName: options.collectionName || options.collection,
    limit: options.limit,
    batchSize: options.batchSize,
    retries: options.retries,
    dryRun: options.dryRun,
    validate: options.validate,
    sampleLimit: options.sampleLimit,
  };
}

module.exports = {
  DEFAULT_CONFIG_FILENAME,
  loadMigrationConfig,
  resolveConfigPath,
};
