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
import { createApiRef } from '@backstage/core-plugin-api';

/**
 * Traversal direction for Cloud Spanner Graph subgraph queries.
 *
 * @public
 */
export type GraphDirection = 'outgoing' | 'incoming' | 'both';

/**
 * Node representation returned in a Cloud Spanner Graph subgraph response.
 *
 * @public
 */
export interface GraphNode {
  id: string;
  kind: string;
  namespace: string;
  name: string;
  title?: string;
  description?: string;
  lifecycle?: string;
  ownerRef?: string;
  systemRef?: string;
}

/**
 * Directed edge representation returned in a Cloud Spanner Graph subgraph response.
 *
 * @public
 */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  label?: string;
}

/**
 * Query parameters for fetching a multi-hop subgraph from Cloud Spanner Graph.
 *
 * @public
 */
export interface SubgraphQueryOptions {
  root: string;
  maxDepth?: number;
  direction?: GraphDirection;
  relationTypes?: string[];
  entityKinds?: string[];
}

/**
 * Subgraph payload returned by `SpannerGraphApi.getSubgraph`.
 *
 * @public
 */
export interface SubgraphResponse {
  rootEntityRef: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  queryDurationMs: number;
}

/**
 * Response payload returned by `SpannerGraphApi.askNaturalLanguage`.
 *
 * @public
 */
export interface NaturalLanguageGraphResponse {
  answer: string;
  executedGql: string;
  matchedNodes: GraphNode[];
  subgraph?: SubgraphResponse;
}

/**
 * Frontend API contract for querying the Cloud Spanner Graph backend plugin.
 *
 * @public
 */
export interface SpannerGraphApi {
  getSubgraph(options: SubgraphQueryOptions): Promise<SubgraphResponse>;
  askNaturalLanguage(query: string): Promise<NaturalLanguageGraphResponse>;
}

/**
 * Backstage `ApiRef` for {@link SpannerGraphApi}.
 *
 * @public
 */
export const spannerGraphApiRef = createApiRef<SpannerGraphApi>({
  id: 'plugin.spanner-graph.service',
});
