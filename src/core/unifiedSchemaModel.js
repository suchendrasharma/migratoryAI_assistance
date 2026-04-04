const MODEL_VERSION = '1.0';

function createUnifiedColumn({
  name,
  logicalType = 'string',
  nullable = true,
  role = 'field',
  references = null,
  sourcePath = null,
  sampleValues = [],
  metadata = {},
}) {
  return {
    name,
    logicalType,
    nullable,
    role,
    references,
    sourcePath,
    sampleValues,
    metadata,
  };
}

function createUnifiedRelationship({
  fromEntity,
  fromField,
  toEntity,
  toField,
  relationType = 'many-to-one',
  onDelete = 'cascade',
}) {
  return {
    fromEntity,
    fromField,
    toEntity,
    toField,
    relationType,
    onDelete,
  };
}

function createUnifiedEntity({
  name,
  parentEntity = null,
  fields = [],
  relationships = [],
  sourceRecordCount = 0,
  metadata = {},
}) {
  return {
    name,
    parentEntity,
    fields,
    relationships,
    sourceRecordCount,
    metadata,
  };
}

function createUnifiedSchemaModel({
  sourceAdapter,
  targetAdapter,
  rootEntity,
  entities = [],
  indexes = [],
  statements = [],
  metadata = {},
}) {
  return {
    version: MODEL_VERSION,
    sourceAdapter,
    targetAdapter,
    rootEntity,
    entities,
    indexes,
    statements,
    metadata,
  };
}

function mapSqlTypeToLogicalType(sqlType) {
  const normalizedType = String(sqlType || '').toUpperCase();

  if (normalizedType.includes('INT')) {
    return 'integer';
  }

  if (normalizedType.includes('DECIMAL') || normalizedType.includes('NUMERIC')) {
    return 'decimal';
  }

  if (normalizedType.includes('FLOAT') || normalizedType.includes('DOUBLE')) {
    return 'float';
  }

  if (normalizedType.includes('BOOL')) {
    return 'boolean';
  }

  if (normalizedType.includes('TIME') || normalizedType.includes('DATE')) {
    return 'datetime';
  }

  return 'string';
}

function buildUnifiedSchemaModelFromAnalysis(
  analysis,
  sourceAdapter = 'mongodb',
  targetAdapter = 'postgres'
) {
  const entities = analysis.tables.map((table) => {
    const fields = table.columns.map((column) => {
      const role = column.isPrimaryKey
        ? 'primary-key'
        : column.isForeignKey
          ? 'foreign-key'
          : 'field';

      return createUnifiedColumn({
        name: column.name,
        logicalType: mapSqlTypeToLogicalType(column.inferredSqlType),
        nullable: column.nullable,
        role,
        references: column.references,
        sourcePath: column.sourcePath,
        sampleValues: column.sampleValues || [],
        metadata: {
          sqlType: column.inferredSqlType,
          detectedKinds: column.detectedKinds || [],
          presentCount: column.presentCount,
          documentCount: column.documentCount,
          note: column.note || null,
        },
      });
    });

    const relationships = (table.relationships || []).map((relationship) => (
      createUnifiedRelationship({
        fromEntity: relationship.fromTable,
        fromField: relationship.fromColumn,
        toEntity: relationship.toTable,
        toField: relationship.toColumn,
      })
    ));

    return createUnifiedEntity({
      name: table.tableName,
      parentEntity: table.parentTableName,
      fields,
      relationships,
      sourceRecordCount: table.documentCount,
      metadata: {
        physicalName: table.tableName,
      },
    });
  });

  return createUnifiedSchemaModel({
    sourceAdapter,
    targetAdapter,
    rootEntity: analysis.rootTableName,
    entities,
    indexes: analysis.indexSuggestions || [],
    statements: analysis.sqlStatements || [],
    metadata: {
      generatedAt: new Date().toISOString(),
    },
  });
}

function assertValidUnifiedSchemaModel(model) {
  if (!model || typeof model !== 'object' || Array.isArray(model)) {
    throw new Error('Unified schema model must be an object.');
  }

  if (!model.rootEntity || typeof model.rootEntity !== 'string') {
    throw new Error('Unified schema model requires a rootEntity string.');
  }

  if (!Array.isArray(model.entities)) {
    throw new Error('Unified schema model requires an entities array.');
  }

  model.entities.forEach((entity) => {
    if (!entity.name || typeof entity.name !== 'string') {
      throw new Error('Every unified entity must have a name.');
    }

    if (!Array.isArray(entity.fields)) {
      throw new Error(`Unified entity "${entity.name}" must have a fields array.`);
    }
  });

  return model;
}

module.exports = {
  MODEL_VERSION,
  assertValidUnifiedSchemaModel,
  buildUnifiedSchemaModelFromAnalysis,
  createUnifiedColumn,
  createUnifiedEntity,
  createUnifiedRelationship,
  createUnifiedSchemaModel,
  mapSqlTypeToLogicalType,
};
