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
import { TypesenseSearchEngine } from './TypesenseSearchEngine';
import { LoggerService } from '@backstage/backend-plugin-api';
import { Writable } from 'node:stream';

// Mock typesense client
const mockImport = jest.fn();
const mockSearch = jest.fn();
const mockRetrieve = jest.fn();
const mockDocuments = jest.fn().mockReturnValue({
  import: mockImport,
  search: mockSearch,
});
const mockCollections = jest.fn().mockReturnValue({
  retrieve: mockRetrieve,
  documents: mockDocuments,
});

jest.mock('typesense', () => {
  return {
    Client: jest.fn().mockImplementation(() => {
      return {
        collections: mockCollections,
      };
    }),
  };
});

describe('TypesenseSearchEngine', () => {
  let engine: TypesenseSearchEngine;
  let mockLogger: jest.Mocked<LoggerService>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;

    engine = new TypesenseSearchEngine({
      apiKey: 'test-key',
      nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
      logger: mockLogger,
    });
  });

  describe('getIndexer', () => {
    it('should return a Writable stream that imports documents to Typesense', async () => {
      mockImport.mockResolvedValue([]);

      const indexer = await engine.getIndexer('software-catalog');
      expect(indexer).toBeInstanceOf(Writable);

      // Write a document to the stream and end it
      indexer.write({
        title: 'My Component',
        text: 'This is my component',
        location: 'catalog/default/component/my-comp',
        owner: 'team-a',
        lifecycle: 'production',
      });
      indexer.end();

      // Wait for stream to finish
      await new Promise<void>((resolve, reject) => {
        indexer.on('finish', resolve);
        indexer.on('error', reject);
      });

      expect(mockCollections).toHaveBeenCalledWith(
        'backstage_software-catalog',
      );
      expect(mockImport).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({
            title: 'My Component',
            text: 'This is my component',
            owner: 'team-a',
            lifecycle: 'production',
          }),
        ]),
        expect.any(Object),
      );
    });
  });

  describe('query', () => {
    it('should query Typesense collection and map results back to Backstage schema', async () => {
      const mockSearchResponse = {
        hits: [
          {
            document: {
              title: 'My Component',
              text: 'This is my component',
              location: 'catalog/default/component/my-comp',
              kind: 'Component',
              namespace: 'default',
              name: 'my-comp',
              owner: 'team-a',
              lifecycle: 'production',
            },
            text_match_info: { score: '42' },
          },
        ],
        found: 1,
        page: 1,
      };
      mockSearch.mockResolvedValue(mockSearchResponse);

      const queryObj = {
        term: 'test-term',
        types: ['software-catalog'],
      };

      const response = await engine.query(queryObj);

      expect(mockCollections).toHaveBeenCalledWith(
        'backstage_software-catalog',
      );
      expect(mockSearch).toHaveBeenCalledWith({
        q: 'test-term',
        query_by: 'title,text,location',
        filter_by: undefined,
        per_page: 20,
        page: 1,
      });

      expect(response.results).toHaveLength(1);
      expect(response.results[0]).toEqual({
        type: 'software-catalog',
        document: {
          title: 'My Component',
          text: 'This is my component',
          location: 'catalog/default/component/my-comp',
          kind: 'Component',
          namespace: 'default',
          name: 'my-comp',
          owner: 'team-a',
          lifecycle: 'production',
        },
        score: 42,
      });
      expect(response.nextPageCursor).toBeUndefined();
    });

    it('should query all configured collections when query types are not specified', async () => {
      const engineWithCollections = new TypesenseSearchEngine({
        apiKey: 'test-key',
        nodes: [{ host: 'localhost', port: 8108, protocol: 'http' }],
        logger: mockLogger,
        collections: {
          'software-catalog': {},
          techdocs: {},
        },
      });

      mockSearch.mockResolvedValue({ hits: [] });

      await engineWithCollections.query({ term: 'test-term' });

      expect(mockCollections).toHaveBeenCalledWith(
        'backstage_software-catalog',
      );
      expect(mockCollections).toHaveBeenCalledWith('backstage_techdocs');
    });

    it('should pass down filter_by parameters derived from Backstage query filters', async () => {
      mockSearch.mockResolvedValue({ hits: [] });

      await engine.query({
        term: 'test-term',
        types: ['software-catalog'],
        filters: {
          kind: 'Component',
          tags: ['aws', 'react'],
        },
      });

      expect(mockSearch).toHaveBeenCalledWith(
        expect.objectContaining({
          filter_by: 'kind:=`Component` && tags:=[`aws`, `react`]',
        }),
      );
    });

    it('should pass pagination parameters and compute nextPageCursor', async () => {
      mockSearch.mockResolvedValue({
        hits: [
          {
            document: { title: 'Comp A', location: 'a' },
          },
        ],
        found: 50,
        page: 2,
      });

      const response = await engine.query({
        term: 'test-term',
        types: ['software-catalog'],
        pageLimit: 10,
        pageCursor: '2',
      });

      expect(mockSearch).toHaveBeenCalledWith({
        q: 'test-term',
        query_by: 'title,text,location',
        filter_by: undefined,
        per_page: 10,
        page: 2,
      });

      expect(response.nextPageCursor).toBe('3');
    });
  });
});
