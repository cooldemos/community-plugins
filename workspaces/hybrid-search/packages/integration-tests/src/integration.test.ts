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

import crypto from 'crypto';
import { startTestBackend, mockServices } from '@backstage/backend-test-utils';
import {
  createServiceFactory,
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { SchedulerService } from '@backstage/backend-plugin-api';
import searchPlugin from '@backstage/plugin-search-backend';
import searchModuleTechDocsCollator from '@backstage/plugin-search-backend-module-techdocs';
import searchModuleCatalogCollator from '@backstage/plugin-search-backend-module-catalog';
import eventsPlugin from '@backstage/plugin-events-backend';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { searchModuleVertexAISearch } from '@backstage-community/plugin-search-backend-module-vertexai';
import { searchModuleVertexAISearchHybrid } from '@backstage-community/plugin-search-backend-module-vertexai/hybrid';
import { eventsModuleGcsEventarcWebhook } from '@backstage-community/plugin-events-backend-module-gcs-eventarc';
import { searchModuleHybridSearch } from '@backstage-community/plugin-search-backend-module-hybrid';
import { searchModuleTypesenseSearch } from '@backstage-community/plugin-search-backend-module-typesense';
import { searchModuleTypesenseHybridSearch } from '@backstage-community/plugin-search-backend-module-typesense/hybrid';
import request from 'supertest';

// Import our class-level SDK spies directly from the mocked modules!
import {
  mockSearch,
  mockImportDocuments,
  mockDeleteDocument,
} from './mockDiscoveryEngine';
import { mockDownload, mockGetFiles, mockDeleteFiles } from './mockStorage';
import { mockTypesenseSearch } from './mockTypesense';

// =========================================================================
// SCHEDULER SERVICE EXPOSER
// Custom backend module to intercept and expose the MockSchedulerService
// so tests can programmatically trigger scheduled tasks without timing hacks!
// =========================================================================
let globalScheduler: SchedulerService | undefined;

const schedulerExposerModule = createBackendModule({
  pluginId: 'search',
  moduleId: 'scheduler-exposer',
  register(env) {
    env.registerInit({
      deps: {
        scheduler: coreServices.scheduler,
      },
      async init({ scheduler }) {
        globalScheduler = scheduler;
      },
    });
  },
});

const originalFetch = global.fetch;

beforeAll(() => {
  jest.setTimeout(15000);
  global.fetch = jest.fn().mockImplementation((url: string) => {
    if (url.includes('search_index.json') || url.includes('/docs')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            docs: [
              {
                title: 'Intro',
                text: 'Welcome to Backstage',
                location: 'index.html',
              },
            ],
          }),
      } as any);
    }
    return originalFetch
      ? originalFetch(url)
      : Promise.reject(new Error(`Fetch not mocked for: ${url}`));
  });
});

afterEach(() => {
  jest.clearAllMocks(); // Automatically clears all Jest mock functions and spies!
  globalScheduler = undefined;
});

afterAll(() => {
  global.fetch = originalFetch;
});

