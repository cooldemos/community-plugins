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
import { ConfigReader } from '@backstage/config';
import { normalizeEntityRef, SpannerGraphService } from './SpannerGraphService';

describe('SpannerGraphService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('executes a parameterized ISO GQL MATCH TRAIL query and deduplicates nodes and edges', async () => {
    const run = jest.fn().mockResolvedValue([
      [
        {
          toJSON: () => ({
            path: [
              {
                kind: 'node',
                properties: {
                  entity_ref: 'component:default/checkout-service',
                  kind: 'component',
                  namespace: 'default',
                  name: 'checkout-service',
                  title: 'Checkout Service',
                  lifecycle: 'production',
                },
              },
              {
                kind: 'edge',
                properties: {
                  source_entity_ref: 'component:default/checkout-service',
                  target_entity_ref: 'resource:default/orders-spanner-db',
                  relation_type: 'dependsOn',
                },
              },
              {
                kind: 'node',
                properties: {
                  entity_ref: 'resource:default/orders-spanner-db',
                  kind: 'resource',
                  namespace: 'default',
                  name: 'orders-spanner-db',
                  title: 'Orders DB',
                  lifecycle: 'production',
                },
              },
            ],
          }),
        },
        {
          toJSON: () => ({
            path: [
              {
                kind: 'node',
                properties: {
                  entity_ref: 'component:default/checkout-service',
                  kind: 'component',
                  namespace: 'default',
                  name: 'checkout-service',
                },
              },
              {
                kind: 'edge',
                properties: {
                  source_entity_ref: 'component:default/checkout-service',
                  target_entity_ref: 'resource:default/orders-spanner-db',
                  relation_type: 'dependsOn',
                },
              },
            ],
          }),
        },
      ],
    ]);

    const service = new SpannerGraphService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
      },
      mockServices.logger.mock(),
      { run },
    );

    const subgraph = await service.getSubgraph({
      root: 'Component:Default/checkout-service',
      maxDepth: 2,
      direction: 'outgoing',
      relationTypes: ['dependsOn'],
      entityKinds: ['Resource', 'Component'],
    });

    expect(subgraph.rootEntityRef).toBe('component:default/checkout-service');
    expect(subgraph.depth).toBe(2);
    expect(subgraph.nodes).toHaveLength(2);
    expect(subgraph.edges).toEqual([
      {
        from: 'component:default/checkout-service',
        to: 'resource:default/orders-spanner-db',
        type: 'dependsOn',
        label: 'dependsOn',
      },
    ]);
    expect(run).toHaveBeenCalledWith({
      sql: expect.stringContaining('-[e:Relation]->{1,2}'),
      params: {
        rootRef: 'component:default/checkout-service',
        maxPaths: 500,
        relationTypes: ['dependsOn'],
        entityKinds: ['resource', 'component'],
      },
    });
  });

  it('falls back to looking up the isolated root node in entities when the GQL path query returns zero rows', async () => {
    const run = jest
      .fn()
      .mockResolvedValueOnce([[]])
      .mockResolvedValueOnce([
        [
          {
            toJSON: () => ({
              entity_ref: 'component:default/audit-archiver-isolated',
              kind: 'component',
              namespace: 'default',
              name: 'audit-archiver-isolated',
              title: 'Isolated Compliance Audit Archiver',
              lifecycle: 'experimental',
              owner_ref: 'group:default/data-platform',
            }),
          },
        ],
      ]);

    const service = new SpannerGraphService(
      {
        instanceId: 'backstage-graph',
        databaseId: 'backstage-catalog',
        maxDepth: 3,
      },
      mockServices.logger.mock(),
      { run },
    );

    const subgraph = await service.getSubgraph({
      root: 'Component:Default/audit-archiver-isolated',
      maxDepth: 9,
      direction: 'incoming',
    });

    expect(subgraph.depth).toBe(3);
    expect(subgraph.edges).toEqual([]);
    expect(subgraph.nodes).toEqual([
      {
        id: 'component:default/audit-archiver-isolated',
        kind: 'component',
        namespace: 'default',
        name: 'audit-archiver-isolated',
        title: 'Isolated Compliance Audit Archiver',
        description: undefined,
        lifecycle: 'experimental',
        ownerRef: 'group:default/data-platform',
        systemRef: undefined,
      },
    ]);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1][0].sql).toContain('FROM entities');
  });

  it('proxies natural language queries to aiServiceUrl and validates config', async () => {
    const config = new ConfigReader({
      spannerGraph: {
        projectId: 'demo-gcp',
        instanceId: 'demo-instance',
        databaseId: 'demo-db',
        graphName: 'BackstageCatalogGraph',
        maxDepth: 4,
        aiServiceUrl: 'http://localhost:8085/',
      },
    });

    const service = SpannerGraphService.fromConfig(
      config,
      mockServices.logger.mock(),
      { run: jest.fn() },
    );

    const fetchSpy = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        answer: 'Orders Spanner DB has 3 upstream dependents.',
        executedGql: 'GRAPH BackstageCatalogGraph MATCH ...',
        matchedNodes: [
          {
            id: 'resource:default/orders-spanner-db',
            kind: 'resource',
            namespace: 'default',
            name: 'orders-spanner-db',
          },
        ],
      }),
    } as Response);

    const result = await service.executeNaturalQuery(
      'What depends on orders-spanner-db?',
    );

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://localhost:8085/v1/graph/natural-query',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(result.answer).toBe('Orders Spanner DB has 3 upstream dependents.');
    expect(result.matchedNodes).toHaveLength(1);
    expect(normalizeEntityRef('Resource:Default/orders-spanner-db')).toBe(
      'resource:default/orders-spanner-db',
    );
  });
});
