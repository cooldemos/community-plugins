# Master Architecture & Technical Specification: Hybrid Search Workspace

**Document Version**: 1.0.0  
**Target Architecture**: Backstage New Backend System (`@backstage/backend-plugin-api`)  
**Workspace**: `workspaces/hybrid-search`

## Executive Summary

Standard upstream Backstage search provides a foundational baseline for developer portals by organizing discovery around a central search backend plugin. The core system routes all portal queries through a single search engine backend, using background pipelines to collect software catalog entities and technical documentation pages on periodic timer intervals.

However, as developer portals scale in size and complexity, this baseline architecture encounters three structural limitations. First, hard-binding all portal queries to a single search engine prevents leveraging specialized backends tailored to specific content types. Second, reliance on lexical keyword matching precludes semantic vector retrieval and hybrid ranking models for unstructured documentation. Finally, executing background ingestion pipelines directly inside the application server creates CPU saturation and V8 memory strain within the single-threaded Node.js runtime.

The **Hybrid Search Workspace** resolves these issues by introducing:

- A multi-engine search router to dispatch search requests across different backends based on content type.
- Search backend modules for Typesense and Vertex AI Search that power semantic search and run standalone or combined in hybrid mode.
- An offloaded indexing pattern (implemented for Vertex AI Search) that shifts search indexing out of the application server process.

This document is written for engineers configuring search in Backstage. It explains how to use the solutions provided in this workspace, while providing context on how default Backstage search works and why this workspace was created. The guide is organized into three parts:

- **Part 1: Standard Backstage Search Mechanics & Limitations** analyzes core Backstage search abstractions, query lifecycles, and structural bottlenecks.
- **Part 2: Workspace Architecture & Backend Module Design** details the federated search router, engine modules, and offloaded event-driven indexing architecture.
- **Part 3: Deployment & Operations Manual** guides platform engineers through configuring, deploying, and operating these modules in production.

## Document Overview & Structural Map

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                   Architecture Document Structure & Navigation                    │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 1: Standard Backstage Search Mechanics & Limitations                        │
│  Part 2: Workspace Architecture & Backend Module Design                           │
│  Part 3: Deployment & Operations Manual                                           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

# Part 1: How Backstage Search Works (Conceptual & Architectural Analysis)

## Section 1: Core Architecture & Extension Points

To examine how standard Backstage search operates under the hood, it helps to first analyze its component model. Backstage organizes search through a central search backend plugin (`@backstage/plugin-search-backend`) and a shared node library (`@backstage/plugin-search-backend-node`), decomposing document discovery into five core abstractions:

- **`SearchEngine`**: The boundary interface connecting generic portal search APIs to a specific search technology (such as Lunr, Elasticsearch, or PostgreSQL). It translates generic search queries into engine-native DSLs, provides writable indexing streams for document batches, and manages index lifecycle operations.
- **`SearchEngineRegistry`**: The central registry where search engine modules register their `SearchEngine` instance during backend startup. Standard Backstage enforces a strict single-engine constraint here, allowing only one primary engine instance to be active for the entire portal.
- **`Collators` & `Decorators`**: Data collection and enrichment streams. Collators extract content from upstream sources (such as Software Catalog entities or compiled TechDocs) and emit standardized `IndexableDocument` objects. Decorators enrich those documents with additional metadata (such as RBAC security tags or canonical URLs).
- **`IndexBuilder`**: The pipeline orchestrator running inside the Node.js backend. It pipes readable data extraction streams (`Collators`) through optional transformation streams (`Decorators`) into the writable indexing streams of the registered `SearchEngine`.
- **`Scheduler`**: The background task runner. Operating on configurable cron intervals, it periodically triggers `IndexBuilder` re-indexing jobs for registered document types and uses database locks to coordinate execution across multi-replica portal deployments.

