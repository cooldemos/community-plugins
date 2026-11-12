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
import { Entity } from '@backstage/catalog-model';
import { EntityProvider } from '@backstage/plugin-catalog-react';
import { renderInTestApp, TestApiProvider } from '@backstage/test-utils';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { SpannerGraphApi, spannerGraphApiRef } from '../api/types';
import {
  BLAST_RADIUS_RELATIONS,
  mergeParallelEdges,
  SpannerCatalogGraphCard,
} from './SpannerCatalogGraphCard';

describe('SpannerCatalogGraphCard', () => {
  const mockEntity: Entity = {
    apiVersion: 'backstage.io/v1alpha1',
    kind: 'Component',
    metadata: {
      name: 'checkout-service',
      namespace: 'default',
    },
  };

  it('renders subgraph nodes, merges parallel and reciprocal edges, and preserves relationTypes in explorer deep-link', async () => {
    const getSubgraph = jest.fn().mockResolvedValue({
      rootEntityRef: 'component:default/checkout-service',
      depth: 2,
      nodes: [
        {
          id: 'component:default/checkout-service',
          kind: 'component',
          namespace: 'default',
          name: 'checkout-service',
          title: 'Checkout Service',
        },
        {
          id: 'resource:default/orders-spanner-db',
          kind: 'resource',
          namespace: 'default',
          name: 'orders-spanner-db',
          title: 'Orders Spanner DB',
        },
      ],
      edges: [
        {
          from: 'component:default/checkout-service',
          to: 'resource:default/orders-spanner-db',
          type: 'dependsOn',
          label: 'dependsOn',
        },
        {
          from: 'resource:default/orders-spanner-db',
          to: 'component:default/checkout-service',
          type: 'dependencyOf',
          label: 'dependencyOf',
        },
        {
          from: 'component:default/checkout-service',
          to: 'resource:default/orders-spanner-db',
          type: 'consumesApi',
          label: 'consumesApi',
        },
      ],
      truncated: false,
      queryDurationMs: 14,
    });

    const mockApi: SpannerGraphApi = {
      getSubgraph,
      askNaturalLanguage: jest.fn(),
    };

    await renderInTestApp(
      <TestApiProvider apis={[[spannerGraphApiRef, mockApi]]}>
        <EntityProvider entity={mockEntity}>
          <SpannerCatalogGraphCard relationTypes={BLAST_RADIUS_RELATIONS} />
        </EntityProvider>
      </TestApiProvider>,
    );

    expect(await screen.findByText('checkout-service')).toBeInTheDocument();
    expect(await screen.findByText('orders-spanner-db')).toBeInTheDocument();
    expect(await screen.findByText('1 edges')).toBeInTheDocument();

    const explorerLink = screen.getByRole('link', {
      name: /Open in Spanner Graph Explorer/i,
    });
    expect(explorerLink.getAttribute('href')).toContain(
      `relationTypes=${encodeURIComponent(BLAST_RADIUS_RELATIONS.join(','))}`,
    );

    fireEvent.mouseDown(screen.getByLabelText('Relations'));
    fireEvent.click(await screen.findByText('Hierarchy & Ownership'));

    await waitFor(() =>
      expect(getSubgraph).toHaveBeenCalledWith(
        expect.objectContaining({
          relationTypes: [
            'partOf',
            'hasPart',
            'ownedBy',
            'ownerOf',
            'childOf',
            'parentOf',
          ],
        }),
      ),
    );

    const merged = mergeParallelEdges([
      {
        from: 'component:default/checkout-service',
        to: 'resource:default/orders-spanner-db',
        type: 'dependsOn',
      },
      {
        from: 'resource:default/orders-spanner-db',
        to: 'component:default/checkout-service',
        type: 'dependencyOf',
      },
      {
        from: 'component:default/checkout-service',
        to: 'resource:default/orders-spanner-db',
        type: 'consumesApi',
      },
    ]);
    expect(merged).toEqual([
      {
        from: 'component:default/checkout-service',
        to: 'resource:default/orders-spanner-db',
        type: 'dependsOn / consumesApi',
        label: 'dependsOn / consumesApi',
      },
    ]);

    const unmergedReciprocal = mergeParallelEdges(
      [
        {
          from: 'component:default/checkout-service',
          to: 'resource:default/orders-spanner-db',
          type: 'dependsOn',
        },
        {
          from: 'resource:default/orders-spanner-db',
          to: 'component:default/checkout-service',
          type: 'dependencyOf',
        },
      ],
      { mergeReciprocal: false },
    );
    expect(unmergedReciprocal).toHaveLength(2);
  });
});
