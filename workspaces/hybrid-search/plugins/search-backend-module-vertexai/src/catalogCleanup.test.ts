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
import { runCatalogCleanupSweeper } from './catalogCleanup';
import { ConfigReader } from '@backstage/config';

// 1. Define mock functions
const mockDownload = jest.fn();
const mockFile = jest.fn().mockReturnValue({
  download: mockDownload,
});
const mockDeleteFiles = jest.fn();
const mockGetFiles = jest.fn();
const mockBucket = jest.fn().mockReturnValue({
  file: mockFile,
  getFiles: mockGetFiles,
  deleteFiles: mockDeleteFiles,
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

const mockDeleteDocument = jest.fn();
jest.mock('@google-cloud/discoveryengine', () => {
  return {
    DocumentServiceClient: jest.fn().mockImplementation(() => {
      return {
        projectLocationCollectionDataStoreBranchPath: jest
          .fn()
          .mockReturnValue('mock-parent-path'),
        deleteDocument: mockDeleteDocument,
      };
    }),
  };
});

describe('runCatalogCleanupSweeper', () => {
  let mockCatalog: any;
  let mockLogger: any;
  let mockAuth: any;
  let mockConfig: any;

  beforeEach(() => {
    jest.clearAllMocks();

    mockCatalog = {
      getEntities: jest.fn(),
    };

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    };

    mockAuth = {
      getOwnServiceCredentials: jest
        .fn()
        .mockResolvedValue({ token: 'mock-token' }),
    };

    mockConfig = new ConfigReader({
      techdocs: {
        publisher: {
          googleGcs: {
            bucketName: 'my-techdocs-bucket',
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
    });
  });

  it('should skip sweep if bucketName is not configured', async () => {
    mockConfig = new ConfigReader({
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
    });

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('TechDocs GCS bucketName is not configured'),
    );
    expect(mockCatalog.getEntities).not.toHaveBeenCalled();
  });

  it('should sweep orphaned folders in GCS and delete their entries in Vertex AI Search', async () => {
    mockCatalog.getEntities.mockResolvedValue({
      items: [
        {
          metadata: {
            name: 'active-comp',
            namespace: 'default',
          },
          kind: 'Component',
        },
      ],
    });

    const mockActiveFile = {
      name: 'default/component/active-comp/index.html',
    };
    const mockStaleFile = { name: 'default/component/stale-comp/index.html' };
    const mockStaleIndexFile = {
      name: 'default/component/stale-comp/search/search_index.json',
    };

    mockGetFiles.mockResolvedValue([
      [mockActiveFile, mockStaleFile, mockStaleIndexFile],
    ]);

    const mockStaleDocs = [
      { title: 'Stale Page 1', text: 'stale text', location: 'page1.html' },
    ];
    mockDownload.mockResolvedValueOnce([
      Buffer.from(JSON.stringify({ docs: mockStaleDocs })),
    ]);

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockCatalog.getEntities).toHaveBeenCalledWith(
      expect.objectContaining({
        filter: { kind: 'component' },
      }),
      expect.objectContaining({
        credentials: { token: 'mock-token' },
      }),
    );

    expect(mockGetFiles).toHaveBeenCalled();
    expect(mockBucket).toHaveBeenCalledWith('my-techdocs-bucket');
    expect(mockFile).toHaveBeenCalledWith(
      'default/component/stale-comp/search/search_index.json',
    );
    expect(mockDownload).toHaveBeenCalled();

    expect(mockDeleteDocument).toHaveBeenCalledWith({
      name: 'mock-parent-path/documents/00d8f682855e663978f294dc1d323001',
    });

    expect(mockDeleteFiles).toHaveBeenCalledWith({
      prefix: 'default/component/stale-comp/',
    });
  });

  it('should handle failure when listing GCS bucket files (fails entire sweep)', async () => {
    mockCatalog.getEntities.mockResolvedValue({ items: [] });
    const mockError = new Error('GCS list failed');
    mockGetFiles.mockRejectedValueOnce(mockError);

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'TechDocs Orphan Sweeper: sweep failed with error',
      ),
      mockError,
    );
  });

  it('should handle failure when stale index file download fails (skips GDE purges, continues GCS purge)', async () => {
    mockCatalog.getEntities.mockResolvedValue({ items: [] });
    mockGetFiles.mockResolvedValue([
      [{ name: 'default/component/stale-comp/index.html' }],
    ]);
    const mockError = new Error('GCS download failed');
    mockDownload.mockRejectedValueOnce(mockError);

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'search_index.json not found or unreadable for orphan default/component/stale-comp',
      ),
    );
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteFiles).toHaveBeenCalledWith({
      prefix: 'default/component/stale-comp/',
    });
  });

  it('should handle failure when deleting a single document from Vertex AI (continues loop)', async () => {
    mockCatalog.getEntities.mockResolvedValue({ items: [] });
    mockGetFiles.mockResolvedValue([
      [{ name: 'default/component/stale-comp/search/search_index.json' }],
    ]);
    mockDownload.mockResolvedValueOnce([
      Buffer.from(
        JSON.stringify({
          docs: [
            { title: 'Doc 1', text: 'text 1', location: 'page1.html' },
            { title: 'Doc 2', text: 'text 2', location: 'page2.html' },
          ],
        }),
      ),
    ]);

    const mockError = new Error('Vertex delete document failed');
    mockDeleteDocument
      .mockRejectedValueOnce(mockError)
      .mockResolvedValueOnce({});

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'TechDocs Orphan Sweeper: failed to delete document',
      ),
      mockError,
    );
    expect(mockDeleteDocument).toHaveBeenCalledTimes(2);
    expect(mockDeleteFiles).toHaveBeenCalledWith({
      prefix: 'default/component/stale-comp/',
    });
  });

  it('should handle GDE client initialization error during document purges', async () => {
    mockCatalog.getEntities.mockResolvedValue({ items: [] });
    mockGetFiles.mockResolvedValue([
      [{ name: 'default/component/stale-comp/search/search_index.json' }],
    ]);
    mockDownload.mockResolvedValueOnce([
      Buffer.from(
        JSON.stringify({
          docs: [{ title: 'Doc 1', text: 'text 1', location: 'page1.html' }],
        }),
      ),
    ]);

    // Force getConfig to throw an error
    const brokenConfig = {
      getOptionalString: (key: string) => {
        if (key.includes('bucketName')) return 'my-techdocs-bucket';
        return undefined;
      },
      getConfig: () => {
        throw new Error('Config error');
      },
      getString: (key: string) => {
        throw new Error(`Config error for ${key}`);
      },
      getOptional: () => undefined,
    } as any;

    await runCatalogCleanupSweeper({
      config: brokenConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'TechDocs Orphan Sweeper: GDE client error during document purges',
      ),
      expect.any(Error),
    );
    expect(mockDeleteFiles).toHaveBeenCalledWith({
      prefix: 'default/component/stale-comp/',
    });
  });

  it('should handle failure when deleting files from GCS bucket', async () => {
    mockCatalog.getEntities.mockResolvedValue({ items: [] });
    mockGetFiles.mockResolvedValue([
      [{ name: 'default/component/stale-comp/index.html' }],
    ]);
    mockDownload.mockResolvedValueOnce([
      Buffer.from(JSON.stringify({ docs: [] })),
    ]);

    const mockError = new Error('GCS delete files failed');
    mockDeleteFiles.mockRejectedValueOnce(mockError);

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'TechDocs Orphan Sweeper: failed to clean GCS files for orphan',
      ),
      mockError,
    );
  });

  it('should skip cleanup if no orphaned folders are found in GCS', async () => {
    mockCatalog.getEntities.mockResolvedValue({
      items: [
        {
          metadata: { name: 'my-comp', namespace: 'default' },
          kind: 'Component',
        },
      ],
    });
    // The GCS file belongs to the active component, so it is not an orphan!
    mockGetFiles.mockResolvedValue([
      [{ name: 'default/component/my-comp/index.html' }],
    ]);

    await runCatalogCleanupSweeper({
      config: mockConfig,
      logger: mockLogger,
      catalog: mockCatalog,
      auth: mockAuth,
    });

    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'TechDocs Orphan Sweeper: no orphaned folders found in GCS',
      ),
    );
    expect(mockDownload).not.toHaveBeenCalled();
    expect(mockDeleteDocument).not.toHaveBeenCalled();
    expect(mockDeleteFiles).not.toHaveBeenCalled();
  });
});
