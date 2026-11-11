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
import express from 'express';
import request from 'supertest';
import { createRouter } from './router';
import { SpannerGraphService } from './SpannerGraphService';

describe('createRouter', () => {
  it('returns status ok on GET /health', async () => {
    const router = await createRouter({
      logger: mockServices.logger.mock(),
      httpAuth: mockServices.httpAuth.mock(),
      graphService: {
        getSubgraph: jest.fn(),
        executeNaturalQuery: jest.fn(),
      } as unknown as SpannerGraphService,
    });
    const app = express().use(router);

    const response = await request(app).get('/health');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'spanner-graph-backend',
    });
  });

  it('validates GET /subgraph query parameters and delegates valid queries to SpannerGraphService', async () => {
    const getSubgraph = jest.fn().mockResolvedValue({
      rootEntityRef: 'component:default/checkout-service',
      depth: 3,
      nodes: [
        {
          id: 'component:default/checkout-service',
          kind: 'component',
          namespace: 'default',
          name: 'checkout-service',
        },
      ],
      edges: [],
      truncated: false,
      queryDurationMs: 8,
    });

    const router = await createRouter({
      logger: mockServices.logger.mock(),
      httpAuth: mockServices.httpAuth.mock(),
      graphService: {
        getSubgraph,
        executeNaturalQuery: jest.fn(),
      } as unknown as SpannerGraphService,
    });
    const app = express().use(router);

    const missingRoot = await request(app).get('/subgraph');
    expect(missingRoot.status).toBe(400);

    const invalidDepth = await request(app).get(
      '/subgraph?root=component:default/checkout-service&maxDepth=0',
    );
    expect(invalidDepth.status).toBe(400);

    const invalidDirection = await request(app).get(
      '/subgraph?root=component:default/checkout-service&direction=sideways',
    );
    expect(invalidDirection.status).toBe(400);

    const validResponse = await request(app).get(
      '/subgraph?root=component:default/checkout-service&maxDepth=3&direction=outgoing&relationTypes=dependsOn,consumesApi&entityKinds=resource,api',
    );
    expect(validResponse.status).toBe(200);
    expect(getSubgraph).toHaveBeenCalledWith({
      root: 'component:default/checkout-service',
      maxDepth: 3,
      direction: 'outgoing',
      relationTypes: ['dependsOn', 'consumesApi'],
      entityKinds: ['resource', 'api'],
    });
  });

  it('validates POST /natural-query body and delegates to executeNaturalQuery', async () => {
    const executeNaturalQuery = jest.fn().mockResolvedValue({
      answer: 'Two services depend on orders-spanner-db.',
      executedGql: 'GRAPH BackstageCatalogGraph MATCH ...',
      matchedNodes: [],
    });

    const router = await createRouter({
      logger: mockServices.logger.mock(),
      httpAuth: mockServices.httpAuth.mock(),
      graphService: {
        getSubgraph: jest.fn(),
        executeNaturalQuery,
      } as unknown as SpannerGraphService,
    });
    const app = express().use(router);

    const emptyQuery = await request(app).post('/natural-query').send({});
    expect(emptyQuery.status).toBe(400);

    const validQuery = await request(app)
      .post('/natural-query')
      .send({ query: 'What depends on orders-spanner-db?' });
    expect(validQuery.status).toBe(200);
    expect(validQuery.body.answer).toBe(
      'Two services depend on orders-spanner-db.',
    );
    expect(executeNaturalQuery).toHaveBeenCalledWith(
      'What depends on orders-spanner-db?',
    );
  });
});
