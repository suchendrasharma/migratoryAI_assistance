const { mongoDbSourceAdapter } = require('./source/mongodbAdapter');
const { postgresTargetAdapter } = require('./target/postgresAdapter');

const sourceAdapters = new Map();
const targetAdapters = new Map();

function registerSourceAdapter(adapter) {
  if (!adapter || !adapter.id || adapter.kind !== 'source') {
    throw new Error('Source adapter must include id and kind="source".');
  }

  sourceAdapters.set(adapter.id, adapter);
}

function registerTargetAdapter(adapter) {
  if (!adapter || !adapter.id || adapter.kind !== 'target') {
    throw new Error('Target adapter must include id and kind="target".');
  }

  targetAdapters.set(adapter.id, adapter);
}

function getSourceAdapter(adapterId = 'mongodb') {
  const adapter = sourceAdapters.get(adapterId);

  if (!adapter) {
    throw new Error(`Unsupported source adapter "${adapterId}".`);
  }

  return adapter;
}

function getTargetAdapter(adapterId = 'postgres') {
  const adapter = targetAdapters.get(adapterId);

  if (!adapter) {
    throw new Error(`Unsupported target adapter "${adapterId}".`);
  }

  return adapter;
}

function listSourceAdapters() {
  return Array.from(sourceAdapters.keys());
}

function listTargetAdapters() {
  return Array.from(targetAdapters.keys());
}

registerSourceAdapter(mongoDbSourceAdapter);
registerTargetAdapter(postgresTargetAdapter);

module.exports = {
  getSourceAdapter,
  getTargetAdapter,
  listSourceAdapters,
  listTargetAdapters,
  registerSourceAdapter,
  registerTargetAdapter,
};
