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
import { SpannerSyncService } from '@backstage-community/plugin-catalog-backend-module-spanner-sync';
import {
  createRouter,
  SpannerGraphService,
} from '@backstage-community/plugin-spanner-graph-backend';
import { mockServices } from '@backstage/backend-test-utils';
import { Entity } from '@backstage/catalog-model';
import express from 'express';
import request from 'supertest';
import { InMemorySpannerDatabase } from './mockSpanner';

const isLiveSpannerTest = process.env.SPANNER_LIVE_TEST === 'true';

describe('Cloud Spanner Graph end-to-end integration pipeline', () => {
  const catalogEntities: Entity[] = [
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'System',
      metadata: {
        uid: 'uid-sys-fulfillment',
        name: 'Catalog-Fulfillment',
        title: 'Catalog Fulfillment System',
      },
      spec: {
        owner: 'group:default/platform-sre',
      },
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        uid: 'uid-res-spanner',
        name: 'orders-spanner-db',
        title: 'Orders Cloud Spanner Database',
        description: 'Primary transactional order ledger',
      },
      spec: {
        type: 'database',
        lifecycle: 'production',
        system: 'System:default/Catalog-Fulfillment',
      },
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        uid: 'uid-res-redis',
        name: 'payment-Redis-Cache',
        title: 'Payment Redis Cache',
      },
      spec: {
        type: 'cache',
        lifecycle: 'production',
      },
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-comp-payment',
        name: 'payment-worker',
        title: 'Payment Settlement Worker',
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
      },
      relations: [
        {
          type: 'dependsOn',
          targetRef: 'resource:default/orders-spanner-db',
        },
        {
          type: 'dependsOn',
          targetRef: 'Resource:Default/payment-Redis-Cache',
        },
      ],
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-comp-checkout',
        name: 'checkout-service',
        title: 'Checkout Orchestrator Service',
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
      },
      relations: [
        {
          type: 'dependsOn',
          targetRef: 'component:default/payment-worker',
        },
        {
          type: 'dependsOn',
          targetRef: 'resource:default/orders-spanner-db',
        },
      ],
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-comp-gateway',
        name: 'order-api-gateway',
        title: 'Order Edge API Gateway',
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
      },
      relations: [
        {
          type: 'dependsOn',
          targetRef: 'component:default/checkout-service',
        },
      ],
    },
    {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-comp-isolated',
        name: 'audit-archiver-isolated',
        title: 'Isolated Compliance Audit Archiver',
      },
      spec: {
        type: 'service',
        lifecycle: 'experimental',
      },
    },
  ];

  it('provisions schema, syncs catalog entities, serves multi-hop subgraphs and isolated nodes, and reconciles stale entities', async () => {
    const logger = mockServices.logger.mock();
    const sharedDb = isLiveSpannerTest
      ? undefined
      : new InMemorySpannerDatabase();

    const syncConfig = {
      projectId: process.env.SPANNER_PROJECT_ID ?? 'demo-gcp-project',
      instanceId: process.env.SPANNER_INSTANCE_ID ?? 'backstage-graph-instance',
      databaseId: process.env.SPANNER_DATABASE_ID ?? 'backstage-catalog',
      autoCreateSchema: true,
      enableEmbeddings: !isLiveSpannerTest,
      batchSize: 3,
    };

    const syncService = new SpannerSyncService(syncConfig, logger, sharedDb);
    const schemaCreated = await syncService.ensureSchema();
    expect(schemaCreated).toBe(true);

    const firstSync = await syncService.runSync(catalogEntities);
    expect(firstSync.entitiesSynced).toBe(7);
    expect(firstSync.relationsSynced).toBe(5);
    expect(firstSync.staleEntitiesDeleted).toBe(0);

    const graphService = new SpannerGraphService(
      {
        projectId: syncConfig.projectId,
        instanceId: syncConfig.instanceId,
        databaseId: syncConfig.databaseId,
        graphName: 'BackstageCatalogGraph',
        maxDepth: 5,
      },
      logger,
      sharedDb,
    );

    const router = await createRouter({
      logger,
      httpAuth: mockServices.httpAuth.mock(),
      graphService,
    });
    const app = express().use('/api/spanner-graph', router);

    // 1. Health check endpoint.
    const healthRes = await request(app).get('/api/spanner-graph/health');
    expect(healthRes.status).toBe(200);
    expect(healthRes.body.status).toBe('ok');

    // 2. Multi-hop outgoing traversal from order-api-gateway (3 hops to orders-spanner-db and payment-Redis-Cache).
    const outgoingRes = await request(app).get(
      '/api/spanner-graph/subgraph?root=Component:Default/order-api-gateway&maxDepth=3&direction=outgoing',
    );
    expect(outgoingRes.status).toBe(200);
    const nodeIds = (outgoingRes.body.nodes as Array<{ id: string }>).map(
      n => n.id,
    );
    expect(nodeIds).toEqual(
      expect.arrayContaining([
        'component:default/order-api-gateway',
        'component:default/checkout-service',
        'component:default/payment-worker',
        'resource:default/orders-spanner-db',
        'resource:default/payment-Redis-Cache',
      ]),
    );

    // 3. Multi-hop incoming blast-radius traversal from orders-spanner-db.
    const incomingRes = await request(app).get(
      '/api/spanner-graph/subgraph?root=resource:default/orders-spanner-db&maxDepth=3&direction=incoming',
    );
    expect(incomingRes.status).toBe(200);
    const dependentIds = (incomingRes.body.nodes as Array<{ id: string }>).map(
      n => n.id,
    );
    expect(dependentIds).toEqual(
      expect.arrayContaining([
        'resource:default/orders-spanner-db',
        'component:default/payment-worker',
        'component:default/checkout-service',
        'component:default/order-api-gateway',
      ]),
    );

    // 4. Filtered subgraph query by entityKinds and relationTypes (case-insensitive normalization).
    const filteredKindRes = await request(app).get(
      '/api/spanner-graph/subgraph?root=component:default/checkout-service&maxDepth=2&direction=outgoing&entityKinds=Resource&relationTypes=dependsOn',
    );
    expect(filteredKindRes.status).toBe(200);
    expect(
      (filteredKindRes.body.nodes as Array<{ id: string }>).map(n => n.id),
    ).toEqual(
      expect.arrayContaining([
        'resource:default/orders-spanner-db',
        'resource:default/payment-Redis-Cache',
      ]),
    );

    // 5. Isolated root entity with zero edges still returns its root node via fallback lookup.
    const isolatedRes = await request(app).get(
      '/api/spanner-graph/subgraph?root=component:default/audit-archiver-isolated&maxDepth=2&direction=both',
    );
    expect(isolatedRes.status).toBe(200);
    expect(isolatedRes.body.edges).toEqual([]);
    expect(isolatedRes.body.nodes).toEqual([
      expect.objectContaining({
        id: 'component:default/audit-archiver-isolated',
        name: 'audit-archiver-isolated',
      }),
    ]);

    // 6. Reconcile stale entities when order-api-gateway is removed on a subsequent sync run.
    const reducedCatalog = catalogEntities.filter(
      e => e.metadata.name !== 'order-api-gateway',
    );
    const secondSync = await syncService.runSync(reducedCatalog);
    expect(secondSync.entitiesSynced).toBe(6);
    expect(secondSync.staleEntitiesDeleted).toBe(1);
  }, 120_000);
});
