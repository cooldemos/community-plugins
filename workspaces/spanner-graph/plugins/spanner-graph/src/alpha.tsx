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
import { compatWrapper } from '@backstage/core-compat-api';
import {
  ApiBlueprint,
  createFrontendPlugin,
  createRouteRef,
  discoveryApiRef,
  fetchApiRef,
  PageBlueprint,
} from '@backstage/frontend-plugin-api';
import {
  EntityCardBlueprint,
  EntityContentBlueprint,
} from '@backstage/plugin-catalog-react/alpha';
import { z } from 'zod';
import { SpannerGraphClient } from './api/SpannerGraphClient';
import { spannerGraphApiRef } from './api/types';

/**
 * New Frontend System route reference for the Cloud Spanner Graph topology explorer page.
 *
 * @alpha
 */
export const spannerGraphNewRouteRef = createRouteRef();

/**
 * API extension registering `SpannerGraphClient` for `spannerGraphApiRef`.
 *
 * @alpha
 */
export const spannerGraphApi = ApiBlueprint.make({
  params: defineParams =>
    defineParams({
      api: spannerGraphApiRef,
      deps: {
        discoveryApi: discoveryApiRef,
        fetchApi: fetchApiRef,
      },
      factory: ({ discoveryApi, fetchApi }) =>
        new SpannerGraphClient({ discoveryApi, fetchApi }),
    }),
});

/**
 * Entity card blueprint rendering `<SpannerCatalogGraphCard />` on Catalog Entity Pages.
 *
 * @alpha
 */
export const entitySpannerGraphCard = EntityCardBlueprint.makeWithOverrides({
  name: 'spanner-dependencies',
  configSchema: {
    maxDepth: z.number().int().min(1).max(10).optional(),
    direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
    height: z.number().int().min(200).optional(),
    title: z.string().optional(),
  },
  factory(originalFactory, { config }) {
    return originalFactory({
      loader: async () =>
        import('./components/SpannerCatalogGraphCard').then(m =>
          compatWrapper(
            <m.SpannerCatalogGraphCard
              maxDepth={config.maxDepth ?? 2}
              direction={config.direction ?? 'both'}
              height={config.height ?? 380}
              title={config.title}
            />,
          ),
        ),
    });
  },
});

/**
 * Entity content tab blueprint rendering a multi-hop blast-radius view for resources and systems.
 *
 * @alpha
 */
export const entitySpannerBlastRadiusContent =
  EntityContentBlueprint.makeWithOverrides({
    name: 'blast-radius',
    configSchema: {
      maxDepth: z.number().int().min(1).max(10).optional(),
      direction: z.enum(['outgoing', 'incoming', 'both']).optional(),
    },
    factory(originalFactory, { config }) {
      return originalFactory({
        path: '/blast-radius',
        title: 'Blast Radius (Spanner Graph)',
        filter: {
          kind: { $in: ['resource', 'system'] },
        },
        loader: async () =>
          import('./components/SpannerCatalogGraphCard').then(m =>
            compatWrapper(
              <m.SpannerCatalogGraphCard
                variant="fullHeight"
                maxDepth={config.maxDepth ?? 4}
                direction={config.direction ?? 'incoming'}
                relationTypes={m.BLAST_RADIUS_RELATIONS}
                height={600}
                title="Downstream Blast Radius & Impact Analysis"
              />,
            ),
          ),
      });
    },
  });

/**
 * Full-screen page blueprint for the Cloud Spanner Graph explorer at `/spanner-graph`.
 *
 * @alpha
 */
export const spannerGraphPage = PageBlueprint.makeWithOverrides({
  configSchema: {
    initialRootRef: z.string().optional(),
    initialMaxDepth: z.number().int().min(1).max(10).optional(),
  },
  factory(originalFactory, { config }) {
    return originalFactory({
      path: '/spanner-graph',
      noHeader: true,
      routeRef: spannerGraphNewRouteRef,
      loader: async () =>
        import('./components/SpannerGraphPage').then(m =>
          compatWrapper(
            <m.SpannerGraphPage
              noHeader
              initialRootRef={config.initialRootRef}
              initialMaxDepth={config.initialMaxDepth ?? 3}
            />,
          ),
        ),
    });
  },
});

/**
 * Backstage New Frontend System plugin for Google Cloud Spanner Graph.
 *
 * @alpha
 */
export const spannerGraphAlphaPlugin = createFrontendPlugin({
  pluginId: 'spanner-graph',
  extensions: [
    spannerGraphApi,
    entitySpannerGraphCard,
    entitySpannerBlastRadiusContent,
    spannerGraphPage,
  ],
  routes: {
    root: spannerGraphNewRouteRef,
  },
});

export default spannerGraphAlphaPlugin;
