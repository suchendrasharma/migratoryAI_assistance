#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora').default;

const {
  getMongoConfig,
  getPostgresConfig,
  mergeMongoConfig,
  mergePostgresConfig,
} = require('../config/env');
const {
  DEFAULT_CONFIG_FILENAME,
  loadMigrationConfig,
} = require('../config/fileConfig');
const { analyzeDocuments } = require('../core/analyzer');
const { migrateDocuments } = require('../core/migrator');
const { validateMigration } = require('../core/validator');
const {
  fetchDocuments,
  fetchSampleDocuments,
  closeMongoConnection,
} = require('../db/mongoConnector');
const {
  connectPostgres,
  withPostgresTransaction,
  closePostgresConnection,
} = require('../db/pgConnector');

const program = new Command();

function printRerunSafetyNote() {
  console.log(chalk.cyan('\nRerun safety:'));
  console.log('- Rows are tracked with stable source fingerprints.');
  console.log('- PostgreSQL writes use upsert semantics on those fingerprints.');
  console.log('- Re-running the same migration fills missing rows without creating duplicate entries.');
}

function readPositiveIntegerOption(value, optionName) {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const parsedValue = Number.parseInt(value, 10);

  if (Number.isNaN(parsedValue) || parsedValue <= 0) {
    throw new Error(`The ${optionName} option must be a positive integer.`);
  }

  return parsedValue;
}

function resolveRuntimeConfig(options, commandName, requirements = {}) {
  const loadedConfig = loadMigrationConfig(options.config);
  const config = loadedConfig.config;
  const configOptions = config ? config.options : {};
  const sourceConfig = config ? config.source : {};
  const targetConfig = config ? config.target : {};

  if (config && sourceConfig.type !== 'mongodb') {
    throw new Error(`Unsupported source type "${sourceConfig.type}" in ${loadedConfig.configPath}.`);
  }

  if (config && targetConfig.type !== 'postgres') {
    throw new Error(`Unsupported target type "${targetConfig.type}" in ${loadedConfig.configPath}.`);
  }

  const collectionName = options.collection || configOptions.collectionName || sourceConfig.collectionName;
  const limit = readPositiveIntegerOption(
    options.limit !== undefined ? options.limit : configOptions.limit,
    '--limit'
  );
  const sampleLimit = readPositiveIntegerOption(
    options.limit !== undefined ? options.limit : configOptions.sampleLimit,
    '--limit'
  );
  const batchSize = readPositiveIntegerOption(
    options.batchSize !== undefined ? options.batchSize : configOptions.batchSize,
    '--batch-size'
  );
  const retries = readPositiveIntegerOption(
    options.retries !== undefined ? options.retries : configOptions.retries,
    '--retries'
  );
  const validate = options.validate === true || configOptions.validate === true;

  const mongoOverrides = {
    uri: sourceConfig.uri,
    dbName: sourceConfig.dbName,
    collectionName,
    sampleLimit:
      sourceConfig.sampleLimit !== undefined ? sourceConfig.sampleLimit : configOptions.sampleLimit,
  };
  const postgresOverrides = {
    connectionString: targetConfig.connectionString,
    host: targetConfig.host,
    port: targetConfig.port,
    user: targetConfig.user,
    password: targetConfig.password,
    database: targetConfig.database,
  };

  const runtimeConfig = {
    mongoConfig: requirements.mongo
      ? (config ? mergeMongoConfig(removeUndefinedValues(mongoOverrides)) : getMongoConfig())
      : null,
    postgresConfig: requirements.postgres
      ? (config
        ? mergePostgresConfig(removeUndefinedValues(postgresOverrides))
        : getPostgresConfig())
      : null,
    collectionName,
    limit,
    sampleLimit,
    batchSize,
    retries,
    validate,
    loadedConfig,
    commandName,
  };

  if (!config) {
    runtimeConfig.mongoConfig.collectionName = collectionName || runtimeConfig.mongoConfig.collectionName;
  }

  return runtimeConfig;
}

function removeUndefinedValues(input) {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => value !== undefined)
  );
}

function printConfigUsageInfo(loadedConfig, commandName) {
  if (!loadedConfig.exists) {
    return;
  }

  console.log(
    chalk.cyan(`\nUsing ${DEFAULT_CONFIG_FILENAME} for ${commandName}: ${loadedConfig.configPath}`)
  );
}