Together, these abstractions form the foundation of standard Backstage search—decoupling document extraction, transformation, and query execution into distinct, pluggable components:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                       Standard Backstage Search Core Abstractions                           │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  HTTP Query Request ──► [ Search Backend Router ]                                           │
│                                │                                                            │
│                                ▼                                                            │
│                      [ SearchEngineRegistry ] ──────► [ SearchEngine (Active) ]             │
│                                                                     ▲                       │
│                                                                     │ (Writable Stream)     │
│  Background Task                                                    │                       │
│  [ Scheduler ] ───────► [ IndexBuilder ] ───────────────────────────┴──────────┐            │
│                                │                                               │            │
│                                ├────────► [ Collators ] (Readable Stream)      │            │
│                                │                 │                             │            │
│                                │                 ▼                             │            │
│                                └────────► [ Decorators ] (Transform Stream) ───┘            │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

## Section 2: Query Execution Mechanics

When a developer enters a search query into the Backstage portal user interface, the request executes through an HTTP request-response flow managed by the search backend plugin:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                                    Query Execution Flow                                     │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│   Backstage Search UI                                  Search Backend Service               │
│       │                                                       │                             │
│       │ ── 1. HTTP GET /api/search/query ───────────────────► │                             │
│       │                                                       │ ── 2. Resolve Engine        │
│       │                                                       ▼                             │
│       │                                             SearchEngineRegistry                    │
│       │                                                       │                             │
│       │                                                       │ ── 3. Translate SearchQuery │
│       │                                                       ▼                             │
│       │                                             SearchEngine Implementation             │
│       │                                                       │                             │
│       │                                                       │ ── 4. Execute Search        │
│       │                                                       ▼                             │
│       │                                             Target Search Engine / Service          │
│       │                                                       │                             │
│       │                                                       │ ── 5. Normalize Results     │
│       │                                                       ▼                             │
│       │ ◄─ 6. Return JSON SearchResult Payload ──────── Response Normalization Layer        │
│       ▼                                                                                     │
│   Render Unified UI Results                                                                 │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Step 1 – HTTP Request**: The frontend issues an HTTP `GET /api/search/query` request containing search terms, document category filters, entity filters, and pagination parameters.
- **Step 2 – Engine Resolution**: The search backend plugin authenticates the request, parses query parameters, and retrieves the active `SearchEngine` instance from the `SearchEngineRegistry`.
- **Step 3 – Query Translation**: The active `SearchEngine` receives the abstract `SearchQuery` object and translates its terms and filters into engine-native query syntax (such as Elasticsearch JSON DSL, SQL, or Lunr term queries).
- **Step 4 – Search Execution**: The `SearchEngine` dispatches the translated query to the underlying search service or datastore to fetch matching records.
- **Step 5 – Response Normalization**: The raw search response—containing matching documents, relevance scores, and snippet highlights—is mapped into Backstage's standardized `SearchResult` payload structure.
- **Step 6 – HTTP Response**: The search backend returns a JSON payload to the client containing the normalized search results, total result count, and pagination cursors.

## Section 3: Document Ingestion Mechanics

Standard Backstage manages document ingestion through an in-process, stream-based pull pipeline. Operating directly within the primary Node.js backend process, this pipeline periodically collects content from portal sources and indexes it into the active search engine.

Instead of subscribing to real-time push events when content changes, the backend relies on scheduled polling. At configured intervals, it extracts data from upstream services (such as Software Catalog entities or compiled TechDocs search files), streams the documents through optional enrichment layers, and writes them in batches into the search store:

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ Backstage Backend Process (Node.js Event Loop Memory)                                          │
│                                                                                                │
│ ┌──────────────────────┐     ┌───────────────────────┐     ┌─────────────────────────────────┐ │
│ │  Collator (Readable) │     │ Decorators (Transform)│     │   SearchEngineIndexer (Writable)│ │
│ │                      │     │                       │     │                                 │ │
│ │ Pulls raw items from │────>│ Enriches doc fields,  │────>│ Batches & writes documents into │ │
│ │ Catalog / TechDocs   │     │ adds auth/meta tags   │     │ target search datastore index   │ │
│ └──────────────────────┘     └───────────────────────┘     └─────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Step 1 – Scheduled Task Trigger**: The `Scheduler` fires a background re-indexing job based on the configured timer interval for a specific document type.
- **Step 2 – Pipeline Assembly**: `IndexBuilder` instantiates the readable `Collator` stream, any transform `Decorator` streams, and the writable indexing stream of the registered `SearchEngine`.
- **Step 3 – Stream Composition**: `IndexBuilder` connects the readable, transform, and writable streams into a unified Node.js stream pipeline.
- **Step 4 – Data Extraction**: The `Collator` extracts records from its upstream source (such as Software Catalog entities or compiled TechDocs) and emits standardized `IndexableDocument` objects into the pipeline.
- **Step 5 – Document Enrichment**: As documents pass through transform `Decorators`, additional metadata is appended or modified (such as RBAC security tags or canonical URLs).
- **Step 6 – Batch Indexing**: The `SearchEngine` writable stream receives enriched documents, buffers them into memory batches, and writes them to the search engine.
- **Step 7 – Pipeline Completion**: Once the `Collator` finishes emitting documents, the readable stream closes, in-memory buffers flush to the search engine, and task completion is reported to the `Scheduler`.

