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
import { SpannerGraphService } from '../service/SpannerGraphService';

const OPERATIONAL_BLAST_RADIUS_RELATIONS = [
  'dependsOn',
  'consumesApi',
  'apiProvidedBy',
  'partOf',
];

/**
 * Registers read-only Cloud Spanner Graph topology, blast-radius, and natural-language actions
 * with the Backstage Actions Registry (MCP tool integration).
 *
 * @public
 */
export function registerSpannerGraphMcpActions(options: {
  actionsRegistry: ActionsRegistryService;
  graphService: SpannerGraphService;
}): void {
  const { actionsRegistry, graphService } = options;

  actionsRegistry.register({
    name: 'query-catalog-subgraph',
    title: 'Query Cloud Spanner Catalog Subgraph',
    description:
      'Queries a multi-hop Backstage catalog dependency and ownership subgraph from Google Cloud Spanner Graph using parameterized ISO GQL.',
    attributes: {
      readOnly: true,
      idempotent: true,
      destructive: false,
    },
    schema: {
      input: z =>
        z.object({
          root: z
            .string()
            .min(1)
            .describe(
              'Root entity reference or short entity name (e.g. component:default/checkout-service or orders-spanner-db).',
            ),
          maxDepth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('Maximum number of traversal hops (1 to 5).'),
          direction: z
            .enum(['outgoing', 'incoming', 'both'])
            .optional()
            .describe('Traversal direction relative to the root entity.'),
          relationTypes: z
            .array(z.string())
            .optional()
            .describe('Optional filter of Backstage catalog relation types.'),
          entityKinds: z
            .array(z.string())
            .optional()
            .describe('Optional filter of target entity kinds.'),
        }),
      output: z =>
        z.object({
          rootEntityRef: z.string(),
          depth: z.number(),
          nodeCount: z.number(),
          edgeCount: z.number(),
          nodes: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              namespace: z.string(),
              name: z.string(),
              title: z.string().optional(),
              lifecycle: z.string().optional(),
            }),
          ),
          edges: z.array(
            z.object({
              from: z.string(),
              to: z.string(),
              type: z.string(),
            }),
          ),
        }),
    },
    action: async ({ input }) => {
      const subgraph = await graphService.getSubgraph(input);
      return {
        output: {
          rootEntityRef: subgraph.rootEntityRef,
          depth: subgraph.depth,
          nodeCount: subgraph.nodes.length,
          edgeCount: subgraph.edges.length,
          nodes: subgraph.nodes.map(node => ({
            id: node.id,
            kind: node.kind,
            namespace: node.namespace,
            name: node.name,
            title: node.title,
            lifecycle: node.lifecycle,
          })),
          edges: subgraph.edges.map(edge => ({
            from: edge.from,
            to: edge.to,
            type: edge.type,
          })),
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'analyze-blast-radius',
    title: 'Analyze Downstream Catalog Blast Radius',
    description:
      'Computes the multi-hop operational blast radius (dependents, API consumers, and parent systems) impacted by a Backstage entity in Cloud Spanner Graph.',
    attributes: {
      readOnly: true,
      idempotent: true,
      destructive: false,
    },
    schema: {
      input: z =>
        z.object({
          entityRef: z
            .string()
            .min(1)
            .describe(
              'Entity reference or short name to analyze (e.g. resource:default/orders-spanner-db).',
            ),
          maxDepth: z
            .number()
            .int()
            .min(1)
            .max(5)
            .optional()
            .describe('Maximum upstream impact hops (default 4).'),
        }),
      output: z =>
        z.object({
          rootEntityRef: z.string(),
          impactedCount: z.number(),
          impactedEntities: z.array(
            z.object({
              id: z.string(),
              kind: z.string(),
              name: z.string(),
              lifecycle: z.string().optional(),
            }),
          ),
        }),
    },
    action: async ({ input }) => {
      const subgraph = await graphService.getSubgraph({
        root: input.entityRef,
        maxDepth: input.maxDepth ?? 4,
        direction: 'incoming',
        relationTypes: OPERATIONAL_BLAST_RADIUS_RELATIONS,
      });
      const impactedEntities = subgraph.nodes
        .filter(node => node.id !== subgraph.rootEntityRef)
        .map(node => ({
          id: node.id,
          kind: node.kind,
          name: node.name,
          lifecycle: node.lifecycle,
        }));
      return {
        output: {
          rootEntityRef: subgraph.rootEntityRef,
          impactedCount: impactedEntities.length,
          impactedEntities,
        },
      };
    },
  });

  actionsRegistry.register({
    name: 'ask-catalog-graph',
    title: 'Ask Natural-Language Question Against Catalog Graph',
    description:
      'Translates a natural-language architecture or dependency question into parameterized ISO GQL and executes it against Cloud Spanner Graph.',
    attributes: {
      readOnly: true,
      idempotent: true,
      destructive: false,
    },
    schema: {
      input: z =>
        z.object({
          query: z
            .string()
            .min(1)
            .max(1000)
            .describe(
              'Natural-language question about Backstage services, APIs, resources, or ownership.',
            ),
        }),
      output: z =>
        z.object({
          answer: z.string(),
          executedGql: z.string(),
          matchedEntityIds: z.array(z.string()),
        }),
    },
    action: async ({ input }) => {
      const response = await graphService.executeNaturalQuery(input.query);
      return {
        output: {
          answer: response.answer,
          executedGql: response.executedGql,
          matchedEntityIds: response.matchedNodes.map(node => node.id),
        },
      };
    },
  });
}
