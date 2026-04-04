const { mongoDbSourceAdapter } = require('./source/mongodbAdapter');
const { couchDbSourceAdapter } = require('./source/couchdbAdapter');
const { postgresTargetAdapter } = require('./target/postgresAdapter');

const sourceAdapters = new Map();
const targetAdapters = new Map();
const sourceAdapterAliases = new Map([
  ['mongo', 'mongodb'],
  ['couch', 'couchdb'],
]);

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
  const normalizedAdapterId = normalizeSourceAdapterId(adapterId);
  const adapter = sourceAdapters.get(normalizedAdapterId);

  if (!adapter) {
    throw new Error(`Unsupported source adapter "${adapterId}".`);
  }

  return adapter;
}

function normalizeSourceAdapterId(adapterId = 'mongodb') {
  return sourceAdapterAliases.get(adapterId) || adapterId;
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
registerSourceAdapter(couchDbSourceAdapter);
registerTargetAdapter(postgresTargetAdapter);

module.exports = {
  getSourceAdapter,
  getTargetAdapter,
  listSourceAdapters,
  listTargetAdapters,
  normalizeSourceAdapterId,
  registerSourceAdapter,
  registerTargetAdapter,
};
