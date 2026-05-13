const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const chalk = require('chalk');
const ora = require('ora').default;

const {
  getMongoConfig,
  getPostgresConfig,
  getSourceAdapterType,
  getSourceConfig,
  getTargetAdapterType,
  mergePostgresConfig,
  mergeSourceConfig,
} = require('../config/env');
const {
  DEFAULT_CONFIG_FILENAME,
  loadMigrationConfig,
} = require('../config/fileConfig');
const { explainMigrationAnalysis } = require('../ai/migrationExplainer');
const { analyzeDocuments } = require('../core/analyzer');
const { ingestLogFile } = require('../core/logIngestor');
const { buildRowsFromDocuments, migrateDocuments } = require('../core/migrator');
const { saveDocuments, closeMongoConnection } = require('../db/mongoConnector');
const { validateMigration } = require('../core/validator');
const {
  getSourceAdapter,
  getTargetAdapter,
  listSourceAdapters,
  listTargetAdapters,
  normalizeSourceAdapterId,
} = require('../plugins/registry');

function printRerunSafetyNote() {
  console.log(chalk.cyan('\nRerun safety:'));
  console.log('- Rows are tracked with stable source fingerprints.');
  console.log('- Target adapter writes use upsert semantics on those fingerprints.');
  console.log('- Re-running the same migration fills missing rows without creating duplicate entries.');
}

