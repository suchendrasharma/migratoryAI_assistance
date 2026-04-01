# MigratoryAI Assistance

MigratoryAI is a CLI data migration engine for moving data from MongoDB to PostgreSQL safely.

It is designed for nested NoSQL documents, relational inference, rerun-safe migrations, and post-migration validation.

## Highlights

- infer SQL tables from MongoDB documents
- extract nested arrays into child tables with foreign keys
- generate suggested SQL and index recommendations
- migrate MongoDB data into PostgreSQL in batches
- retry transient PostgreSQL failures
- validate source-to-target row counts
- rerun the same migration safely without duplicate rows
- generate randomized MongoDB load-test data

## Example

MongoDB document:

```json
{
  "name": "Samael",
  "age": 25,
  "orders": [
    { "product": "shoes", "price": 2000 }
  ]
}
```

Inferred relational model:

```sql
CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  age INTEGER NOT NULL
);

CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL,
  product TEXT NOT NULL,
  price INTEGER NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);
```

## Why This Exists

MongoDB documents often contain nested objects and arrays that do not map directly to relational tables.
MigratoryAI helps bridge that gap by:

- analyzing real MongoDB sample documents
- inferring a relational schema
- migrating documents into PostgreSQL
- validating that migrated SQL rows match the MongoDB-derived expectation

## Safety First

MigratoryAI is built to support reruns when a migration is interrupted or partially applied.

### Rerun-safe migration

- every migrated SQL row gets a stable `source_fingerprint`
- PostgreSQL stores a unique index on `source_fingerprint`
- writes use `ON CONFLICT` upserts
- rerunning the same dataset fills missing rows instead of creating duplicates

### Validation

- compares expected relational row counts derived from MongoDB
- compares actual PostgreSQL row counts
- checks distinct fingerprint counts
- detects duplicate rows
- tells the user when a rerun is recommended

### Transaction protection

- migration runs inside PostgreSQL transactions
- migration uses serializable isolation
- validation uses read-only repeatable-read transactions
- batch retries use savepoints for partial rollback inside a transaction

### Legacy row protection

If a target table already contains rows without migration fingerprints, the tool stops before continuing idempotent migration. This prevents unmanaged legacy rows from mixing with rerun-safe migrated rows.

## Quick Start

### 1. Install dependencies

```bash
npm install
```

### 2. Create `.env`

Use `.env.example` as your base:

```env
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=sample_mflix
MONGODB_COLLECTION=movies
MONGODB_SAMPLE_LIMIT=5
PGHOST=127.0.0.1
PGPORT=5432
PGUSER=postgres
PGPASSWORD=postgres
PGDATABASE=migratoryai
```

### 3. Check PostgreSQL

```bash
migratoryAI pg-check
```

### 4. Analyze sample MongoDB data

```bash
migratoryAI analyze --collection users --limit 5
```

### 5. Migrate with validation

```bash
migratoryAI migrate --collection users --limit 5000 --batch-size 500 --retries 3 --validate
```

### Optional: Create `migrate.config.json`

MigratoryAI can also read configuration from a JSON file named `migrate.config.json` in the project root.

Example:

```json
{
  "source": {
    "type": "mongodb",
    "uri": "mongodb://127.0.0.1:27017",
    "dbName": "sample_mflix",
    "collectionName": "users"
  },
  "target": {
    "type": "postgres",
    "host": "127.0.0.1",
    "port": 5432,
    "user": "postgres",
    "password": "postgres",
    "database": "migratoryai"
  },
  "options": {
    "sampleLimit": 5,
    "limit": 1000,
    "batchSize": 250,
    "retries": 3,
    "validate": true
  }
}
```

This file uses three main sections:

- `source`
  MongoDB connection and source collection settings.

- `target`
  PostgreSQL connection settings.

- `options`
  Migration defaults such as limit, batch size, retries, and validation.

## Environment Variables

### MongoDB

- `MONGODB_URI`
  MongoDB connection string.

- `MONGODB_DB`
  Source MongoDB database.

- `MONGODB_COLLECTION`
  Default collection when `--collection` is not passed.

- `MONGODB_SAMPLE_LIMIT`
  Default document count for `analyze`.

### PostgreSQL

