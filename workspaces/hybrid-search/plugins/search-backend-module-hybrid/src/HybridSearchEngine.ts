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
  SearchEngine,
  QueryTranslator,
} from '@backstage/plugin-search-backend-node';
import {
  IndexableResultSet,
  SearchQuery,
  SearchResult,
} from '@backstage/plugin-search-common';
import { Writable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';

/**
 * Merging strategy for combining search results from multiple engines.
 * @public
 */
export type HybridSearchMergeStrategy =
  /**
   * Sequentially pulls results from each sub-engine in a round-robin order.
   * Best for disjoint search scopes where each engine deserves equal presence.
   */
  | 'interleave'
  /**
   * Scales the relevance scores from each sub-engine to a [0, 1] scale relative
   * to the highest score in that set, and sorts the combined results descending.
   * Best for sorting by relevance when engines operate on different score scales.
   */
  | 'score-normalized-sort';

/**
 * Orchestrator search engine that routes queries across registered sub-engines.
 *
 * @public
 */
export class HybridSearchEngine implements SearchEngine {
  /**
   * Map of registered search sub-engines, keyed by engine name.
   */
  private readonly engines = new Map<string, SearchEngine>();
  /**
   * Mapping of search document types to the handling engine's name.
   */
  private readonly typeMapping = new Map<string, string>(); // type -> engineName
  /**
   * The merging strategy used to aggregate search results.
   */
  private readonly mergeStrategy: HybridSearchMergeStrategy;

  /**
   * Creates a new instance of HybridSearchEngine.
   *
   * @param logger - The logger service.
   * @param options - Configuration options.
   */
  constructor(
    private readonly logger: LoggerService,
    options?: { mergeStrategy?: HybridSearchMergeStrategy },
  ) {
    const strategy = options?.mergeStrategy || 'interleave';
    if (strategy !== 'interleave' && strategy !== 'score-normalized-sort') {
      throw new Error(
        `Invalid hybrid search mergeStrategy: "${strategy}". Valid options are "interleave" or "score-normalized-sort".`,
      );
    }
    this.mergeStrategy = strategy;
    this.logger.info(
      `Initialized custom Hybrid Search Engine with merge strategy: "${this.mergeStrategy}".`,
    );
  }

  /**
   * Registers a search sub-engine with the orchestrator.
   *
   * @param name - Unique name of the sub-engine (e.g. 'typesense', 'vertexai').
   * @param engine - The SearchEngine implementation.
   * @param options - Registration options.
   */
  registerEngine(
    name: string,
    engine: SearchEngine,
    options: { supportsTypes: string[] },
  ) {
    this.engines.set(name, engine);
    for (const type of options.supportsTypes) {
      this.typeMapping.set(type, name);
      this.logger.info(
        `Hybrid Search: Registered engine "${name}" for type "${type}"`,
      );
    }
  }

  /**
   * Sets the query translator on all registered sub-engines.
   *
   * @param translator - The query translator to assign.
   */
  setTranslator(translator: QueryTranslator): void {
    for (const engine of this.engines.values()) {
      engine.setTranslator(translator);
    }
  }

  /**
   * Resolves the appropriate writable index stream for a given document type.
   * Routes indexing tasks to the corresponding registered sub-engine.
   * If no engine is matched, returns a dummy no-op stream.
   *
   * @param type - The document index category (e.g. 'software-catalog', 'techdocs').
   * @returns A Promise resolving to a Writable index stream.
   */
  async getIndexer(type: string): Promise<Writable> {
    let engineName = this.typeMapping.get(type);
    if (!engineName) {
      engineName = this.typeMapping.get('default');
    }

    if (!engineName) {
      this.logger.warn(
        `Hybrid Search: No engine registered for type "${type}" and no default fallback. Using dummy no-op stream.`,
      );
      // Return a dummy no-op stream
      return new Writable({
        objectMode: true,
        write(_chunk, _encoding, callback) {
          callback();
        },
      });
    }

    this.logger.info(
      `Hybrid Search: Routing indexing for type "${type}" to engine "${engineName}".`,
    );
    const engine = this.engines.get(engineName)!;
    return engine.getIndexer(type);
  }

  /**
   * Performs federated query execution across registered sub-engines based on the requested types.
   * - If no types are specified, it queries all registered engines in parallel and merges the results.
   * - If types are mapped to a single engine, it forwards the query directly to that engine.
   * - If types are mapped to multiple engines, it executes queries in parallel and merges the results.
   * - Enforces the requested `pageLimit` count by slicing the final consolidated results list before returning.
   *
   * @param query - The abstract search request query structure.
   * @returns A Promise resolving to the indexable results.
   */
  async query(query: SearchQuery): Promise<IndexableResultSet> {
    const types = query.types || [];

    // If empty types, execute parallel query across all registered engines and interleave results
    if (types.length === 0) {
      this.logger.info(
        `Hybrid routing: Executing federated search across all registered engines for: "${query.term}"`,
      );

      // Group supported types by engine name so we can query each engine specifically for its types
      const engineSupportedTypes = new Map<string, string[]>();
      for (const [type, name] of this.typeMapping.entries()) {
        if (type !== 'default') {
          if (!engineSupportedTypes.has(name)) {
            engineSupportedTypes.set(name, []);
          }
          engineSupportedTypes.get(name)!.push(type);
        }
      }

      const enginesList = Array.from(this.engines.entries());
      const targets = enginesList.map(([name]): [string, string[]] => [
        name,
        engineSupportedTypes.get(name) || [],
      ]);

      const successfulResults = await this.queryEnginesInParallel(
        targets,
        query,
      );
      const mergedResults = this.mergeResults(successfulResults);
      return {
        results: query.pageLimit
          ? mergedResults.slice(0, query.pageLimit)
          : mergedResults,
      };
    }

    // Map each requested type to its engine
    const engineQueries = new Map<string, string[]>(); // engineName -> types
    for (const type of types) {
      let engineName = this.typeMapping.get(type);
      if (!engineName) {
        engineName = this.typeMapping.get('default');
      }

      if (engineName) {
        if (!engineQueries.has(engineName)) {
          engineQueries.set(engineName, []);
        }
        engineQueries.get(engineName)!.push(type);
      }
    }

    if (engineQueries.size === 0) {
      this.logger.info(
        `Hybrid routing: No engines matched types: ${JSON.stringify(types)}`,
      );
      return { results: [] };
    }

    // If only one engine matches, query it directly
    if (engineQueries.size === 1) {
      const [[engineName, engineTypes]] = Array.from(engineQueries.entries());
      this.logger.info(
        `Hybrid routing: Routing query for types ${JSON.stringify(
          engineTypes,
        )} to engine "${engineName}"`,
      );
      const engine = this.engines.get(engineName)!;
      return engine.query({ ...query, types: engineTypes });
    }

    // Parallel federated query across matched engines
    this.logger.info(
      `Hybrid routing: Executing parallel federated query for "${
        query.term
      }" across engines: ${Array.from(engineQueries.keys()).join(', ')}`,
    );
    const enginesToQuery = Array.from(engineQueries.entries());
    const successfulResults = await this.queryEnginesInParallel(
      enginesToQuery,
      query,
    );
    const mergedResults = this.mergeResults(successfulResults);
    return {
      results: query.pageLimit
        ? mergedResults.slice(0, query.pageLimit)
        : mergedResults,
    };
  }

  /**
   * Executes search queries across multiple sub-engines in parallel and gathers successful result sets.
   *
   * @param enginesToQuery - Array of tuples containing engine name and targeted types list.
   * @param query - The abstract search request query structure.
   * @returns A Promise resolving to an array of search result sets from each successful sub-engine.
   */
  private async queryEnginesInParallel(
    enginesToQuery: Array<[string, string[]]>,
    query: SearchQuery,
  ): Promise<SearchResult[][]> {
    const settledResults = await Promise.allSettled(
      enginesToQuery.map(([engineName, engineTypes]) => {
        const engine = this.engines.get(engineName)!;
        return engine.query({ ...query, types: engineTypes });
      }),
    );

    const successfulResults: SearchResult[][] = [];
    settledResults.forEach((result, idx) => {
      const [engineName] = enginesToQuery[idx];
      if (result.status === 'fulfilled') {
        successfulResults.push(result.value.results);
      } else {
        this.logger.error(
          `Hybrid routing: Parallel query failed for engine "${engineName}":`,
          result.reason as Error,
        );
      }
    });

    return successfulResults;
  }

  /**
   * Merges multiple search result sets into a single unified result list based on the configured merge strategy.
   *
   * @param sets - Array of search result sets from the sub-engines.
   * @returns Staged and merged array of SearchResult.
   */
  private mergeResults(sets: SearchResult[][]): SearchResult[] {
    if (this.mergeStrategy === 'score-normalized-sort') {
      return this.scoreNormalizedSortResults(sets);
    }
    return this.interleaveResults(sets);
  }

  /**
   * Blends results sequentially in a round-robin/interleaving order (e.g. Set A [0], Set B [0], Set A [1]...).
   *
   * @param sets - Array of search result sets from the sub-engines.
   * @returns Interleaved array of SearchResult.
   */
  private interleaveResults(sets: SearchResult[][]): SearchResult[] {
    const merged: SearchResult[] = [];
    const maxLen = Math.max(...sets.map(s => s.length));
    for (let i = 0; i < maxLen; i++) {
      for (const set of sets) {
        if (i < set.length) {
          merged.push(set[i]);
        }
      }
    }
    return merged;
  }

  /**
   * Normalizes the scores of each engine's search result set to a [0, 1] scale relative to the maximum score
   * in that set, then aggregates and sorts the unified results list by normalized score descending.
   * If a document has no score, it calculates a fallback rank-based score relative to the set's length.
   *
   * @param sets - Array of search result sets from the sub-engines.
   * @returns Sorted and score-normalized array of SearchResult.
   */
  private scoreNormalizedSortResults(sets: SearchResult[][]): SearchResult[] {
    const scoredResults: Array<SearchResult & { normalizedScore: number }> = [];

    for (const set of sets) {
      if (set.length === 0) continue;

      const scores = set
        .map(item => (item as any).score)
        .filter((s): s is number => typeof s === 'number');

      const maxScore = scores.length > 0 ? Math.max(...scores) : 1;

      set.forEach((item, idx) => {
        const rawScore = (item as any).score;
        let normalizedScore: number;

        if (typeof rawScore === 'number') {
          normalizedScore = maxScore > 0 ? rawScore / maxScore : 1;
        } else {
          // Fallback score calculation: top ranks get higher priority
          normalizedScore = 1.0 - idx / set.length;
        }

        scoredResults.push({
          ...item,
          normalizedScore,
        });
      });
    }

    scoredResults.sort((a, b) => b.normalizedScore - a.normalizedScore);

    return scoredResults.map(({ normalizedScore, ...rest }) => ({
      ...rest,
      score: normalizedScore,
    }));
  }
}
