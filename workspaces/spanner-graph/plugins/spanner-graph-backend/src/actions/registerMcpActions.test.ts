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
import { ActionsRegistryService } from '@backstage/backend-plugin-api/alpha';
import { z } from 'zod';
import { SpannerGraphService } from '../service/SpannerGraphService';
import { registerSpannerGraphMcpActions } from './registerMcpActions';

describe('registerSpannerGraphMcpActions', () => {
  it('registers query-catalog-subgraph, analyze-blast-radius, and ask-catalog-graph actions and delegates to SpannerGraphService', async () => {
    const registered: Record<
      string,
      {
        action: (args: { input: any }) => Promise<{ output: any }>;
        inputSchema: any;
        outputSchema: any;
      }
    > = {};

    const mockActionsRegistry: ActionsRegistryService = {
      register: jest.fn((definition: any) => {
        registered[definition.name] = {
          action: definition.action,
          inputSchema: definition.schema.input(z),
          outputSchema: definition.schema.output(z),
        };
      }),
    };

    const mockGraphService = {
      getSubgraph: jest.fn().mockResolvedValue({
        rootEntityRef: 'resource:default/orders-spanner-db',
        depth: 4,
        nodes: [
          {
            id: 'resource:default/orders-spanner-db',
            kind: 'resource',
            namespace: 'default',
            name: 'orders-spanner-db',
            lifecycle: 'production',
          },
          {
            id: 'component:default/checkout-service',
            kind: 'component',
            namespace: 'default',
            name: 'checkout-service',
            lifecycle: 'production',
          },
        ],
        edges: [
          {
            from: 'component:default/checkout-service',
            to: 'resource:default/orders-spanner-db',
            type: 'dependsOn',
          },
        ],
        truncated: false,
        queryDurationMs: 9,
      }),
      executeNaturalQuery: jest.fn().mockResolvedValue({
        answer: 'checkout-service depends on orders-spanner-db.',
        executedGql: 'GRAPH BackstageCatalogGraph MATCH p = ACYCLIC ...',
        matchedNodes: [
          {
            id: 'component:default/checkout-service',
            kind: 'component',
            namespace: 'default',
            name: 'checkout-service',
          },
        ],
      }),
    } as unknown as SpannerGraphService;

    registerSpannerGraphMcpActions({
      actionsRegistry: mockActionsRegistry,
      graphService: mockGraphService,
    });

    expect(Object.keys(registered)).toEqual([
      'query-catalog-subgraph',
      'analyze-blast-radius',
      'ask-catalog-graph',
    ]);

    const subgraphResult = await registered['query-catalog-subgraph'].action({
      input: {
        root: 'resource:default/orders-spanner-db',
        maxDepth: 2,
        direction: 'both',
      },
    });
    expect(subgraphResult.output.nodeCount).toBe(2);
    expect(subgraphResult.output.edgeCount).toBe(1);

    const blastResult = await registered['analyze-blast-radius'].action({
      input: {
        entityRef: 'orders-spanner-db',
      },
    });
    expect(mockGraphService.getSubgraph).toHaveBeenCalledWith({
      root: 'orders-spanner-db',
      maxDepth: 4,
      direction: 'incoming',
      relationTypes: ['dependsOn', 'consumesApi', 'apiProvidedBy', 'partOf'],
    });
    expect(blastResult.output).toEqual({
      rootEntityRef: 'resource:default/orders-spanner-db',
      impactedCount: 1,
      impactedEntities: [
        {
          id: 'component:default/checkout-service',
          kind: 'component',
          name: 'checkout-service',
          lifecycle: 'production',
        },
      ],
    });

    const nlResult = await registered['ask-catalog-graph'].action({
      input: {
        query: 'Which services depend on orders-spanner-db?',
      },
    });
    expect(nlResult.output).toEqual({
      answer: 'checkout-service depends on orders-spanner-db.',
      executedGql: 'GRAPH BackstageCatalogGraph MATCH p = ACYCLIC ...',
      matchedEntityIds: ['component:default/checkout-service'],
    });
  });
});
