#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora').default;

const { getMongoConfig } = require('../config/env');
const { analyzeDocuments } = require('../core/analyzer');
const {
  fetchSampleDocuments,
  closeMongoConnection,
} = require('../db/mongoConnector');

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
      console.log(
        `- ${column.name}: ${column.inferredSqlType}${column.nullable ? ' NULL' : ' NOT NULL'}${qualifierText}`
      );
    });
  });

  console.log(chalk.cyan('\nSuggested SQL:'));
  analysis.sqlStatements.forEach((statement) => {
    console.log(statement);
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

program.parse(process.argv);