- `PGHOST`
  PostgreSQL host.

- `PGPORT`
  PostgreSQL port.

- `PGUSER`
  PostgreSQL username.

- `PGPASSWORD`
  PostgreSQL password.

- `PGDATABASE`
  PostgreSQL database name.

Optional alternatives:

- `POSTGRES_URL`
  Full PostgreSQL connection string.

- `DATABASE_URL`
  Alternate PostgreSQL connection string variable.

If `POSTGRES_URL` or `DATABASE_URL` is set, it can be used instead of separate `PG*` values.

## Config File Option

MigratoryAI supports both:

- CLI flags
- `migrate.config.json`

Default behavior:

- if `migrate.config.json` exists in the current working directory, the CLI can inherit it automatically
- CLI flags override values from `migrate.config.json`
- environment variables remain the fallback when values are not provided in the config file

You can also pass a custom config file:

```bash
migratoryAI migrate --config ./my-migration-config.json
```

Supported top-level fields:

- `source`
- `target`
- `options`

## Commands

### `migratoryAI pg-check`

Checks that PostgreSQL is reachable with the configured credentials.

Supports:

- inherited `migrate.config.json`
- `--config <path>` for a custom config file

### `migratoryAI analyze`

```bash
migratoryAI analyze --collection users --limit 5
```

What it does:

- fetches sample MongoDB documents
- prints sample JSON
- infers relational tables
- prints suggested SQL
- prints suggested indexes

Supports:

- inherited `migrate.config.json`
- `--config <path>` for a custom config file

### `migratoryAI migrate`

```bash
migratoryAI migrate --collection users --limit 1000 --batch-size 250 --retries 3 --validate
```

What it does:

- reads MongoDB documents
- infers relational mapping
- creates missing PostgreSQL tables and indexes
- migrates rows in batches
- retries transient PostgreSQL failures
- optionally validates after migration

Options:

- `--config`
  Path to a migration config JSON file.

- `--collection`
  MongoDB collection to migrate.

- `--limit`
  Number of source documents to migrate.

- `--batch-size`
  Number of SQL rows per batch.

- `--retries`
  Retry attempts for transient PostgreSQL failures.

- `--validate`
  Runs validation after migration.

### `migratoryAI validate`

```bash
migratoryAI validate --collection users --limit 1000
```

What it does:

- computes expected relational row counts from MongoDB
- compares them against PostgreSQL target tables
- checks fingerprint coverage and duplicates
- tells the user whether a rerun is recommended

Supports:

- inherited `migrate.config.json`
- `--config <path>` for a custom config file

## Recommended Workflow

1. Configure `.env`
2. Run `migratoryAI pg-check`
3. Run `migratoryAI analyze --collection <name> --limit <n>`
4. Run `migratoryAI migrate --collection <name> --limit <n> --batch-size <n> --retries <n> --validate`
5. If validation recommends a rerun, run the same migrate command again

Because the migration is fingerprint-based and uses PostgreSQL upserts, rerunning the same dataset does not create duplicate rows.

## Load Testing

You can generate random MongoDB source data in a separate database for performance and migration testing.

```bash
npm run seed:loadtest -- --count 5000 --batch-size 1000 --reset
```

What it creates:

- database: `load_test_db`
- collection: `users`

Options:

- `--count`
  Number of MongoDB documents to generate.

- `--batch-size`
  Number of MongoDB documents inserted per batch.

- `--reset`
  Clears the target collection before inserting new test data.

## Testing

Run the regression test suite:

```bash
npm test
```

Current automated coverage includes:

- idempotent rerun recovery
- simulated partial data loss between runs
- duplicate prevention through fingerprint-based upserts

## Current Scope

MigratoryAI currently focuses on:

- nested MongoDB document analysis
- parent-child relational mapping
- batch migration into PostgreSQL
- rerun-safe idempotent recovery
- row-count and fingerprint-level validation

Possible future improvements:

- field-level value validation
- schema drift reporting
- migration checkpoints
- configurable conflict policies
- richer migration reports

## Windows Note

On Windows PowerShell, if the `.ps1` shim is blocked by execution policy, use the `.cmd` shim instead:

```powershell
migratoryAI.cmd --help
npm.cmd test
```
