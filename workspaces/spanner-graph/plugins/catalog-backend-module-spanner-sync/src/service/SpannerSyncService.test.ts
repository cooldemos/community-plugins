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
import { mockServices } from '@backstage/backend-test-utils';
import { Entity } from '@backstage/catalog-model';
import { ConfigReader } from '@backstage/config';
import { SpannerSyncService } from './SpannerSyncService';

describe('SpannerSyncService', () => {
  const sampleEntities: Entity[] = [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-svc-1',
        name: 'checkout-service',
        description: 'Checkout orchestrator',
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
        owner: 'group:default/checkout-squad',
      },
      relations: [
        {
          type: 'dependsOn',
          targetRef: 'resource:default/orders-spanner-db',
        },
      ],
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        uid: 'uid-res-1',
        name: 'orders-spanner-db',
        description: 'Orders Spanner database',
      },
      spec: {
        type: 'database',
        lifecycle: 'production',
      },
    },
  ];

  it('provisions entities, interleaved relations, indexes, and BackstageCatalogGraph DDL when autoCreateSchema is enabled', async () => {
    const updateSchema = jest
      .fn()
      .mockResolvedValue([{ promise: jest.fn().mockResolvedValue(undefined) }]);
    const mockDb = {
      updateSchema,
    };

    const service = new SpannerSyncService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
      },
      mockServices.logger.mock(),
      mockDb,
    );

    const created = await service.ensureSchema();

    expect(created).toBe(true);
    expect(updateSchema).toHaveBeenCalledTimes(1);
    const statements = updateSchema.mock.calls[0][0] as string[];
    expect(statements).toHaveLength(6);
    expect(statements[0]).toContain('CREATE TABLE IF NOT EXISTS entities');
    expect(statements[3]).toContain(
      'INTERLEAVE IN PARENT entities ON DELETE CASCADE',
    );
    expect(statements[4]).toContain('relations_by_target');
    expect(statements[5]).toContain(
      'CREATE OR REPLACE PROPERTY GRAPH BackstageCatalogGraph',
    );
  });

  it('skips schema provisioning when autoCreateSchema is false and tolerates AlreadyExists DDL errors', async () => {
    const updateSchema = jest.fn();
    const disabledSchemaService = new SpannerSyncService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
        autoCreateSchema: false,
      },
      mockServices.logger.mock(),
      { updateSchema },
    );

    expect(await disabledSchemaService.ensureSchema()).toBe(false);
    expect(updateSchema).not.toHaveBeenCalled();

    const alreadyExistsError = Object.assign(
      new Error('Duplicate name in schema: idx_entities_ref already exists'),
      { code: 6 },
    );
    const idempotentUpdateSchema = jest
      .fn()
      .mockRejectedValue(alreadyExistsError);
    const idempotentService = new SpannerSyncService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
        autoCreateSchema: true,
      },
      mockServices.logger.mock(),
      { updateSchema: idempotentUpdateSchema },
    );

    expect(await idempotentService.ensureSchema()).toBe(true);
  });

  it('batches entity and relation upserts and reconciles stale entities in runSync', async () => {
    const entitiesUpsert = jest.fn().mockResolvedValue(undefined);
    const relationsUpsert = jest.fn().mockResolvedValue(undefined);
    const runUpdate = jest
      .fn()
      .mockResolvedValueOnce([1])
      .mockResolvedValueOnce([3]);
    const commit = jest.fn().mockResolvedValue(undefined);

    const mockDb = {
      table: jest.fn((name: string) =>
        name === 'entities'
          ? { upsert: entitiesUpsert }
          : { upsert: relationsUpsert },
      ),
      runTransactionAsync: jest.fn(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            runUpdate,
            commit,
          }),
      ),
    };

    const service = new SpannerSyncService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
        batchSize: 1,
      },
      mockServices.logger.mock(),
      mockDb,
    );

    const summary = await service.runSync(sampleEntities);

    expect(summary.entitiesSynced).toBe(2);
    expect(summary.relationsSynced).toBe(1);
    expect(summary.staleEntitiesDeleted).toBe(3);
    expect(summary.embeddingsGenerated).toBe(0);
    expect(entitiesUpsert).toHaveBeenCalledTimes(2);
    expect(relationsUpsert).toHaveBeenCalledTimes(1);
    expect(runUpdate).toHaveBeenCalledTimes(2);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it('generates in-database Vertex AI embeddings via read-only ML.PREDICT followed by transaction.update when enableEmbeddings is true', async () => {
    const entitiesUpsert = jest.fn().mockResolvedValue(undefined);
    const relationsUpsert = jest.fn().mockResolvedValue(undefined);
    const runUpdate = jest.fn().mockResolvedValue([0]);
    const update = jest.fn();
    const commit = jest.fn().mockResolvedValue(undefined);
    const run = jest.fn().mockResolvedValue([
      [
        {
          toJSON: () => ({
            entity_id: 'uid-svc-1',
            embedding: [0.12, 0.34, 0.56],
          }),
        },
      ],
    ]);

    const mockDb = {
      table: jest.fn((name: string) =>
        name === 'entities'
          ? { upsert: entitiesUpsert }
          : { upsert: relationsUpsert },
      ),
      run,
      runTransactionAsync: jest.fn(
        async (fn: (tx: unknown) => Promise<unknown>) =>
          fn({
            runUpdate,
            update,
            commit,
          }),
      ),
    };

    const service = new SpannerSyncService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
        enableEmbeddings: true,
        embeddingModel: 'VertexEmbeddingModel',
      },
      mockServices.logger.mock(),
      mockDb,
    );

    const summary = await service.runSync(sampleEntities);

    expect(summary.embeddingsGenerated).toBe(1);
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        sql: expect.stringContaining('ML.PREDICT(MODEL VertexEmbeddingModel'),
      }),
    );
    expect(update).toHaveBeenCalledWith('entities', [
      {
        entity_id: 'uid-svc-1',
        description_embedding: [0.12, 0.34, 0.56],
      },
    ]);
  });

  it('reads configuration in fromConfig and rejects invalid embeddingModel names', async () => {
    const config = new ConfigReader({
      catalog: {
        spannerSync: {
          enabled: true,
          projectId: 'test-project',
          instanceId: 'test-instance',
          databaseId: 'test-db',
          autoCreateSchema: false,
          enableEmbeddings: true,
          embeddingModel: 'Invalid-Model-Name!',
          batchSize: 250,
        },
      },
    });

    const service = SpannerSyncService.fromConfig(
      config,
      mockServices.logger.mock(),
      {},
    );

    expect(service.config).toMatchObject({
      enabled: true,
      projectId: 'test-project',
      instanceId: 'test-instance',
      databaseId: 'test-db',
      autoCreateSchema: false,
      enableEmbeddings: true,
      embeddingModel: 'Invalid-Model-Name!',
      batchSize: 250,
    });

    await expect(service.generateEmbeddingsInDatabase()).rejects.toThrow(
      'Invalid Spanner ML model identifier',
    );
  });
});
