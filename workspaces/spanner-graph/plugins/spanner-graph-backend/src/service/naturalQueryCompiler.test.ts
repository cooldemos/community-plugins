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
import {
  compileNaturalGraphQuery,
  NaturalGraphQueryIntentSchema,
  normalizeEntityRef,
  resolveEntityRefInSpanner,
} from './naturalQueryCompiler';

describe('naturalQueryCompiler', () => {
  it('validates structured intents and compiles parameterized ACYCLIC ISO GQL queries', () => {
    const intent = NaturalGraphQueryIntentSchema.parse({
      rootEntityRef: 'resource:default/orders-spanner-db',
      direction: 'incoming',
      maxDepth: 4,
      relationTypes: ['dependsOn', 'consumesApi'],
      entityKinds: ['Component'],
      lifecycle: 'Production',
      summaryTemplate: 'Production components impacted by orders-spanner-db',
    });

    const compiled = compileNaturalGraphQuery({
      graphName: 'BackstageCatalogGraph',
      rootEntityRef: intent.rootEntityRef,
      intent,
      maxAllowedDepth: 5,
      maxPaths: 250,
    });

    expect(compiled.depth).toBe(4);
    expect(compiled.sql).toContain('GRAPH BackstageCatalogGraph');
    expect(compiled.sql).toContain(
      'MATCH p = ACYCLIC (start:Entity {entity_ref: @rootRef})(<-[e:Relation WHERE e.relation_type IN UNNEST(@relationTypes)]-){1,4}(target:Entity)',
    );
    expect(compiled.sql).toContain(
      'WHERE target.kind IN UNNEST(@entityKinds) AND LOWER(target.lifecycle) = @lifecycle',
    );
    expect(compiled.sql).toContain(
      'RETURN SAFE_TO_JSON(p) AS path, target.entity_ref AS target_ref',
    );
    expect(compiled.params).toEqual({
      rootRef: 'resource:default/orders-spanner-db',
      maxPaths: 250,
      relationTypes: ['dependsOn', 'consumesApi'],
      entityKinds: ['component'],
      lifecycle: 'production',
    });
  });

  it('rejects hallucinated relationTypes and coerces null optional intent fields to undefined', () => {
    const invalidResult = NaturalGraphQueryIntentSchema.safeParse({
      rootEntityRef: 'orders-spanner-db',
      direction: 'incoming',
      maxDepth: 2,
      relationTypes: ['dependsOn', 'inventedRelation'],
    });
    expect(invalidResult.success).toBe(false);

    const nullableIntent = NaturalGraphQueryIntentSchema.parse({
      rootEntityRef: 'orders-spanner-db',
      direction: 'incoming',
      maxDepth: 2,
      relationTypes: null,
      entityKinds: null,
      lifecycle: null,
      summaryTemplate: null,
    });
    expect(nullableIntent).toEqual({
      rootEntityRef: 'orders-spanner-db',
      direction: 'incoming',
      maxDepth: 2,
      relationTypes: undefined,
      entityKinds: undefined,
      lifecycle: undefined,
      summaryTemplate: undefined,
    });
  });

  it('runs exact point-seek lookup via idx_entities_name preserving qualifiers before case-insensitive fallback', async () => {
    const mockDbExact = {
      run: jest
        .fn()
        .mockResolvedValueOnce([
          [{ entity_ref: 'resource:payments/orders-spanner-db' }],
        ]),
    };

    const resolvedQualified = await resolveEntityRefInSpanner(
      mockDbExact,
      'payments/orders-spanner-db',
    );
    expect(resolvedQualified).toBe('resource:payments/orders-spanner-db');
    expect(mockDbExact.run).toHaveBeenCalledTimes(1);
    expect(mockDbExact.run.mock.calls[0][0].sql).toContain(
      'entities@{FORCE_INDEX=idx_entities_name}',
    );
    expect(mockDbExact.run.mock.calls[0][0].sql).toContain(
      'WHERE name = @shortName',
    );
    expect(mockDbExact.run.mock.calls[0][0].sql).toContain(
      'namespace = @explicitNamespace',
    );
    expect(mockDbExact.run.mock.calls[0][0].params).toEqual({
      shortName: 'orders-spanner-db',
      fallbackRef: 'component:payments/orders-spanner-db',
      explicitNamespace: 'payments',
    });

    const mockDbFallback = {
      run: jest
        .fn()
        .mockResolvedValueOnce([[]])
        .mockResolvedValueOnce([
          [{ entity_ref: 'resource:default/Orders-Spanner-DB' }],
        ]),
    };

    const resolvedCaseInsensitive = await resolveEntityRefInSpanner(
      mockDbFallback,
      'resource:orders-spanner-db',
    );
    expect(resolvedCaseInsensitive).toBe('resource:default/Orders-Spanner-DB');
    expect(mockDbFallback.run).toHaveBeenCalledTimes(2);
    expect(mockDbFallback.run.mock.calls[0][0].sql).toContain(
      'kind = @explicitKind',
    );
    expect(mockDbFallback.run.mock.calls[1][0].sql).toContain(
      'LOWER(name) = LOWER(@shortName)',
    );
    expect(mockDbFallback.run.mock.calls[1][0].sql).toContain(
      'kind = @explicitKind',
    );
  });

  it('normalizes entity references and resolves short names via Spanner', async () => {
    expect(normalizeEntityRef('orders-spanner-db', 'resource')).toBe(
      'resource:default/orders-spanner-db',
    );
    expect(
      normalizeEntityRef('Component:Payments/Checkout-Service', 'component'),
    ).toBe('component:payments/Checkout-Service');

    const mockDb = {
      run: jest
        .fn()
        .mockResolvedValue([
          [{ entity_ref: 'resource:default/orders-spanner-db' }],
        ]),
    };

    const resolvedShort = await resolveEntityRefInSpanner(
      mockDb,
      'orders-spanner-db',
    );
    expect(resolvedShort).toBe('resource:default/orders-spanner-db');
    expect(mockDb.run).toHaveBeenCalledTimes(1);

    const resolvedFull = await resolveEntityRefInSpanner(
      mockDb,
      'component:default/checkout-service',
    );
    expect(resolvedFull).toBe('component:default/checkout-service');
    expect(mockDb.run).toHaveBeenCalledTimes(1);
  });

  it('rejects unsafe graph identifiers', () => {
    expect(() =>
      compileNaturalGraphQuery({
        graphName: 'Bad-Graph; DROP TABLE entities',
        rootEntityRef: 'component:default/checkout-service',
        intent: {
          rootEntityRef: 'component:default/checkout-service',
          direction: 'both',
          maxDepth: 2,
        },
      }),
    ).toThrow(/Invalid Spanner Graph identifier/);
  });
});