## Section 4: Architectural Constraints

While standard Backstage search provides a simple baseline for small portal installations, analyzing its runtime behavior reveals four fundamental architectural limitations that severely impact scalability, search relevance, operational stability, and index freshness in production environments:

- **Single Search Engine Binding**: The standard Backstage core search backend (`@backstage/plugin-search-backend`) enforces a strict single-engine registration pattern. The core `SearchEngineRegistry` design assumes that one, and only one, `SearchEngine` instance handles all search capabilities for the entire developer portal. If a second search engine module attempts to register itself during backend initialization, the core system throws a fatal startup exception. Furthermore, standard Backstage core possesses zero native routing logic to inspect document types or direct requests to distinct engines based on requested document categories, limiting the portal to a single monolithic discovery topology.

- **Built-In Search Engine Constraints**: Standard Backstage supports three search engines out of the box—**Lunr** (in-memory, non-persistent, non-scalable across replicas), **PostgreSQL** (relational full-text search with heavy database CPU load during text extraction), and **Elasticsearch** (lexical keyword matching). Across all three built-in engines, standard Backstage lacks native support for semantic vector search, neural embeddings, or category-tailored relevance scoring.

- **In-Process Ingestion Bottlenecks**: Ingestion pipelines (`Collator → Decorators → Indexer`) execute directly inside the primary Node.js web server process. Heavy data parsing and transformation tasks compete for CPU time on the same single-threaded V8 event loop that handles user HTTP traffic. This introduces severe **CPU Contention** (blocking concurrent HTTP requests and causing latency spikes) and **Memory Saturation** (in-memory document buffering causing garbage collection freezes or out-of-memory process crashes as data volume grows).

- **Polling Delays & Lack of Real-Time Ingestion**: Standard Backstage ingestion relies on scheduled timer polling (`Scheduler`) rather than real-time event notifications. Because index updates occur only when a scheduled poll runs, search results suffer from a persistent freshness lag: newly published content remains unsearchable, while deleted or renamed items continue to produce temporary "ghost results" (leading to 404 links) until the next poll completes.

# Part 2: Workspace Architecture & Backend Module Design

## Section 1: Backend Modules Architecture

The Hybrid Search Workspace is architected as four modular, backend packages designed for Backstage's New Backend System (`@backstage/backend-plugin-api`). Each package encapsulates a distinct architectural responsibility:

- **`@backstage-community/plugin-search-backend-module-hybrid`**: Top-level federated query router and extension point registry. Intercepts search requests, routes queries to mapped sub-engines based on document type, manages parallel fan-out, and normalizes result scores across heterogeneous engines.
- **`@backstage-community/plugin-search-backend-module-typesense`**: Search engine module backed by Typesense, an open-source, fast in-memory search engine optimized for typo-tolerant keyword matching, structured metadata filtering, and vector search.
- **`@backstage-community/plugin-search-backend-module-vertexai`**: Search engine module backed by Google Cloud Vertex AI Search, a managed enterprise search service providing semantic vector retrieval, natural language understanding, and LLM-powered extractive answers.
- **`@backstage-community/plugin-events-backend-module-gcs-eventarc`**: Event-driven asynchronous ingestion webhook module (`/api/events/gcs`) used exclusively with the Vertex AI Search backend search module.

