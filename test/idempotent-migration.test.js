const assert = require('node:assert/strict');

const { migrateDocuments } = require('../src/core/migrator');
const { validateMigration } = require('../src/core/validator');

function createTestDocuments() {
  return [
    {
      _id: 'user-1',
      externalId: 'user-1',
      name: 'Alpha',
      age: 28,
      orders: [
        { orderId: 'order-1-1', product: 'shoes', price: 1200, quantity: 1 },
        { orderId: 'order-1-2', product: 'bag', price: 900, quantity: 2 },
      ],
    },
    {
      _id: 'user-2',
      externalId: 'user-2',
      name: 'Beta',
      age: 31,
      orders: [
        { orderId: 'order-2-1', product: 'watch', price: 2500, quantity: 1 },
      ],
    },
    {
      _id: 'user-3',
      externalId: 'user-3',
      name: 'Gamma',
      age: 24,
      orders: [
        { orderId: 'order-3-1', product: 'keyboard', price: 1800, quantity: 1 },
        { orderId: 'order-3-2', product: 'mouse', price: 700, quantity: 1 },
      ],
    },
  ];
}

function createFakePgStore() {
  const tables = new Map();

  function ensureTable(tableName) {
    if (!tables.has(tableName)) {
      tables.set(tableName, new Map());
    }

    return tables.get(tableName);
  }

  function cloneTables(source) {
    const copy = new Map();

    source.forEach((rows, tableName) => {
      const rowCopy = new Map();

      rows.forEach((row, fingerprint) => {
        rowCopy.set(fingerprint, { ...row });
      });

      copy.set(tableName, rowCopy);
    });

    return copy;
  }

  function restoreTables(snapshot) {
    tables.clear();
    snapshot.forEach((rows, tableName) => {
      tables.set(tableName, rows);
    });
  }

  function getClient() {
    const transactionSnapshot = cloneTables(tables);
    const savepoints = new Map();

    return {
      async query(text, params = []) {
        const normalized = text.trim();

        if (normalized.startsWith('BEGIN')) {
          return { rows: [] };
        }

        if (normalized === 'COMMIT') {
          return { rows: [] };
        }

        if (normalized === 'ROLLBACK') {
          restoreTables(transactionSnapshot);
          return { rows: [] };
        }

        if (
          normalized.startsWith('CREATE UNIQUE INDEX') ||
          normalized.startsWith('CREATE INDEX') ||
          normalized.startsWith('ALTER TABLE')
        ) {
          return { rows: [] };
        }

        if (normalized.startsWith('SAVEPOINT ')) {
          savepoints.set(normalized.slice('SAVEPOINT '.length), cloneTables(tables));
          return { rows: [] };
        }

        if (normalized.startsWith('ROLLBACK TO SAVEPOINT ')) {
          const savepointName = normalized.slice('ROLLBACK TO SAVEPOINT '.length);
          const snapshot = savepoints.get(savepointName);
          if (snapshot) {
            restoreTables(snapshot);
          }
          return { rows: [] };
        }

        if (normalized.startsWith('RELEASE SAVEPOINT ')) {
          savepoints.delete(normalized.slice('RELEASE SAVEPOINT '.length));
          return { rows: [] };
        }

        if (normalized.startsWith('CREATE TABLE')) {
          const match = normalized.match(/CREATE TABLE IF NOT EXISTS ([a-zA-Z0-9_]+)/);
          if (match) {
            ensureTable(match[1]);
          }
          return { rows: [] };
        }

        if (normalized.includes('AS total_rows') && normalized.includes('AS fingerprinted_rows')) {
          const tableName = normalized.match(/FROM ([a-zA-Z0-9_]+)/)[1];
          const rows = Array.from(ensureTable(tableName).values());
          const fingerprintedRows = rows.filter((row) => row.source_fingerprint !== undefined).length;

          return {
            rows: [
              {
                total_rows: rows.length,
                fingerprinted_rows: fingerprintedRows,
              },
            ],
          };
        }

        if (normalized.includes('AS actual_rows') && normalized.includes('AS distinct_fingerprints')) {
          const tableName = normalized.match(/FROM ([a-zA-Z0-9_]+)/)[1];
          const rows = Array.from(ensureTable(tableName).values());
          const fingerprints = rows
            .map((row) => row.source_fingerprint)
            .filter((value) => value !== undefined);
          const distinctFingerprints = new Set(fingerprints).size;

          return {
            rows: [
              {
                actual_rows: rows.length,
                distinct_fingerprints: distinctFingerprints,
                duplicate_rows: rows.length - distinctFingerprints,
                fingerprint_coverage: fingerprints.length,
              },
            ],
          };
        }

        if (normalized.startsWith('INSERT INTO ')) {
          const match = normalized.match(
            /^INSERT INTO ([a-zA-Z0-9_]+) \((.+)\) VALUES (.+) ON CONFLICT \(source_fingerprint\) DO UPDATE SET .+ RETURNING id, source_fingerprint$/
          );

          if (!match) {
            throw new Error(`Unsupported INSERT statement in test double: ${normalized}`);
          }

          const tableName = match[1];
          const columns = match[2].split(',').map((column) => column.trim());
          const rowWidth = columns.length;
          const rowCount = params.length / rowWidth;
          const table = ensureTable(tableName);
          const returnedRows = [];

          for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
            const row = {};

            columns.forEach((column, columnIndex) => {
              row[column] = params[rowIndex * rowWidth + columnIndex];
            });

            table.set(row.source_fingerprint, row);
            returnedRows.push({
              id: row.id,
              source_fingerprint: row.source_fingerprint,
            });
          }

          return { rows: returnedRows };
        }

        throw new Error(`Unsupported SQL in test double: ${normalized}`);
      },
    };
  }

  return {
    async run(callback) {
      return callback(getClient());
    },
    deleteFingerprint(tableName, fingerprint) {
      ensureTable(tableName).delete(fingerprint);
    },
    count(tableName) {
      return ensureTable(tableName).size;
    },
  };
}

