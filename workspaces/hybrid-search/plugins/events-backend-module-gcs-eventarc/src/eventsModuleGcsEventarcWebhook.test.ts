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
import { startTestBackend, mockServices } from '@backstage/backend-test-utils';
import { eventsServiceRef } from '@backstage/plugin-events-node';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { createServiceFactory } from '@backstage/backend-plugin-api';
import request from 'supertest';

// 1. Define mock functions
const mockDownload = jest.fn();
const mockFile = jest.fn().mockReturnValue({
  download: mockDownload,
});
const mockGetFiles = jest.fn();
const mockBucket = jest.fn().mockReturnValue({
  file: mockFile,
  getFiles: mockGetFiles,
});

jest.mock('@google-cloud/storage', () => {
  return {
    Storage: jest.fn().mockImplementation(() => {
      return {
        bucket: mockBucket,
      };
    }),
  };
});

const mockImportDocuments = jest.fn();
const mockDeleteDocument = jest.fn();
const mockPromise = jest.fn();

jest.mock('@google-cloud/discoveryengine', () => {
  return {
    DocumentServiceClient: jest.fn().mockImplementation(() => {
      return {
        projectLocationCollectionDataStoreBranchPath: jest
          .fn()
          .mockReturnValue('mock-parent-path'),
        importDocuments: mockImportDocuments,
        deleteDocument: mockDeleteDocument,
      };
    }),
  };
});

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => {
  return {
    OAuth2Client: jest.fn().mockImplementation(() => {
      return {
        verifyIdToken: mockVerifyIdToken,
      };
    }),
  };
});

// 2. Load the module under test after mocks are defined
const mod = require('./eventsModuleGcsEventarcWebhook');

const eventsModuleGcsEventarcWebhook =
  mod.eventsModuleGcsEventarcWebhook || mod.default;