## Section 2: Hybrid Search Router Mechanics

### Extension Points & Custom Engine Registration

In Backstage's New Backend System, **Extension Points** serve as pluggable architectural boundaries that allow backend plugins to accept dynamic contributions from independent modules during server initialization.

Standard Backstage search uses a single-engine extension point (`searchEngineRegistryExtensionPoint`) that allows only one search engine to register for the entire portal. To bypass this limitation without modifying Backstage core, the hybrid search module (`plugin-search-backend-module-hybrid`) registers itself as the primary engine, while exposing a custom extension point (`hybridSearchEngineRegistryExtensionPoint`) to host downstream search backends.

This extension point pattern enables a flexible, open-ended search architecture:

- **Dynamic Engine Discovery**: Domain-specific search modules (such as Typesense or Vertex AI Search) register automatically with the hybrid router at startup without hardcoded dependencies between packages.
- **Pluggable Sub-Engine Ecosystem**: Platform teams can integrate custom or third-party search engines by creating lightweight backend modules that register against the hybrid extension point.

### Query Routing & Dispatch

The core architectural solution to the limitations of standard Backstage search is **Federated Multi-Engine Routing**. Rather than forcing all portal document categories into a single, uniform search engine, the Hybrid Search Architecture introduces a dynamic query orchestrator (`HybridSearchEngine`) that intercepts incoming search requests, evaluates document category filters, dispatches queries to domain-specialized sub-engines, and consolidates the results into a unified response.

In a developer portal, search queries specify target document categories through request parameters (such as `types[]=software-catalog` or `types[]=techdocs`). Rather than executing every query against a single search backend, the router evaluates these category parameters against a configured routing matrix to select the optimal dispatch pattern. When a query targets a single category, the router forwards the request directly to the mapped search engine. Conversely, when a query spans multiple categories or requests a portal-wide search, the router broadcasts the query concurrently across all relevant sub-engines, aggregating and normalizing downstream responses into a unified result set.

The following sequence illustrates how the `HybridSearchEngine` intercepts incoming HTTP queries, evaluates request parameters against the routing matrix, executes parallel or targeted dispatch, and returns consolidated results:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Backstage Search Request (e.g., GET /api/search/query?term=auth&types[]=...)                │
└──────────────────────────────┬──────────────────────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Hybrid Search Engine Router                                                                 │
│                                                                                             │
│  ┌──────────────────────────────────────────────────────────────────────────────────────┐   │
│  │ Evaluates requested document categories (`types`) against configured routing matrix   │   │
│  └───────────────────────────┬──────────────────────────────────────────┘   │
│                                              │                                              │
│               ┌──────────────────────────────┴──────────────────────────────┐               │
│               │                                                             │               │
│               ▼                                                             ▼               │
│  ┌─────────────────────────┐                                 ┌───────────────────────────┐  │
│  │ Targeted Direct Dispatch│                                 │ Federated Parallel Fan-Out│  │
│  │ (Single Category Type)  │                                 │ (Global / Multiple Types) │  │
│  └────────────┬────────────┘                                 └─────────────┬─────────────┘  │
└───────────────┼────────────────────────────────────────────────────────────┼────────────────┘
                │                                                            │
                ▼                                                            ▼
┌──────────────────────────────┐                              ┌──────────────────────────────┐
│ Target Search Sub-Engine     │                              │ Sub-Engine A   Sub-Engine B   │
│ (Direct Query & Pagination)  │                              └──────────────┬───────────────┘
└───────────────┬──────────────┘                                             │
                │                                                            ▼
                │                                             ┌──────────────────────────────┐
                │                                             │ Result Merging & Scoring     │
                │                                             │ (Score Normalization & Sort) │
                │                                             └──────────────┬───────────────┘
                │                                                            │
                └──────────────────────────────┬─────────────────────────────┘
                                               │
                                               ▼
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│ Consolidated Search Response (`SearchResultResponse`)                                       │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Fault Isolation & Parallel Execution

Querying multiple search backends in parallel introduces operational risks: slow network links can delay user responses, and individual backend failures can crash the search request. The hybrid router prevents this through two core mechanisms:

