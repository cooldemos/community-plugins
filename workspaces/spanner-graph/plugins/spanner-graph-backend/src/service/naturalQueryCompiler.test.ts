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
    expect(compiled.params).toEqual({
      rootRef: 'resource:default/orders-spanner-db',
      maxPaths: 250,
      relationTypes: ['dependsOn', 'consumesApi'],
      entityKinds: ['component'],
      lifecycle: 'production',
    });
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
