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
} from '@backstage/plugin-search-common';
import {
  SearchServiceClient,
  DocumentServiceClient,
  protos,
} from '@google-cloud/discoveryengine';
import { Writable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';
import crypto from 'crypto';

/**
 * Configuration for a Google Cloud Data Store.
 * @public
 */
export interface VertexAIDataStoreConfig {
  /** The Google Cloud Project ID where this data store is located. */
  projectId: string;
  /** The target Data Store ID. */
  datastoreId: string;
  /** The geographic location/region of the data store (e.g. 'global', 'europe-west4'). */
  location: string;
}

/**
 * Configuration for a Google Cloud Search App Engine.
 * @public
 */
export interface VertexAIEngineConfig {
  /** The Google Cloud Project ID where this search app (engine) is located. */
  projectId: string;
  /** The target App Engine ID. */
  engineId: string;
  /** The geographic location/region of the search app (e.g. 'global', 'europe-west4'). */
  location: string;
}

/**
 * Structured configuration for a specific document type's Google Cloud Data Store and App Engine.
 * @public
 */
export interface VertexAITypeConfig {
  /** Ingestion/Storage configuration (Required). */
  datastore: VertexAIDataStoreConfig;
  /** Query-time Search App configuration (Optional). */
  engine?: VertexAIEngineConfig;
  /** Optional custom Discovery Engine query configurations specific to this document type. */
  searchOptions?: Omit<
    protos.google.cloud.discoveryengine.v1.ISearchRequest,
    'servingConfig' | 'query'
  > &
    Record<string, any>;
  /** Optional override for local indexing stream configuration specific to this type. */
  indexing?: VertexAIIndexingOptions;
}

/**
 * Options for configuring local indexing streams in Vertex AI Search.
 * @public
 */
export interface VertexAIIndexingOptions {
  /** If set to true, allows streaming document collator indexes directly. */
  enabled?: boolean;
  /** Optional batch size for inline document uploads. Recommended maximum: 100. */
  batchSize?: number;
  /** Optional delay in milliseconds between batch uploads to throttle the ingestion rate. */
  throttleMs?: number;
}

/**
 * Global configurations and defaults for the Vertex AI Search engine.
 * @public
 */
export interface VertexAIEngineBlendedSearchConfig {
  /** The Google Cloud Project ID where the global blended search app is located. */
  projectId: string;
  /** The geographic location/region of the global blended search app (e.g. 'global', 'europe-west4'). */
  location: string;
  /** The global blended App Engine ID. */
  engineId: string;
  /** Optional custom Discovery Engine query configurations. */
  searchOptions?: Omit<
    protos.google.cloud.discoveryengine.v1.ISearchRequest,
    'servingConfig' | 'query'
  > &
    Record<string, any>;
}

/**
 * Options for configuring the VertexAISearchEngine.
 * @public
 */
export interface VertexAIEngineOptions {
  /** Configuration defaults and blended search app settings for multi-type queries. */
  blendedSearch?: VertexAIEngineBlendedSearchConfig;
  /** Optional configuration for direct local collator indexing. */
  indexing?: VertexAIIndexingOptions;
  /** Unified, explicit mapping of search document types to specific Google Cloud Data Stores/App Engines. */
  types: Record<string, VertexAITypeConfig>;
  /** Core Backstage logging service. */
  logger?: LoggerService;
}

/**
 * Open-ended document representation extending Backstage IndexableDocument to support arbitrary metadata fields.
 */
interface ExtendedIndexableDocument extends IndexableDocument {
  [key: string]: any;
}

/**
 * Unpacks and flattens a gRPC/protobuf Struct/Value JSON representation into standard Javascript primitives.
 * Recursively parses string values, number values, nested structs, and arrays.
 *
 * @param val - The raw protobuf value payload.
 * @returns The flattened/unpacked object structure.
 */
const unpackProtobuf = (val: any): any => {
  if (val === null || typeof val !== 'object') return val;

  if ('stringValue' in val) return val.stringValue;
  if ('numberValue' in val) return val.numberValue;
  if ('boolValue' in val) return val.boolValue;
  if ('nullValue' in val) return null;
  if ('structValue' in val) return unpackProtobuf(val.structValue);
  if ('listValue' in val)
    return (val.listValue?.values || []).map(unpackProtobuf);

  const target = val.fields || val;
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(target)) {
    result[k] = unpackProtobuf(v);
  }
  return result;
};

