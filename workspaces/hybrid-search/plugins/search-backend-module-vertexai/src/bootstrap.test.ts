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
  asyncPool,
  fetchCatalogEntity,
  processEntity,
  prepareDocs,
  importDocs,
} from '../scripts/bootstrap';

// 1. Mock @google-cloud/storage
const mockDownload = jest.fn();
const mockSave = jest.fn();
const mockGetFiles = jest.fn();

const mockFileObj = (name: string) => ({
  name,
  download: mockDownload,
  save: mockSave,
});

const mockBucketObj = {
  file: jest.fn().mockImplementation((name: string) => mockFileObj(name)),
  getFiles: mockGetFiles,
};

jest.mock('@google-cloud/storage', () => {
  return {
    Storage: jest.fn().mockImplementation(() => ({
      bucket: jest.fn().mockReturnValue(mockBucketObj),
    })),
  };
});

// 2. Mock @google-cloud/discoveryengine
const mockImportDocuments = jest.fn();

jest.mock('@google-cloud/discoveryengine', () => {
  return {
    DocumentServiceClient: jest.fn().mockImplementation(() => ({
      importDocuments: mockImportDocuments,
      projectLocationCollectionDataStoreBranchPath: jest
        .fn()
        .mockReturnValue('mock-gcp-path'),
    })),
  };
});

