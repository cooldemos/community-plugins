# Hybrid Search Architecture: Technical Capabilities and Limitation Resolutions

**Document Status**: Technical Reference  
**Target Workspace**: `workspaces/hybrid-search`

---

## Executive Overview

Default Backstage search relies on periodic bulk polling, in-process Node.js memory storage, single-engine lexical matching, and static relevance ranking. As developer portals scale, these design choices create data staleness, memory consumption spikes, query inflexibility, and backend performance bottlenecks.

The `hybrid-search` workspace addresses these challenges by introducing specialized backend modules: a Google Cloud Storage Eventarc webhook plugin, search engine modules for Typesense and Google Cloud Vertex AI Search, and a federated Hybrid Search Router.

Rather than replacing core Backstage abstractions, these plugins provide targeted enhancements depending on which modules an organization chooses to deploy. This document explains how the plugins in this workspace resolve specific limitations of default search.

---

## Real-Time Document Synchronization

Default Backstage search relies on periodic background tasks that rebuild indexes on fixed schedules. Changes to catalog entities or documentation pages remain invisible in search results until the next scheduled index rebuild completes.

The `events-backend-module-gcs-eventarc` plugin replaces scheduled polling with real-time event-driven updates for documentation stored in Google Cloud Storage. When documentation files are uploaded or modified, GCS Eventarc webhooks notify the backend immediately. The plugin streams updated documents directly into search data stores, compares document versions to purge deleted pages, and runs background cleanup routines to remove orphaned entries when catalog entities are deleted.

---

## Memory Footprint and External Offloading

The default Lunr search engine stores the entire document index inside Node.js application process memory. As catalog volume increases, memory consumption grows linearly, increasing the risk of garbage collection pauses, process crashes, and replica memory duplication.

Adopting the `search-backend-module-typesense` or `search-backend-module-vertexai` plugins offloads document indexing and query evaluation entirely to external search clusters or cloud services. Backend Node.js instances remain stateless with respect to search index memory, allowing backend replicas to scale horizontally without duplicating index state.

---

## Query Capabilities and Vector Search

Upstream Backstage search is strictly keyword-based and routes all document categories through a single search engine implementation. If a user's search query does not match the exact wording in the documentation, relevant pages are missed.

The plugins in this workspace introduce dual-engine hybrid search and semantic vector matching:

- **Semantic Vector Matching**: Both `search-backend-module-typesense` (via built-in or custom embedding models) and `search-backend-module-vertexai` support vector embeddings to understand the conceptual intent behind natural language queries, matching relevant documentation even when exact keywords differ.
- **Federated Multi-Engine Routing**: The `search-backend-module-hybrid` plugin provides a search router that directs queries to specialized engines based on document type—such as high-speed attribute engines for catalog entities and semantic vector engines for long-form technical documentation.
- **Score Normalization and Blending**: When global queries span multiple document categories, searches execute in parallel across engines and merge results using score normalization or rank-blending strategies.
- **Engine-Native Filter Translation**: The Typesense and Vertex AI Search modules include dedicated translators that convert Backstage query filters into native predicate expressions supported by each backend platform.

---

## Summary Comparison

| Feature Area            | Default Backstage Search                  | Hybrid Search Workspace Resolution                     | Primary Module                                 |
| :---------------------- | :---------------------------------------- | :----------------------------------------------------- | :--------------------------------------------- |
| **Ingestion Model**     | Scheduled bulk polling & full index swaps | Event-driven webhooks & real-time incremental updates  | `events-backend-module-gcs-eventarc`           |
| **Index Storage**       | In-process Node.js V8 heap memory         | Externalized search clusters & cloud services          | `search-backend-module-typesense` / `vertexai` |
| **Search Paradigm**     | Lexical keyword matching only             | Dual hybrid: Lexical matching + Semantic vector search | `search-backend-module-typesense` / `vertexai` |
| **Engine Architecture** | Monolithic single-engine                  | Federated router delegating by document category       | `search-backend-module-hybrid`                 |
| **Relevance & Ranking** | Static relevance score ordering           | Multi-engine score normalization & rank blending       | `search-backend-module-hybrid`                 |
| **Filter Translation**  | Simplistic string sanitization / warnings | Engine-native predicate mapping & filter translation   | `search-backend-module-typesense` / `vertexai` |
