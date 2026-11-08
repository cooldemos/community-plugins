# Hybrid Search Plugins & Modules

This directory contains four Backstage backend modules built for the New Backend System (`@backstage/backend-plugin-api`). Each search backend can run standalone as the portal's sole search engine or attach as a sub-engine under the Hybrid Search Router.

## Core Architectural Pillars

### 1. Dynamic Sub-Engine Registry via Extension Points

Backstage's core search plugin exposes `searchEngineRegistryExtensionPoint`, which accepts only one primary search engine per portal. To support multiple backends without modifying Backstage core, [`search-backend-module-hybrid`](./search-backend-module-hybrid/README.md) claims that primary slot and exposes **`hybridSearchEngineRegistryExtensionPoint`**.

Downstream search modules register themselves into `hybridSearchEngineRegistryExtensionPoint` during backend initialization via their `/hybrid` entry points:

- **Vertex AI Search Hybrid Module**: `@backstage-community/plugin-search-backend-module-vertexai/hybrid`
- **Typesense Hybrid Module**: `@backstage-community/plugin-search-backend-module-typesense/hybrid`

### 2. Fault-Isolated Parallel Dispatch & Score Normalization

When a search request spans multiple categories (or omits category filters on the portal search page), `HybridSearchEngine` fans the query out across all matching sub-engines concurrently via `Promise.allSettled`. Single-engine failures are logged and isolated so healthy backends still return results.

Results from heterogeneous engines are combined using one of two configurable strategies:

- `interleave` (Default): Alternates results round-robin by rank position so every category receives balanced visibility on page one.
- `score-normalized-sort`: Scales each engine's raw scores onto `[0.0, 1.0]` relative to the top score in that batch (falling back to linear rank decay when an engine omits numerical scores) and sorts globally descending.

### 3. Flexible Ingestion & Reconciliation

The workspace supports both in-process collator reconciliation and offloaded event-driven ingestion for Vertex AI Search:

- **Direct Reconciling Collator Stream (`BatchSearchEngineIndexer`)**: When `indexing.enabled: true`, `VertexAISearchEngine` snapshots existing datastore `contentHash` digests via explicit pagination, imports only new or changed documents with transient gRPC retry/backoff, and evicts stale documents only when the collator stream ends cleanly without errors.
- **Event-Driven GCS Eventarc Webhook & Orphan Sweeper**: When `indexing.enabled: false` for `techdocs`, [`events-backend-module-gcs-eventarc`](./events-backend-module-gcs-eventarc/README.md) ingests `search_index.json` uploads from Cloud Storage in real time, enriches pages with canonical Software Catalog metadata, verifies LRO `failureCount` before running generation delta deletions, and pairs with `techdocs-orphan-sweeper` to clean up deleted catalog entities.

## Available Plugins & Modules

| Plugin / Module                    | Directory                                                                              | Purpose                                                                                                                                                                     |
| :--------------------------------- | :------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Router**           | [`search-backend-module-hybrid`](./search-backend-module-hybrid/README.md)             | **Dynamic Orchestrator**: Exposes `hybridSearchEngineRegistryExtensionPoint`, routes queries by document type, and merges federated result sets.                            |
| **Vertex AI Search Engine Module** | [`search-backend-module-vertexai`](./search-backend-module-vertexai/README.md)         | **Semantic Search**: Queries Google Cloud Discovery Engine Data Stores and Search Apps, reconciles direct collator streams via `contentHash`, and sweeps orphaned TechDocs. |
| **Typesense Search Engine Module** | [`search-backend-module-typesense`](./search-backend-module-typesense/README.md)       | **Structured & Vector Search**: Auto-provisions `backstage_<type>` collections, batch-upserts collator streams, and executes typo-tolerant keyword or vector queries.       |
| **GCS Eventarc TechDocs Webhook**  | [`events-backend-module-gcs-eventarc`](./events-backend-module-gcs-eventarc/README.md) | **Cloud-Native Ingestion**: Processes Google Eventarc `object.v1.finalized` webhooks to synchronize TechDocs indices into Vertex AI Search out-of-band.                     |
