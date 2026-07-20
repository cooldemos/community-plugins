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

### 3. Event-Driven Ingestion & Reconciliation (Vertex AI & TechDocs Specific)

For TechDocs document indexing in Vertex AI Search, synchronization is real-time, decentralized, and event-driven:

- **Real-time Webhook**: Listens to bucket upload notifications from Google Eventarc to trigger document indexing immediately upon publication.
- **Throttled Batch Ingestion**: Processes changed files, maps them to stable document IDs, and performs batch imports within API rate limits to protect resource bounds.
- **Catalog Metadata Enrichment**: Automatically associates indexed documents with their Backstage catalog metadata to enrich search results with owner, lifecycle, and component annotations.
- **Delta Reconciliation**: Compares current and historic index states to automatically detect and purge stale or deleted pages.

## 📦 Available Plugins & Modules

| Plugin / Module                    | Directory                                                                              | Purpose                                                                                                                                                                                                                      |
| :--------------------------------- | :------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Router**           | [`search-backend-module-hybrid`](./search-backend-module-hybrid/README.md)             | **Dynamic Orchestrator**: Registers sub-engines through its registry extension point, delegates incoming search queries, and consolidates search results.                                                                    |
| **Vertex AI Search Engine Module** | [`search-backend-module-vertexai`](./search-backend-module-vertexai/README.md)         | **Semantic Search**: Integrates Google Cloud Vertex AI Search. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Translates Backstage queries to Discovery Engine API calls.        |
| **Typesense Search Engine Module** | [`search-backend-module-typesense`](./search-backend-module-typesense/README.md)       | **Structured Search**: Integrates Typesense capabilities. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Indexes and searches structured Backstage entities with typo-tolerance. |
| **GCS Eventarc TechDocs Webhook**  | [`events-backend-module-gcs-eventarc`](./events-backend-module-gcs-eventarc/README.md) | **Cloud-Native Ingestion**: Receives bucket upload alerts from Google Eventarc to trigger TechDocs search index parsing and ingestion into Vertex AI Search.                                                                 |
