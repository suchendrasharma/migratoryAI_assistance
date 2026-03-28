#!/usr/bin/env node

const { Command } = require('commander');
const chalk = require('chalk');
const ora = require('ora').default;

const { getMongoConfig } = require('../config/env');
const {
  fetchSampleDocuments,
  closeMongoConnection,
} = require('../db/mongoConnector');

const program = new Command();

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
