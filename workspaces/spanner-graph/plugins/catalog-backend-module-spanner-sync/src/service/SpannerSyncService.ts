/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
import { LoggerService } from '@backstage/backend-plugin-api';
import { Entity } from '@backstage/catalog-model';
import { Config } from '@backstage/config';
import { Spanner } from '@google-cloud/spanner';
import { v4 as uuidv4 } from 'uuid';
import {
  SpannerEntityRow,
  SpannerRelationRow,
  SpannerSyncConfig,
  SyncSummary,
} from '../types';
import {
  transformEntityRelationsToSpannerEdges,
  transformEntityToSpannerNode,
} from './transformer';

/**
 * DDL statements required for the Backstage Cloud Spanner Graph schema.
 *
 * @public
 */
export const SPANNER_GRAPH_DDL_STATEMENTS: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS entities (
    entity_id STRING(MAX) NOT NULL,
    entity_ref STRING(MAX) NOT NULL,
    api_version STRING(128) NOT NULL,
    kind STRING(64) NOT NULL,
    namespace STRING(128) NOT NULL,
    name STRING(256) NOT NULL,
    title STRING(MAX),
    description STRING(MAX),
    lifecycle STRING(64),
    owner_ref STRING(MAX),
    system_ref STRING(MAX),
    metadata_json JSON,
    spec_json JSON,
    etag STRING(128),
    description_embedding ARRAY<FLOAT32>(vector_length=>768),
    updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
    sync_run_id STRING(64) NOT NULL
  ) PRIMARY KEY(entity_id)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_ref ON entities(entity_ref)`,
  `CREATE INDEX IF NOT EXISTS idx_entities_kind_ns ON entities(kind, namespace)`,
  `CREATE TABLE IF NOT EXISTS relations (
    entity_id STRING(MAX) NOT NULL,
    target_entity_ref STRING(MAX) NOT NULL,
    relation_type STRING(128) NOT NULL,
    source_entity_ref STRING(MAX) NOT NULL,
    updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
    sync_run_id STRING(64) NOT NULL
  ) PRIMARY KEY(entity_id, relation_type, target_entity_ref),
    INTERLEAVE IN PARENT entities ON DELETE CASCADE`,
  `CREATE INDEX IF NOT EXISTS relations_by_target ON relations(target_entity_ref, relation_type) STORING (source_entity_ref)`,
  `CREATE OR REPLACE PROPERTY GRAPH BackstageCatalogGraph
    NODE TABLES (
      entities
        KEY (entity_id)
        LABEL Entity
        PROPERTIES (
          entity_id,
          entity_ref,
          kind,
          namespace,
          name,
          title,
          description,
          lifecycle,
          owner_ref,
          system_ref
        )
    )
    EDGE TABLES (
      relations
        KEY (entity_id, relation_type, target_entity_ref)
        SOURCE KEY (entity_id) REFERENCES entities (entity_id)
        DESTINATION KEY (target_entity_ref) REFERENCES entities (entity_ref)
        LABEL Relation
        PROPERTIES (
          relation_type,
          source_entity_ref,
          target_entity_ref
        )
    )`,
];

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Checks whether a Spanner DDL error indicates an object already exists. */
function isAlreadyExistsError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const maybeGrpc = error as { code?: number; message?: string };
  if (maybeGrpc.code === 6) {
    return true;
  }
  return (
    typeof maybeGrpc.message === 'string' &&
    /already exists|duplicate name/i.test(maybeGrpc.message)
  );
}

/** Extracts a plain JSON object from a Spanner row or mock row. */
function rowToPlainObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') {
    return {};
  }
  const maybeJson = row as { toJSON?: () => Record<string, unknown> };
  if (typeof maybeJson.toJSON === 'function') {
    return maybeJson.toJSON();
  }
  return row as Record<string, unknown>;
}

/** Minimal interface for the Spanner database operations used by SpannerSyncService. */
interface SpannerDatabaseHandle {
  updateSchema?: (
    statements: readonly string[],
  ) => Promise<Array<{ promise?: () => Promise<unknown> }>>;
  table: (tableName: string) => {
    upsert: (rows: unknown[]) => Promise<unknown>;
  };
  run?: (query: {
    sql: string;
    params?: Record<string, unknown>;
  }) => Promise<[unknown[], ...unknown[]]>;
  runTransactionAsync: <T>(
    callback: (transaction: {
      runUpdate: (query: {
        sql: string;
        params?: Record<string, unknown>;
      }) => Promise<[number, ...unknown[]]>;
      update?: (table: string, rows: unknown[]) => void;
      commit: () => Promise<unknown>;
    }) => Promise<T>,
  ) => Promise<T>;
}

/**
 * Synchronizes Backstage Catalog entities and relationships into Google Cloud Spanner Graph.
 *
 * @public
 */
export class SpannerSyncService {
  private readonly database: SpannerDatabaseHandle;

  /**
   * Builds a `SpannerSyncService` instance from the Backstage root configuration.
   */
  static fromConfig(
    config: Config,
    logger: LoggerService,
    databaseOverride?: unknown,
  ): SpannerSyncService {
    const syncConfig = config.getConfig('catalog.spannerSync');
    const parsedConfig: SpannerSyncConfig = {
      enabled: syncConfig.getOptionalBoolean('enabled') ?? true,
      projectId: syncConfig.getOptionalString('projectId'),
      instanceId: syncConfig.getString('instanceId'),
      databaseId: syncConfig.getString('databaseId'),
      autoCreateSchema:
        syncConfig.getOptionalBoolean('autoCreateSchema') ?? true,
      enableEmbeddings:
        syncConfig.getOptionalBoolean('enableEmbeddings') ?? false,
      embeddingModel:
        syncConfig.getOptionalString('embeddingModel') ?? 'TextEmbeddingModel',
      batchSize: syncConfig.getOptionalNumber('batchSize') ?? 500,
      scheduleFrequency:
        syncConfig.getOptionalString('schedule.frequency') ?? 'PT2M',
      scheduleTimeout:
        syncConfig.getOptionalString('schedule.timeout') ?? 'PT10M',
    };

    return new SpannerSyncService(parsedConfig, logger, databaseOverride);
  }

  constructor(
    public readonly config: SpannerSyncConfig,
    private readonly logger: LoggerService,
    databaseOverride?: unknown,
  ) {
    if (databaseOverride) {
      this.database = databaseOverride as SpannerDatabaseHandle;
      return;
    }

    // Pass undefined when projectId is omitted so ADC auto-detects the active GCP project.
    const spanner = new Spanner(
      config.projectId ? { projectId: config.projectId } : undefined,
    );
    const instance = spanner.instance(config.instanceId);
    this.database = instance.database(
      config.databaseId,
    ) as unknown as SpannerDatabaseHandle;
  }

  /**
   * Ensures the Spanner `entities`, interleaved `relations`, indexes, and `BackstageCatalogGraph`
   * property graph exist when `autoCreateSchema` is enabled (the default).
   */
  async ensureSchema(): Promise<boolean> {
    if (this.config.autoCreateSchema === false) {
      this.logger.info(
        'Skipping Cloud Spanner Graph schema auto-provisioning (autoCreateSchema=false).',
      );
      return false;
    }

    if (!this.database.updateSchema) {
      return false;
    }

    try {
      const [operation] = await this.database.updateSchema(
        SPANNER_GRAPH_DDL_STATEMENTS,
      );
      if (operation?.promise) {
        await operation.promise();
      }
      this.logger.info(
        'Verified Cloud Spanner Graph DDL schema and BackstageCatalogGraph property graph.',
      );
      return true;
    } catch (error) {
      if (isAlreadyExistsError(error)) {
        this.logger.info(
          'Cloud Spanner Graph DDL objects already exist; continuing startup.',
        );
        return true;
      }
      throw error;
    }
  }

  /**
   * Executes a full catalog synchronization cycle: batching node/edge upserts, reconciling stale entities,
   * and optionally generating Vertex AI embeddings in-database.
   */
  async runSync(entities: Entity[] = []): Promise<SyncSummary> {
    const startTime = Date.now();
    const syncRunId = uuidv4();
    const nowIso = new Date().toISOString();
    const batchSize = Math.max(1, this.config.batchSize ?? 500);

    let entitiesSynced = 0;
    let relationsSynced = 0;

    for (let offset = 0; offset < entities.length; offset += batchSize) {
      const chunk = entities.slice(offset, offset + batchSize);
      const batchResult = await this.syncBatch(chunk, syncRunId, nowIso);
      entitiesSynced += batchResult.entitiesSynced;
      relationsSynced += batchResult.relationsSynced;
    }

    const staleEntitiesDeleted = await this.reconcileStaleEntities(syncRunId);
    const embeddingsGenerated = this.config.enableEmbeddings
      ? await this.generateEmbeddingsInDatabase()
      : 0;

    const summary: SyncSummary = {
      syncRunId,
      entitiesSynced,
      relationsSynced,
      staleEntitiesDeleted,
      embeddingsGenerated,
      durationMs: Date.now() - startTime,
    };

    this.logger.info('Completed Cloud Spanner Graph catalog synchronization.', {
      syncRunId: summary.syncRunId,
      entitiesSynced: summary.entitiesSynced,
      relationsSynced: summary.relationsSynced,
      staleEntitiesDeleted: summary.staleEntitiesDeleted,
      embeddingsGenerated: summary.embeddingsGenerated,
      durationMs: summary.durationMs,
    });

    return summary;
  }

  /**
   * Transforms and upserts a single batch of catalog entities and their outgoing relations into Spanner.
   */
  async syncBatch(
    entities: Entity[],
    syncRunId: string,
    nowIso: string = new Date().toISOString(),
  ): Promise<{ entitiesSynced: number; relationsSynced: number }> {
    if (entities.length === 0) {
      return { entitiesSynced: 0, relationsSynced: 0 };
    }

    const nodeRows: SpannerEntityRow[] = [];
    const edgeRows: SpannerRelationRow[] = [];

    for (const entity of entities) {
      nodeRows.push(transformEntityToSpannerNode(entity, syncRunId, nowIso));
      edgeRows.push(
        ...transformEntityRelationsToSpannerEdges(entity, syncRunId, nowIso),
      );
    }

    await this.database.table('entities').upsert(nodeRows);
    if (edgeRows.length > 0) {
      await this.database.table('relations').upsert(edgeRows);
    }

    return {
      entitiesSynced: nodeRows.length,
      relationsSynced: edgeRows.length,
    };
  }

  /**
   * Deletes relations and entities that were not touched during the active `syncRunId`.
   */
  async reconcileStaleEntities(activeSyncRunId: string): Promise<number> {
    return this.database.runTransactionAsync(async transaction => {
      await transaction.runUpdate({
        sql: 'DELETE FROM relations WHERE sync_run_id != @syncRunId',
        params: { syncRunId: activeSyncRunId },
      });
      const [deletedEntities] = await transaction.runUpdate({
        sql: 'DELETE FROM entities WHERE sync_run_id != @syncRunId',
        params: { syncRunId: activeSyncRunId },
      });
      await transaction.commit();
      return deletedEntities ?? 0;
    });
  }

  /**
   * Computes vector embeddings via a read-only Spanner `ML.PREDICT` query and persists updates in a separate write transaction.
   */
  async generateEmbeddingsInDatabase(): Promise<number> {
    const modelName = this.config.embeddingModel ?? 'TextEmbeddingModel';
    if (!SAFE_SQL_IDENTIFIER.test(modelName)) {
      throw new Error(
        `Invalid Spanner ML model identifier "${modelName}". Expected alphanumeric/underscore identifier.`,
      );
    }

    if (!this.database.run) {
      return 0;
    }

    const [rows] = await this.database.run({
      sql: `
        SELECT
          entity_id,
          embeddings.values AS embedding
        FROM ML.PREDICT(MODEL ${modelName},
          (
            SELECT
              entity_id,
              CONCAT(kind, ' ', name, ': ', IFNULL(description, '')) AS content
            FROM entities
            WHERE description_embedding IS NULL
            LIMIT 500
          )
        )
      `,
    });

    if (!rows || rows.length === 0) {
      return 0;
    }

    const updates = rows
      .map(row => rowToPlainObject(row))
      .filter(
        plain =>
          typeof plain.entity_id === 'string' && Array.isArray(plain.embedding),
      )
      .map(plain => ({
        entity_id: plain.entity_id as string,
        description_embedding: plain.embedding as number[],
      }));

    if (updates.length === 0) {
      return 0;
    }

    await this.database.runTransactionAsync(async transaction => {
      if (transaction.update) {
        transaction.update('entities', updates);
      }
      await transaction.commit();
    });

    return updates.length;
  }
}
