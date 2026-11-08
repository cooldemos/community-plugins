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
  BatchSearchEngineIndexer,
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
 * Per-type options for enabling or disabling local indexing streams in Vertex AI Search.
 * @public
 */
export interface VertexAITypeIndexingOptions {
  /** If set to true, allows streaming document collator indexes directly for this document type. */
  enabled?: boolean;
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
  /** Optional override for local indexing enablement specific to this type. */
  indexing?: VertexAITypeIndexingOptions;
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
  /** Optional maximum retry attempts on transient gRPC errors (codes 4, 8, 14). Defaults to 3. */
  maxRetries?: number;
  /** Optional initial backoff delay in milliseconds before retrying transient gRPC errors. Defaults to 500. */
  initialRetryDelayMs?: number;
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

/** Transient gRPC status codes eligible for retry (DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, UNAVAILABLE). */
const RETRYABLE_GRPC_CODES = new Set([4, 8, 14]);

/** Recursively sorts object keys and strips undefined properties for deterministic JSON hashing. */
const canonicalizeForHash = (val: unknown): unknown => {
  if (Array.isArray(val)) {
    return val.map(canonicalizeForHash);
  }
  if (val !== null && typeof val === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(val as Record<string, unknown>).sort()) {
      const entry = (val as Record<string, unknown>)[key];
      if (entry !== undefined) {
        sorted[key] = canonicalizeForHash(entry);
      }
    }
    return sorted;
  }
  return val;
};

/** Computes a deterministic SHA-256 content hash over a normalized document payload (excluding contentHash). */
const computeContentHash = (doc: Record<string, unknown>): string => {
  const { contentHash: _ignored, ...rest } = doc;
  const canonicalJson = JSON.stringify(canonicalizeForHash(rest));
  return crypto.createHash('sha256').update(canonicalJson).digest('hex');
};

/**
 * Reconciling batch indexer for streaming Backstage collator documents into Google Cloud Vertex AI Search.
 *
 * Implements a three-phase reconciliation cycle (`initialize` -> `index` -> `finalize`):
 * 1. `initialize()` snapshots existing datastore document IDs and `contentHash` digests via explicit pagination.
 * 2. `index()` normalizes missing `text` to `""`, skips unchanged documents via SHA-256 `contentHash` comparison,
 *    and verifies long-running import operations for partial `failureCount` errors.
 * 3. `finalize()` evicts stale documents absent from `seenIds` only when the collator stream ends cleanly.
 */
class VertexAISearchEngineIndexer extends BatchSearchEngineIndexer {
  private readonly throttleMs: number;
  private readonly maxRetries: number;
  private readonly initialRetryDelayMs: number;
  private readonly client: DocumentServiceClient;
  private readonly existingHashes = new Map<string, string>();
  private readonly seenIds = new Set<string>();

  constructor(
    private readonly options: {
      projectId: string;
      location: string;
      dataStoreId: string;
      batchSize: number;
      throttleMs?: number;
      maxRetries?: number;
      initialRetryDelayMs?: number;
      logger?: LoggerService;
    },
  ) {
    super({ batchSize: options.batchSize });
    this.throttleMs = options.throttleMs ?? 0;
    this.maxRetries = options.maxRetries ?? 3;
    this.initialRetryDelayMs = options.initialRetryDelayMs ?? 500;

    const apiEndpoint =
      options.location !== 'global'
        ? `${options.location}-discoveryengine.googleapis.com`
        : undefined;
    this.client = new DocumentServiceClient({ apiEndpoint });
  }

  /** Builds the Discovery Engine default branch resource path for the target datastore. */
  private getBranchParent(): string {
    return this.client.projectLocationCollectionDataStoreBranchPath(
      this.options.projectId,
      this.options.location,
      'default_collection',
      this.options.dataStoreId,
      'default_branch',
    );
  }

  /** Executes a Discovery Engine RPC with exponential backoff and random jitter on transient gRPC codes (4, 8, 14). */
  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const grpcCode =
          typeof (error as { code?: unknown })?.code === 'number'
            ? (error as { code: number }).code
            : undefined;
        if (
          grpcCode === undefined ||
          !RETRYABLE_GRPC_CODES.has(grpcCode) ||
          attempt >= this.maxRetries
        ) {
          throw error;
        }

        // Apply exponential backoff plus up to 25% random jitter to prevent synchronized retry bursts across collators.
        const baseDelay = this.initialRetryDelayMs * Math.pow(2, attempt);
        const jitter =
          baseDelay > 0
            ? Math.floor(Math.random() * (baseDelay * 0.25 + 1))
            : 0;
        const delayMs = baseDelay + jitter;