/**
 * High-performance batching stream for importing documents directly into Google Cloud Vertex AI Search.
 *
 * Buffers index documents and flushes them in bulk batches of 100 using Discovery Engine inline imports
 * to minimize roundtrip latencies and bypass intermediate GCS staging.
 * Maps unique document IDs deterministically to prevent duplicate index entries.
 */
class VertexAIWritableStream extends Writable {
  private buffer: ExtendedIndexableDocument[] = [];
  private batchSize: number;
  private throttleMs: number;
  private client: DocumentServiceClient;

  constructor(
    private readonly options: {
      projectId: string;
      location: string;
      dataStoreId: string;
      batchSize: number;
      throttleMs?: number;
      logger?: LoggerService;
    },
  ) {
    super({ objectMode: true });
    this.batchSize = options.batchSize;
    this.throttleMs = options.throttleMs ?? 0;

    const apiEndpoint =
      options.location !== 'global'
        ? `${options.location}-discoveryengine.googleapis.com`
        : undefined;
    this.client = new DocumentServiceClient({ apiEndpoint });
  }

  /**
   * Internal write handler. Buffers document chunks and flushes when batch limit is met.
   */
  async _write(
    chunk: ExtendedIndexableDocument,
    _encoding: string,
    callback: (error?: Error | null) => void,
  ): Promise<void> {
    this.buffer.push(chunk);

    if (this.buffer.length >= this.batchSize) {
      try {
        await this.flush();
        callback();
      } catch (err) {
        this.options.logger?.error(
          `Failed to flush batch to Vertex AI Search:`,
          err as Error,
        );
        callback(err as Error);
      }
    } else {
      callback();
    }
  }

  /**
   * Internal final handler. Ensures any remaining buffered documents are flushed.
   */
  async _final(callback: (error?: Error | null) => void): Promise<void> {
    try {
      await this.flush();
      callback();
    } catch (err) {
      this.options.logger?.error(
        `Failed to flush final stream buffer to Vertex AI Search:`,
        err as Error,
      );
      callback(err as Error);
    }
  }

  /**
   * Flushes the current document buffer to Vertex AI Search using inline source import.
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;

    const parent = this.client.projectLocationCollectionDataStoreBranchPath(
      this.options.projectId,
      this.options.location,
      'default_collection',
      this.options.dataStoreId,
      'default_branch',
    );

    const documents = this.buffer
      .filter(doc => {
        const hasTitle = !!doc.title;
        const hasText = !!doc.text;
        const hasLocation = !!doc.location;
        if (!hasTitle || !hasText || !hasLocation) {
          this.options.logger?.warn(
            `Vertex AI Search: Skipping document from indexing due to missing required fields: ` +
              `[title: ${hasTitle ? 'present' : 'MISSING'}, ` +
              `text: ${hasText ? 'present' : 'MISSING'}, ` +
              `location: ${hasLocation ? 'present' : 'MISSING'}]. ` +
              `Location: "${doc.location || 'unknown'}"`,
          );
          return false;
        }
        return true;
      })
      .map(doc => {
        const docId = crypto
          .createHash('md5')
          .update(doc.location)
          .digest('hex');

        return {
          id: docId,
          jsonData: JSON.stringify({
            id: docId,
            ...doc,
          }),
        };
      });

    const skippedCount = this.buffer.length - documents.length;
    if (skippedCount > 0) {
      this.options.logger?.warn(
        `Vertex AI Search: Filtered out ${skippedCount} invalid documents from the batch of ${this.buffer.length}.`,
      );
    }

    this.buffer = [];

    if (documents.length === 0) {
      this.options.logger?.info(
        `Vertex AI Search: No valid documents left to flush in this batch.`,
      );
      return;
    }

    this.options.logger?.info(
      `Flushing ${documents.length} documents to Vertex AI Search dataStore: ${this.options.dataStoreId}`,
    );

    try {
      const [operation] = await this.client.importDocuments({
        parent,
        inlineSource: {
          documents: documents as any,
        },
        reconciliationMode: 'INCREMENTAL',
      } as any);

      this.options.logger?.debug(
        `Spawned import operation: ${operation.name}. Waiting...`,
      );
      await (operation as any).promise();
      this.options.logger?.info(`Successfully imported batch of documents.`);

      if (this.throttleMs > 0) {
        this.options.logger?.debug(
          `Throttling indexing stream: sleeping for ${this.throttleMs}ms...`,
        );
        await new Promise(resolve => setTimeout(resolve, this.throttleMs));
      }
    } catch (error) {
      this.options.logger?.error(
        `Failed to import documents to Vertex AI Search:`,
        error as Error,
      );
      throw error;
    }
  }
}

/**
 * SearchEngine implementation for Google Cloud Vertex AI Search.
 *
 * Handles routing read-only semantic search requests to Vertex AI Search
 * Generic stores or Search Apps using the Discovery Engine API.
 * Local document indexing is bypassed.
 *
 * @public
 */
export class VertexAISearchEngine implements SearchEngine {
  /** Cache of SearchServiceClient instances by location. */
  private searchClients = new Map<string, SearchServiceClient>();
  /** Quick O(1) lookup map of datastore IDs to Backstage document types. */
  private datastoreTypeMap = new Map<string, string>();
  /** Unified configuration options. */
  private readonly options: VertexAIEngineOptions;

