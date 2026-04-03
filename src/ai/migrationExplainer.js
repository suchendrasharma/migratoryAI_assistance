function toSnakeCase(value) {
  return String(value)
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

function toSingular(value) {
  if (value.endsWith('ies')) {
    return `${value.slice(0, -3)}y`;
  }

  if (value.endsWith('ses')) {
    return value.slice(0, -2);
  }

  if (value.endsWith('s') && !value.endsWith('ss')) {
    return value.slice(0, -1);
  }

  return value;
}

function normalizeTableName(name) {
  return toSnakeCase(name || 'records') || 'records';
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date);
}

function collectInferenceSignals(documents, rootTableName) {
  const signals = {
    scalarFields: new Set(),
    flattenedObjects: new Map(),
    childTables: new Map(),
  };

  function visitDocument(document, tableName, pathSegments = []) {
    Object.entries(document).forEach(([key, value]) => {
      if (key === '_id') {
        return;
      }

      const currentPath = pathSegments.concat(key);

      if (Array.isArray(value)) {
        const nonNullItems = value.filter((item) => item !== null && item !== undefined);

        if (nonNullItems.some((item) => isPlainObject(item))) {
          const childTableName = currentPath.length <= 1
            ? normalizeTableName(key)
            : normalizeTableName(`${toSingular(tableName)}_${key}`);

          if (!signals.childTables.has(childTableName)) {
            signals.childTables.set(childTableName, {
              fieldPath: currentPath.join('.'),
              parentTableName: tableName,
              objectFields: new Set(),
              scalarValues: false,
            });
          }

          const childSignal = signals.childTables.get(childTableName);

          nonNullItems.forEach((item) => {
            if (isPlainObject(item)) {
              Object.keys(item)
                .filter((fieldName) => fieldName !== '_id')
                .forEach((fieldName) => {
                  childSignal.objectFields.add(fieldName);
                });
              visitDocument(item, childTableName, currentPath);
              return;
            }

            childSignal.scalarValues = true;
          });

          return;
        }

        if (pathSegments.length === 0) {
          signals.scalarFields.add(key);
        }

        return;
      }

      if (isPlainObject(value)) {
        signals.flattenedObjects.set(currentPath.join('.'), {
          tableName,
          path: currentPath.join('.'),
          columns: Object.keys(value).map((nestedKey) => `${currentPath.join('_')}_${nestedKey}`),
        });
        visitDocument(value, tableName, currentPath);
        return;
      }

      if (pathSegments.length === 0) {
        signals.scalarFields.add(key);
      }
    });
  }

  documents.forEach((document) => {
    visitDocument(document, rootTableName);
  });

  return signals;
}

function explainMigrationAnalysis(documents, analysis, collectionName) {
  const rootTableName = normalizeTableName(collectionName);
  const signals = collectInferenceSignals(documents, rootTableName);
  const lines = [];

  lines.push(
    `Using '${rootTableName}' as the root table because the analyzed MongoDB collection is '${collectionName}'.`
  );

  if (signals.scalarFields.size > 0) {
    lines.push(
      `Kept scalar fields ${Array.from(signals.scalarFields).map((field) => `'${field}'`).join(', ')} in '${rootTableName}' because they are direct values, not repeatable child records.`
    );
  }

  signals.flattenedObjects.forEach((signal) => {
    if (signal.columns.length === 0) {
      return;
    }

    lines.push(
      `Flattened embedded object '${signal.path}' into columns ${signal.columns.map((column) => `'${column}'`).join(', ')} because it is a nested object inside the same record, not an array of separate records.`
    );
  });

  analysis.tables
    .filter((table) => table.parentTableName)
    .forEach((table) => {
      const childSignal = signals.childTables.get(table.tableName);
      const foreignKeyColumn = table.columns.find((column) => column.isForeignKey);

      if (childSignal) {
        lines.push(
          `Detected '${childSignal.fieldPath}' as child table '${table.tableName}' because it is an array of objects and represents a one-to-many relationship from '${table.parentTableName}' to '${table.tableName}'.`
        );
      } else {
        lines.push(
          `Created child table '${table.tableName}' because the source data contains repeatable nested records under '${table.parentTableName}'.`
        );
      }

      if (foreignKeyColumn) {
        lines.push(
          `Created foreign key '${foreignKeyColumn.name}' to connect '${table.tableName}' back to '${table.parentTableName}.id' and preserve the parent-child relationship.`
        );
      }
    });

  analysis.indexSuggestions.forEach((indexSuggestion) => {
    if (indexSuggestion.columnNames.length === 1) {
      lines.push(
        `Suggested index on '${indexSuggestion.tableName}.${indexSuggestion.columnNames[0]}' because ${indexSuggestion.reason.toLowerCase()}.`
      );
      return;
    }

    lines.push(
      `Suggested index on '${indexSuggestion.tableName}(${indexSuggestion.columnNames.join(', ')})' because ${indexSuggestion.reason.toLowerCase()}.`
    );
  });

  return lines;
}

module.exports = {
  explainMigrationAnalysis,
};