function printFieldAnalysis(analysis) {
  console.log(chalk.cyan('\nDetected SQL mapping:'));

  analysis.tables.forEach((table) => {
    console.log(chalk.green(`\nTable: ${table.tableName}`));

    table.columns.forEach((column) => {
      const qualifiers = [];

      if (column.isPrimaryKey) {
        qualifiers.push('PK');
      }

      if (column.isForeignKey) {
        qualifiers.push(`FK -> ${column.references}`);
      }

      if (column.note) {
        qualifiers.push(column.note);
      }

      const qualifierText = qualifiers.length > 0 ? ` [${qualifiers.join(', ')}]` : '';
      const optionality = column.nullable ? 'NULL' : 'NOT NULL';
      const presence = column.documentCount > 0
        ? ` (${column.presentCount}/${column.documentCount} docs)`
        : '';

      console.log(
        `- ${column.name}: ${column.inferredSqlType} ${optionality}${qualifierText}${presence}`
      );
    });
  });

  console.log(chalk.cyan('\nSuggested SQL:'));
  analysis.sqlStatements.forEach((statement) => {
    console.log(statement);
  });

  if (analysis.indexSuggestions.length > 0) {
    console.log(chalk.cyan('\nSuggested indexes:'));

    analysis.indexSuggestions.forEach((indexSuggestion) => {
      console.log(
        `- ${indexSuggestion.tableName}(${indexSuggestion.columnNames.join(', ')}): ${indexSuggestion.reason}`
      );
      console.log(indexSuggestion.sql);
    });
  }
}

function printValidationSummary(validationResult) {
  console.log(chalk.cyan('\nValidation summary:'));

  validationResult.tableComparisons.forEach((comparison) => {
    const status = comparison.matches ? chalk.green('MATCH') : chalk.red('MISMATCH');
    console.log(
      `- ${comparison.tableName}: expected ${comparison.expectedRows}, actual ${comparison.actualRows}, distinct fingerprints ${comparison.distinctFingerprints}, duplicates ${comparison.duplicateRows} -> ${status}`
    );
  });
}

function printValidationGuidance(validationResult) {
  const mismatches = validationResult.tableComparisons.filter((comparison) => !comparison.matches);

  if (mismatches.length === 0) {
    console.log(chalk.green('\nValidation result: source and target counts are aligned.'));
    console.log('A rerun is not required right now, but it remains safe if you need to resume later.');
    printRerunSafetyNote();
    return;
  }

  console.log(chalk.yellow('\nValidation result: rerun recommended.'));
  console.log('Some target tables are missing expected rows or have fingerprint inconsistencies.');
  printRerunSafetyNote();
  console.log(chalk.yellow('\nRecommended next step:'));
  console.log('Run the same migrate command again for the same collection and dataset window.');

  mismatches.forEach((comparison) => {
    const missingRows = comparison.expectedRows - comparison.actualRows;
    const duplicateRows = comparison.duplicateRows;

    if (missingRows > 0) {
      console.log(
        `- ${comparison.tableName}: ${missingRows} expected row(s) are still missing in PostgreSQL.`
      );
    }

    if (duplicateRows > 0) {
      console.log(
        `- ${comparison.tableName}: ${duplicateRows} duplicate row(s) were detected and should be investigated.`
      );
    }

    if (comparison.fingerprintCoverage < comparison.actualRows) {
      console.log(
        `- ${comparison.tableName}: ${comparison.actualRows - comparison.fingerprintCoverage} row(s) do not have migration fingerprints.`
      );
    }
  });
}