  /**
   * Creates a new instance of VertexAISearchEngine.
   *
   * @param options - Configuration options.
   */
  constructor(options: VertexAIEngineOptions) {
    if (!options.types || Object.keys(options.types).length === 0) {
      throw new Error(
        'VertexAISearchEngine requires a strictly defined "types" configuration mapping.',
      );
    }

    for (const [typeName, typeConfig] of Object.entries(options.types)) {
      if (!typeConfig.datastore.location) {
        throw new Error(
          `Location is missing. Every individual type must explicitly specify a location. Type "${typeName}" is missing a datastore location configuration.`,
        );
      }
      if (typeConfig.engine && !typeConfig.engine.location) {
        throw new Error(
          `Location is missing. Every individual type must explicitly specify a location. Type "${typeName}" is missing an engine location configuration.`,
        );
      }
    }

    this.options = options;

    // Pre-build lookup map of datastore IDs to Backstage types for instant O(1) query resolution
    for (const [type, config] of Object.entries(this.options.types)) {
      this.datastoreTypeMap.set(config.datastore.datastoreId, type);
    }

    // Safety guardrail: override if indexing is disabled for software-catalog
    const catalogConfig = this.options.types?.['software-catalog'];
    if (catalogConfig) {
      const isCatalogIndexingEnabled =
        catalogConfig.indexing?.enabled !== undefined
          ? catalogConfig.indexing.enabled
          : this.options.indexing?.enabled;

      if (isCatalogIndexingEnabled === false) {
        this.options.logger?.info(
          `Vertex AI Search: Local indexing was configured as disabled for "software-catalog". ` +
            `This has been overridden to ENABLED because the Software Catalog is a highly dynamic metadata store ` +
            `that requires direct local indexing to keep the search index in sync.`,
        );
      }
    }

    this.options.logger?.info(
      `Initializing VertexAISearchEngine for location ${
        this.options.blendedSearch?.location || 'custom per-type'
      }${
        this.options.blendedSearch?.engineId
          ? `, global blended engineId ${this.options.blendedSearch.engineId}`
          : ''
      }. Configured types: ${Object.keys(this.options.types).join(', ')}`,
    );
  }

  /**
   * Helper to resolve or instantiate a regionalized SearchServiceClient.
   */
  private getSearchClient(location: string): SearchServiceClient {
    let client = this.searchClients.get(location);
    if (!client) {
      const endpoint =
        location !== 'global'
          ? `${location}-discoveryengine.googleapis.com`
          : undefined;
      client = new SearchServiceClient({ apiEndpoint: endpoint });
      this.searchClients.set(location, client);
    }
    return client;
  }