- **Parallel Execution**: Dispatches queries concurrently across sub-engines so overall latency is bounded by the slowest responding engine rather than the sum of all response times.
- **Fault Isolation**: Suppresses single-engine errors and enforces strict per-engine timeouts, ensuring that if one backend fails or responds slowly, the router still returns valid results from all healthy engines.

### Result Aggregation & Score Merging

When a federated search query returns match payloads from multiple search backends, the router must consolidate these distinct arrays into a single ordered result list.

Directly sorting results by raw score is problematic because different search engines use different scoring scales. Sorting raw scores directly would cause one engine to permanently dominate search results.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                       Federated Result Merging Strategies (Example)                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Example Engine Responses (Heterogeneous Scoring Scales)                                   │
│  • Engine A Hits (e.g. BM25 Scores):       [ Doc A1 (450),  Doc A2 (210),  Doc A3 (90) ]    │
│  • Engine B Hits (e.g. Cosine Scores):    [ Doc B1 (0.92), Doc B2 (0.84), Doc B3 (0.61) ]  │
├─────────────────────────────────────────────┬───────────────────────────────────────────────┤
│  Strategy 1: Round-Robin Interleaving       │  Strategy 2: Relative Max-Score Normalization │
├─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│  • Bypasses numerical scores entirely       │  • Normalizes scores onto a [0.0, 1.0] scale   │
│  • Alternates engines by rank position      │  • Sorts globally by normalized score         │
│                                             │                                               │
│  Example Merged Order:                      │  Example Normalized Scores:                   │
│  1. Doc A1 (Engine A, Rank 1)               │  • Engine A: A1 (1.00), A2 (0.46), A3 (0.20)  │
│  2. Doc B1 (Engine B, Rank 1)               │  • Engine B: B1 (1.00), B2 (0.91), B3 (0.66)  │
│  3. Doc A2 (Engine A, Rank 2)               │                                               │
│  4. Doc B2 (Engine B, Rank 2)               │  Example Merged Order (Descending Sort):      │
│  ...                                        │  1. Doc A1 (1.00) / Doc B1 (1.00)             │
│                                             │  2. Doc B2 (0.91)                             │
│                                             │  3. Doc B3 (0.66)                             │
│                                             │  4. Doc A2 (0.46)                             │
└─────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

To resolve this, the hybrid router provides two configurable merging strategies:

- **Round-Robin Interleaving**: Alternates results sequentially across engine arrays (Position 0: Engine A; Position 1: Engine B; Position 2: Engine A...). By bypassing numerical scores entirely, this strategy guarantees equal visual representation across document categories regardless of underlying engine metrics.

- **Relative Max-Score Normalization**: Standardizes all scores onto a $[0.0, 1.0]$ scale prior to executing a global descending sort:
  - **Scored Engines**: Scales each raw score relative to the maximum score in that engine's current batch ($\text{score} / \text{max\_score}$), assigning $1.0$ to the top hit and scaling remaining hits proportionally.
  - **Rank-Only Engines**: Generates a synthetic score decaying linearly from $1.0$ down to $0.0$ based on rank position ($1.0 - \text{index} / \text{total\_items}$) for backends that omit numerical scores.

### Pagination Mechanics

Pagination mechanics in the hybrid architecture depend on whether a query targets a single engine or federates across multiple backends:

- **Single-Engine Queries**: Triggered when a query specifies a single category in the query string (e.g., `types[]=software-catalog`). The router forwards pagination parameters (`pageCursor`, `pageLimit`) directly to the mapped search engine, returning its native pagination token (`pageCursor`) for full multi-page navigation.

- **Multi-Engine Queries**: Triggered when a query specifies multiple categories (e.g., `types[]=software-catalog&types[]=techdocs`) or omits `types` parameters entirely from the query string (global portal search). Because pagination tokens across heterogeneous engines cannot be aligned once results are merged or score-normalized, the router slices the consolidated result set to `pageLimit` and explicitly sets `pageCursor` to `undefined`. This delivers top-relevance blended results on Page 1 while delegating deep pagination to single-category scoped views.
