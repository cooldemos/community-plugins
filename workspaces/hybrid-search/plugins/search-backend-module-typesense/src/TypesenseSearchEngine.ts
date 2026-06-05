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
  IndexableDocument,
  IndexableResult,
} from '@backstage/plugin-search-common';
import {
  Client,
  ConfigurationOptions,
  CollectionFieldSchema,
  SearchParams,
  SearchResponse,
} from 'typesense';
import { Writable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';
import { JsonObject } from '@backstage/types';

/**
 * Extended document representation for Typesense storage, mapping standard Backstage IndexableDocument fields.
 */
interface TypesenseDocument extends IndexableDocument {
  /** Unique document identifier. */
  id?: string;
  /** The catalog entity kind (e.g. Component, API). */
  kind?: string;
  /** The catalog entity namespace (e.g. default). */
  namespace?: string;
  /** The catalog entity name. */
  name?: string;
}

/**
 * Translates a Backstage SearchQuery filter object into a Typesense filter expression.
 * Maps exact key-value strings or array list predicates.
 *
 * @param filters - The Backstage filters JSON object.
 * @returns A Typesense-compatible query filter string, or undefined if no filters are present.
 */
function buildTypesenseFilter(filters?: JsonObject): string | undefined {
  if (!filters || Object.keys(filters).length === 0) {
    return undefined;
  }

  const formatVal = (v: any) => (typeof v === 'string' ? `\`${v}\`` : `${v}`);

  const expressions = Object.entries(filters)
    .map(([key, val]) => {
      if (Array.isArray(val)) {
        const listStr = val.map(formatVal).join(', ');
        return `${key}:=[${listStr}]`;
      }
      if (val !== null && val !== undefined) {
        return `${key}:=${formatVal(val)}`;
      }
      return null;
    })
    .filter((expr): expr is string => expr !== null);

  return expressions.length > 0 ? expressions.join(' && ') : undefined;
}

/**
 * Options for configuring the TypesenseSearchEngine.
 *
 * @public
 */
export interface TypesenseEngineOptions {
  /**
   * The API Key used to authenticate requests to the Typesense cluster.
   */
  apiKey: string;
  /**
   * The nodes config array for cluster connectivity.
   */
  nodes: Array<{ host: string; port: number; protocol: string; path?: string }>;
  /**
   * Additional configuration options passed straight to the raw Typesense client.
   */
  clientOptions?: ConfigurationOptions;
  /**
   * Optional custom field definitions and default search query options grouped by collection type.
   */
  collections?: Record<
    string,
    {
      fields?: CollectionFieldSchema[];
      searchOptions?: SearchParams<any>;
    }
  >;
  /**
   * Core Backstage logging service utility.
   */
  logger: LoggerService;
}

/**
 * High-performance batching stream for importing documents into Typesense.
 *
 * Extends the Node writable stream in objectMode, buffering collated index documents
 * and flushing them in batch sets of 100 to reduce connection roundtrips and improve ingestion throughput.
 * Maps unique document IDs deterministically from catalog/storage location strings to prevent duplicates.
 */
class TypesenseWritableStream extends Writable {
  /** Internal memory array buffering documents before import. */
  private buffer: TypesenseDocument[] = [];
  /** Maximum number of documents to buffer before importing in a single request. */
  private batchSize = 100;

  /**
   * Creates a new instance of TypesenseWritableStream.
   *
   * @param client - Typesense client client.
   * @param collectionName - The target collection to import documents into.
   * @param logger - The logger service.
   */
  constructor(
    private client: Client,
    private collectionName: string,
    private logger: LoggerService,
  ) {
    super({ objectMode: true });
  }

  /**
   * Writable stream internal write handler. Buffers chunk elements and flushes on batch limits.
   */
  async _write(
    chunk: TypesenseDocument,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): Promise<void> {
    this.buffer.push(chunk);

    if (this.buffer.length >= this.batchSize) {
      try {
        await this.flush();
        callback();
      } catch (err) {
        this.logger.error(`Failed to flush batch to Typesense:`, err as Error);
        callback(err as Error);
      }
    } else {
      callback();
    }
  }

  /**
   * Writable stream internal final handler. Ensures any remaining buffered documents are flushed.
   */
  async _final(callback: (error?: Error | null) => void): Promise<void> {
    try {
      await this.flush();
      callback();
    } catch (err) {
      this.logger.error(
        `Failed to flush final stream buffer to Typesense:`,
        err as Error,
      );
      callback(err as Error);
    }
  }

  /**
   * Flushes the current document buffer to Typesense using upsert.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const batch = this.buffer.map(doc => ({
      ...doc,
      // Use existing document ID or derive a stable deterministic ID from the file location
      id: doc.id || Buffer.from(doc.location).toString('hex'),
    }));

    this.buffer = [];

    this.logger.info(
      `Flushing ${batch.length} documents to Typesense collection: ${this.collectionName}`,
    );

    // Using 'upsert' ensures existing assets are safely overwritten without producing duplicates
    await this.client
      .collections(this.collectionName)
      .documents()
      .import(batch, { action: 'upsert' });
  }
}

/**
 * Typesense SearchEngine implementation.
 *
 * Orchestrates document ingestion and query handling for Backstage categories
 * mapped to Typesense sub-routing. Registers auto-provisioned collections with
 * fallback schemas, and maps search match score relevancy back to search queries.
 *
 * @public
 */
export class TypesenseSearchEngine implements SearchEngine {
  private client: Client;
  private logger: LoggerService;
  private collectionsConfig?: Record<
    string,
    {
      fields?: CollectionFieldSchema[];
      searchOptions?: SearchParams<any>;
    }
  >;

  constructor(options: TypesenseEngineOptions) {
    this.logger = options.logger;
    this.collectionsConfig = options.collections;
    this.client = new Client({
      apiKey: options.apiKey,
      nodes: options.nodes,
      ...options.clientOptions,
    });

    this.logger.info('Initialized custom Typesense Search Engine.');
  }

  /**
   * Registers a query translator. (No-op interface placeholder).
   */
  setTranslator(_translator: QueryTranslator): void {
    // No-op: Translator not needed for raw queries, but interface requires implementation
  }

  /**
   * Asserts that the target collection exists in Typesense, creating it with the fallback
   * or configured schema if it returns a 404.
   *
   * @param collectionName - The name of the collection to check or create.
   */
  private async ensureCollection(collectionName: string): Promise<void> {
    try {
      await this.client.collections(collectionName).retrieve();
    } catch (error: any) {
      // Create the collection if it does not exist
      if (error && (error.status === 404 || error.name === 'ObjectNotFound')) {
        this.logger.info(
          `Creating missing Typesense collection: ${collectionName}`,
        );
        const type = collectionName.replace(/^backstage_/, '');
        const config = this.collectionsConfig?.[type];
        // Standard wildcard fallback schema allows dynamic indexing
        const fields = config?.fields || [{ name: '.*', type: 'auto' }];

        await this.client.collections().create({
          name: collectionName,
          fields,
        });
      } else {
        throw error;
      }
    }
  }

  /**
   * Resolves the custom writable stream for document ingestion.
   * Ensures the target collection is provisioned before returning the stream.
   *
   * @param type - The document index category/type.
   * @returns A Promise resolving to the Writable index stream.
   */
  async getIndexer(type: string): Promise<Writable> {
    const collectionName = `backstage_${type}`;
    await this.ensureCollection(collectionName);

    return new TypesenseWritableStream(
      this.client,
      collectionName,
      this.logger,
    );
  }

  /**
   * Performs queries across target collections, mapping Typesense scoring and documents
   * back to the standard Backstage IndexableResultSet shape.
   *
   * @param query - The abstract search request query structure.
   * @returns A Promise resolving to the indexable results.
   */
  async query(query: SearchQuery): Promise<IndexableResultSet> {
    const rawTypes =
      query.types && query.types.length > 0
        ? query.types
        : Object.keys(this.collectionsConfig || {});
    const typesToQuery = rawTypes.length > 0 ? rawTypes : ['software-catalog'];
    const types = typesToQuery.map(t =>
      t === 'catalog' ? 'software-catalog' : t,
    );

    const perPage = query.pageLimit || 20;
    const pageNum = query.pageCursor ? parseInt(query.pageCursor, 10) : 1;
    const filterBy = buildTypesenseFilter(query.filters);

    const queryPromises = types.map(async type => {
      const collectionName = `backstage_${type}`;

      try {
        this.logger.info(
          `Querying Typesense collection "${collectionName}" for: "${query.term}"`,
        );

        const collectionType = collectionName.replace(/^backstage_/, '');
        const config = this.collectionsConfig?.[collectionType];
        const searchOptions = {
          q: query.term,
          query_by: 'title,text,location', // Standard text index search targets
          filter_by: filterBy,
          per_page: perPage,
          page: pageNum,
          ...config?.searchOptions,
        };

        const searchResponse = (await this.client
          .collections(collectionName)
          .documents()
          .search(searchOptions)) as SearchResponse<TypesenseDocument>;

        const hits = searchResponse.hits || [];
        this.logger.info(
          `Typesense returned ${hits.length} results for query "${query.term}" in collection "${collectionName}"`,
        );

        const searchHasMore =
          searchResponse.found !== undefined &&
          searchResponse.page !== undefined &&
          searchResponse.page * perPage < searchResponse.found;

        const mappedResults = hits.map(hit => {
          const doc = hit.document;
          return {
            type,
            document: {
              ...doc,
              title: doc.title || '',
              text: doc.text || '',
              location: doc.location || '',
            } as IndexableDocument,
            score: hit.text_match_info?.score
              ? parseFloat(hit.text_match_info.score)
              : undefined,
          } as IndexableResult & { score?: number };
        });

        return { results: mappedResults, hasMore: searchHasMore };
      } catch (error) {
        this.logger.error(
          `Failed to search Typesense collection "${collectionName}"`,
          error as Error,
        );
        return { results: [], hasMore: false };
      }
    });

    const settledResults = await Promise.all(queryPromises);

    const results: IndexableResult[] = [];
    let hasMore = false;

    for (const res of settledResults) {
      results.push(...res.results);
      if (res.hasMore) {
        hasMore = true;
      }
    }

    return {
      results,
      nextPageCursor: hasMore ? (pageNum + 1).toString() : undefined,
    };
  }
}
