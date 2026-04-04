module.exports = {
  cli: require('./src/cli'),
  analyzer: require('./src/core/analyzer'),
  migrator: require('./src/core/migrator'),
  plugins: require('./src/plugins/registry'),
  schemaModel: require('./src/core/unifiedSchemaModel'),
  validator: require('./src/core/validator'),
  mongoConnector: require('./src/db/mongoConnector'),
  pgConnector: require('./src/db/pgConnector'),
};