function printDryRunPlan(analysis, rowBuckets) {
  const totalRows = Array.from(rowBuckets.values()).reduce((sum, rows) => sum + rows.length, 0);

  console.log(chalk.cyan('\nDry-run plan:'));
  console.log('- No PostgreSQL writes will be executed.');
  console.log(`- Planned relational tables: ${analysis.tables.length}`);
  console.log(`- Planned relational rows: ${totalRows}`);

  analysis.tables.forEach((table) => {
    const rowCount = (rowBuckets.get(table.tableName) || []).length;
    console.log(`- ${table.tableName}: ${rowCount} row(s) would be written`);
  });
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

  const entityName =
    options.entity ||
    options.collection ||
    configOptions.entityName ||
    configOptions.collectionName ||
    sourceConfig.entityName ||
    sourceConfig.collectionName;
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
  const dryRun = options.dryRun === true || configOptions.dryRun === true;
  const sourceType = normalizeSourceAdapterId(
    options.source || sourceConfig.type || getSourceAdapterType()
  );
  const targetType = targetConfig.type || getTargetAdapterType();
  const needsSource = Boolean(requirements.source || requirements.mongo);
  const needsTarget = requirements.target === true ||
    requirements.postgres === true ||
    ((requirements.target === 'if-not-dry-run' || requirements.postgres === 'if-not-dry-run') && !dryRun);
  const sourceAdapter = needsSource ? getSourceAdapter(sourceType) : null;
  const targetAdapter = needsTarget
    ? getTargetAdapter(targetType)
    : null;

  const sourceOverrides = {
    uri: sourceConfig.uri,
    dbName: sourceConfig.dbName,
    collectionName: entityName,
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
    sourceConfig: needsSource
      ? (config
        ? mergeSourceConfig(sourceType, removeUndefinedValues(sourceOverrides))
        : getSourceConfig(sourceType))
      : null,
    targetConfig: needsTarget
      ? (config
        ? mergePostgresConfig(removeUndefinedValues(postgresOverrides))
        : getPostgresConfig())
      : null,
    collectionName: entityName,
    entityName,
    limit,
    sampleLimit,
    batchSize,
    retries,
    validate,
    dryRun,
    loadedConfig,
    commandName,
    sourceType,
    targetType,
    sourceAdapter,
    targetAdapter,
  };

  runtimeConfig.mongoConfig = runtimeConfig.sourceConfig;
  runtimeConfig.postgresConfig = runtimeConfig.targetConfig;

  if (!config && runtimeConfig.sourceConfig) {
    runtimeConfig.sourceConfig.collectionName = entityName || runtimeConfig.sourceConfig.collectionName;
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

function printFieldAnalysis(analysis, targetAdapter = null) {
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

  const schemaStatements = targetAdapter && analysis.unifiedSchemaModel
    ? targetAdapter.renderSchemaStatements(analysis.unifiedSchemaModel)
    : analysis.sqlStatements;
  const indexSuggestions = targetAdapter && analysis.unifiedSchemaModel
    ? targetAdapter.renderIndexSuggestions(analysis.unifiedSchemaModel)
    : analysis.indexSuggestions;

  console.log(chalk.cyan('\nSuggested SQL:'));
  schemaStatements.forEach((statement) => {
    console.log(statement);
  });

  if (indexSuggestions.length > 0) {
    console.log(chalk.cyan('\nSuggested indexes:'));

    indexSuggestions.forEach((indexSuggestion) => {
      console.log(
        `- ${indexSuggestion.tableName}(${indexSuggestion.columnNames.join(', ')}): ${indexSuggestion.reason}`
      );
      console.log(indexSuggestion.sql);
    });
  }
}

function printExplainMode(explanations) {
  if (!explanations || explanations.length === 0) {
    return;
  }

  console.log(chalk.cyan('\nWhy this mapping:'));
  explanations.forEach((line) => {
    console.log(`- ${line}`);
  });
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
  let sourceAdapter = null;
  const spinner = ora('Connecting to source adapter...').start();

  try {
  const runtimeConfig = resolveRuntimeConfig(options, 'analyze', { source: true });
    sourceAdapter = runtimeConfig.sourceAdapter;
    const targetAdapter = getTargetAdapter(runtimeConfig.targetType);
    const config = runtimeConfig.sourceConfig;
    const limit = runtimeConfig.sampleLimit || config.sampleLimit;

    spinner.text = `Fetching sample records from ${runtimeConfig.sourceType}...`;

    const result = await sourceAdapter.fetchSampleRecords(config, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    spinner.succeed(
      `Fetched ${result.records.length} sample record(s) from "${result.sourceEntityName}".`
    );

    if (result.records.length === 0) {
      console.log(chalk.yellow('The source entity is empty.'));
      return;
    }

    console.log(chalk.cyan('\nSample data:'));
    console.log(JSON.stringify(result.records, null, 2));

    const analysis = analyzeDocuments(result.records, result.sourceEntityName, {
      sourceAdapter: runtimeConfig.sourceType,
      targetAdapter: runtimeConfig.targetType,
    });
    printFieldAnalysis(analysis, targetAdapter);
    if (options.explain) {
      printExplainMode(
        explainMigrationAnalysis(result.records, analysis, result.sourceEntityName)
      );
    }
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'analyze');
  } catch (error) {
    spinner.fail('Unable to analyze source sample data.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    if (sourceAdapter) {
      await sourceAdapter.close();
    }
  }
}

async function runPostgresCheckCommand(options) {
  let targetAdapter = null;
  const spinner = ora('Connecting to target adapter...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'target-check', { target: true });
    targetAdapter = runtimeConfig.targetAdapter;
    const targetConfig = runtimeConfig.targetConfig;
    await targetAdapter.checkConnection(targetConfig);
    spinner.succeed(`${runtimeConfig.targetType} connection successful.`);
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'target-check');
  } catch (error) {
    spinner.fail('Unable to connect to target adapter.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  } finally {
    if (targetAdapter) {
      await targetAdapter.close();
    }
  }
}

async function runMigrateCommand(options) {
  let sourceAdapter = null;
  let targetAdapter = null;
  const spinner = ora('Preparing migration...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'migrate', {
      source: true,
      target: 'if-not-dry-run',
    });
    sourceAdapter = runtimeConfig.sourceAdapter;
    targetAdapter = runtimeConfig.targetAdapter;
    const sourceConfig = runtimeConfig.sourceConfig;
    const targetConfig = runtimeConfig.targetConfig;
    const limit = runtimeConfig.limit;
    const batchSize = runtimeConfig.batchSize || 250;
    const maxRetries = runtimeConfig.retries || 3;
    const dryRun = runtimeConfig.dryRun;

    spinner.text = `Fetching records from ${runtimeConfig.sourceType}...`;

    const result = await sourceAdapter.fetchRecords(sourceConfig, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    if (result.records.length === 0) {
      spinner.warn(`No records found in "${result.sourceEntityName}".`);
      return;
    }

    if (dryRun) {
      const previewTargetAdapter = getTargetAdapter(runtimeConfig.targetType);
      const analysis = analyzeDocuments(result.records, result.sourceEntityName, {
        sourceAdapter: runtimeConfig.sourceType,
        targetAdapter: runtimeConfig.targetType,
      });
      const rowBuckets = buildRowsFromDocuments(result.records, analysis.unifiedSchemaModel);

      spinner.succeed(
        `Dry run complete for "${result.sourceEntityName}". SQL preview generated with no database writes.`
      );
      printFieldAnalysis(analysis, previewTargetAdapter);
      printDryRunPlan(analysis, rowBuckets);
      printConfigUsageInfo(runtimeConfig.loadedConfig, 'migrate');

      if (runtimeConfig.validate) {
        console.log(chalk.yellow('\nValidation skipped because --dry-run does not write data to PostgreSQL.'));
      }

      return;
    }

    spinner.info(
      `Starting idempotent migration for "${result.sourceEntityName}" using ${runtimeConfig.sourceType} -> ${runtimeConfig.targetType}. Safe reruns are enabled through source fingerprints and target upserts.`
    );
    spinner.start(`Migrating records into ${runtimeConfig.targetType}...`);

    spinner.text = `Migrating records into ${runtimeConfig.targetType}...`;

    const migrationResult = await migrateDocuments({
      documents: result.records,
      collectionName: result.sourceEntityName,
      sourceAdapterType: runtimeConfig.sourceType,
      targetAdapterType: runtimeConfig.targetType,
      queryExecutor: (callback) => targetAdapter.runInTransaction(targetConfig, callback, {
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

    printFieldAnalysis(migrationResult.analysis, targetAdapter);
    printConfigUsageInfo(runtimeConfig.loadedConfig, 'migrate');

    if (runtimeConfig.validate) {
      const validationResult = await validateMigration({
        documents: result.records,
        collectionName: result.sourceEntityName,
        sourceAdapterType: runtimeConfig.sourceType,
        targetAdapterType: runtimeConfig.targetType,
        queryExecutor: (callback) => targetAdapter.runInTransaction(targetConfig, callback, {
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
    if (sourceAdapter) {
      await sourceAdapter.close();
    }

    if (targetAdapter) {
      await targetAdapter.close();
    }
  }
}

async function runValidateCommand(options) {
  let sourceAdapter = null;
  let targetAdapter = null;
  const spinner = ora('Validating migrated data...').start();

  try {
    const runtimeConfig = resolveRuntimeConfig(options, 'validate', {
      source: true,
      target: true,
    });
    sourceAdapter = runtimeConfig.sourceAdapter;
    targetAdapter = runtimeConfig.targetAdapter;
    const sourceConfig = runtimeConfig.sourceConfig;
    const targetConfig = runtimeConfig.targetConfig;
    const limit = runtimeConfig.limit;

    const result = await sourceAdapter.fetchRecords(sourceConfig, {
      collectionName: runtimeConfig.collectionName,
      limit,
    });

    if (result.records.length === 0) {
      spinner.warn(`No records found in "${result.sourceEntityName}".`);
      return;
    }

    const validationResult = await validateMigration({
      documents: result.records,
      collectionName: result.sourceEntityName,
      sourceAdapterType: runtimeConfig.sourceType,
      targetAdapterType: runtimeConfig.targetType,
      queryExecutor: (callback) => targetAdapter.runInTransaction(targetConfig, callback, {
        isolationLevel: 'REPEATABLE READ',
        readOnly: true,
      }),
    });

    if (validationResult.matches) {
      spinner.succeed(`Validation passed between ${runtimeConfig.sourceType} and ${runtimeConfig.targetType}.`);
    } else {
      spinner.fail(`Validation found mismatches between ${runtimeConfig.sourceType} and ${runtimeConfig.targetType}.`);
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
    if (sourceAdapter) {
      await sourceAdapter.close();
    }

    if (targetAdapter) {
      await targetAdapter.close();
    }
  }
}

function resolveOutputFilePath(outputValue) {
  if (!outputValue) {
    return null;
  }

  const hasExtension = path.extname(outputValue) !== '';
  const normalizedOutput = hasExtension ? outputValue : `${outputValue}.json`;

  return path.resolve(process.cwd(), normalizedOutput);
}

function resolveIngestOutput({ output, outputFile, inputFile }) {
  const allowedTargets = new Set(['json', 'postgres', 'mongo']);
  const requestedOutput = output || 'json';

  if (!allowedTargets.has(requestedOutput)) {
    return {
      target: 'json',
      filePath: resolveOutputFilePath(requestedOutput),
    };
  }

  if (requestedOutput === 'json') {
    const fallbackFileName = `${path.basename(inputFile, path.extname(inputFile))}-parsed.json`;

    return {
      target: 'json',
      filePath: resolveOutputFilePath(outputFile || fallbackFileName),
    };
  }

  return {
    target: requestedOutput,
    filePath: null,
  };
}

function writeJsonOutputFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function runIngestCommand(filePath, outputFile, options = {}) {
  const spinner = ora(`Reading log file "${filePath}"...`).start();
  const usingLlm = Boolean(options.llmFallback);

  try {
    const result = await ingestLogFile(filePath, {
      collection: options.collection,
      llmFallback: usingLlm,
      onProgress: (progress) => {
        if (progress.phase === 'parse-success') {
          spinner.text = `Ingest: recognized ${progress.parsedCount} structured log line(s)...`;
          return;
        }

        if (progress.phase === 'parse-failed') {
          spinner.text = 'Ingest: preserving an ambiguous line for review...';
          return;
        }

        if (progress.phase === 'llm-retry') {
          spinner.text = 'Ingest: retrying an ambiguous line with Claude...';
        }
      },
    });

    spinner.text = 'Ingest: finalizing parsed output...';
    await wait(1000);

    const output = resolveIngestOutput({
      output: options.output,
      outputFile,
      inputFile: filePath,
    });

    if (output.target === 'json') {
      writeJsonOutputFile(output.filePath, result);
    }

    if (output.target === 'postgres') {
      spinner.text = 'Migrating parsed log documents into PostgreSQL...';
      const targetAdapter = getTargetAdapter('postgres');
      const postgresConfig = getPostgresConfig();
      try {
        await migrateDocuments({
          documents: result.documents,
          collectionName: result.collection,
          sourceAdapterType: 'logfile',
          targetAdapterType: 'postgres',
          queryExecutor: (callback) => targetAdapter.runInTransaction(postgresConfig, callback, {
            isolationLevel: 'SERIALIZABLE',
          }),
        });
      } finally {
        await targetAdapter.close();
      }
    }

    if (output.target === 'mongo') {
      spinner.text = 'Saving parsed log documents into MongoDB...';
      const mongoConfig = getMongoConfig();
      try {
        await saveDocuments(mongoConfig, result.documents, {
          collectionName: result.collection,
        });
      } finally {
        await closeMongoConnection();
      }
    }

    spinner.succeed(
      `Parsed ${result.documents.length} log line(s), ${result.unparsed.length} unparsed, coverage ${result.coverage}%.`
    );
    console.log(chalk.cyan('Ingest summary:'));
    console.log('- Regex parser extracted structured log records first.');
    if (usingLlm) {
      console.log('- Claude was used as fallback for ambiguous lines.');
    } else if (result.unparsed.length > 0) {
      console.log(`- ${result.unparsed.length} ambiguous line(s) skipped. Re-run with --llm-fallback to parse them with Claude.`);
    }

    if (output.target === 'json') {
      console.log(chalk.cyan(`Output saved to ${output.filePath}`));
    }

    if (output.target === 'postgres') {
      console.log(chalk.cyan(`Parsed log documents migrated to PostgreSQL collection/table "${result.collection}".`));
    }

    if (output.target === 'mongo') {
      console.log(chalk.cyan(`Parsed log documents saved to MongoDB collection "${result.collection}".`));
    }
  } catch (error) {
    spinner.fail('Unable to ingest log file.');
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  }
}

function createProgram() {
  const program = new Command();

  program
    .name('migratoryai')
    .description('AI-powered NoSQL to SQL migration CLI')
    .version('1.0.0');

  program
    .command('init')
    .description('Initialize migration project')
    .action(() => {
      console.log(chalk.green('MigratoryAI initialized!'));
    });

  program
    .command('ingest')
    .description('Ingest a local log file and parse it into JSON documents')
    .argument('<file>', 'Path to logs.txt file')
    .argument('[outputFile]', 'JSON output file path when --output=json')
    .option('--collection <name>', 'Output collection name', 'logs')
    .option('-o, --output <target>', 'Output target: json, postgres, mongo, or a JSON file path', 'json')
    .option('--llm-fallback', 'Use Claude as fallback parser for lines the regex cannot parse')
    .action(runIngestCommand);

  program
    .command('analyze')
    .description(`Analyze source records and infer a relational model. Source adapters: ${listSourceAdapters().join(', ')}`)
    .option('--config <path>', 'Path to migration config JSON file')
    .option('--source <adapter>', 'Override source adapter from config/env (mongodb, mongo, couchdb, couch)')
    .option('-e, --entity <name>', 'Source entity name')
    .option('-c, --collection <name>', 'Alias for --entity')
    .option('-l, --limit <number>', 'Number of sample records to fetch')
    .option('--explain', 'Explain why the relational mapping was inferred this way')
    .action(runAnalyzeCommand);

  program
    .command('target-check')
    .alias('pg-check')
    .description(`Test target connectivity. Target adapters: ${listTargetAdapters().join(', ')}`)
    .option('--config <path>', 'Path to migration config JSON file')
    .action(runPostgresCheckCommand);

  program
    .command('migrate')
    .description(`Migrate source records into the target adapter. Source: ${listSourceAdapters().join(', ')} | Target: ${listTargetAdapters().join(', ')}`)
    .option('--config <path>', 'Path to migration config JSON file')
    .option('--source <adapter>', 'Override source adapter from config/env (mongodb, mongo, couchdb, couch)')
    .option('-e, --entity <name>', 'Source entity name')
    .option('-c, --collection <name>', 'Alias for --entity')
    .option('-l, --limit <number>', 'Number of source records to migrate')
    .option('-b, --batch-size <number>', 'Number of rows to insert per batch')
    .option('-r, --retries <number>', 'Retry attempts for transient target batch failures')
    .option('--dry-run', 'Preview target DDL and planned row counts without writing data')
    .option('--validate', 'Validate target row counts against the source after migration')
    .action(runMigrateCommand);

  program
    .command('validate')
    .description('Validate migrated target row counts against source data')
    .option('--config <path>', 'Path to migration config JSON file')
    .option('--source <adapter>', 'Override source adapter from config/env (mongodb, mongo, couchdb, couch)')
    .option('-e, --entity <name>', 'Source entity name')
    .option('-c, --collection <name>', 'Alias for --entity')
    .option('-l, --limit <number>', 'Number of source records to validate')
    .action(runValidateCommand);

  return program;
}

async function runCli(argv = process.argv) {
  const program = createProgram();
  await program.parseAsync(argv);
  return program;
}

module.exports = {
  createProgram,
  runCli,
  runAnalyzeCommand,
  runPostgresCheckCommand,
  runMigrateCommand,
  runIngestCommand,
  runValidateCommand,
};

if (require.main === module) {
  runCli().catch((error) => {
    console.error(chalk.red(error.message));
    process.exitCode = 1;
  });
}
