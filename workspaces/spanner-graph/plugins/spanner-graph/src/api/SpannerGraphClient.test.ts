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
import { SpannerGraphClient } from './SpannerGraphClient';

describe('SpannerGraphClient', () => {
  it('requests GET /subgraph with encoded query parameters', async () => {
    const fetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        rootEntityRef: 'component:default/checkout-service',
        depth: 3,
        nodes: [],
        edges: [],
        truncated: false,
        queryDurationMs: 5,
      }),
    });

    const client = new SpannerGraphClient({
      discoveryApi: {
        getBaseUrl: async () => 'http://localhost:7007/api/spanner-graph',
      },
      fetchApi: { fetch },
    });

    const result = await client.getSubgraph({
      root: 'component:default/checkout-service',
      maxDepth: 3,
      direction: 'outgoing',
      relationTypes: ['dependsOn', 'consumesApi'],
      entityKinds: ['resource', 'api'],
    });

    expect(result.rootEntityRef).toBe('component:default/checkout-service');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:7007/api/spanner-graph/subgraph?root=component%3Adefault%2Fcheckout-service&maxDepth=3&direction=outgoing&relationTypes=dependsOn%2CconsumesApi&entityKinds=resource%2Capi',
    );
  });

  it('posts natural language queries to POST /natural-query and throws ResponseError on non-OK responses', async () => {
    const fetch = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          answer: 'Orders DB has 2 dependents.',
          executedGql: 'GRAPH BackstageCatalogGraph MATCH ...',
          matchedNodes: [],
        }),
      })
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        statusText: 'Bad Request',
        headers: new Headers({ 'content-type': 'application/json' }),
        text: async () =>
          JSON.stringify({
            error: { name: 'InputError', message: 'Missing root' },
          }),
      });

    const client = new SpannerGraphClient({
      discoveryApi: {
        getBaseUrl: async () => 'http://localhost:7007/api/spanner-graph',
      },
      fetchApi: { fetch },
    });

    const nlResponse = await client.askNaturalLanguage(
      'Who depends on orders-spanner-db?',
    );
    expect(nlResponse.answer).toBe('Orders DB has 2 dependents.');

    await expect(client.getSubgraph({ root: '' })).rejects.toThrow();
  });
});