async function runAnalyzeCommand(options) {
  const spinner = ora('Connecting to MongoDB...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'analyze', { mongo: true });
    const config = runtimeConfig.mongoConfig;
    const limit = runtimeConfig.sampleLimit || config.sampleLimit;

    spinner.text = 'Fetching sample documents...';

    const result = await fetchSampleDocuments(config, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    spinner.succeed(
      `Fetched ${result.documents.length} sample document(s) from "${result.collectionName}".`
    );

    if (result.documents.length === 0) {
      console.log(chalk.yellow('The collection is empty.'));
      return;
    }

    console.log(chalk.cyan('\nSample data:'));
    console.log(JSON.stringify(result.documents, null, 2));

    const analysis = analyzeDocuments(result.documents, result.collectionName);
    printFieldAnalysis(analysis);
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'analyze');
  } catch (error) {
    spinner.fail('Unable to analyze MongoDB sample data.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    await closeMongoConnection();
  }
}

async function runPostgresCheckCommand(options) {
  const spinner = ora('Connecting to PostgreSQL...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'pg-check', { postgres: true });
    const postgresConfig = runtimeConfig.postgresConfig;
    await connectPostgres(postgresConfig);
    spinner.succeed('PostgreSQL connection successful.');
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'pg-check');
  } catch (error) {
    spinner.fail('Unable to connect to PostgreSQL.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    await closePostgresConnection();
  }
}

async function runMigrateCommand(options) {
  const spinner = ora('Preparing migration...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'migrate', {
      mongo: true,
      postgres: true,
    });
    const mongoConfig = runtimeConfig.mongoConfig;
    const postgresConfig = runtimeConfig.postgresConfig;
    const limit = runtimeConfig.limit;
    const batchSize = runtimeConfig.batchSize || 250;
    const maxRetries = runtimeConfig.retries || 3;

    spinner.text = 'Fetching MongoDB documents...';

    const result = await fetchDocuments(mongoConfig, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    if (result.documents.length === 0) {
      spinner.warn(`No documents found in "${result.collectionName}".`);
      return;
    }

    spinner.info(
      `Starting idempotent migration for "${result.collectionName}". Safe reruns are enabled through source fingerprints and PostgreSQL upserts.`
    );
    spinner.start('Migrating documents into PostgreSQL...');

    spinner.text = 'Migrating documents into PostgreSQL...';

    const migrationResult = await migrateDocuments({
      documents: result.documents,
      collectionName: result.collectionName,
      queryExecutor: (callback) => withPostgresTransaction(postgresConfig, callback, {
        isolationLevel: 'SERIALIZABLE',
      }),
      batchSize,
      maxRetries,
      onProgress: (progress) => {
        if (progress.phase === 'planning-complete') {
          spinner.text = `Planned ${progress.totalRows} row(s) across ${progress.tableCount} table(s)...`;
          return;
        }

        if (progress.phase === 'table-start') {
          spinner.text = `Migrating table "${progress.tableName}" (${progress.tableRowCount} row(s), ${progress.batchCount} batch(es))...`;
          return;
        }

        if (progress.phase === 'retry') {
          spinner.text = `Retrying ${progress.tableName} batch ${progress.batchNumber}/${progress.batchCount} (${progress.attempt}/${progress.maxRetries})...`;
          return;
        }

        if (progress.phase === 'batch-complete') {
          spinner.text = `Inserted ${progress.insertedRows}/${progress.totalRows} row(s) - ${progress.tableName} batch ${progress.batchNumber}/${progress.batchCount}`;
        }
      },
    });

    spinner.succeed(
      `Migrated ${migrationResult.insertedRowCount} row(s) across ${migrationResult.migratedTables} table(s) with batch size ${migrationResult.batchSize}.`
    );

    printFieldAnalysis(migrationResult.analysis);
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'migrate');

    if (runtimeConfig.validate) {
      const validationResult = await validateMigration({
        documents: result.documents,
        collectionName: result.collectionName,
        queryExecutor: (callback) => withPostgresTransaction(postgresConfig, callback, {
          isolationLevel: 'REPEATABLE READ',
          readOnly: true,
        }),
      });

      printValidationSummary(validationResult);
      printValidationGuidance(validationResult);

      if (!validationResult.matches) {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    spinner.fail('Migration failed.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    await closeMongoConnection();
    await closePostgresConnection();
  }
}

async function runValidateCommand(options) {
  const spinner = ora('Validating migrated data...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'validate', {
      mongo: true,
      postgres: true,
    });
    const mongoConfig = runtimeConfig.mongoConfig;
    const postgresConfig = runtimeConfig.postgresConfig;
    const limit = runtimeConfig.limit;

    const result = await fetchDocuments(mongoConfig, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    if (result.documents.length === 0) {
      spinner.warn(`No documents found in "${result.collectionName}".`);
      return;
    }

    const validationResult = await validateMigration({
      documents: result.documents,
      collectionName: result.collectionName,
      queryExecutor: (callback) => withPostgresTransaction(postgresConfig, callback, {
        isolationLevel: 'REPEATABLE READ',
        readOnly: true,
      }),
    });

    if (validationResult.matches) {
      spinner.succeed('Validation passed between MongoDB and PostgreSQL.');
    } else {
      spinner.fail('Validation found mismatches between MongoDB and PostgreSQL.');
      process.exitCode = 1;
    }

    printValidationSummary(validationResult);
    printValidationGuidance(validationResult);
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'validate');
  } catch (error) {
    spinner.fail('Validation failed.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    await closeMongoConnection();
    await closePostgresConnection();
  }
}

program
  .name('migratoryAI')
  .description('AI-powered DB migration tool')
  .version('1.0.0');

program
  .command('init')
  .description('Initialize migration project')
  .action(() => {
    console.log(chalk.green('MigratoryAI initialized!'));
  });

program
  .command('analyze')
  .description('Analyze MongoDB and print sample documents')
  .option('--config <path>', 'Path to migration config JSON file')
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of sample documents to fetch')
  .action(runAnalyzeCommand);

program
  .command('pg-check')
  .description('Test PostgreSQL connectivity')
  .option('--config <path>', 'Path to migration config JSON file')
  .action(runPostgresCheckCommand);

program
  .command('migrate')
  .description('Migrate MongoDB documents into PostgreSQL')
  .option('--config <path>', 'Path to migration config JSON file')
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of documents to migrate')
  .option('-b, --batch-size <number>', 'Number of rows to insert per batch')
  .option('-r, --retries <number>', 'Retry attempts for transient PostgreSQL batch failures')
  .option('--validate', 'Validate PostgreSQL row counts against the MongoDB source after migration')
  .action(runMigrateCommand);

program
  .command('validate')
  .description('Validate migrated PostgreSQL row counts against MongoDB source data')
  .option('--config <path>', 'Path to migration config JSON file')
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of MongoDB documents to validate')
  .action(runValidateCommand);

program.parse(process.argv);
