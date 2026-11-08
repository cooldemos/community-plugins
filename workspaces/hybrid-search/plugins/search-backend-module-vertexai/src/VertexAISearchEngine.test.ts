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
const mockListDocuments = jest.fn();
const mockDeleteDocument = jest.fn();
const mockClose = jest.fn();
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
        listDocuments: mockListDocuments,
        deleteDocument: mockDeleteDocument,
        close: mockClose,
      };
    }),
  };
});

describe('VertexAISearchEngine', () => {
  let engine: VertexAISearchEngine;
  let mockLogger: jest.Mocked<LoggerService>;

  beforeEach(() => {
    jest.clearAllMocks();
    mockListDocuments.mockResolvedValue([[], null, {}]);
    mockDeleteDocument.mockResolvedValue([{}]);
    mockClose.mockResolvedValue(undefined);

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
    it('should NOT log an override when indexing is disabled globally for software-catalog', () => {
      const infoLogger = { warn: jest.fn(), info: jest.fn() } as any;
      // eslint-disable-next-line no-new
      new VertexAISearchEngine({
        indexing: {
          enabled: false,
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

      expect(infoLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('overridden to ENABLED'),
      );
      expect(infoLogger.warn).not.toHaveBeenCalled();
    });

    it('should NOT log an override when indexing is disabled specifically for software-catalog', () => {
      const infoLogger = { warn: jest.fn(), info: jest.fn() } as any;
      // eslint-disable-next-line no-new
      new VertexAISearchEngine({
        indexing: {
          enabled: true,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'my-catalog-store',
              location: 'europe-west4',
            },
            indexing: {
              enabled: false,
            },
          },
        },
        logger: infoLogger,
      });

      expect(infoLogger.info).not.toHaveBeenCalledWith(
        expect.stringContaining('overridden to ENABLED'),
      );
      expect(infoLogger.warn).not.toHaveBeenCalled();
    });

    it('should throw when types mapping is empty or missing location', () => {
      expect(
        () =>
          new VertexAISearchEngine({
            types: {},
          }),
      ).toThrow('requires a strictly defined "types" configuration mapping');

      expect(
        () =>
          new VertexAISearchEngine({
            types: {
              techdocs: {
                datastore: {
                  projectId: 'my-project',
                  datastoreId: 'my-datastore',
                  location: '',
                },
              },
            },
          }),
      ).toThrow('Type "techdocs" is missing a datastore location');
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
      await new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });

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

      // 1. Catalog has indexing enabled -> returns the reconciling BatchSearchEngineIndexer subclass
      const catalogStream = await indexingEngine.getIndexer('software-catalog');
      expect(catalogStream.constructor.name).toBe(
        'VertexAISearchEngineIndexer',
      );
      await new Promise<void>((resolve, reject) => {
        catalogStream.end((err: any) => (err ? reject(err) : resolve()));
      });

      // 2. TechDocs inherits global disabled -> returns a dummy no-op stream (standard Node Writable)
      const techdocsStream = await indexingEngine.getIndexer('techdocs');
      expect(techdocsStream.constructor.name).toBe('Writable');
      techdocsStream.end();
    });

    it('should respect disabled indexing for software-catalog without forcing an override', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: false,
        },
        types: {
          'software-catalog': {
            datastore: {
              projectId: 'my-project',
              datastoreId: 'catalog-datastore',
              location: 'europe-west4',
            },
            indexing: {
              enabled: false,
            },
          },
        },
        logger: mockLogger,
      });

      const stream = await indexingEngine.getIndexer('software-catalog');
      expect(stream.constructor.name).toBe('Writable');
      stream.end();
      expect(mockListDocuments).not.toHaveBeenCalled();
      expect(mockImportDocuments).not.toHaveBeenCalled();
    });

    it('should normalize missing text to empty string for catalog entities and skip documents missing title or location', async () => {
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
        promise: jest.fn().mockResolvedValue([{}, { failureCount: 0 }]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      const closePromise = new Promise<void>(resolve =>
        stream.once('close', resolve),
      );

      // Valid catalog entity with undefined text
      stream.write({
        title: 'Entity Without Description',
        location: '/catalog/default/component/no-desc',
        kind: 'Component',
      } as any);
      // Invalid document missing title
      stream.write({
        title: '',
        text: 'Has text',
        location: '/catalog/default/component/no-title',
      });
      // Invalid document missing location
      stream.write({
        title: 'No Location',
        text: 'Has text',
        location: '',
      });

      await new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });
      await closePromise;

      expect(mockImportDocuments).toHaveBeenCalledTimes(1);
      const importedDocs =
        mockImportDocuments.mock.calls[0][0].inlineSource.documents;
      expect(importedDocs).toHaveLength(1);
      const parsed = JSON.parse(importedDocs[0].jsonData);
      expect(parsed.title).toBe('Entity Without Description');
      expect(parsed.text).toBe('');
      expect(parsed.contentHash).toMatch(/^[a-f0-9]{64}$/);
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should page listDocuments with autoPaginate: false and skip unchanged documents via contentHash', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
          batchSize: 2,
          throttleMs: 200,
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
        promise: jest.fn().mockResolvedValue([{}, { failureCount: 0 }]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const docA = {
        title: 'Service A',
        text: 'Unchanged A',
        location: '/catalog/default/component/service-a',
        kind: 'Component',
      };
      const docB = {
        title: 'Service B',
        text: 'Unchanged B',
        location: '/catalog/default/component/service-b',
        kind: 'Component',
      };

      // Run 1: initial import to capture deterministic IDs and contentHashes
      const firstStream = await indexingEngine.getIndexer('software-catalog');
      const closeFirst = new Promise<void>(resolve =>
        firstStream.once('close', resolve),
      );
      firstStream.write(docA);
      firstStream.write(docB);
      await new Promise<void>((resolve, reject) => {
        firstStream.end((err: any) => (err ? reject(err) : resolve()));
      });
      await closeFirst;

      const firstBatch =
        mockImportDocuments.mock.calls[0][0].inlineSource.documents;
      const storedA = JSON.parse(firstBatch[0].jsonData);
      const storedB = JSON.parse(firstBatch[1].jsonData);

      jest.clearAllMocks();
      mockDeleteDocument.mockResolvedValue([{}]);
      mockClose.mockResolvedValue(undefined);
      mockImportDocuments.mockResolvedValue([mockOperation]);

      // Simulate two pages from listDocuments: page 1 via structData, page 2 via jsonData
      mockListDocuments
        .mockResolvedValueOnce([
          [
            {
              id: storedA.id,
              structData: {
                fields: {
                  contentHash: { stringValue: storedA.contentHash },
                },
              },
            },
          ],
          null,
          { nextPageToken: 'page-2-token' },
        ])
        .mockResolvedValueOnce([
          [
            {
              id: storedB.id,
              jsonData: JSON.stringify({ contentHash: storedB.contentHash }),
            },
          ],
          null,
          {},
        ]);

      // Run 2: write unchanged docA and docB (even with reordered keys) in batch 1, then modified docB in batch 2
      const secondStream = await indexingEngine.getIndexer('software-catalog');
      const closeSecond = new Promise<void>(resolve =>
        secondStream.once('close', resolve),
      );
      const startTime = Date.now();
      secondStream.write({
        kind: 'Component',
        location: '/catalog/default/component/service-a',
        text: 'Unchanged A',
        title: 'Service A',
      });
      secondStream.write(docB);
      await new Promise<void>((resolve, reject) => {
        secondStream.end((err: any) => (err ? reject(err) : resolve()));
      });
      await closeSecond;
      const elapsed = Date.now() - startTime;

      // Both pages fetched with autoPaginate: false
      expect(mockListDocuments).toHaveBeenCalledTimes(2);
      expect(mockListDocuments).toHaveBeenNthCalledWith(
        1,
        { parent: 'mock-parent-path', pageSize: 1000 },
        { autoPaginate: false },
      );
      expect(mockListDocuments).toHaveBeenNthCalledWith(
        2,
        {
          parent: 'mock-parent-path',
          pageSize: 1000,
          pageToken: 'page-2-token',
        },
        { autoPaginate: false },
      );

      // Zero changes -> importDocuments and 200ms throttle skipped, and zero deletions!
      expect(mockImportDocuments).not.toHaveBeenCalled();
      expect(elapsed).toBeLessThan(150);
      expect(mockDeleteDocument).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should evict stale documents in finalize() on clean completion and ignore NOT_FOUND (code 5)', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: { enabled: true },
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
        promise: jest.fn().mockResolvedValue([{}, { failureCount: 0 }]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const activeLocation = '/catalog/default/component/active-service';
      const activeId = require('crypto')
        .createHash('md5')
        .update(activeLocation)
        .digest('hex');

      mockListDocuments.mockResolvedValueOnce([
        [
          { id: activeId, jsonData: JSON.stringify({ contentHash: 'old' }) },
          { id: 'stale-doc-1', structData: { fields: {} } },
          {
            name: 'mock-parent-path/documents/stale-doc-2',
            structData: { fields: {} },
          },
        ],
        null,
        {},
      ]);

      mockDeleteDocument
        .mockResolvedValueOnce([{}])
        .mockRejectedValueOnce(
          Object.assign(new Error('NOT_FOUND'), { code: 5 }),
        );

      const stream = await indexingEngine.getIndexer('software-catalog');
      const closePromise = new Promise<void>(resolve =>
        stream.once('close', resolve),
      );

      stream.write({
        title: 'Active Service',
        text: 'Still exists',
        location: activeLocation,
      });

      await new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });
      await closePromise;

      expect(mockDeleteDocument).toHaveBeenCalledTimes(2);
      expect(mockDeleteDocument).toHaveBeenCalledWith({
        name: 'mock-parent-path/documents/stale-doc-1',
      });
      expect(mockDeleteDocument).toHaveBeenCalledWith({
        name: 'mock-parent-path/documents/stale-doc-2',
      });
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should throw, log errorSamples, skip eviction, and close client when importDocuments reports failureCount > 0', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: { enabled: true },
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

      mockListDocuments.mockResolvedValueOnce([
        [{ id: 'existing-doc-must-not-be-deleted', structData: {} }],
        null,
        {},
      ]);

      const mockOperation = {
        name: 'op-partial-fail',
        promise: jest
          .fn()
          .mockResolvedValue([
            { errorSamples: [{ code: 3, message: 'Schema mismatch' }] },
            { failureCount: 1 },
          ]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      const closePromise = new Promise<void>(resolve =>
        stream.once('close', resolve),
      );

      stream.write({
        title: 'Broken Doc',
        text: 'Content',
        location: '/catalog/default/component/broken',
      });

      await expect(
        new Promise<void>((resolve, reject) => {
          stream.on('error', reject);
          stream.end((err: any) => (err ? reject(err) : resolve()));
        }),
      ).rejects.toThrow(/importDocuments failed/);

      await closePromise;

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Schema mismatch'),
      );
      expect(mockDeleteDocument).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should skip eviction and close gRPC client when an upstream error destroys the stream', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: { enabled: true },
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

      mockListDocuments.mockResolvedValueOnce([
        [{ id: 'existing-doc-safe', structData: {} }],
        null,
        {},
      ]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      const errorAndClose = new Promise<Error>(resolve => {
        let capturedErr: Error;
        stream.once('error', err => {
          capturedErr = err;
        });
        stream.once('close', () => resolve(capturedErr));
      });

      stream.destroy(new Error('Upstream collator failure'));
      const err = await errorAndClose;

      expect(err.message).toBe('Upstream collator failure');
      expect(mockDeleteDocument).not.toHaveBeenCalled();
      expect(mockClose).toHaveBeenCalledTimes(1);
    });

    it('should retry transient gRPC codes (4, 8, 14) with backoff and not retry permanent errors', async () => {
      const indexingEngine = new VertexAISearchEngine({
        indexing: {
          enabled: true,
          maxRetries: 3,
          initialRetryDelayMs: 5,
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
        name: 'op-retried',
        promise: jest.fn().mockResolvedValue([{}, { failureCount: 0 }]),
      };

      mockImportDocuments
        .mockRejectedValueOnce(
          Object.assign(new Error('UNAVAILABLE'), { code: 14 }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('RESOURCE_EXHAUSTED'), { code: 8 }),
        )
        .mockRejectedValueOnce(
          Object.assign(new Error('DEADLINE_EXCEEDED'), { code: 4 }),
        )
        .mockResolvedValueOnce([mockOperation]);

      const stream = await indexingEngine.getIndexer('software-catalog');
      const closePromise = new Promise<void>(resolve =>
        stream.once('close', resolve),
      );
      stream.write({
        title: 'Resilient Entity',
        text: 'Body',
        location: '/catalog/default/component/resilient',
      });
      await new Promise<void>((resolve, reject) => {
        stream.end((err: any) => (err ? reject(err) : resolve()));
      });
      await closePromise;

      expect(mockImportDocuments).toHaveBeenCalledTimes(4);

      // Permanent gRPC error (code 3 INVALID_ARGUMENT) must fail immediately without retry
      mockImportDocuments.mockReset();
      mockImportDocuments.mockRejectedValue(
        Object.assign(new Error('INVALID_ARGUMENT'), { code: 3 }),
      );

      const failStream = await indexingEngine.getIndexer('software-catalog');
      const failClose = new Promise<void>(resolve =>
        failStream.once('close', resolve),
      );
      failStream.write({
        title: 'Invalid Entity',
        text: 'Body',
        location: '/catalog/default/component/invalid',
      });
      await expect(
        new Promise<void>((resolve, reject) => {
          failStream.on('error', reject);
          failStream.end((err: any) => (err ? reject(err) : resolve()));
        }),
      ).rejects.toThrow('INVALID_ARGUMENT');
      await failClose;
      expect(mockImportDocuments).toHaveBeenCalledTimes(1);
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

      expect(mockSearch).toHaveBeenCalledWith(
        {
          servingConfig:
            'projects/my-project/locations/europe-west4/dataStores/my-datastore/servingConfigs/default_search',
          query: 'search-term',
          filter: undefined,
          pageSize: undefined,
          pageToken: undefined,
          relevanceScoreSpec: { returnRelevanceScore: true },
        },
        { autoPaginate: false },
      );

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

      expect(mockSearch).toHaveBeenCalledWith(
        {
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
        },
        { autoPaginate: false },
      );
    });

    it('should translate filters into a Google AIP-160 predicate preserving canonical kind casing', async () => {
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
          filter: 'namespace: ANY("default") AND kind: ANY("Component", "API")',
        }),
        { autoPaginate: false },
      );
    });

    it('should pass pagination options through to Vertex AI search API with autoPaginate: false', async () => {
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
        { autoPaginate: false },
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
        { autoPaginate: false },
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
        { autoPaginate: false },
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
        { autoPaginate: false },
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

    it('should preserve plain JavaScript arrays when unpacking snippets from derivedStructData', async () => {
      mockSearch.mockResolvedValue([
        [
          {
            document: {
              name: 'doc-name',
              structData: {
                title: 'Plain Array Doc',
                location: '/docs/default/component/my-comp/page.html',
                text: 'Full fallback body',
              },
              derivedStructData: {
                snippets: [{ snippet: 'Plain array snippet' }],
              },
            },
          },
        ],
        undefined,
        {},
      ]);

      const response = await engine.query({
        term: 'search-term',
        types: ['techdocs'],
      });

      expect(response.results[0].document.text).toBe('Plain array snippet');
    });
  });
});