        this.options.logger?.warn(
          `Vertex AI Search: Transient gRPC error (code ${grpcCode}) on attempt ${
            attempt + 1
          }/${this.maxRetries + 1} for dataStore "${
            this.options.dataStoreId
          }". Retrying in ${delayMs}ms...`,
        );
        if (delayMs > 0) {
          await new Promise(resolve => setTimeout(resolve, delayMs));
        }
      }
    }
  }

  /** Pages through existing datastore documents to snapshot stored `contentHash` digests before indexing begins. */
  async initialize(): Promise<void> {
    const parent = this.getBranchParent();
    let pageToken: string | undefined = undefined;

    do {
      const request: protos.google.cloud.discoveryengine.v1.IListDocumentsRequest =
        pageToken
          ? { parent, pageSize: 1000, pageToken }
          : { parent, pageSize: 1000 };
      const [docs, nextRequest, rawResponse] = await this.withRetry(() =>
        this.client.listDocuments(request, { autoPaginate: false }),
      );

      for (const storedDoc of docs || []) {
        const docId =
          storedDoc.id ||
          (typeof storedDoc.name === 'string'
            ? storedDoc.name.split('/').pop()
            : undefined);
        if (!docId) {
          continue;
        }

        let storedHash = '';
        if (storedDoc.structData) {
          const unpacked = unpackProtobuf(storedDoc.structData);
          if (typeof unpacked?.contentHash === 'string') {
            storedHash = unpacked.contentHash;
          }
        }
        if (!storedHash && typeof storedDoc.jsonData === 'string') {
          try {
            const parsed = JSON.parse(storedDoc.jsonData);
            if (typeof parsed?.contentHash === 'string') {
              storedHash = parsed.contentHash;
            }
          } catch {
            // Malformed legacy jsonData defaults to an empty hash so it will be refreshed or evicted.
          }
        }

        this.existingHashes.set(docId, storedHash);
      }

      pageToken =
        rawResponse?.nextPageToken ||
        (nextRequest as { pageToken?: string } | null)?.pageToken ||
        undefined;
    } while (pageToken);

    this.options.logger?.debug(
      `Vertex AI Search: Snapshot initialized with ${this.existingHashes.size} existing document(s) in dataStore "${this.options.dataStoreId}".`,
    );
  }

  /** Validates, hashes, and imports only changed documents in the current batch into Vertex AI Search. */
  async index(documents: IndexableDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    const parent = this.getBranchParent();
    const changedDocuments: Array<{ id: string; jsonData: string }> = [];
    let validCount = 0;

    for (const rawDoc of documents as ExtendedIndexableDocument[]) {
      const hasTitle = !!rawDoc.title;
      const hasLocation = !!rawDoc.location;
      if (!hasTitle || !hasLocation) {
        this.options.logger?.warn(
          `Vertex AI Search: Skipping document from indexing due to missing required fields: ` +
            `[title: ${hasTitle ? 'present' : 'MISSING'}, ` +
            `location: ${hasLocation ? 'present' : 'MISSING'}]. ` +
            `Location: "${rawDoc.location || 'unknown'}"`,
        );
        continue;
      }

      validCount++;
      const docId = crypto
        .createHash('md5')
        .update(rawDoc.location)
        .digest('hex');

      // Record every valid document ID so unchanged documents are preserved during clean-end eviction.
      this.seenIds.add(docId);

      // Catalog entities without a description emit undefined/empty text; normalize to "" so they remain searchable.
      const { contentHash: _ignoredHash, ...restDoc } = rawDoc;
      const normalizedDoc: Record<string, unknown> = {
        ...restDoc,
        id: docId,
        text: rawDoc.text ?? '',
      };

      const contentHash = computeContentHash(normalizedDoc);
      if (this.existingHashes.get(docId) === contentHash) {
        continue;
      }

      changedDocuments.push({
        id: docId,
        jsonData: JSON.stringify({
          ...normalizedDoc,
          contentHash,
        }),
      });
    }

    const skippedInvalidCount = documents.length - validCount;
    if (skippedInvalidCount > 0) {
      this.options.logger?.warn(
        `Vertex AI Search: Filtered out ${skippedInvalidCount} invalid documents from the batch of ${documents.length}.`,
      );
    }

    if (changedDocuments.length === 0) {
      this.options.logger?.debug(
        `Vertex AI Search: Skipping batch import for dataStore "${this.options.dataStoreId}" (0 changed documents).`,
      );
      return;
    }

    this.options.logger?.info(
      `Flushing ${changedDocuments.length} changed documents to Vertex AI Search dataStore: ${this.options.dataStoreId}`,
    );

    try {
      await this.withRetry(async () => {
        const [operation] = await this.client.importDocuments({
          parent,
          inlineSource: {
            documents: changedDocuments as any,
          },
          reconciliationMode: 'INCREMENTAL',
        } as any);

        this.options.logger?.debug(
          `Spawned import operation: ${operation.name}. Waiting...`,
        );
        const opResult = await (operation as any).promise();
        const [response, metadata] = Array.isArray(opResult)
          ? opResult
          : [opResult, undefined];

        // Discovery Engine LROs resolve even on per-document schema/validation failures; abort so finalize() skips eviction.
        const failureCount = Number(metadata?.failureCount ?? 0);
        if (failureCount > 0) {
          const errorSamples = response?.errorSamples ?? [];
          this.options.logger?.error(
            `Vertex AI Search: importDocuments reported ${failureCount} failed document(s) in dataStore "${
              this.options.dataStoreId
            }". Error samples: ${JSON.stringify(errorSamples)}`,
          );
          throw new Error(
            `Vertex AI Search importDocuments failed for ${failureCount} document(s) in dataStore "${this.options.dataStoreId}"`,
          );
        }
      });

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

  /** Evicts stored documents that were not observed during a completed, error-free collator stream. */
  async finalize(): Promise<void> {
    const parent = this.getBranchParent();
    const staleIds: string[] = [];

    for (const existingId of this.existingHashes.keys()) {
      if (!this.seenIds.has(existingId)) {
        staleIds.push(existingId);
      }
    }

    if (staleIds.length === 0) {
      return;
    }

    this.options.logger?.info(
      `Vertex AI Search: Evicting ${staleIds.length} stale document(s) from dataStore "${this.options.dataStoreId}"...`,
    );

    for (const staleId of staleIds) {
      const name = `${parent}/documents/${staleId}`;
      try {
        await this.withRetry(() => this.client.deleteDocument({ name }));
      } catch (error) {
        const grpcCode =
          typeof (error as { code?: unknown })?.code === 'number'
            ? (error as { code: number }).code
            : undefined;
        // Ignore NOT_FOUND (gRPC code 5) when concurrent cleanup already removed the document.
        if (grpcCode === 5) {
          continue;
        }
        throw error;
      }
    }
  }

  /** Closes the underlying Discovery Engine gRPC channel whenever the stream finishes or aborts. */
  override _destroy(
    error: Error | null,
    callback: (error?: Error | null) => void,
  ): void {
    Promise.resolve()
      .then(() => this.client.close())
      .catch(closeErr => {
        this.options.logger?.warn(
          `Vertex AI Search: Failed to close DocumentServiceClient for dataStore "${
            this.options.dataStoreId
          }": ${(closeErr as Error)?.message ?? closeErr}`,
        );
      })
      .finally(() => {
        callback(error);
      });
  }
}

/**
 * SearchEngine implementation for Google Cloud Vertex AI Search.
 *
 * Routes semantic search queries to Vertex AI Search Data Stores or Search Apps via the Discovery Engine API,
 * and supports optional direct collator reconciliation via `BatchSearchEngineIndexer` alongside external
 * event-driven GCS ingestion.
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
   * Returns a Writable stream to index documents for a given Backstage document type.
   *
   * When indexing is enabled (either globally on the engine or overridden per type), returns a
   * reconciling batch indexer configured with the engine's batch, throttle, and retry settings.
   * Otherwise, returns a no-op stream so external ingestion pipelines can own the datastore.
   */
  async getIndexer(type: string): Promise<Writable> {
    const typeConfig = this.options.types?.[type];
    const isIndexingEnabled =
      typeConfig?.indexing?.enabled !== undefined
        ? typeConfig.indexing.enabled
        : this.options.indexing?.enabled;

    if (isIndexingEnabled) {
      if (typeConfig) {
        const location = typeConfig.datastore.location;
        if (!location) {
          throw new Error(
            `Location could not be resolved for indexing type "${type}".`,
          );
        }
        const batchSize = this.options.indexing?.batchSize ?? 100;
        const throttleMs = this.options.indexing?.throttleMs ?? 0;
        const maxRetries = this.options.indexing?.maxRetries ?? 3;
        const initialRetryDelayMs =
          this.options.indexing?.initialRetryDelayMs ?? 500;

        this.options.logger?.info(
          `Vertex AI Search: Direct indexing enabled for type "${type}" (batchSize: ${batchSize}, throttleMs: ${throttleMs}ms, maxRetries: ${maxRetries}). Streaming to project "${typeConfig.datastore.projectId}" location "${location}" dataStore "${typeConfig.datastore.datastoreId}"...`,
        );
        return new VertexAISearchEngineIndexer({
          projectId: typeConfig.datastore.projectId,
          location,
          dataStoreId: typeConfig.datastore.datastoreId,
          batchSize,
          throttleMs,
          maxRetries,
          initialRetryDelayMs,
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
        // Preserve canonical entity casing (e.g. "Component", "API") because Vertex AI string filters are case-sensitive.
        const list = arrayVal.map(v => JSON.stringify(String(v))).join(', ');
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
      // Disable GAX auto-pagination so a single SearchQuery never walks every result page in the datastore.
      const [apiResults, , rawResponse] = await client.search(
        searchRequestPayload,
        { autoPaginate: false },
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
