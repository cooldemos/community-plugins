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
import { createServiceFactory } from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { searchModuleVertexAISearch } from './module';
import { searchModuleVertexAISearchHybrid } from './hybrid';
import { VertexAISearchEngine } from './VertexAISearchEngine';

// Mock Google Cloud Discovery Engine
jest.mock('@google-cloud/discoveryengine', () => {
  return {
    SearchServiceClient: jest.fn().mockImplementation(() => {
      return {
        search: jest.fn(),
      };
    }),
    DocumentServiceClient: jest.fn().mockImplementation(() => {
      return {
        projectLocationCollectionDataStoreBranchPath: jest
          .fn()
          .mockReturnValue('mock-path'),
        importDocuments: jest.fn(),
      };
    }),
  };
});

describe('search-backend-module-vertexai modules', () => {
  const mockCatalogFactory = createServiceFactory({
    service: catalogServiceRef,
    deps: {},
    async factory() {
      return {
        getEntityByRef: jest.fn(),
      } as any;
    },
  });

  const baseConfigData = {
    search: {
      engines: {
        vertexai: {
          types: {
            techdocs: {
              datastore: {
                projectId: 'my-project',
                datastoreId: 'techdocs-ds',
                location: 'europe-west4',
              },
            },
          },
        },
      },
    },
  };

  describe('searchModuleVertexAISearch (Standalone)', () => {
    let schedulerMock: { scheduleTask: jest.Mock };
    let schedulerMockService: any;

    beforeEach(() => {
      schedulerMock = {
        scheduleTask: jest.fn(),
      };
      schedulerMockService = mockServices.scheduler.mock(schedulerMock as any);
    });

    it('should boot, register the engine, and schedule cleanup task with default 2 hours frequency', async () => {
      const searchEngineRegistryMock = {
        setSearchEngine: jest.fn(),
      };

      await startTestBackend({
        extensionPoints: [
          [searchEngineRegistryExtensionPoint, searchEngineRegistryMock],
        ],
        features: [
          searchModuleVertexAISearch,
          mockCatalogFactory,
          schedulerMockService.factory,
          mockServices.rootConfig.factory({
            data: baseConfigData,
          }),
        ],
      });

      expect(searchEngineRegistryMock.setSearchEngine).toHaveBeenCalledTimes(1);
      expect(
        searchEngineRegistryMock.setSearchEngine.mock.calls[0][0],
      ).toBeInstanceOf(VertexAISearchEngine);

      // Verify default cleanup sweeper task scheduling
      expect(schedulerMock.scheduleTask).toHaveBeenCalledTimes(1);
      expect(schedulerMock.scheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'techdocs-orphan-sweeper',
          frequency: { hours: 2 },
        }),
      );
    });

    it('should schedule cleanup task with custom frequency (seconds/hours/minutes) from config', async () => {
      const customFrequencyConfig = {
        search: {
          engines: {
            vertexai: {
              ...baseConfigData.search.engines.vertexai,
              cleanup: {
                frequency: {
                  seconds: 30,
                },
              },
            },
          },
        },
      };

      await startTestBackend({
        extensionPoints: [
          [searchEngineRegistryExtensionPoint, { setSearchEngine: jest.fn() }],
        ],
        features: [
          searchModuleVertexAISearch,
          mockCatalogFactory,
          schedulerMockService.factory,
          mockServices.rootConfig.factory({
            data: customFrequencyConfig,
          }),
        ],
      });

      expect(schedulerMock.scheduleTask).toHaveBeenCalledTimes(1);
      expect(schedulerMock.scheduleTask).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'techdocs-orphan-sweeper',
          frequency: { seconds: 30 },
        }),
      );
    });

    it('should NOT schedule cleanup task if techdocs indexing is enabled', async () => {
      const indexingEnabledConfig = {
        search: {
          engines: {
            vertexai: {
              ...baseConfigData.search.engines.vertexai,
              indexing: {
                enabled: true, // Enable indexing globally (techdocs inherits it)
              },
            },
          },
        },
      };

      await startTestBackend({
        extensionPoints: [
          [searchEngineRegistryExtensionPoint, { setSearchEngine: jest.fn() }],
        ],
        features: [
          searchModuleVertexAISearch,
          mockCatalogFactory,
          schedulerMockService.factory,
          mockServices.rootConfig.factory({
            data: indexingEnabledConfig,
          }),
        ],
      });

      expect(schedulerMock.scheduleTask).not.toHaveBeenCalled();
    });

    it('should NOT schedule cleanup task if explicitly disabled in configuration', async () => {
      const cleanupDisabledConfig = {
        search: {
          engines: {
            vertexai: {
              ...baseConfigData.search.engines.vertexai,
              cleanup: {
                enabled: false,
              },
            },
          },
        },
      };

      await startTestBackend({
        extensionPoints: [
          [searchEngineRegistryExtensionPoint, { setSearchEngine: jest.fn() }],
        ],
        features: [
          searchModuleVertexAISearch,
          mockCatalogFactory,
          schedulerMockService.factory,
          mockServices.rootConfig.factory({
            data: cleanupDisabledConfig,
          }),
        ],
      });

      expect(schedulerMock.scheduleTask).not.toHaveBeenCalled();
    });
  });

  describe('searchModuleVertexAISearchHybrid (Hybrid)', () => {
    it('should register Vertex AI Search into the hybrid registry with fallback default type techdocs', async () => {
      const hybridRegistryMock = {
        registerEngine: jest.fn(),
      };

      await startTestBackend({
        extensionPoints: [
          [hybridSearchEngineRegistryExtensionPoint, hybridRegistryMock],
        ],
        features: [
          searchModuleVertexAISearchHybrid,
          mockCatalogFactory,
          mockServices.rootConfig.factory({
            data: baseConfigData,
          }),
        ],
      });

      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledTimes(1);
      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledWith(
        'vertexai',
        expect.any(VertexAISearchEngine),
        { supportsTypes: ['techdocs'] },
      );
    });

    it('should discover supported types from hybrid routing config and register them', async () => {
      const hybridRegistryMock = {
        registerEngine: jest.fn(),
      };

      const routingConfig = {
        search: {
          engines: {
            ...baseConfigData.search.engines,
            hybrid: {
              routing: {
                'custom-techdocs': 'vertexai',
                techdocs: 'vertexai',
                catalog: 'typesense', // Should ignore this
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
          searchModuleVertexAISearchHybrid,
          mockCatalogFactory,
          mockServices.rootConfig.factory({
            data: routingConfig,
          }),
        ],
      });

      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledTimes(1);
      expect(hybridRegistryMock.registerEngine).toHaveBeenCalledWith(
        'vertexai',
        expect.any(VertexAISearchEngine),
        { supportsTypes: ['custom-techdocs', 'techdocs'] },
      );
    });

    it('should throw an error on configuration conflict (blended engineId + hybrid routing delegating to other engines)', async () => {
      const hybridRegistryMock = {
        registerEngine: jest.fn(),
      };

      const conflictingConfig = {
        search: {
          engines: {
            vertexai: {
              ...baseConfigData.search.engines.vertexai,
              blendedSearch: {
                projectId: 'my-project',
                location: 'europe-west4',
                engineId: 'global-blended-app',
              },
            },
            hybrid: {
              routing: {
                techdocs: 'vertexai',
                catalog: 'typesense', // Delegating catalog to Typesense!
              },
            },
          },
        },
      };

      // Assert that booting the backend rejects/throws the conflict validation error
      await expect(
        startTestBackend({
          extensionPoints: [
            [hybridSearchEngineRegistryExtensionPoint, hybridRegistryMock],
          ],
          features: [
            searchModuleVertexAISearchHybrid,
            mockCatalogFactory,
            mockServices.rootConfig.factory({
              data: conflictingConfig,
            }),
          ],
        }),
      ).rejects.toThrow(
        /Configuration conflict: "search.engines.vertexai.blendedSearch.engineId" \(global blended search app\) cannot be configured when hybrid search routing is active/,
      );
    });
  });
});
