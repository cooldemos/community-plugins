# Hybrid Search Plugins & Modules

This directory houses a collection of highly flexible search modules for Backstage. It supports standalone deployment of modern search backends (e.g. structured Typesense search or semantic Vertex AI Search) as primary engines, alongside an optional Hybrid Search Router that orchestrates parallel federated queries and dynamic result merging.

## 🏛️ Core Architectural Pillars (Grounded in Code)

Our workspace is built around three core architectural pillars:

### 1. Dynamic Engine Registry via Extension Points

To maintain decoupling, the router module [`search-backend-module-hybrid`](./search-backend-module-hybrid) does not hardcode sub-engines. Instead, it registers them dynamically during backend startup using a custom Backstage Extension Point: **`hybridSearchRegistryExtensionPoint`**.
Specialized backend search modules plug into this extension point to self-register:

- **Vertex AI Search Engine Module** ([`search-backend-module-vertexai`](./search-backend-module-vertexai))
- **Typesense Search Engine Module** ([`search-backend-module-typesense`](./search-backend-module-typesense))

### 2. Query Orchestration & Consolidation Strategies

When a user executes a search, the **`HybridSearchEngine`** queries all matching registered backends in parallel and merges the results based on the configured strategy:

- `interleave` (Default): Blends search results round-robin style to give developers a diverse first page of mixed results.
- `score-normalized-sort`: Normalizes search relevance scores from different engines to a `[0, 1]` scale and sorts them descending.

### 3. Event-Driven Delta Ingestion (Vertex AI Search & TechDocs Specific)

For TechDocs document indexing in Vertex AI Search, synchronization can be fully real-time, decentralized, and event-driven:

- **Real-time Webhook**: The [`events-backend-module-gcs-eventarc`](./events-backend-module-gcs-eventarc) module exposes a webhook endpoint `/api/events/gcs` that listens for bucket upload notifications from Google Eventarc.
- **Two-Tier Throttled Ingestion**: When GCS notifies the webhook of an index change, the module fetches `search_index.json`, maps it to stable MD5 document IDs, and triggers concurrent imports. It uses `asyncPool` to throttle **spawning** of inline import requests (protecting connection sockets and Cloud API burst rate limits), but awaits all LRO promises in parallel using `Promise.all()` to let Google Cloud index the batches concurrently at maximum speed.
- **Catalog Metadata Enrichment**: The module extracts the associated Backstage entity reference from the GCS directory path and queries the Backstage **`CatalogService`** (`catalogServiceRef`). It injects catalog metadata (like `owner`, `lifecycle`, `componentType`, and `annotations`) as structured attributes into the search documents, allowing rich filtering of semantic searches.
- **Delta-Reconciliation**: It queries the GCS object version history to compare current and previous documents, automatically identifying and purging stale or deleted pages in parallel.

## 📦 Available Plugins & Modules

| Plugin / Module                    | Directory                                                                              | Purpose                                                                                                                                                                                                                      |
| :--------------------------------- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Router**           | [`search-backend-module-hybrid`](./search-backend-module-hybrid/README.md)             | **Dynamic Orchestrator**: Registers sub-engines through its registry extension point, delegates incoming search queries, and consolidates search results.                                                                    |
| **Vertex AI Search Engine Module** | [`search-backend-module-vertexai`](./search-backend-module-vertexai/README.md)         | **Semantic Search**: Integrates Google Cloud Vertex AI Search. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Translates Backstage queries to Discovery Engine API calls.        |
| **Typesense Search Engine Module** | [`search-backend-module-typesense`](./search-backend-module-typesense/README.md)       | **Structured Search**: Integrates Typesense capabilities. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Indexes and searches structured Backstage entities with typo-tolerance. |
| **GCS Eventarc TechDocs Webhook**  | [`events-backend-module-gcs-eventarc`](./events-backend-module-gcs-eventarc/README.md) | **Cloud-Native Ingestion**: Receives bucket upload alerts from Google Eventarc to trigger TechDocs search index parsing and ingestion into Vertex AI Search.                                                                 |
