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
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SpannerGraphApi, spannerGraphApiRef } from '../api/types';
import { SpannerGraphPage } from './SpannerGraphPage';
import { SpannerNaturalQueryCard } from './SpannerNaturalQueryCard';

describe('SpannerGraphPage and SpannerNaturalQueryCard', () => {
  it('renders the topology explorer, filters by relation type and entity kind, and executes natural language queries', async () => {
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
        {
          id: 'resource:default/orders-spanner-db',
          kind: 'resource',
          namespace: 'default',
          name: 'orders-spanner-db',
        },
      ],
      edges: [
        {
          from: 'component:default/checkout-service',
          to: 'resource:default/orders-spanner-db',
          type: 'dependsOn',
          label: 'dependsOn',
        },
      ],
      truncated: false,
      queryDurationMs: 11,
    });

    const askNaturalLanguage = jest.fn().mockResolvedValue({
      answer: 'Checkout service depends on orders-spanner-db.',
      executedGql: 'GRAPH BackstageCatalogGraph MATCH TRAIL ...',
      matchedNodes: [
        {
          id: 'resource:default/orders-spanner-db',
          kind: 'resource',
          namespace: 'default',
          name: 'orders-spanner-db',
        },
      ],
    });

    const mockApi: SpannerGraphApi = {
      getSubgraph,
      askNaturalLanguage,
    };

    await renderInTestApp(
      <TestApiProvider apis={[[spannerGraphApiRef, mockApi]]}>
        <SpannerGraphPage>
          <SpannerNaturalQueryCard />
        </SpannerGraphPage>
      </TestApiProvider>,
    );

    expect(
      await screen.findByText('Cloud Spanner Graph Explorer'),
    ).toBeInTheDocument();
    expect(await screen.findByText('2 nodes')).toBeInTheDocument();
    expect(await screen.findByText('1 edges')).toBeInTheDocument();

    fireEvent.click(screen.getByText('consumesApi'));
    await waitFor(() =>
      expect(getSubgraph).toHaveBeenCalledWith(
        expect.objectContaining({
          relationTypes: ['consumesApi'],
        }),
      ),
    );

    fireEvent.click(screen.getByText('Ask Graph'));
    expect(
      await screen.findByText('Checkout service depends on orders-spanner-db.'),
    ).toBeInTheDocument();
    const matchedChip = await screen.findByRole('button', {
      name: 'resource:default/orders-spanner-db',
    });
    expect(matchedChip).toBeInTheDocument();

    fireEvent.click(matchedChip);
    await waitFor(() =>
      expect(getSubgraph).toHaveBeenCalledWith(
        expect.objectContaining({
          root: 'resource:default/orders-spanner-db',
        }),
      ),
    );
  });

  it('falls back to initialMaxDepth and initialDirection when URL query parameters are out of range or invalid', async () => {
    const getSubgraph = jest.fn().mockResolvedValue({
      rootEntityRef: 'component:default/checkout-service',
      depth: 3,
      nodes: [],
      edges: [],
      truncated: false,
      queryDurationMs: 5,
    });

    const mockApi: SpannerGraphApi = {
      getSubgraph,
      askNaturalLanguage: jest.fn(),
    };

    await renderInTestApp(
      <TestApiProvider apis={[[spannerGraphApiRef, mockApi]]}>
        <SpannerGraphPage initialMaxDepth={3} initialDirection="both" />
      </TestApiProvider>,
      {
        routeEntries: [
          '/spanner-graph?maxDepth=99&direction=invalid&relationTypes=dependsOn,dependencyOf',
        ],
      },
    );

    await waitFor(() =>
      expect(getSubgraph).toHaveBeenCalledWith(
        expect.objectContaining({
          maxDepth: 3,
          direction: 'both',
          relationTypes: ['dependsOn', 'dependencyOf'],
        }),
      ),
    );
  });

  it('renders an app-config.yaml setup snippet when spannerGraph.aiServiceUrl is not configured', async () => {
    const mockApi: SpannerGraphApi = {
      getSubgraph: jest.fn(),
      askNaturalLanguage: jest
        .fn()
        .mockRejectedValue(
          new Error(
            'Request failed with 400 Bad Request, Natural language graph queries require spannerGraph.aiServiceUrl to be configured.',
          ),
        ),
    };

    await renderInTestApp(
      <TestApiProvider apis={[[spannerGraphApiRef, mockApi]]}>
        <SpannerNaturalQueryCard />
      </TestApiProvider>,
    );

    fireEvent.click(screen.getByText('Ask Graph'));
    expect(
      await screen.findByText('Natural Language AI Service Not Configured'),
    ).toBeInTheDocument();
    expect(
      await screen.findByText(
        /Configure spannerGraph\.aiServiceUrl in app-config\.yaml/i,
      ),
    ).toBeInTheDocument();
  });
});
