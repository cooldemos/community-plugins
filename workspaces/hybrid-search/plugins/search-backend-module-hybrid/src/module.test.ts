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

import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { searchEngineRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';
import { createBackendModule } from '@backstage/backend-plugin-api';
import { Writable } from 'node:stream';
import { searchModuleHybridSearch } from './module';
import { hybridSearchEngineRegistryExtensionPoint } from './extensions';
import { HybridSearchEngine } from './HybridSearchEngine';

describe('searchModuleHybridSearch', () => {
  it('should boot, register the extension point, configure the orchestrator, and register sub-engines', async () => {
    const searchEngineRegistryMock = {
      setSearchEngine: jest.fn(),
    };

    const mockWritableStream = new Writable({
      objectMode: true,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });

    const mockSubEngine = {
      setTranslator: jest.fn(),
      getIndexer: jest.fn().mockResolvedValue(mockWritableStream),
      query: jest.fn(),
    };

    // A dummy search module simulating a sub-engine registering itself to the hybrid search registry
    const testSubEngineModule = createBackendModule({
      pluginId: 'search',
      moduleId: 'test-sub-engine',
      register(env) {
        env.registerInit({
          deps: {
            hybridRegistry: hybridSearchEngineRegistryExtensionPoint,
          },
          async init({ hybridRegistry }) {
            hybridRegistry.registerEngine('mock-engine', mockSubEngine as any, {
              supportsTypes: ['mock-type'],
            });
          },
        });
      },
    });

    await startTestBackend({
      extensionPoints: [
        [searchEngineRegistryExtensionPoint, searchEngineRegistryMock],
      ],
      features: [
        searchModuleHybridSearch,
        testSubEngineModule,
        mockServices.rootConfig.factory({
          data: {
            search: {
              engines: {
                hybrid: {
                  mergeStrategy: 'score-normalized-sort',
                },
              },
            },
          },
        }),
      ],
    });

    // 1. Verify that the Hybrid Search Engine orchestrator was registered to the search registry
    expect(searchEngineRegistryMock.setSearchEngine).toHaveBeenCalledTimes(1);
    const registeredEngine =
      searchEngineRegistryMock.setSearchEngine.mock.calls[0][0];
    expect(registeredEngine).toBeInstanceOf(HybridSearchEngine);

    // 2. Verify that the registered sub-engine was wired into the orchestrator by trying to resolve its indexer
    const indexer = await (registeredEngine as HybridSearchEngine).getIndexer(
      'mock-type',
    );
    expect(mockSubEngine.getIndexer).toHaveBeenCalledWith('mock-type');
    expect(indexer).toBe(mockWritableStream);
  });
});