async function runScenario() {
  const documents = createTestDocuments();
  const store = createFakePgStore();

  await migrateDocuments({
    documents,
    collectionName: 'users',
    batchSize: 2,
    queryExecutor: (callback) => store.run(callback),
  });

  let validation = await validateMigration({
    documents,
    collectionName: 'users',
    queryExecutor: (callback) => store.run(callback),
  });

  assert.equal(validation.matches, true);
  assert.equal(store.count('users'), 3);
  assert.equal(store.count('orders'), 5);

  store.deleteFingerprint('orders', 'users::user-1::orders::0::order-1-1');

  validation = await validateMigration({
    documents,
    collectionName: 'users',
    queryExecutor: (callback) => store.run(callback),
  });

  assert.equal(validation.matches, false);
  assert.equal(
    validation.tableComparisons.find((comparison) => comparison.tableName === 'orders').actualRows,
    4
  );

  await migrateDocuments({
    documents,
    collectionName: 'users',
    batchSize: 2,
    queryExecutor: (callback) => store.run(callback),
  });

  validation = await validateMigration({
    documents,
    collectionName: 'users',
    queryExecutor: (callback) => store.run(callback),
  });

  assert.equal(validation.matches, true);
  assert.equal(store.count('users'), 3);
  assert.equal(store.count('orders'), 5);

  store.deleteFingerprint('users', 'users::user-3');

  validation = await validateMigration({
    documents,
    collectionName: 'users',
    queryExecutor: (callback) => store.run(callback),
  });

  assert.equal(validation.matches, false);
  assert.equal(
    validation.tableComparisons.find((comparison) => comparison.tableName === 'users').actualRows,
    2
  );

  await migrateDocuments({
    documents,
    collectionName: 'users',
    batchSize: 2,
    queryExecutor: (callback) => store.run(callback),
  });

  validation = await validateMigration({
    documents,
    collectionName: 'users',
    queryExecutor: (callback) => store.run(callback),
  });

  assert.equal(validation.matches, true);
  assert.equal(store.count('users'), 3);
  assert.equal(store.count('orders'), 5);
}

runScenario()
  .then(() => {
    console.log('Idempotent migration recovery test passed');
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
