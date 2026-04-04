function normalizeBaseUrl(uri) {
  return String(uri || '').replace(/\/+$/, '');
}

function resolveDatabaseName(config = {}, options = {}) {
  const databaseName = options.collectionName || config.collectionName || config.dbName;

  if (!databaseName) {
    throw new Error('Missing CouchDB database name. Set source.dbName or pass --entity.');
  }

  return databaseName;
}

function buildAllDocsUrl(config, databaseName, limit) {
  if (!config.uri) {
    throw new Error('Missing CouchDB connection URI. Set COUCHDB_URI or source.uri.');
  }

  const url = new URL(
    `${normalizeBaseUrl(config.uri)}/${encodeURIComponent(databaseName)}/_all_docs`
  );

  url.searchParams.set('include_docs', 'true');

  if (limit) {
    url.searchParams.set('limit', String(limit));
  }

  return url;
}

async function fetchCouchDocuments(config, options = {}) {
  const databaseName = resolveDatabaseName(config, options);
  const url = buildAllDocsUrl(config, databaseName, options.limit);
  const response = await fetch(url);

  if (!response.ok) {
    const details = await response.text();
    throw new Error(
      `Unable to fetch CouchDB records from "${databaseName}". HTTP ${response.status}: ${details}`
    );
  }

  const payload = await response.json();
  const documents = Array.isArray(payload.rows)
    ? payload.rows
      .map((row) => row.doc)
      .filter((doc) => doc && !String(doc._id || '').startsWith('_design/'))
    : [];

  return {
    collectionName: databaseName,
    documents,
  };
}

async function fetchSampleCouchDocuments(config, options = {}) {
  return fetchCouchDocuments(config, {
    ...options,
    limit: options.limit || config.sampleLimit,
  });
}

async function closeCouchConnection() {
  return undefined;
}

module.exports = {
  closeCouchConnection,
  fetchCouchDocuments,
  fetchSampleCouchDocuments,
};
