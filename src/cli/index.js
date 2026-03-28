#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora').default;

const { getMongoConfig, getPostgresConfig } = require('../config/env');
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
      `- ${comparison.tableName}: expected ${comparison.expectedRows}, actual ${comparison.actualRows} -> ${status}`
    );
  });
}

async function runAnalyzeCommand(options) {
  const spinner = ora('Connecting to MongoDB...').start();

  try {
    const config = getMongoConfig();
    const limit = options.limit ? Number.parseInt(options.limit, 10) : config.sampleLimit;

    if (Number.isNaN(limit) || limit <= 0) {
      throw new Error('The --limit option must be a positive integer.');
    }

    spinner.text = 'Fetching sample documents...';

    const result = await fetchSampleDocuments(config, {
      collectionName: options.collection,
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
  } catch (error) {
    spinner.fail('Unable to analyze MongoDB sample data.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    await closeMongoConnection();
  }
}

async function runPostgresCheckCommand() {
  const spinner = ora('Connecting to PostgreSQL...').start();

  try {
    const postgresConfig = getPostgresConfig();
    await connectPostgres(postgresConfig);
    spinner.succeed('PostgreSQL connection successful.');
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
    const mongoConfig = getMongoConfig();
    const postgresConfig = getPostgresConfig();
    const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;
    const batchSize = options.batchSize ? Number.parseInt(options.batchSize, 10) : 250;
    const maxRetries = options.retries ? Number.parseInt(options.retries, 10) : 3;

    if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
      throw new Error('The --limit option must be a positive integer.');
    }

    if (Number.isNaN(batchSize) || batchSize <= 0) {
      throw new Error('The --batch-size option must be a positive integer.');
    }

    if (Number.isNaN(maxRetries) || maxRetries <= 0) {
      throw new Error('The --retries option must be a positive integer.');
    }

    spinner.text = 'Fetching MongoDB documents...';

    const result = await fetchDocuments(mongoConfig, {
      collectionName: options.collection,
      limit,
    });

    if (result.documents.length === 0) {
      spinner.warn(`No documents found in "${result.collectionName}".`);
      return;
    }

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

    if (options.validate) {
      const validationResult = await validateMigration({
        documents: result.documents,
        collectionName: result.collectionName,
        queryExecutor: (callback) => withPostgresTransaction(postgresConfig, callback, {
          isolationLevel: 'REPEATABLE READ',
          readOnly: true,
        }),
      });

      printValidationSummary(validationResult);

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
    const mongoConfig = getMongoConfig();
    const postgresConfig = getPostgresConfig();
    const limit = options.limit ? Number.parseInt(options.limit, 10) : undefined;

    if (limit !== undefined && (Number.isNaN(limit) || limit <= 0)) {
      throw new Error('The --limit option must be a positive integer.');
    }

    const result = await fetchDocuments(mongoConfig, {
      collectionName: options.collection,
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
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of sample documents to fetch')
  .action(runAnalyzeCommand);

program
  .command('pg-check')
  .description('Test PostgreSQL connectivity')
  .action(runPostgresCheckCommand);

program
  .command('migrate')
  .description('Migrate MongoDB documents into PostgreSQL')
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of documents to migrate')
  .option('-b, --batch-size <number>', 'Number of rows to insert per batch')
  .option('-r, --retries <number>', 'Retry attempts for transient PostgreSQL batch failures')
  .option('--validate', 'Validate PostgreSQL row counts against the MongoDB source after migration')
  .action(runMigrateCommand);

program
  .command('validate')
  .description('Validate migrated PostgreSQL row counts against MongoDB source data')
  .option('-c, --collection <name>', 'MongoDB collection name')
  .option('-l, --limit <number>', 'Number of MongoDB documents to validate')
  .action(runValidateCommand);

program.parse(process.argv);