describe('bootstrap CLI script', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    global.fetch = jest.fn();
  });

  describe('asyncPool', () => {
    it('should limit parallel executions and collect all results', async () => {
      const items = [1, 2, 3, 4, 5];
      let activeCount = 0;
      let maxActiveCount = 0;

      const fn = async (item: number) => {
        activeCount++;
        maxActiveCount = Math.max(maxActiveCount, activeCount);
        await new Promise(resolve => setTimeout(resolve, 10));
        activeCount--;
        return item * 2;
      };

      const results = await asyncPool(2, items, fn); // Limit to 2 parallel tasks!

      expect(results).toEqual([2, 4, 6, 8, 10]);
      expect(maxActiveCount).toBeLessThanOrEqual(2); // Never exceeded 2 parallel tasks
    });
  });

  describe('fetchCatalogEntity', () => {
    it('should return parsed JSON when the catalog API responds successfully', async () => {
      const mockEntity = {
        metadata: { name: 'my-service' },
        spec: { owner: 'team-a' },
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockEntity),
      });

      const result = await fetchCatalogEntity(
        'http://localhost:7007',
        'Component',
        'default',
        'my-service',
      );
      expect(result).toEqual(mockEntity);
      expect(global.fetch).toHaveBeenCalledWith(
        'http://localhost:7007/api/catalog/entities/by-name/component/default/my-service',
      );
    });

    it('should return null and warn when the catalog API returns a non-2xx status', async () => {
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: false,
        status: 404,
      });

      const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await fetchCatalogEntity(
        'http://localhost:7007',
        'Component',
        'default',
        'my-service',
      );
      expect(result).toBeNull();
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });

    it('should return null and warn when a network exception occurs', async () => {
      (global.fetch as jest.Mock).mockRejectedValue(
        new Error('Connection refused'),
      );

      const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await fetchCatalogEntity(
        'http://localhost:7007',
        'Component',
        'default',
        'my-service',
      );
      expect(result).toBeNull();
      expect(logSpy).toHaveBeenCalled();
      logSpy.mockRestore();
    });
  });

  describe('processEntity', () => {
    it('should download GCS index, fetch catalog metadata, format NDJSON, and upload staging file', async () => {
      // Mock GCS blob download containing 2 documents
      const mockIndexContent = JSON.stringify({
        docs: [
          { title: 'Doc 1', text: 'Text 1', location: 'page-1.html' },
          { title: 'Doc 2', text: 'Text 2', location: 'page-2.html' },
        ],
      });
      mockDownload.mockResolvedValue([Buffer.from(mockIndexContent)]);

      // Mock Catalog Entity response
      const mockEntity = {
        metadata: { annotations: { 'backstage.io/techdocs-ref': 'dir' } },
        spec: {
          owner: 'group:default/team-a',
          lifecycle: 'production',
          type: 'service',
        },
      };
      (global.fetch as jest.Mock).mockResolvedValue({
        ok: true,
        json: jest.fn().mockResolvedValue(mockEntity),
      });

      const mockBlob = mockFileObj(
        'default/component/my-service/search_index.json',
      ) as any;
      const mockDestBlob = mockFileObj(
        'default-component-my-service.ndjson',
      ) as any;
      mockBucketObj.file.mockReturnValue(mockDestBlob);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await processEntity(mockBlob, mockBucketObj, 'http://localhost:7007');

      // Verify staging bucket NDJSON file creation
      expect(mockBucketObj.file).toHaveBeenCalledWith(
        'default-component-my-service.ndjson',
      );
      expect(mockSave).toHaveBeenCalled();

      // Parse the saved NDJSON entries
      const savedNdjson = mockSave.mock.calls[0][0];
      const lines = savedNdjson.split('\n');
      expect(lines.length).toBe(2);

      const firstEntry = JSON.parse(lines[0]);
      expect(firstEntry.id).toBeDefined();

      const firstData = JSON.parse(firstEntry.jsonData);
      expect(firstData.title).toBe('Doc 1');
      expect(firstData.owner).toBe('group:default/team-a');
      expect(firstData.lifecycle).toBe('production');
      expect(firstData.componentType).toBe('service');
      expect(firstData.authorization.resourceRef).toBe(
        'component:default/my-service',
      );

      logSpy.mockRestore();
    });

    it('should skip invalid file paths and log warnings', async () => {
      const mockBlob = mockFileObj('invalid-path.json') as any;
      const logSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

      await processEntity(mockBlob, mockBucketObj, 'http://localhost:7007');

      expect(mockDownload).not.toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Skipping invalid path structure'),
      );
      logSpy.mockRestore();
    });
  });

  describe('prepareDocs', () => {
    it('should scan techdocs bucket, filter search_index.json files, and trigger processing', async () => {
      // Mock files in source bucket
      const mockBlobs = [
        mockFileObj('default/component/my-service/search_index.json'),
        mockFileObj('default/component/my-service/style.css'), // CSS file (should be ignored!)
        mockFileObj('default/component/other-service/search_index.json'),
      ];
      mockGetFiles.mockResolvedValue([mockBlobs]);

      // Mock processing methods
      mockDownload.mockResolvedValue([
        Buffer.from(JSON.stringify({ docs: [] })),
      ]);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await prepareDocs({
        techdocsBucket: 'source-bucket',
        stagingBucket: 'staging-bucket',
        backstageUrl: 'http://localhost:7007',
      });

      // Verify GCS scanning and filter
      expect(mockGetFiles).toHaveBeenCalled();
      expect(logSpy).toHaveBeenCalledWith(
        expect.stringContaining('Found 2 entities to process.'),
      );

      logSpy.mockRestore();
    });
  });

  describe('importDocs', () => {
    it('should batch staging files in groups of 100 and trigger Vertex AI Search imports', async () => {
      // Mock 120 staging ndjson files in the staging bucket
      const mockNdjsonFiles: any[] = [];
      for (let i = 1; i <= 120; i++) {
        mockNdjsonFiles.push(mockFileObj(`file-${i}.ndjson`));
      }
      mockGetFiles.mockResolvedValue([mockNdjsonFiles]);

      // Mock Discovery Engine operation response
      const mockOperation = {
        name: 'import-op-id',
        promise: jest.fn().mockResolvedValue([{}]),
      };
      mockImportDocuments.mockResolvedValue([mockOperation]);

      const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

      await importDocs({
        projectId: 'my-project',
        location: 'europe-west4',
        datastoreId: 'techdocs-ds',
        stagingBucket: 'staging-bucket',
      });

      // Verify staging bucket files were retrieved
      expect(mockGetFiles).toHaveBeenCalled();

      // Verify that importDocuments was called TWICE (batch 1: 100 files, batch 2: 20 files)
      expect(mockImportDocuments).toHaveBeenCalledTimes(2);

      // Verify the first batch size is exactly 100
      const firstCallArgs = mockImportDocuments.mock.calls[0][0];
      expect(firstCallArgs.gcsSource.inputUris.length).toBe(100);
      expect(firstCallArgs.gcsSource.inputUris[0]).toBe(
        'gs://staging-bucket/file-1.ndjson',
      );

      // Verify the second batch size is exactly 20
      const secondCallArgs = mockImportDocuments.mock.calls[1][0];
      expect(secondCallArgs.gcsSource.inputUris.length).toBe(20);
      expect(secondCallArgs.gcsSource.inputUris[0]).toBe(
        'gs://staging-bucket/file-101.ndjson',
      );

      logSpy.mockRestore();
    });
  });
});
