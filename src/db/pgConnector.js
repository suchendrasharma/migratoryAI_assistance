const { Pool } = require('pg');

let pool;

function buildPoolConfig(config) {
  if (config.connectionString) {
    return {
      connectionString: config.connectionString,
      application_name: 'migratoryAI',
    };
  }

  return {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    application_name: 'migratoryAI',
  };
}

async function connectPostgres(config) {
  if (!pool) {
    pool = new Pool(buildPoolConfig(config));
  }

  await pool.query('SELECT 1');
  return pool;
}

async function query(config, text, params = []) {
  const activePool = await connectPostgres(config);
  return activePool.query(text, params);
}

async function withPostgresTransaction(config, callback) {
  const activePool = await connectPostgres(config);
  const client = await activePool.connect();

  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closePostgresConnection() {
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

module.exports = {
  connectPostgres,
  query,
  withPostgresTransaction,
  closePostgresConnection,
};
