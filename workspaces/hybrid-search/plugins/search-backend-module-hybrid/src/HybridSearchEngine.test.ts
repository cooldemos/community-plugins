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
import { HybridSearchEngine } from './HybridSearchEngine';
import { SearchEngine } from '@backstage/plugin-search-backend-node';
import { Writable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';

describe('HybridSearchEngine', () => {
  let mockTypesenseEngine: jest.Mocked<SearchEngine>;
  let mockVertexAiEngine: jest.Mocked<SearchEngine>;
  let mockLogger: jest.Mocked<LoggerService>;
  let hybridSearchEngine: HybridSearchEngine;

  beforeEach(() => {
    mockTypesenseEngine = {
      setTranslator: jest.fn(),
      getIndexer: jest.fn(),
      query: jest.fn(),
    } as any;

    mockVertexAiEngine = {
      setTranslator: jest.fn(),
      getIndexer: jest.fn(),
      query: jest.fn(),
    } as any;

    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn(),
    } as any;

    hybridSearchEngine = new HybridSearchEngine(mockLogger);
    hybridSearchEngine.registerEngine('typesense', mockTypesenseEngine, {
      supportsTypes: ['software-catalog', 'default'],
    });
    hybridSearchEngine.registerEngine('vertexai', mockVertexAiEngine, {
      supportsTypes: ['techdocs'],
    });
  });

  it('should initialize and log a message', () => {
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining(
        'Initialized custom Hybrid Search Engine with merge strategy: "interleave"',
      ),
    );
  });

  it('should throw an error on invalid mergeStrategy', () => {
    expect(() => {
      // eslint-disable-next-line no-new
      new HybridSearchEngine(mockLogger, { mergeStrategy: 'rubbish' as any });
    }).toThrow(
      'Invalid hybrid search mergeStrategy: "rubbish". Valid options are "interleave" or "score-normalized-sort".',
    );
  });

  describe('setTranslator', () => {
    it('should set translators on both engines', () => {
      const mockTranslator = {} as any;
      hybridSearchEngine.setTranslator(mockTranslator);
      expect(mockTypesenseEngine.setTranslator).toHaveBeenCalledWith(
        mockTranslator,
      );
      expect(mockVertexAiEngine.setTranslator).toHaveBeenCalledWith(
        mockTranslator,
      );
    });
  });

  describe('getIndexer', () => {
    it('should return the engine-specific indexer for techdocs', async () => {
      const mockWritable = new Writable();
      mockVertexAiEngine.getIndexer.mockResolvedValue(mockWritable);

      const indexer = await hybridSearchEngine.getIndexer('techdocs');
      expect(mockVertexAiEngine.getIndexer).toHaveBeenCalledWith('techdocs');
      expect(indexer).toBe(mockWritable);
    });

    it('should return Typesense indexer for other types', async () => {
      const mockWritable = new Writable();
      mockTypesenseEngine.getIndexer.mockResolvedValue(mockWritable);

      const indexer = await hybridSearchEngine.getIndexer('software-catalog');
      expect(mockTypesenseEngine.getIndexer).toHaveBeenCalledWith(
        'software-catalog',
      );
      expect(indexer).toBe(mockWritable);
    });
  });

  describe('query', () => {
    it('should route software-catalog to Typesense', async () => {
      const mockResult = {
        results: [{ document: { title: 'Component A' } }],
      } as any;
      mockTypesenseEngine.query.mockResolvedValue(mockResult);

      const queryObj = { term: 'test', types: ['software-catalog'] };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith(queryObj);
      expect(mockVertexAiEngine.query).not.toHaveBeenCalled();
      expect(response).toBe(mockResult);
    });

    it('should route techdocs to Vertex AI Search', async () => {
      const mockResult = { results: [{ document: { title: 'Doc A' } }] } as any;
      mockVertexAiEngine.query.mockResolvedValue(mockResult);

      const queryObj = { term: 'test', types: ['techdocs'] };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockVertexAiEngine.query).toHaveBeenCalledWith(queryObj);
      expect(mockTypesenseEngine.query).not.toHaveBeenCalled();
      expect(response).toBe(mockResult);
    });

    it('should query both in parallel and interleave results when no types are provided', async () => {
      const typesenseResult = {
        results: [
          { document: { title: 'Cat 1' } },
          { document: { title: 'Cat 2' } },
        ],
      } as any;
      const vertexResult = {
        results: [
          { document: { title: 'Doc 1' } },
          { document: { title: 'Doc 2' } },
        ],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = { term: 'test' };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        ...queryObj,
        types: ['software-catalog'],
      });
      expect(mockVertexAiEngine.query).toHaveBeenCalledWith({
        ...queryObj,
        types: ['techdocs'],
      });

      // Expected interleaved order: Cat 1, Doc 1, Cat 2, Doc 2
      expect(response.results).toEqual([
        { document: { title: 'Cat 1' } },
        { document: { title: 'Doc 1' } },
        { document: { title: 'Cat 2' } },
        { document: { title: 'Doc 2' } },
      ]);
    });

    it('should query both in parallel, log an error, and return partial results if one engine fails when no types are provided', async () => {
      const typesenseResult = {
        results: [{ document: { title: 'Cat 1' } }],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockRejectedValue(new Error('Vertex AI down'));

      const queryObj = { term: 'test' };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        ...queryObj,
        types: ['software-catalog'],
      });
      expect(mockVertexAiEngine.query).toHaveBeenCalledWith({
        ...queryObj,
        types: ['techdocs'],
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Parallel query failed for engine "vertexai":'),
        expect.any(Error),
      );

      // Expected results only contain Typesense results since Vertex failed
      expect(response.results).toEqual([{ document: { title: 'Cat 1' } }]);
    });

    it('should query both in parallel and interleave results when both types are specified', async () => {
      const typesenseResult = {
        results: [{ document: { title: 'Cat 1' } }],
      } as any;
      const vertexResult = {
        results: [
          { document: { title: 'Doc 1' } },
          { document: { title: 'Doc 2' } },
        ],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = {
        term: 'test',
        types: ['software-catalog', 'techdocs'],
      };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['software-catalog'],
      });
      expect(mockVertexAiEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['techdocs'],
      });

      // Expected interleaved order: Cat 1, Doc 1, Doc 2
      expect(response.results).toEqual([
        { document: { title: 'Cat 1' } },
        { document: { title: 'Doc 1' } },
        { document: { title: 'Doc 2' } },
      ]);
    });

    it('should query both in parallel, log an error, and return partial results if one engine fails when both types are specified', async () => {
      const vertexResult = {
        results: [{ document: { title: 'Doc 1' } }],
      } as any;

      mockTypesenseEngine.query.mockRejectedValue(new Error('Typesense down'));
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = {
        term: 'test',
        types: ['software-catalog', 'techdocs'],
      };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['software-catalog'],
      });
      expect(mockVertexAiEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['techdocs'],
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          'Parallel query failed for engine "typesense":',
        ),
        expect.any(Error),
      );

      // Expected results only contain Vertex results since Typesense failed
      expect(response.results).toEqual([{ document: { title: 'Doc 1' } }]);
    });

    it('should default to Typesense query if target types are not catalog or techdocs', async () => {
      const mockResult = { results: [] } as any;
      mockTypesenseEngine.query.mockResolvedValue(mockResult);

      const queryObj = { term: 'test', types: ['other-type'] };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['other-type'],
      });
      expect(response).toBe(mockResult);
    });

    it('should sort results by normalized score when score-normalized-sort strategy is enabled', async () => {
      const scoredEngine = new HybridSearchEngine(mockLogger, {
        mergeStrategy: 'score-normalized-sort',
      });
      scoredEngine.registerEngine('typesense', mockTypesenseEngine, {
        supportsTypes: ['software-catalog', 'default'],
      });
      scoredEngine.registerEngine('vertexai', mockVertexAiEngine, {
        supportsTypes: ['techdocs'],
      });

      // Typesense results: max score is 100
      const typesenseResult = {
        results: [
          { document: { title: 'Cat 1' }, score: 100 },
          { document: { title: 'Cat 2' }, score: 30 },
        ],
      } as any;

      // Vertex results: max score is 1.0
      const vertexResult = {
        results: [
          { document: { title: 'Doc 1' }, score: 0.9 },
          { document: { title: 'Doc 2' }, score: 0.2 },
        ],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = {
        term: 'test',
        types: ['software-catalog', 'techdocs'],
      };
      const response = await scoredEngine.query(queryObj);

      // Expected normalized scores:
      // Cat 1: 100 / 100 = 1.0
      // Doc 1: 0.9 / 0.9 = 1.0
      // Cat 2: 30 / 100 = 0.3
      // Doc 2: 0.2 / 0.9 = 0.222...
      // Expected sorted order: Cat 1 (1.0), Doc 1 (1.0), Cat 2 (0.3), Doc 2 (0.22)
      expect(response.results).toEqual([
        { document: { title: 'Cat 1' }, score: 1.0 },
        { document: { title: 'Doc 1' }, score: 1.0 },
        { document: { title: 'Cat 2' }, score: 0.3 },
        { document: { title: 'Doc 2' }, score: 0.22222222222222224 },
      ]);
    });

    it('should respect the pageLimit option and slice the merged results array to the requested limit', async () => {
      const typesenseResult = {
        results: [
          { document: { title: 'Cat 1' } },
          { document: { title: 'Cat 2' } },
        ],
      } as any;
      const vertexResult = {
        results: [
          { document: { title: 'Doc 1' } },
          { document: { title: 'Doc 2' } },
        ],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = { term: 'test', pageLimit: 2 };
      const response = await hybridSearchEngine.query(queryObj);

      // The results array should be sliced to exactly 2 results (Cat 1 and Doc 1)
      expect(response.results).toHaveLength(2);
      expect(response.results).toEqual([
        { document: { title: 'Cat 1' } },
        { document: { title: 'Doc 1' } },
      ]);
    });

    it('should fall back to rank-based scoring when results are missing raw scores in score-normalized-sort strategy', async () => {
      const scoredEngine = new HybridSearchEngine(mockLogger, {
        mergeStrategy: 'score-normalized-sort',
      });
      scoredEngine.registerEngine('typesense', mockTypesenseEngine, {
        supportsTypes: ['software-catalog', 'default'],
      });
      scoredEngine.registerEngine('vertexai', mockVertexAiEngine, {
        supportsTypes: ['techdocs'],
      });

      // Cat 1 has score 100. Cat 2 is missing score (index 1 of length 2 -> 1 - 1/2 = 0.5)
      const typesenseResult = {
        results: [
          { document: { title: 'Cat 1' }, score: 100 },
          { document: { title: 'Cat 2' } },
        ],
      } as any;

      // Doc 1 is missing score (index 0 of length 2 -> 1 - 0/2 = 1.0). Doc 2 has score 0.2 (which is the max, so 0.2/0.2 = 1.0)
      const vertexResult = {
        results: [
          { document: { title: 'Doc 1' } },
          { document: { title: 'Doc 2' }, score: 0.2 },
        ],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = {
        term: 'test',
        types: ['software-catalog', 'techdocs'],
      };
      const response = await scoredEngine.query(queryObj);

      // Expected sorted order:
      // Cat 1 (1.0), Doc 1 (1.0), Doc 2 (1.0) -> followed by Cat 2 (0.5)
      expect(response.results).toEqual([
        { document: { title: 'Cat 1' }, score: 1.0 },
        { document: { title: 'Doc 1' }, score: 1.0 },
        { document: { title: 'Doc 2' }, score: 1.0 },
        { document: { title: 'Cat 2' }, score: 0.5 },
      ]);
    });

    it('should query both engines in parallel when one type maps explicitly and another type falls back to default', async () => {
      const typesenseResult = {
        results: [{ document: { title: 'Cat 1' } }],
      } as any;
      const vertexResult = {
        results: [{ document: { title: 'Doc 1' } }],
      } as any;

      mockTypesenseEngine.query.mockResolvedValue(typesenseResult);
      mockVertexAiEngine.query.mockResolvedValue(vertexResult);

      const queryObj = { term: 'test', types: ['techdocs', 'custom-type'] };
      const response = await hybridSearchEngine.query(queryObj);

      expect(mockVertexAiEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['techdocs'],
      });
      expect(mockTypesenseEngine.query).toHaveBeenCalledWith({
        term: 'test',
        types: ['custom-type'],
      });

      expect(response.results).toEqual([
        { document: { title: 'Doc 1' } },
        { document: { title: 'Cat 1' } },
      ]);
    });
  });
});
