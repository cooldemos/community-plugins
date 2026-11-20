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
import { coreExtensionData } from '@backstage/frontend-plugin-api';
import { createExtensionTester } from '@backstage/frontend-test-utils';
import { EntityContentBlueprint } from '@backstage/plugin-catalog-react/alpha';
import spannerGraphAlphaPlugin, {
  entitySpannerBlastRadiusContent,
  entitySpannerGraphCard,
  spannerGraphPage,
} from './alpha';

describe('alpha (New Frontend System blueprints)', () => {
  it('registers API, entity card, blast radius entity content, and page extensions on the plugin', () => {
    expect(
      spannerGraphAlphaPlugin.getExtension('api:spanner-graph'),
    ).toBeDefined();
    expect(
      spannerGraphAlphaPlugin.getExtension(
        'entity-card:spanner-graph/spanner-dependencies',
      ),
    ).toBeDefined();
    expect(
      spannerGraphAlphaPlugin.getExtension(
        'entity-content:spanner-graph/blast-radius',
      ),
    ).toBeDefined();
    expect(
      spannerGraphAlphaPlugin.getExtension('page:spanner-graph'),
    ).toBeDefined();
  });

  it('configures default paths, titles, and FilterPredicate on entity content and page blueprints', () => {
    const contentTester = createExtensionTester(
      entitySpannerBlastRadiusContent,
    );
    expect(contentTester.get(EntityContentBlueprint.dataRefs.title)).toBe(
      'Blast Radius (Spanner Graph)',
    );
    expect(contentTester.get(coreExtensionData.routePath)).toBe(
      '/blast-radius',
    );

    const pageTester = createExtensionTester(spannerGraphPage);
    expect(pageTester.get(coreExtensionData.routePath)).toBe('/spanner-graph');

    const cardTester = createExtensionTester(entitySpannerGraphCard);
    expect(cardTester.get(coreExtensionData.reactElement)).toBeDefined();
  });
});
