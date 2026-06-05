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
import { VertexAISearchEngine } from './VertexAISearchEngine';
import { LoggerService } from '@backstage/backend-plugin-api';

// Mock Discovery Engine client
const mockSearch = jest.fn();
const mockImportDocuments = jest.fn();
const mockBranchPath = jest.fn().mockReturnValue('mock-parent-path');

jest.mock('@google-cloud/discoveryengine', () => {
  return {
    SearchServiceClient: jest.fn().mockImplementation(() => {
      return {
        search: mockSearch,
      };
    }),
    DocumentServiceClient: jest.fn().mockImplementation(() => {
      return {
        projectLocationCollectionDataStoreBranchPath: mockBranchPath,
        importDocuments: mockImportDocuments,
      };
    }),
  };
});

describe('VertexAISearchEngine', () => {
  let engine: VertexAISearchEngine;
  let mockLogger: jest.Mocked<LoggerService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;

    engine = new VertexAISearchEngine({
      blendedSearch: {
        projectId: 'my-project',
        location: 'europe-west4',
        engineId: 'my-engine-id',
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
      logger: mockLogger,
    });
  });

  describe('constructor validation', () => {
    it('should log info override if indexing is disabled globally for software-catalog', () => {
      const infoLogger = { warn: jest.fn(), info: jest.fn() } as any;
      // eslint-disable-next-line no-new
      new VertexAISearchEngine({
        indexing: {
          enabled: false, // Disabled globally!
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'my-catalog-store',
              location: 'europe-west4',
            },
          },
        },
        logger: infoLogger,
      });

      expect(infoLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Vertex AI Search: Local indexing was configured as disabled for "software-catalog". This has been overridden to ENABLED',
        ),
      );
    });

    it('should log info override if indexing is disabled specifically for software-catalog', () => {
      const infoLogger = { warn: jest.fn(), info: jest.fn() } as any;
      // eslint-disable-next-line no-new
      new VertexAISearchEngine({
        indexing: {
          enabled: true, // Enabled globally
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'my-catalog-store',
              location: 'europe-west4',
            },
            indexing: {
              enabled: false, // Disabled specifically!
            },
          },
        },
        logger: infoLogger,
      });

      expect(infoLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Vertex AI Search: Local indexing was configured as disabled for "software-catalog". This has been overridden to ENABLED',
        ),
      );
    });

    it('should NOT warn if indexing is enabled for software-catalog', () => {
      const warnLogger = { warn: jest.fn(), info: jest.fn() } as any;
      // eslint-disable-next-line no-new
      new VertexAISearchEngine({
        indexing: {
          enabled: true, // Enabled!
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'my-catalog-store',
              location: 'europe-west4',
            },
          },
        },
        logger: warnLogger,
      });

      expect(warnLogger.warn).not.toHaveBeenCalled();
    });
  });

  describe('getIndexer', () => {
    it('should return a working no-op stream when indexing is bypassed (default)', async () => {
      const stream = await engine.getIndexer('techdocs');
      expect(stream).toBeDefined();

      const writePromise = new Promise<void>((resolve, reject) => {
        stream.write(
          {
            title: 'Doc',
            text: 'Content',
            location: 'index.html',
          },
          (err: any) => (err ? reject(err) : resolve()),
        );
      });

      await writePromise;
      stream.end();
      expect(mockImportDocuments).not.toHaveBeenCalled();
    });

    it('should return a writable stream and flush documents in inline batches when indexing is enabled', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const mockOperation = {
        name: 'operation-id',
        promise: jest.fn().mockResolvedValue([{}, {}]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream).toBeDefined();

      const writePromise = new Promise<void>((resolve, reject) => {
        stream.write(
          {
            title: 'My Component',
            text: 'Description text...',
            location: 'catalog-item',
            kind: 'Component',
            namespace: 'default',
            name: 'my-service',
            owner: 'group:default/team-a',
            lifecycle: 'production',
            componentType: 'service',
          },
          (err: any) => (err ? reject(err) : resolve()),
        );
      });

      await writePromise;

      const finishPromise = new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });

      await finishPromise;

      expect(mockImportDocuments).toHaveBeenCalledWith({
        parent: 'mock-parent-path',
        inlineSource: {
          documents: [
            {
              id: expect.any(String),
              jsonData: expect.any(String),
            },
          ],
        },
        reconciliationMode: 'INCREMENTAL',
      });
    });

    it('should respect custom batch size from configuration and flush when the limit is met', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
          batchSize: 3, // Custom batch size of 3!
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const mockOperation = {
        name: 'operation-id',
        promise: jest.fn().mockResolvedValue([{}, {}]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream).toBeDefined();

      const doc = {
        title: 'My Component',
        text: 'Description text...',
        location: 'catalog-item',
        kind: 'Component',
        namespace: 'default',
        name: 'my-service',
        owner: 'group:default/team-a',
      };

      // 1. Write first two documents (below batch size of 3)
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });

      // Verification: Under batch size, should NOT flush yet
      expect(mockImportDocuments).not.toHaveBeenCalled();

      // 2. Write third document (meets batch size of 3)
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });

      // Verification: Meets batch size, should immediately flush the first 3 documents!
      expect(mockImportDocuments).toHaveBeenCalledTimes(1);
      expect(mockImportDocuments).toHaveBeenLastCalledWith(
        expect.objectContaining({
          inlineSource: expect.objectContaining({
            documents: expect.arrayContaining([
              expect.objectContaining({ id: expect.any(String) }),
            ]),
          }),
        }),
      );
      expect(
        mockImportDocuments.mock.calls[0][0].inlineSource.documents.length,
      ).toBe(3);

      // 3. Write fourth document (buffered)
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });
      expect(mockImportDocuments).toHaveBeenCalledTimes(1); // Still only 1 flush

      // 4. End the stream (should flush the remaining 4th document!)
      await new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });

      expect(mockImportDocuments).toHaveBeenCalledTimes(2); // Second flush triggered!
      expect(
        mockImportDocuments.mock.calls[1][0].inlineSource.documents.length,
      ).toBe(1); // Just the 4th document
    });

    it('should respect throttleMs delay from configuration between batch flushes', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
          batchSize: 1, // Flush every document immediately!
          throttleMs: 100, // Wait 100ms between flushes
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const mockOperation = {
        name: 'operation-id',
        promise: jest.fn().mockResolvedValue([{}, {}]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream).toBeDefined();

      const doc = {
        title: 'My Component',
        text: 'Description text...',
        location: 'catalog-item',
      };

      // Write first document (immediate flush, followed by 100ms throttle sleep)
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });

      const firstWriteTime = Date.now();

      // Write second document (immediate flush, followed by 100ms throttle sleep)
      await new Promise<void>((resolve, reject) => {
        stream.write(doc, (err: any) => (err ? reject(err) : resolve()));
      });

      const secondWriteTime = Date.now();
      stream.end();

      // The time between the first write completing and the second write completing must be at least 100ms!
      const elapsed = secondWriteTime - firstWriteTime;
      expect(elapsed).toBeGreaterThanOrEqual(95); // allow a tiny buffer for timer inaccuracy
      expect(mockImportDocuments).toHaveBeenCalledTimes(2);
    });

    it('should return a working no-op stream and warn when indexing is enabled but the type is unmapped', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const stream = await indexingEngine.getIndexer('unmapped-type');
      expect(stream).toBeDefined();

      const writePromise = new Promise<void>((resolve, reject) => {
        stream.write(
          {
            title: 'Unmapped Doc',
            text: 'Content',
            location: 'unmapped',
          },
          (err: any) => (err ? reject(err) : resolve()),
        );
      });

      await writePromise;
      stream.end();

      expect(mockImportDocuments).not.toHaveBeenCalled();
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          'Vertex AI Search: Local indexing is enabled but unmapped for type "unmapped-type"',
        ),
      );
    });

    it('should support cross-project data store configuration overrides and stream correctly', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'other-gcp-project',
              datastoreId: 'other-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const mockOperation = {
        name: 'operation-id',
        promise: jest.fn().mockResolvedValue([{}, {}]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream).toBeDefined();

      const writePromise = new Promise<void>((resolve, reject) => {
        stream.write(
          {
            title: 'Doc',
            text: 'Content',
            location: 'item',
          },
          (err: any) => (err ? reject(err) : resolve()),
        );
      });

      await writePromise;

      const finishPromise = new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });

      await finishPromise;

      expect(mockBranchPath).toHaveBeenCalledWith(
        'other-gcp-project', // Overridden Project ID!
        'europe-west4', // Inherited Location!
        'default_collection',
        'other-datastore', // Overridden Data Store ID!
        'default_branch',
      );

      expect(mockImportDocuments).toHaveBeenCalled();
    });

    it('should dynamically route indexer clients to regional endpoints based on datastore location overrides', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'other-gcp-project',
              datastoreId: 'other-datastore',
              location: 'us', // US regional location override!
            },
          },
        },
        logger: mockLogger,
      });

      const {
        DocumentServiceClient: MockedDocumentServiceClient,
      } = require('@google-cloud/discoveryengine');
      jest.clearAllMocks();

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream).toBeDefined();

      expect(MockedDocumentServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          apiEndpoint: 'us-discoveryengine.googleapis.com',
        }),
      );
    });

    it('should respect type-specific indexing overrides and fall back to global default', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: false, // Global default is DISABLED!
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'catalog-store',
              location: 'europe-west4',
            },
            indexing: {
              enabled: true, // Overridden to ENABLED specifically for catalog!
            },
          },
          techdocs: {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'docs-store',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      // 1. Catalog has indexing enabled -> returns a real writable stream
      const catalogStream = await indexingEngine.getIndexer('software-catalog');
      expect(catalogStream.constructor.name).toBe('VertexAIWritableStream');

      // 2. TechDocs inherits global disabled -> returns a dummy no-op stream (standard Node Writable)
      const techdocsStream = await indexingEngine.getIndexer('techdocs');
      expect(techdocsStream.constructor.name).toBe('Writable');
    });

    it('should force indexing to enabled for software-catalog even if config disables it', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: false, // Disabled globally
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
            indexing: {
              enabled: false, // Disabled specifically for catalog!
            },
          },
        },
        logger: mockLogger,
      });

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream.constructor.name).toBe('VertexAIWritableStream');
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          'Vertex AI Search: Forcing indexing to enabled for "software-catalog"',
        ),
      );
    });
  });

  describe('query', () => {
    it('should query Vertex AI Search and map struct data fields back', async () => {
      const mockResult = [
        {
          document: {
            name: 'doc-name',
            structData: {
              fields: {
                title: { stringValue: 'My Document' },
                text: { stringValue: 'Some document content' },
                location: {
                  stringValue: '/docs/default/Component/my-comp/index.html',
                },
                kind: { stringValue: 'Component' },
                namespace: { stringValue: 'default' },
                name: { stringValue: 'my-comp' },
              },
            },
          },
          rankSignals: { relevanceScore: 0.95 },
        },
      ];
      mockSearch.mockResolvedValue([
        mockResult,
        {},
        { nextPageToken: 'next-token' },
      ]);

      const queryObj = {
        term: 'search-term',
        types: ['techdocs'],
      };

      const response = await engine.query(queryObj);

      expect(mockSearch).toHaveBeenCalledWith({
        servingConfig:
          'projects/my-project/locations/europe-west4/dataStores/my-datastore/servingConfigs/default_search',
        query: 'search-term',
        filter: undefined,
        pageSize: undefined,
        pageToken: undefined,
        relevanceScoreSpec: { returnRelevanceScore: true },
      });

      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual({
        type: 'techdocs',
        document: {
          title: 'My Document',
          text: 'Some document content',
          location: '/docs/default/Component/my-comp/index.html',
          kind: 'Component',
          namespace: 'default',
          name: 'my-comp',
        },
        score: 0.95,
      });
      expect(response.nextPageCursor).toBe('next-token');
    });

    it('should merge and pass custom searchOptions to Vertex AI search API', async () => {
      const customEngine = new VertexAISearchEngine({
        blendedSearch: {
          projectId: 'my-project',
          location: 'europe-west4',
          engineId: 'my-engine-id',
          searchOptions: {
            summarySpec: {
              summaryResultCount: 3,
              includeCitations: true,
            },
            spellCorrectionSpec: {
              mode: 'AUTO',
            },
          },
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
      });

      mockSearch.mockResolvedValue([[], {}, {}]);

      await customEngine.query({
        term: 'test-query',
        types: ['techdocs'],
      });

      expect(mockSearch).toHaveBeenCalledWith({
        servingConfig:
          'projects/my-project/locations/europe-west4/dataStores/my-datastore/servingConfigs/default_search',
        query: 'test-query',
        filter: undefined,
        pageSize: undefined,
        pageToken: undefined,
        relevanceScoreSpec: { returnRelevanceScore: true },
        summarySpec: {
          summaryResultCount: 3,
          includeCitations: true,
        },
        spellCorrectionSpec: {
          mode: 'AUTO',
        },
      });
    });

    it('should translate filters into a Google AIP-160 predicate', async () => {
      mockSearch.mockResolvedValue([[], {}, {}]);

      await engine.query({
        term: 'test-term',
        types: ['techdocs'],
        filters: {
          namespace: 'default',
          kind: ['Component', 'API'],
        },
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          filter: 'namespace: ANY("default") AND kind: ANY("component", "api")',
        }),
      );
    });

    it('should pass pagination options through to Vertex AI search API', async () => {
      mockSearch.mockResolvedValue([
        [],
        {},
        { nextPageToken: 'another-token' },
      ]);

      const response = await engine.query({
        term: 'test-term',
        types: ['techdocs'],
        pageLimit: 15,
        pageCursor: 'cursor-token',
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          pageSize: 15,
          pageToken: 'cursor-token',
        }),
      );

      expect(response.nextPageCursor).toBe('another-token');
    });

    it('should dynamically route single-category queries to the mapped Data Store directly when no global engineId is configured', async () => {
      const routingEngine = new VertexAISearchEngine({
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'catalog-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
          techdocs: {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'docs-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      mockSearch.mockResolvedValue([[], {}, {}]);

      await routingEngine.query({
        term: 'test-term',
        types: ['software-catalog'],
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          servingConfig:
            'projects/catalog-project/locations/europe-west4/dataStores/catalog-datastore/servingConfigs/default_search',
        }),
      );
    });

    it('should dynamically route single-category queries to the mapped App Engine when configured', async () => {
      const routingEngine = new VertexAISearchEngine({
        types: {
          techdocs: {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'docs-datastore',
              location: 'europe-west4',
            },
            engine: {
              projectId: 'docs-project',
              engineId: 'dedicated-docs-app',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      mockSearch.mockResolvedValue([[], {}, {}]);

      await routingEngine.query({
        term: 'test-term',
        types: ['techdocs'],
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          servingConfig:
            'projects/docs-project/locations/europe-west4/collections/default_collection/engines/dedicated-docs-app/servingConfigs/default_search',
        }),
      );
    });

    it('should dynamically route query clients to regional endpoints based on engine location overrides', async () => {
      const routingEngine = new VertexAISearchEngine({
        types: {
          techdocs: {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'docs-datastore',
              location: 'europe-west4',
            },
            engine: {
              projectId: 'docs-project',
              engineId: 'dedicated-docs-app',
              location: 'eu', // Europe regional location override!
            },
          },
        },
        logger: mockLogger,
      });

      mockSearch.mockResolvedValue([[], {}, {}]);

      const {
        SearchServiceClient: MockedSearchServiceClient,
      } = require('@google-cloud/discoveryengine');
      jest.clearAllMocks();

      await routingEngine.query({
        term: 'test-term',
        types: ['techdocs'],
      });

      expect(MockedSearchServiceClient).toHaveBeenCalledWith(
        expect.objectContaining({
          apiEndpoint: 'eu-discoveryengine.googleapis.com',
        }),
      );
    });

    it('should dynamically resolve the result document type from GCP resource name during blended search', async () => {
      const blendedEngine = new VertexAISearchEngine({
        blendedSearch: {
          location: 'europe-west4',
          engineId: 'blended-search-app',
          projectId: 'main-project',
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'main-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
          },
          techdocs: {
            datastore: {
              projectId: 'main-project',
              datastoreId: 'docs-datastore',
              location: 'europe-west4',
            },
          },
        },
        logger: mockLogger,
      });

      const mockBlendedResults = [
        {
          document: {
            name: 'projects/123/locations/europe-west4/collections/default_collection/dataStores/catalog-datastore/branches/0/documents/doc-1',
            structData: {
              fields: {
                title: { stringValue: 'Catalog Card' },
                text: { stringValue: 'Catalog item info' },
                location: {
                  stringValue: '/catalog/default/component/my-service',
                },
              },
            },
          },
        },
        {
          document: {
            name: 'projects/123/locations/europe-west4/collections/default_collection/dataStores/docs-datastore/branches/0/documents/doc-2',
            structData: {
              fields: {
                title: { stringValue: 'TechDocs Page' },
                text: { stringValue: 'Documentation page content' },
                location: {
                  stringValue: '/docs/default/Component/my-service/index.html',
                },
              },
            },
          },
        },
      ];

      mockSearch.mockResolvedValue([mockBlendedResults, {}, {}]);

      const response = await blendedEngine.query({
        term: 'blended-query',
      });

      expect(response.results).toHaveLength(2);

      // First result must be dynamically resolved to 'software-catalog'!
      expect(response.results[0].type).toBe('software-catalog');
      expect(response.results[0].document.title).toBe('Catalog Card');

      // Second result must be dynamically resolved to 'techdocs'!
      expect(response.results[1].type).toBe('techdocs');
      expect(response.results[1].document.title).toBe('TechDocs Page');
    });

    it('should merge global searchOptions with type-specific searchOptions when querying a single category', async () => {
      const mergedOptionsEngine = new VertexAISearchEngine({
        blendedSearch: {
          projectId: 'my-project',
          location: 'europe-west4',
          engineId: 'my-engine-id',
          searchOptions: {
            pageSize: 10,
            safeSearch: true,
            contentSearchSpec: {
              extractiveContentSpec: {
                maxExtractiveAnswerCount: 1,
              },
            },
          },
        },
        types: {
          techdocs: {
            datastore: {
              projectId: 'docs-project',
              datastoreId: 'docs-datastore',
              location: 'europe-west4',
            },
            searchOptions: {
              pageSize: 5,
              contentSearchSpec: {
                extractiveContentSpec: {
                  maxExtractiveAnswerCount: 3,
                },
              },
            },
          },
        },
        logger: mockLogger,
      });

      mockSearch.mockResolvedValue([[], {}, {}]);

      await mergedOptionsEngine.query({
        term: 'test-term',
        types: ['techdocs'],
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          pageSize: 5,
          safeSearch: true,
          contentSearchSpec: {
            extractiveContentSpec: {
              maxExtractiveAnswerCount: 3,
            },
          },
        }),
      );
    });

    it('should fallback to snippets when only snippets are returned in search results', async () => {
      const mockResult = [
        {
          document: {
            name: 'doc-name',
            structData: {
              fields: {
                title: { stringValue: 'My Document' },
                text: { stringValue: 'Some document content' },
                location: {
                  stringValue: '/docs/default/Component/my-comp/index.html',
                },
              },
            },
            derivedStructData: {
              fields: {
                snippets: {
                  listValue: {
                    values: [
                      {
                        structValue: {
                          fields: {
                            snippet: {
                              stringValue:
                                'Highlighted keyword snippet content',
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          rankSignals: { relevanceScore: 0.95 },
        },
      ];
      mockSearch.mockResolvedValue([mockResult, {}, {}]);

      const response = await engine.query({
        term: 'search-term',
        types: ['techdocs'],
      });

      expect(response.results[0].document.text).toBe(
        'Highlighted keyword snippet content',
      );
    });

    it('should throw an error and log it when query execution fails', async () => {
      const mockError = new Error('GCP Search API Error');
      mockSearch.mockRejectedValueOnce(mockError);

      await expect(
        engine.query({ term: 'search-term', types: ['techdocs'] }),
      ).rejects.toThrow('GCP Search API Error');

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Vertex AI Search query execution failed'),
        mockError,
      );
    });

    it('should map extractive answers when returned in search results', async () => {
      const mockResult = [
        {
          document: {
            name: 'doc-name',
            structData: {
              fields: {
                title: { stringValue: 'My Document' },
                text: { stringValue: 'Some document content' },
                location: {
                  stringValue: '/docs/default/Component/my-comp/index.html',
                },
              },
            },
            derivedStructData: {
              fields: {
                extractive_answers: {
                  listValue: {
                    values: [
                      {
                        structValue: {
                          fields: {
                            content: {
                              stringValue: 'Precise extractive answer content',
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          rankSignals: { relevanceScore: 0.95 },
        },
      ];
      mockSearch.mockResolvedValue([mockResult, {}, {}]);

      const response = await engine.query({
        term: 'search-term',
        types: ['techdocs'],
      });

      expect(response.results[0].document.text).toBe(
        'Precise extractive answer content',
      );
    });

    it('should map extractive segments when returned in search results', async () => {
      const mockResult = [
        {
          document: {
            name: 'doc-name',
            structData: {
              fields: {
                title: { stringValue: 'My Document' },
                text: { stringValue: 'Some document content' },
                location: {
                  stringValue: '/docs/default/Component/my-comp/index.html',
                },
              },
            },
            derivedStructData: {
              fields: {
                extractive_segments: {
                  listValue: {
                    values: [
                      {
                        structValue: {
                          fields: {
                            content: {
                              stringValue: 'Semantic segment content 1',
                            },
                          },
                        },
                      },
                      {
                        structValue: {
                          fields: {
                            content: {
                              stringValue: 'Semantic segment content 2',
                            },
                          },
                        },
                      },
                    ],
                  },
                },
              },
            },
          },
          rankSignals: { relevanceScore: 0.95 },
        },
      ];
      mockSearch.mockResolvedValue([mockResult, {}, {}]);

      const response = await engine.query({
        term: 'search-term',
        types: ['techdocs'],
      });

      expect(response.results[0].document.text).toBe(
        'Semantic segment content 1\n...\nSemantic segment content 2',
      );
    });
  });
});
