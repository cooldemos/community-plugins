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
import {
  normalizeEntityRef,
  transformEntityRelationsToSpannerEdges,
  transformEntityToSpannerNode,
} from './transformer';

describe('transformer', () => {
  const fixedNow = '2026-01-15T10:00:00.000Z';

  it('normalizes kind and namespace to lowercase while preserving entity name casing', () => {
    expect(normalizeEntityRef('Component:Default/Checkout-Service')).toBe(
      'component:default/Checkout-Service',
    );
  });

  it('defaults omitted kind to component and omitted namespace to default, and rejects blank refs', () => {
    expect(normalizeEntityRef('payment-worker')).toBe(
      'component:default/payment-worker',
    );
    expect(normalizeEntityRef('API:payment-grpc-api')).toBe(
      'api:default/payment-grpc-api',
    );
    expect(normalizeEntityRef('Commerce/order-api')).toBe(
      'component:commerce/order-api',
    );
    expect(() => normalizeEntityRef('   ')).toThrow(
      'Entity reference cannot be empty',
    );
  });

  it('transforms a Backstage Entity into a normalized SpannerEntityRow', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-checkout-1',
        etag: 'etag-123',
        name: 'Checkout-Service',
        namespace: 'Commerce',
        title: 'Checkout Orchestrator',
        description: 'Handles order placement',
      },
      spec: {
        type: 'service',
        lifecycle: 'production',
        owner: 'Group:Default/checkout-squad',
        system: 'System:Commerce/Checkout-System',
      },
    };

    const row = transformEntityToSpannerNode(entity, 'sync-run-42', fixedNow);

    expect(row).toEqual({
      entity_id: 'uid-checkout-1',
      entity_ref: 'component:commerce/Checkout-Service',
      api_version: 'backstage.io/v1alpha1',
      kind: 'component',
      namespace: 'commerce',
      name: 'Checkout-Service',
      title: 'Checkout Orchestrator',
      description: 'Handles order placement',
      lifecycle: 'production',
      owner_ref: 'group:default/checkout-squad',
      system_ref: 'system:commerce/Checkout-System',
      metadata_json: entity.metadata,
      spec_json: entity.spec,
      etag: 'etag-123',
      updated_at: fixedNow,
      sync_run_id: 'sync-run-42',
    });
  });

  it('falls back to entity_ref when metadata.uid is absent and populates null optional columns', () => {
    const minimalEntity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Resource',
      metadata: {
        name: 'orders-spanner-db',
      },
    };

    const row = transformEntityToSpannerNode(
      minimalEntity,
      'sync-run-99',
      fixedNow,
    );

    expect(row.entity_id).toBe('resource:default/orders-spanner-db');
    expect(row.entity_ref).toBe('resource:default/orders-spanner-db');
    expect(row.kind).toBe('resource');
    expect(row.namespace).toBe('default');
    expect(row.title).toBeNull();
    expect(row.description).toBeNull();
    expect(row.lifecycle).toBeNull();
    expect(row.owner_ref).toBeNull();
    expect(row.system_ref).toBeNull();
    expect(row.etag).toBeNull();
  });

  it('transforms and deduplicates entity relations by composite key', () => {
    const entity: Entity = {
      apiVersion: 'backstage.io/v1alpha1',
      kind: 'Component',
      metadata: {
        uid: 'uid-checkout-1',
        name: 'checkout-service',
      },
      relations: [
        {
          type: 'dependsOn',
          targetRef: 'Resource:Default/orders-spanner-db',
        },
        {
          type: 'dependsOn',
          targetRef: 'resource:default/orders-spanner-db',
        },
        {
          type: 'consumesApi',
          targetRef: 'API:default/payment-grpc-api',
        },
      ],
    };

    const edges = transformEntityRelationsToSpannerEdges(
      entity,
      'sync-run-42',
      fixedNow,
    );

    expect(edges).toEqual([
      {
        entity_id: 'uid-checkout-1',
        source_entity_ref: 'component:default/checkout-service',
        target_entity_ref: 'resource:default/orders-spanner-db',
        relation_type: 'dependsOn',
        updated_at: fixedNow,
        sync_run_id: 'sync-run-42',
      },
      {
        entity_id: 'uid-checkout-1',
        source_entity_ref: 'component:default/checkout-service',
        target_entity_ref: 'api:default/payment-grpc-api',
        relation_type: 'consumesApi',
        updated_at: fixedNow,
        sync_run_id: 'sync-run-42',
      },
    ]);
  });
});