  /**
   * Resolves the Backstage search result type (e.g., 'techdocs') based on the GCP resource name
   * or query filters, preventing hardcoded type assignments during blended searches.
   */
  private resolveDocumentType(
    resourceName?: string,
    queryTypes?: string[],
  ): string {
    if (resourceName) {
      const parts = resourceName.split('/');
      // In GCP resource paths, the datastore ID is always index 7, preceded by "dataStores"
      const datastoreId = parts[6] === 'dataStores' ? parts[7] : undefined;

      if (datastoreId) {
        const foundType = this.datastoreTypeMap.get(datastoreId);
        if (foundType) {
          this.options.logger?.debug(
            `Vertex AI Search: Resolved document type "${foundType}" for datastore "${datastoreId}"`,
          );
          return foundType;
        }
        this.options.logger?.warn(
          `Vertex AI Search: Could not map datastore ID "${datastoreId}" to a configured Backstage document type. ` +
            `Configured types: ${JSON.stringify(
              Array.from(this.datastoreTypeMap.keys()),
            )}`,
        );
      }
    }

    // Fallback to the queried type if only one was searched
    if (queryTypes && queryTypes.length === 1) {
      this.options.logger?.debug(
        `Vertex AI Search: Falling back to queried type "${queryTypes[0]}"`,
      );
      return queryTypes[0];
    }

    this.options.logger?.debug(
      `Vertex AI Search: Falling back to default type "techdocs"`,
    );
    return 'techdocs'; // Universal default fallback
  }

  /**
   * Registers a query translator. (No-op interface placeholder).
   */
  setTranslator(_translator: QueryTranslator): void {
    // No-op: interface requires implementation
  }