describe('eventsModuleGcsEventarcWebhook', () => {
  let mockEventsService: any;
  let oidcEnabled = false;

  beforeEach(() => {
    jest.clearAllMocks();
    oidcEnabled = false;

    mockEventsService = {
      publish: jest.fn(),
      subscribe: jest.fn(),
    };

    mockPromise.mockResolvedValue({});
    mockImportDocuments.mockResolvedValue([{ promise: mockPromise }]);
  });

  const getFeatures = (options?: {
    maxConcurrency?: number;
    payloadSizeLimit?: string;
  }) => {
    const configMock = mockServices.rootConfig.factory({
      data: {
        events: {
          modules: {
            gcsEventarcWebhook: {
              oidc: {
                enabled: oidcEnabled,
                audience: 'my-audience',
                serviceAccountEmail: 'expected-sa@gcp.com',
              },
              maxConcurrency: options?.maxConcurrency,
              payloadSizeLimit: options?.payloadSizeLimit,
            },
          },
        },
        search: {
          engines: {
            vertexai: {
              types: {
                techdocs: {
                  datastore: {
                    projectId: 'my-project',
                    datastoreId: 'my-datastore',
                    location: 'europe-west4',
                  },
                },
              },
            },
          },
        },
      },
    });

    const eventsMockServiceFactory = createServiceFactory({
      service: eventsServiceRef,
      deps: {},
      async factory() {
        return mockEventsService;
      },
    });

    return [
      eventsModuleGcsEventarcWebhook,
      configMock,
      eventsMockServiceFactory,
    ];
  };

  it('should initialize and register router + subscriber', async () => {
    await startTestBackend({
      features: getFeatures(),
    });

    expect(mockEventsService.subscribe).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'gcs-eventarc-webhook',
        topics: ['gcs-notifications'],
      }),
    );
  });

  it('should initialize successfully with custom concurrency and payload size configurations', async () => {
    await startTestBackend({
      features: getFeatures({ maxConcurrency: 3, payloadSizeLimit: '500kb' }),
    });
    expect(mockEventsService.subscribe).toHaveBeenCalled();
  });

  it('should fail to initialize if techdocs indexing is enabled globally', async () => {
    const configMock = mockServices.rootConfig.factory({
      data: {
        search: {
          engines: {
            vertexai: {
              indexing: {
                enabled: true, // Enabled globally!
              },
              types: {
                techdocs: {
                  datastore: {
                    projectId: 'my-project',
                    datastoreId: 'my-datastore',
                    location: 'europe-west4',
                  },
                },
              },
            },
          },
        },
      },
    });

    await expect(
      startTestBackend({
        features: [
          eventsModuleGcsEventarcWebhook,
          configMock,
          createServiceFactory({
            service: eventsServiceRef,
            deps: {},
            async factory() {
              return mockEventsService;
            },
          }),
        ],
      }),
    ).rejects.toThrow(
      /GCS Eventarc Webhook conflict: techdocs indexing is enabled/,
    );
  });

  it('should fail to initialize if techdocs indexing is enabled specifically', async () => {
    const configMock = mockServices.rootConfig.factory({
      data: {
        search: {
          engines: {
            vertexai: {
              indexing: {
                enabled: false, // Disabled globally
              },
              types: {
                techdocs: {
                  datastore: {
                    projectId: 'my-project',
                    datastoreId: 'my-datastore',
                    location: 'europe-west4',
                  },
                  indexing: {
                    enabled: true, // Enabled specifically!
                  },
                },
              },
            },
          },
        },
      },
    });

    await expect(
      startTestBackend({
        features: [
          eventsModuleGcsEventarcWebhook,
          configMock,
          createServiceFactory({
            service: eventsServiceRef,
            deps: {},
            async factory() {
              return mockEventsService;
            },
          }),
        ],
      }),
    ).rejects.toThrow(
      /GCS Eventarc Webhook conflict: techdocs indexing is enabled/,
    );
  });

  describe('HTTP /gcs router', () => {
    it('accepts unauthenticated requests when OIDC is disabled', async () => {
      oidcEnabled = false;
      const { server } = await startTestBackend({
        features: getFeatures(),
      });

      const response = await request(server)
        .post('/api/events/gcs')
        .set('ce-type', 'google.cloud.storage.object.v1.finalized')
        .send({
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        });

      expect(response.status).toBe(200);
      expect(mockEventsService.publish).toHaveBeenCalledWith({
        topic: 'gcs-notifications',
        eventPayload: {
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        },
      });
    });

    it('rejects unauthenticated requests when OIDC is enabled and token is missing', async () => {
      oidcEnabled = true;
      const { server } = await startTestBackend({
        features: getFeatures(),
      });

      const response = await request(server)
        .post('/api/events/gcs')
        .set('ce-type', 'google.cloud.storage.object.v1.finalized')
        .send({
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        });

      expect(response.status).toBe(401);
      expect(mockEventsService.publish).not.toHaveBeenCalled();
    });

    it('accepts authenticated requests when OIDC is enabled and valid token is provided', async () => {
      oidcEnabled = true;

      mockVerifyIdToken.mockResolvedValue({
        getPayload: () => ({
          iss: 'https://accounts.google.com',
          email: 'expected-sa@gcp.com',
        }),
      });

      const { server } = await startTestBackend({
        features: getFeatures(),
      });

      const response = await request(server)
        .post('/api/events/gcs')
        .set('ce-type', 'google.cloud.storage.object.v1.finalized')
        .set('authorization', 'Bearer valid-id-token')
        .send({
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        });

      expect(response.status).toBe(200);
      expect(mockVerifyIdToken).toHaveBeenCalledWith({
        idToken: 'valid-id-token',
        audience: 'my-audience',
      });
      expect(mockEventsService.publish).toHaveBeenCalled();
    });
  });

  describe('Events subscriber processing logic', () => {
    it('downloads search_index.json, processes docs, imports into DiscoveryEngine and runs deletes', async () => {
      let subscriberCallback: any;

      mockEventsService.subscribe.mockImplementation((sub: any) => {
        subscriberCallback = sub.onEvent;
      });

      await startTestBackend({
        features: getFeatures(),
      });

      expect(subscriberCallback).toBeDefined();

      // Setup current version docs download
      const mockDocs = [
        { title: 'Doc A', text: 'Some text', location: 'page1.html' },
        { title: 'Doc B', text: 'Some other text', location: 'page2.html' },
      ];
      mockDownload.mockResolvedValueOnce([
        Buffer.from(JSON.stringify({ docs: mockDocs })),
      ]);

      // Setup previous version generations and files
      const mockPrevFile = {
        name: 'default/Component/my-comp/search_index.json',
        generation: 100000,
      };
      mockGetFiles.mockResolvedValueOnce([
        [
          {
            name: 'default/Component/my-comp/search_index.json',
            generation: 123456,
          },
          mockPrevFile,
        ],
      ]);

      // Setup previous version docs download (Doc A and Doc C)
      const mockPrevDocs = [
        { title: 'Doc A', text: 'Some text', location: 'page1.html' },
        { title: 'Doc C', text: 'Stale doc', location: 'page3.html' }, // Stale, should be deleted
      ];
      mockDownload.mockResolvedValueOnce([
        Buffer.from(JSON.stringify({ docs: mockPrevDocs })),
      ]);

      // Execute onEvent subscriber callback
      await subscriberCallback({
        topic: 'gcs-notifications',
        eventPayload: {
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        },
      });

      // Assert current docs download was called
      expect(mockBucket).toHaveBeenCalledWith('my-bucket');
      expect(mockFile).toHaveBeenCalledWith(
        'default/Component/my-comp/search_index.json',
        {
          generation: '123456',
        },
      );

      // Assert import to Discovery Engine was called
      expect(mockImportDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          parent: 'mock-parent-path',
          inlineSource: {
            documents: expect.arrayContaining([
              expect.objectContaining({
                id: '91a9fc50bd9b95d35f92aa4b1da57ce4',
                jsonData: expect.stringContaining('"location":"page1.html"'),
              }),
              expect.objectContaining({
                id: '34eac29c15cd5085912deaf731ccc76a',
                jsonData: expect.stringContaining('"location":"page2.html"'),
              }),
            ]),
          },
          reconciliationMode: 'INCREMENTAL',
        }),
      );

      // Assert previous generation lookups were called
      expect(mockGetFiles).toHaveBeenCalledWith({
        prefix: 'default/Component/my-comp/search_index.json',
        versions: true,
      });

      expect(mockFile).toHaveBeenCalledWith(
        'default/Component/my-comp/search_index.json',
        {
          generation: '100000',
        },
      );

      // Assert deletion of Doc C (page3.html)
      expect(mockDeleteDocument).toHaveBeenCalledWith({
        name: 'mock-parent-path/documents/207531cd3d5c3e8f426d9658a681aa56',
      });
      expect(mockDeleteDocument).toHaveBeenCalledTimes(1);
    });

    it('should chunk and batch inline imports in groups of 100 when the component contains more than 100 pages', async () => {
      let subscriberCallback: any;

      mockEventsService.subscribe.mockImplementation((sub: any) => {
        subscriberCallback = sub.onEvent;
      });

      await startTestBackend({
        features: getFeatures(),
      });

      expect(subscriberCallback).toBeDefined();

      // Mock a large search_index.json containing 120 pages!
      const mockDocs = [];
      for (let i = 1; i <= 120; i++) {
        mockDocs.push({
          title: `Page ${i}`,
          text: `Content ${i}`,
          location: `page-${i}.html`,
        });
      }

      const mockIndexContent = JSON.stringify({ docs: mockDocs });
      mockDownload.mockResolvedValueOnce([Buffer.from(mockIndexContent)]);

      // Execute onEvent subscriber callback directly
      await subscriberCallback({
        topic: 'gcs-notifications',
        eventPayload: {
          bucket: 'my-techdocs-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 200000,
        },
      });

      // Verify that importDocuments was called exactly twice (batch 1: 100 docs, batch 2: 20 docs)
      expect(mockImportDocuments).toHaveBeenCalledTimes(2);

      // Verify the first batch size is exactly 100
      const firstCallArgs = mockImportDocuments.mock.calls[0][0];
      expect(firstCallArgs.inlineSource.documents.length).toBe(100);

      // Verify the second batch size is exactly 20
      const secondCallArgs = mockImportDocuments.mock.calls[1][0];
      expect(secondCallArgs.inlineSource.documents.length).toBe(20);
    });

    it('should query the CatalogService and enrich the ingested documents with catalog metadata', async () => {
      let subscriberCallback: any;

      mockEventsService.subscribe.mockImplementation((sub: any) => {
        subscriberCallback = sub.onEvent;
      });

      // Mock catalog client entity
      const mockEntity = {
        apiVersion: 'backstage.io/v1alpha1',
        kind: 'Component',
        metadata: {
          name: 'my-comp',
          namespace: 'default',
          annotations: {
            'backstage.io/techdocs-ref': 'dir:.',
          },
        },
        spec: {
          owner: 'team-a',
          lifecycle: 'production',
          type: 'service',
        },
      };

      const mockCatalogService = {
        getEntityByRef: jest.fn().mockResolvedValue(mockEntity),
      };

      const catalogMockServiceFactory = createServiceFactory({
        service: catalogServiceRef,
        deps: {},
        async factory() {
          return mockCatalogService as any;
        },
      });

      await startTestBackend({
        features: [...getFeatures(), catalogMockServiceFactory],
      });

      expect(subscriberCallback).toBeDefined();

      // Setup current version docs download
      const mockDocs = [
        { title: 'Doc A', text: 'Some text', location: 'page1.html' },
      ];
      mockDownload.mockResolvedValueOnce([
        Buffer.from(JSON.stringify({ docs: mockDocs })),
      ]);

      // Mock previous versions to return empty (no deletes)
      mockGetFiles.mockResolvedValueOnce([[]]);

      // Execute onEvent subscriber callback
      await subscriberCallback({
        topic: 'gcs-notifications',
        eventPayload: {
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        },
      });

      // Verify getEntityByRef was called with correct ref
      expect(mockCatalogService.getEntityByRef).toHaveBeenCalledWith(
        { kind: 'Component', namespace: 'default', name: 'my-comp' },
        expect.any(Object),
      );

      // Verify the document import request contains the enriched metadata
      expect(mockImportDocuments).toHaveBeenCalledWith(
        expect.objectContaining({
          inlineSource: {
            documents: expect.arrayContaining([
              expect.objectContaining({
                jsonData: expect.stringContaining('"owner":"team-a"'),
              }),
            ]),
          },
        }),
      );

      const importCallArgs = mockImportDocuments.mock.calls[0][0];
      const docPayload = JSON.parse(
        importCallArgs.inlineSource.documents[0].jsonData,
      );

      expect(docPayload.owner).toBe('team-a');
      expect(docPayload.lifecycle).toBe('production');
      expect(docPayload.componentType).toBe('service');
      expect(docPayload.annotations).toEqual({
        'backstage.io/techdocs-ref': 'dir:.',
      });
    });

    it('should fall back to default metadata values when CatalogService cannot find the component entity', async () => {
      let subscriberCallback: any;

      mockEventsService.subscribe.mockImplementation((sub: any) => {
        subscriberCallback = sub.onEvent;
      });

      // Mock catalog service to return undefined (entity not found)
      const mockCatalogService = {
        getEntityByRef: jest.fn().mockResolvedValue(undefined),
      };

      const catalogMockServiceFactory = createServiceFactory({
        service: catalogServiceRef,
        deps: {},
        async factory() {
          return mockCatalogService as any;
        },
      });

      await startTestBackend({
        features: [...getFeatures(), catalogMockServiceFactory],
      });

      expect(subscriberCallback).toBeDefined();

      const mockDocs = [
        { title: 'Doc A', text: 'Some text', location: 'page1.html' },
      ];
      mockDownload.mockResolvedValueOnce([
        Buffer.from(JSON.stringify({ docs: mockDocs })),
      ]);
      mockGetFiles.mockResolvedValueOnce([[]]);

      await subscriberCallback({
        topic: 'gcs-notifications',
        eventPayload: {
          bucket: 'my-bucket',
          name: 'default/Component/my-comp/search_index.json',
          generation: 123456,
        },
      });

      expect(mockImportDocuments).toHaveBeenCalled();
      const importCallArgs = mockImportDocuments.mock.calls[0][0];
      const docPayload = JSON.parse(
        importCallArgs.inlineSource.documents[0].jsonData,
      );

      expect(docPayload.owner).toBe('unknown');
      expect(docPayload.lifecycle).toBe('unknown');
      expect(docPayload.componentType).toBe('');
      expect(docPayload.annotations).toEqual({});
    });
  });
});
