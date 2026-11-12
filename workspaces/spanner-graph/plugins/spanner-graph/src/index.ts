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

export { SpannerGraphClient } from './api/SpannerGraphClient';
export type { SpannerGraphClientOptions } from './api/SpannerGraphClient';
export { spannerGraphApiRef } from './api/types';
export type {
  GraphDirection,
  GraphEdge,
  GraphNode,
  NaturalLanguageGraphResponse,
  SpannerGraphApi,
  SubgraphQueryOptions,
  SubgraphResponse,
} from './api/types';
export {
  BLAST_RADIUS_RELATIONS,
  mergeParallelEdges,
  SpannerCatalogGraphCard,
} from './components/SpannerCatalogGraphCard';
export type { SpannerCatalogGraphCardProps } from './components/SpannerCatalogGraphCard';
export { SpannerGraphPage } from './components/SpannerGraphPage';
export type { SpannerGraphPageProps } from './components/SpannerGraphPage';
export { SpannerNaturalQueryCard } from './components/SpannerNaturalQueryCard';
export type { SpannerNaturalQueryCardProps } from './components/SpannerNaturalQueryCard';
export { useSpannerGraph } from './hooks/useSpannerGraph';
export type { UseSpannerGraphResult } from './hooks/useSpannerGraph';
export {
  EntitySpannerGraphCard,
  SpannerGraphExplorerPage,
  spannerGraphPlugin,
} from './plugin';
export { spannerGraphRouteRef } from './routes';
