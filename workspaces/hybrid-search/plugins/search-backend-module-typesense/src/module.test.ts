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
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';
import { searchModuleTypesenseSearch } from './module';
import { searchModuleTypesenseHybridSearch } from './hybrid';
import { TypesenseSearchEngine } from './TypesenseSearchEngine';

// Mock Typesense Client
jest.mock('typesense', () => {
  return {
    Client: jest.fn().mockImplementation(() => {
      return {
        collections: jest.fn().mockReturnValue({
          documents: jest.fn().mockReturnValue({
            search: jest.fn(),
            upsert: jest.fn(),
            delete: jest.fn(),
          }),
        }),
      };
    }),
  };
});

describe('search-backend-module-typesense modules', () => {
  const typesenseConfigData = {
    search: {
      engines: {
        typesense: {
          apiKey: 'test-api-key',
          nodes: [
            {
              host: 'localhost',
              port: 8108,
              protocol: 'http',
            },
          ],
        },
      },
    },
  };

  describe('searchModuleTypesenseSearch (Standalone)', () => {
    it('should boot and register Typesense directly into the main search engine registry', async () => {
      const searchEngineRegistryMock = {
        setSearchEngine: jest.fn(),
      };

      await startTestBackend({
        extensionPoints: [
          [searchEngineRegistryExtensionPoint, searchEngineRegistryMock],
        ],
        features: [
          searchModuleTypesenseSearch,
          mockServices.rootConfig.factory({
            data: typesenseConfigData,
          }),
        ],
      });

      expect(searchEngineRegistryMock.setSearchEngine).toHaveBeenCalledTimes(1);
      const registeredEngine =
        searchEngineRegistryMock.setSearchEngine.mock.calls[0][0];
      expect(registeredEngine).toBeInstanceOf(TypesenseSearchEngine);
    });
  });

  describe('searchModuleTypesenseHybridSearch (Hybrid)', () => {
    it('should register Typesense to the hybrid registry with default fallback type software-catalog', async () => {
      const hybridRegistryMock = {
        registerEngine: jest.fn(),
      };

      await startTestBackend({
        extensionPoints: [
          [hybridSearchEngineRegistryExtensionPoint, hybridRegistryMock],
        ],
        features: [
          searchModuleTypesenseHybridSearch,
          mockServices.rootConfig.factory({
            data: typesenseConfigData, // No custom routing config
          }),
        ],
      });

      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledTimes(1);
      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledWith(
        'typesense',
        expect.any(TypesenseSearchEngine),
        { supportsTypes: ['software-catalog'] }, // Fallback default
      );
    });

    it('should discover supported types from hybrid routing config and register them', async () => {
      const hybridRegistryMock = {
        registerEngine: jest.fn(),
      };

      const customRoutingConfig = {
        search: {
          engines: {
            ...typesenseConfigData.search.engines,
            hybrid: {
              routing: {
                'custom-catalog': 'typesense',
                'another-type': 'typesense',
                techdocs: 'vertexai', // Should ignore this
              },
            },
          },
        },
      };

      await startTestBackend({
        extensionPoints: [
          [hybridSearchEngineRegistryExtensionPoint, hybridRegistryMock],
        ],
        features: [
          searchModuleTypesenseHybridSearch,
          mockServices.rootConfig.factory({
            data: customRoutingConfig,
          }),
        ],
      });

      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledTimes(1);
      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledWith(
        'typesense',
        expect.any(TypesenseSearchEngine),
        { supportsTypes: ['custom-catalog', 'another-type'] }, // Discovered types
      );
    });
  });
});
