#!/usr/bin/env node

const chalk = require('chalk');
const { runCli } = require('../src/cli');

runCli().catch((error) => {
  console.error(chalk.red(error.message));
  process.exitCode = 1;
});