  /**
   * Returns a Writable stream to index documents.
   *
   * If indexing.enabled is configured to true, returns a VertexAIWritableStream to push documents
   * directly to the target Vertex AI Search data store.
   * Otherwise, returns a dummy no-op stream to gracefully bypass local indexing without throwing errors.
   */
  async getIndexer(type: string): Promise<Writable> {
    const typeConfig = this.options.types?.[type];
    // Resolve type-specific indexing setting (overrides global default)
    let isIndexingEnabled =
      typeConfig?.indexing?.enabled !== undefined
        ? typeConfig.indexing.enabled
        : this.options.indexing?.enabled;

    if (type === 'software-catalog' && isIndexingEnabled === false) {
      this.options.logger?.info(
        `Vertex AI Search: Forcing indexing to enabled for "software-catalog". Catalog indexing cannot be bypassed.`,
      );
      isIndexingEnabled = true;
    }

    if (isIndexingEnabled) {
      if (typeConfig) {
        const location = typeConfig.datastore.location;
        if (!location) {
          throw new Error(
            `Location could not be resolved for indexing type "${type}".`,
          );
        }
        const batchSize =
          typeConfig.indexing?.batchSize ??
          this.options.indexing?.batchSize ??
          100;

        const throttleMs =
          typeConfig.indexing?.throttleMs ??
          this.options.indexing?.throttleMs ??
          0;

        this.options.logger?.info(
          `Vertex AI Search: Direct indexing enabled for type "${type}" (batchSize: ${batchSize}, throttleMs: ${throttleMs}ms). Streaming to project "${typeConfig.datastore.projectId}" location "${location}" dataStore "${typeConfig.datastore.datastoreId}"...`,
        );
        return new VertexAIWritableStream({
          projectId: typeConfig.datastore.projectId,
          location: location,
          dataStoreId: typeConfig.datastore.datastoreId,
          batchSize: batchSize,
          throttleMs: throttleMs,
          logger: this.options.logger,
        });
      }

      this.options.logger?.warn(
        `Vertex AI Search: Local indexing is enabled but unmapped for type "${type}". To index this type, please add an explicit mapping under "search.engines.vertexai.types" in your app-config.yaml. Returning dummy no-op stream.`,
      );
    } else {
      this.options.logger?.info(
        `Vertex AI Search: Local indexing is bypassed for type "${type}". Returning dummy no-op stream.`,
      );
    }

    return new Writable({
      objectMode: true,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }

  /**
   * Performs semantic queries across Vertex AI Search data stores, translating filters into AIP-160
   * predicates and prioritizing answers / segments over snippets.
   *
   * @param query - The abstract search request query structure.
   * @returns A Promise resolving to the indexable results.
   */
  async query(query: SearchQuery): Promise<IndexableResultSet> {
    let parent = '';
    let targetLocation = '';
    const configuredTypes = Object.keys(this.options.types);

    let searchType: string | undefined = undefined;
    if (query.types && query.types.length === 1) {
      searchType = query.types[0];
    } else if (
      (!query.types || query.types.length === 0) &&
      configuredTypes.length === 1
    ) {
      searchType = configuredTypes[0];
    }

    const typeConfig = searchType ? this.options.types[searchType] : undefined;

    if (typeConfig) {
      if (typeConfig.engine) {
        targetLocation = typeConfig.engine.location;
        parent = `projects/${typeConfig.engine.projectId}/locations/${targetLocation}/collections/default_collection/engines/${typeConfig.engine.engineId}/servingConfigs/default_search`;
        this.options.logger?.info(
          `Vertex AI Search: Routing query to Search Engine App "${typeConfig.engine.engineId}" for type "${searchType}"`,
        );
      } else {
        targetLocation = typeConfig.datastore.location;
        parent = `projects/${typeConfig.datastore.projectId}/locations/${targetLocation}/dataStores/${typeConfig.datastore.datastoreId}/servingConfigs/default_search`;
        this.options.logger?.info(
          `Vertex AI Search: Routing query to Data Store "${typeConfig.datastore.datastoreId}" for type "${searchType}"`,
        );
      }
    } else if (this.options.blendedSearch) {
      targetLocation = this.options.blendedSearch.location;
      parent = `projects/${this.options.blendedSearch.projectId}/locations/${targetLocation}/collections/default_collection/engines/${this.options.blendedSearch.engineId}/servingConfigs/default_search`;
      this.options.logger?.info(
        `Vertex AI Search: Routing query to global blended Search Engine App "${this.options.blendedSearch.engineId}"`,
      );
    } else {
      const errMsg = `Vertex AI Search: Cannot query. No global engineId configured for global search across multiple types (${configuredTypes.join(
        ', ',
      )}), and no explicit single type mapping resolved.`;
      this.options.logger?.error(errMsg);
      throw new Error(errMsg);
    }

    if (!targetLocation) {
      const errMsg = `Vertex AI Search: Location could not be resolved for query.`;
      this.options.logger?.error(errMsg);
      throw new Error(errMsg);
    }

    this.options.logger?.info(`Using parent serving config: "${parent}"`);
    this.options.logger?.info(
      `Querying Vertex AI Search with term: "${query.term}"`,
    );

    let filterString = '';
    if (query.filters && Object.keys(query.filters).length > 0) {
      const expressions = Object.entries(query.filters).map(([key, val]) => {
        const arrayVal = Array.isArray(val) ? val : [val];
        const normalizedList =
          key === 'kind'
            ? arrayVal.map(v => String(v).toLowerCase())
            : arrayVal.map(v => String(v));

        const list = normalizedList.map(v => JSON.stringify(v)).join(', ');
        return `${key}: ANY(${list})`;
      });
      filterString = expressions.join(' AND ');
      this.options.logger?.info(`Applying Vertex AI filter: "${filterString}"`);
    }

    // Merge global search options with type-specific search options if available
    const typeSearchOptions = typeConfig?.searchOptions;
    const mergedSearchOptions = {
      ...this.options.blendedSearch?.searchOptions,
      ...typeSearchOptions,
    };

    const searchRequestPayload = {
      servingConfig: parent,
      query: query.term,
      filter: filterString || undefined,
      pageSize: query.pageLimit,
      pageToken: query.pageCursor,
      ...mergedSearchOptions,
      relevanceScoreSpec: {
        // NOTE: Google Cloud Discovery Engine does not return relevance scores for blended search apps
        // (such as website engines or mixed search serving configs) even when returnRelevanceScore is true.
        returnRelevanceScore: true,
        ...mergedSearchOptions?.relevanceScoreSpec,
      },
    };

    this.options.logger?.debug(
      `Vertex AI Search: Sending search request: ${JSON.stringify(
        searchRequestPayload,
      )}`,
    );

    try {
      const client = this.getSearchClient(targetLocation);
      const [apiResults, , rawResponse] = await client.search(
        searchRequestPayload,
      );

      const resultsCount = apiResults?.length || 0;
      this.options.logger?.info(
        `Vertex AI Search returned ${resultsCount} results`,
      );
      this.options.logger?.debug(
        `Vertex AI Search: Received response. Pages: ${
          rawResponse ? 'yes' : 'no'
        }, ` +
          `NextPageToken: ${rawResponse?.nextPageToken || 'none'}, ` +
          `Metadata: ${JSON.stringify((rawResponse as any)?.metadata || {})}`,
      );

      const results = (apiResults || []).map(
        (
          result: protos.google.cloud.discoveryengine.v1.SearchResponse.ISearchResult,
        ) => {
          const structData = unpackProtobuf(result.document?.structData) || {};
          const derivedStructData =
            unpackProtobuf(result.document?.derivedStructData) || {};

          let displayText = '';
          let source = '';

          // Extractive answers and segments are generated by Google's generative models when search option contentSearchSpec is configured.
          // We prioritize these rich answers over raw text snippets to give users precise natural language snippets.
          const extractiveAnswers = (derivedStructData.extractive_answers ||
            []) as Array<{ content?: string }>;
          const extractiveSegments = (derivedStructData.extractive_segments ||
            []) as Array<{ content?: string }>;
          const snippets = (derivedStructData.snippets || []) as Array<{
            snippet?: string;
          }>;

          // 1. Highest Priority: Precise direct natural language answers.
          if (extractiveAnswers.length > 0) {
            displayText = extractiveAnswers
              .map(a => a.content || '')
              .filter((c: string) => c.length > 0)
              .join(' ');
            source = 'extractive_answer';
            // 2. Medium Priority: Surrounding semantic paragraphs. Joined with newlines/ellipses.
          } else if (extractiveSegments.length > 0) {
            displayText = extractiveSegments
              .map(s => s.content || '')
              .filter((c: string) => c.length > 0)
              .join('\n...\n');
            source = 'extractive_segment';
            // 3. Low Priority: Basic highlighted keyword snippets.
          } else if (snippets.length > 0) {
            displayText = snippets
              .map(sn => sn.snippet || '')
              .filter((c: string) => c.length > 0)
              .join(' ');
            source = 'snippet';
            // 4. Lowest Priority: Fallback to raw, full indexed document body text.
          } else {
            displayText = structData.text || '';
            source = 'text';
          }

          this.options.logger?.debug(
            `Vertex AI Search: Mapped search result text for "${
              structData.title || result.document?.name
            }" using source: ${source}. Snippet length: ${displayText.length}`,
          );

          const doc: ExtendedIndexableDocument = {
            ...structData,
            title: structData.title || result.document?.name || '',
            text: displayText,
            location: structData.location || '',
          };

          // Extract relevance score from rankSignals if populated
          const relevanceScore = result.rankSignals?.relevanceScore;

          this.options.logger?.debug(
            `Vertex AI Search: Mapped document: ${doc.title} with semantic score: ${relevanceScore}`,
          );

          const resolvedType = this.resolveDocumentType(
            result.document?.name || undefined,
            query.types,
          );

          return {
            type: resolvedType,
            document: doc,
            score:
              typeof relevanceScore === 'number' ? relevanceScore : undefined,
          };
        },
      );

      return {
        results,
        nextPageCursor: rawResponse?.nextPageToken || undefined,
      } as IndexableResultSet;
    } catch (error) {
      this.options.logger?.error(
        `Vertex AI Search query execution failed:`,
        error as Error,
      );
      throw error;
    }
  }
}