describe('Search Architecture Integration Tests', () => {
  // =========================================================================
  // SCENARIO 1: Standalone Typesense Search
  // =========================================================================
  it('Scenario 1: Standalone Typesense Search executes global, type-specific, and filtered queries', async () => {
    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleTypesenseSearch, // Standalone Typesense primary engine
        searchModuleTechDocsCollator, // Register TechDocs collator to make 'techdocs' a valid type!
        searchModuleCatalogCollator, // Register Catalog collator to make 'software-catalog' a valid type!
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            search: {
              engines: {
                typesense: {
                  apiKey: 'test-key',
                  nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
                },
              },
            },
          },
        }),
      ],
    });
    const { server } = backend;

    try {
      // 1. Global Search (no type filters)
      const responseGlobal = await request(server)
        .get('/api/search/query')
        .query({ term: 'backstage' });
      expect(responseGlobal.status).toBe(200);
      expect(responseGlobal.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );

      // 2. TechDocs Search without filters
      const responseTechDocs = await request(server)
        .get('/api/search/query')
        .query({ term: 'docs', types: ['techdocs'] });
      expect(responseTechDocs.status).toBe(200);
      expect(responseTechDocs.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );

      // 3. TechDocs Search with filters
      const responseTechDocsFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'docs',
          types: ['techdocs'],
          'filters[kind]': 'Component',
        });
      expect(responseTechDocsFiltered.status).toBe(200);
      expect(responseTechDocsFiltered.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );
      expect(mockTypesenseSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter_by: expect.stringContaining('kind:=`Component`'),
        }),
      );

      // 4. Catalog Search without filters
      const responseCatalog = await request(server)
        .get('/api/search/query')
        .query({ term: 'catalog', types: ['software-catalog'] });
      expect(responseCatalog.status).toBe(200);
      expect(responseCatalog.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );

      // 5. Catalog Search with filters
      const responseCatalogFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'catalog',
          types: ['software-catalog'],
          'filters[kind]': 'API',
        });
      expect(responseCatalogFiltered.status).toBe(200);
      expect(responseCatalogFiltered.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );
      expect(mockTypesenseSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter_by: expect.stringContaining('kind:=`API`'),
        }),
      );
    } finally {
      await backend.stop();
    }
  }, 30000);

  // =========================================================================
  // SCENARIO 2: Standalone Vertex AI Search (Ingestion via Eventarc Webhook)
  // =========================================================================
  it('Scenario 2: Standalone Vertex AI Search receives webhook ingestion and executes global, type-specific, and filtered queries', async () => {
    const mockCatalogFactory = createServiceFactory({
      service: catalogServiceRef,
      deps: {},
      async factory() {
        return {
          getEntityByRef: jest.fn().mockResolvedValue({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Component',
            metadata: { name: 'my-comp', namespace: 'default' },
            spec: { owner: 'team-a', lifecycle: 'production', type: 'service' },
          }),
        } as any;
      },
    });

    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleVertexAISearch, // Standalone Vertex AI Search primary engine
        searchModuleTechDocsCollator, // Register TechDocs collator to make 'techdocs' valid
        searchModuleCatalogCollator, // Register Catalog collator to make 'software-catalog' valid
        eventsPlugin,
        eventsModuleGcsEventarcWebhook,
        mockCatalogFactory,
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            events: {
              modules: { gcsEventarcWebhook: { oidc: { enabled: false } } },
            },
            search: {
              engines: {
                vertexai: {
                  blendedSearch: {
                    projectId: 'my-project',
                    location: 'eu',
                    engineId: 'blended-app',
                  },
                  types: {
                    techdocs: {
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'techdocs-ds',
                        location: 'eu',
                      },
                    },
                    'software-catalog': {
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'catalog-ds',
                        location: 'eu',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
    });
    const { server } = backend;

    try {
      // Webhook Ingestion
      const responseWebhook = await request(server)
        .post('/api/events/gcs')
        .set('ce-type', 'google.cloud.storage.object.v1.finalized')
        .send({
          bucket: 'my-techdocs-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 987654,
        });
      expect(responseWebhook.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(mockImportDocuments).toHaveBeenCalled();

      // 1. Global Search
      const responseGlobal = await request(server)
        .get('/api/search/query')
        .query({ term: 'backstage' });
      expect(responseGlobal.status).toBe(200);
      expect(responseGlobal.body.results[0].document.title).toBe('Mock Page');

      // 2. TechDocs Search without filters
      const responseTechDocs = await request(server)
        .get('/api/search/query')
        .query({ term: 'docs', types: ['techdocs'] });
      expect(responseTechDocs.status).toBe(200);
      expect(responseTechDocs.body.results[0].document.title).toBe('Mock Page');

      // 3. TechDocs Search with filters
      const responseTechDocsFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'docs',
          types: ['techdocs'],
          'filters[kind]': 'Component',
        });
      expect(responseTechDocsFiltered.status).toBe(200);
      expect(responseTechDocsFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("component")' }),
      );

      // 4. Catalog Search without filters
      const responseCatalog = await request(server)
        .get('/api/search/query')
        .query({ term: 'catalog', types: ['software-catalog'] });
      expect(responseCatalog.status).toBe(200);
      expect(responseCatalog.body.results[0].document.title).toBe('Mock Page');

      // 5. Catalog Search with filters
      const responseCatalogFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'catalog',
          types: ['software-catalog'],
          'filters[kind]': 'API',
        });
      expect(responseCatalogFiltered.status).toBe(200);
      expect(responseCatalogFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("api")' }),
      );
    } finally {
      await backend.stop();
    }
  }, 30000);

  // =========================================================================
  // SCENARIO 3: Standalone Vertex AI Search (Ingestion via TechDocs Collator)
  // =========================================================================
  it('Scenario 3: Standalone Vertex AI Search receives collator indexing and executes global, type-specific, and filtered queries', async () => {
    const mockCatalogFactory = createServiceFactory({
      service: catalogServiceRef,
      deps: {},
      async factory() {
        return {
          getEntities: jest.fn().mockResolvedValue({
            items: [
              {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Component',
                metadata: {
                  name: 'my-comp',
                  namespace: 'default',
                  title: 'My Component',
                  annotations: { 'backstage.io/techdocs-ref': 'dir:.' },
                },
                spec: { owner: 'team-a', type: 'service' },
              },
            ],
          }),
        } as any;
      },
    });

    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleTechDocsCollator, // Register TechDocs collator
        searchModuleCatalogCollator, // Register Catalog collator
        searchModuleVertexAISearch, // Standalone Vertex AI Search primary engine
        mockCatalogFactory,
        schedulerExposerModule,
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            techdocs: {
              requestUrl: 'http://localhost:3000/docs',
              publisher: {
                type: 'googleGcs',
                googleGcs: { bucketName: 'my-techdocs-bucket' },
              },
            },
            search: {
              engines: {
                vertexai: {
                  blendedSearch: {
                    projectId: 'my-project',
                    location: 'eu',
                    engineId: 'blended-app',
                  },
                  types: {
                    techdocs: {
                      indexing: { enabled: true },
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'techdocs-ds',
                        location: 'eu',
                      },
                    },
                    'software-catalog': {
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'catalog-ds',
                        location: 'eu',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
    });
    const { server } = backend;

    try {
      // Trigger Ingestion
      expect(globalScheduler).toBeDefined();
      await globalScheduler!.triggerTask('search_index_techdocs');
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(mockImportDocuments).toHaveBeenCalled();

      // 1. Global Search
      const responseGlobal = await request(server)
        .get('/api/search/query')
        .query({ term: 'backstage' });
      expect(responseGlobal.status).toBe(200);
      expect(responseGlobal.body.results[0].document.title).toBe('Mock Page');

      // 2. TechDocs Search without filters
      const responseTechDocs = await request(server)
        .get('/api/search/query')
        .query({ term: 'docs', types: ['techdocs'] });
      expect(responseTechDocs.status).toBe(200);
      expect(responseTechDocs.body.results[0].document.title).toBe('Mock Page');

      // 3. TechDocs Search with filters
      const responseTechDocsFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'docs',
          types: ['techdocs'],
          'filters[kind]': 'Component',
        });
      expect(responseTechDocsFiltered.status).toBe(200);
      expect(responseTechDocsFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("component")' }),
      );

      // 4. Catalog Search without filters
      const responseCatalog = await request(server)
        .get('/api/search/query')
        .query({ term: 'catalog', types: ['software-catalog'] });
      expect(responseCatalog.status).toBe(200);
      expect(responseCatalog.body.results[0].document.title).toBe('Mock Page');

      // 5. Catalog Search with filters
      const responseCatalogFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'catalog',
          types: ['software-catalog'],
          'filters[kind]': 'API',
        });
      expect(responseCatalogFiltered.status).toBe(200);
      expect(responseCatalogFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("api")' }),
      );
    } finally {
      await backend.stop();
    }
  }, 30000);

  // =========================================================================
  // SCENARIO 4: Hybrid Search via Eventarc Webhook Ingestion
  // =========================================================================
  it('Scenario 4: Hybrid Search receives webhook ingestion and routes TechDocs queries to Vertex AI and Catalog to Typesense', async () => {
    const mockCatalogFactory = createServiceFactory({
      service: catalogServiceRef,
      deps: {},
      async factory() {
        return {
          getEntityByRef: jest.fn().mockResolvedValue({
            apiVersion: 'backstage.io/v1alpha1',
            kind: 'Component',
            metadata: { name: 'my-comp', namespace: 'default' },
            spec: { owner: 'team-a', lifecycle: 'production', type: 'service' },
          }),
        } as any;
      },
    });

    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleTechDocsCollator,
        searchModuleCatalogCollator,
        searchModuleHybridSearch, // Hybrid Orchestrator
        searchModuleVertexAISearchHybrid, // Vertex AI sub-engine (registers as 'vertexai')
        searchModuleTypesenseHybridSearch, // Typesense sub-engine! (registers as 'typesense')
        eventsPlugin,
        eventsModuleGcsEventarcWebhook,
        mockCatalogFactory,
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            events: {
              modules: { gcsEventarcWebhook: { oidc: { enabled: false } } },
            },
            search: {
              engines: {
                hybrid: {
                  routing: {
                    techdocs: 'vertexai',
                    'software-catalog': 'typesense',
                  },
                },
                typesense: {
                  apiKey: 'test-key',
                  nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
                },
                vertexai: {
                  types: {
                    techdocs: {
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'techdocs-ds',
                        location: 'eu',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
    });
    const { server } = backend;

    try {
      // Webhook Ingestion
      const responseWebhook = await request(server)
        .post('/api/events/gcs')
        .set('ce-type', 'google.cloud.storage.object.v1.finalized')
        .send({
          bucket: 'my-techdocs-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 987654,
        });
      expect(responseWebhook.status).toBe(200);
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(mockImportDocuments).toHaveBeenCalled();

      // 1. Global Search (hits both engines and merges results!)
      const responseGlobal = await request(server)
        .get('/api/search/query')
        .query({ term: 'backstage' });
      expect(responseGlobal.status).toBe(200);
      const titles = responseGlobal.body.results.map(
        (r: any) => r.document.title,
      );
      expect(titles).toContain('Mock Page'); // From Vertex AI sub-engine
      expect(titles).toContain('Mock Typesense Page'); // From Typesense sub-engine

      // 2. TechDocs Search without filters (routed to Vertex AI)
      const responseTechDocs = await request(server)
        .get('/api/search/query')
        .query({ term: 'docs', types: ['techdocs'] });
      expect(responseTechDocs.status).toBe(200);
      expect(responseTechDocs.body.results[0].document.title).toBe('Mock Page');

      // 3. TechDocs Search with filters (routed to Vertex AI)
      const responseTechDocsFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'docs',
          types: ['techdocs'],
          'filters[kind]': 'Component',
        });
      expect(responseTechDocsFiltered.status).toBe(200);
      expect(responseTechDocsFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("component")' }),
      );

      // 4. Catalog Search without filters (routed to Typesense)
      const responseCatalog = await request(server)
        .get('/api/search/query')
        .query({ term: 'catalog', types: ['software-catalog'] });
      expect(responseCatalog.status).toBe(200);
      expect(responseCatalog.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );

      // 5. Catalog Search with filters (routed to Typesense)
      const responseCatalogFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'catalog',
          types: ['software-catalog'],
          'filters[kind]': 'API',
        });
      expect(responseCatalogFiltered.status).toBe(200);
      expect(responseCatalogFiltered.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );
      expect(mockTypesenseSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter_by: expect.stringContaining('kind:=`API`'),
        }),
      );
    } finally {
      await backend.stop();
    }
  }, 30000);

  // =========================================================================
  // SCENARIO 5: Hybrid Search via TechDocs Collator Ingestion
  // =========================================================================
  it('Scenario 5: Hybrid Search receives collator indexing and routes TechDocs queries to Vertex AI and Catalog to Typesense', async () => {
    const mockCatalogFactory = createServiceFactory({
      service: catalogServiceRef,
      deps: {},
      async factory() {
        return {
          getEntities: jest.fn().mockResolvedValue({
            items: [
              {
                apiVersion: 'backstage.io/v1alpha1',
                kind: 'Component',
                metadata: {
                  name: 'my-comp',
                  namespace: 'default',
                  title: 'My Component',
                  annotations: { 'backstage.io/techdocs-ref': 'dir:.' },
                },
                spec: { owner: 'team-a', type: 'service' },
              },
            ],
          }),
        } as any;
      },
    });

    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleTechDocsCollator,
        searchModuleCatalogCollator,
        searchModuleHybridSearch, // Hybrid Orchestrator
        searchModuleVertexAISearchHybrid, // Vertex AI sub-engine
        searchModuleTypesenseHybridSearch, // Typesense sub-engine!
        mockCatalogFactory,
        schedulerExposerModule,
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            techdocs: {
              requestUrl: 'http://localhost:3000/docs',
              publisher: {
                type: 'googleGcs',
                googleGcs: { bucketName: 'my-techdocs-bucket' },
              },
            },
            search: {
              engines: {
                hybrid: {
                  routing: {
                    techdocs: 'vertexai',
                    'software-catalog': 'typesense',
                  },
                },
                typesense: {
                  apiKey: 'test-key',
                  nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
                },
                vertexai: {
                  types: {
                    techdocs: {
                      indexing: { enabled: true },
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'techdocs-ds',
                        location: 'eu',
                      },
                    },
                  },
                },
              },
            },
          },
        }),
      ],
    });
    const { server } = backend;

    try {
      // Trigger Ingestion
      expect(globalScheduler).toBeDefined();
      await globalScheduler!.triggerTask('search_index_techdocs');
      await new Promise(resolve => setTimeout(resolve, 500));
      expect(mockImportDocuments).toHaveBeenCalled();

      // 1. Global Search (hits both engines and merges results!)
      const responseGlobal = await request(server)
        .get('/api/search/query')
        .query({ term: 'backstage' });
      expect(responseGlobal.status).toBe(200);
      const titles = responseGlobal.body.results.map(
        (r: any) => r.document.title,
      );
      expect(titles).toContain('Mock Page'); // From Vertex AI sub-engine
      expect(titles).toContain('Mock Typesense Page'); // From Typesense sub-engine

      // 2. TechDocs Search without filters (routed to Vertex AI)
      const responseTechDocs = await request(server)
        .get('/api/search/query')
        .query({ term: 'docs', types: ['techdocs'] });
      expect(responseTechDocs.status).toBe(200);
      expect(responseTechDocs.body.results[0].document.title).toBe('Mock Page');

      // 3. TechDocs Search with filters (routed to Vertex AI)
      const responseTechDocsFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'docs',
          types: ['techdocs'],
          'filters[kind]': 'Component',
        });
      expect(responseTechDocsFiltered.status).toBe(200);
      expect(responseTechDocsFiltered.body.results[0].document.title).toBe(
        'Mock Page',
      );
      expect(mockSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({ filter: 'kind: ANY("component")' }),
      );

      // 4. Catalog Search without filters (routed to Typesense)
      const responseCatalog = await request(server)
        .get('/api/search/query')
        .query({ term: 'catalog', types: ['software-catalog'] });
      expect(responseCatalog.status).toBe(200);
      expect(responseCatalog.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );

      // 5. Catalog Search with filters (routed to Typesense)
      const responseCatalogFiltered = await request(server)
        .get('/api/search/query')
        .query({
          term: 'catalog',
          types: ['software-catalog'],
          'filters[kind]': 'API',
        });
      expect(responseCatalogFiltered.status).toBe(200);
      expect(responseCatalogFiltered.body.results[0].document.title).toBe(
        'Mock Typesense Page',
      );
      expect(mockTypesenseSearch).toHaveBeenLastCalledWith(
        expect.objectContaining({
          filter_by: expect.stringContaining('kind:=`API`'),
        }),
      );
    } finally {
      await backend.stop();
    }
  }, 30000);

  // =========================================================================
  // SCENARIO 6: TechDocs Orphan Sweeper Cleanup Simulation
  // =========================================================================
  it('Scenario 6: TechDocs Orphan Sweeper cleans up stale search indexes and static files when a component is deleted from the catalog', async () => {
    // 1. Define dynamic catalog state
    let activeCatalogEntities: any[] = [
      {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'stale-comp',
          namespace: 'default',
          title: 'Stale Component',
          annotations: { 'backstage.io/techdocs-ref': 'dir:.' },
        },
        spec: { owner: 'team-a', type: 'service' },
      },
    ];

    const mockCatalogFactory = createServiceFactory({
      service: catalogServiceRef,
      deps: {},
      async factory() {
        return {
          getEntities: jest.fn().mockImplementation(async () => ({
            items: activeCatalogEntities,
          })),
        } as any;
      },
    });

    // Mock GCS bucket to contain files for stale-comp
    mockGetFiles.mockResolvedValue([
      [
        { name: 'default/component/stale-comp/index.html' },
        { name: 'default/component/stale-comp/search_index.json' },
      ],
    ]);

    // Mock search_index.json download content containing page documents
    const mockStaleDocs = [
      { title: 'Stale Page 1', text: 'stale text 1', location: 'index.html' },
    ];
    mockDownload.mockResolvedValue([
      Buffer.from(JSON.stringify({ docs: mockStaleDocs })),
    ]);

    const backend = await startTestBackend({
      features: [
        searchPlugin,
        searchModuleTechDocsCollator,
        searchModuleCatalogCollator,
        searchModuleVertexAISearch, // Register Standalone Vertex AI module to boot the sweeper task!
        mockCatalogFactory,
        schedulerExposerModule,
        mockServices.rootLogger.factory({ level: 'info' }),
        mockServices.rootConfig.factory({
          data: {
            techdocs: {
              requestUrl: 'http://localhost:3000/docs',
              publisher: {
                type: 'googleGcs',
                googleGcs: { bucketName: 'my-techdocs-bucket' },
              },
            },
            search: {
              engines: {
                vertexai: {
                  blendedSearch: {
                    projectId: 'my-project',
                    location: 'eu',
                    engineId: 'blended-app',
                  },
                  types: {
                    techdocs: {
                      datastore: {
                        projectId: 'my-project',
                        datastoreId: 'techdocs-ds',
                        location: 'eu',
                      },
                    },
                  },
                  cleanup: {
                    enabled: true,
                    frequency: { hours: 2 },
                  },
                },
              },
            },
          },
        }),
      ],
    });

    try {
      expect(globalScheduler).toBeDefined();

      // SIMULATION: The component is deleted from the catalog!
      activeCatalogEntities = []; // Catalog is now empty

      // Trigger the scheduled techdocs cleanup sweeper task manually
      await globalScheduler!.triggerTask('techdocs-orphan-sweeper');

      // VERIFICATION:
      // 1. Stale index downloaded from GCS
      expect(mockGetFiles).toHaveBeenCalled();
      expect(mockDownload).toHaveBeenCalled();

      // 2. MD5 hashed document path is deleted from Vertex AI Search
      const cleanLocation = 'index.html';
      const canonicalPath = `/docs/default/component/stale-comp/${cleanLocation}`;
      const docId = crypto
        .createHash('md5')
        .update(canonicalPath)
        .digest('hex');
      expect(mockDeleteDocument).toHaveBeenCalledWith(
        expect.objectContaining({
          name: expect.stringContaining(`/documents/${docId}`),
        }),
      );

      // 3. Stale GCS bucket static files are purged
      expect(mockDeleteFiles).toHaveBeenCalledWith({
        prefix: 'default/component/stale-comp/',
      });
    } finally {
      await backend.stop();
    }
  }, 30000);
});
