module.exports = {
  cli: require('./src/cli'),
  analyzer: require('./src/core/analyzer'),
  logParserLLM: require('./src/ai/logParserLLM'),
  logIngestor: require('./src/core/logIngestor'),
  migrator: require('./src/core/migrator'),
  plugins: require('./src/plugins/registry'),
  schemaModel: require('./src/core/unifiedSchemaModel'),
  validator: require('./src/core/validator'),
  mongoConnector: require('./src/db/mongoConnector'),
  pgConnector: require('./src/db/pgConnector'),
};
