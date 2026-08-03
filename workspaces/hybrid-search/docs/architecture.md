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

This document is written for engineers configuring search in Backstage. It explains how to use the solutions provided in this workspace, while providing context on how default Backstage search works and why this workspace was created. The guide is organized into two parts:

- **Part 1: Backstage Search Architecture** analyzes core Backstage search abstractions, query lifecycles, and structural bottlenecks.
- **Part 2: Workspace Architecture & Backend Module Design** details the federated search router, engine modules, and offloaded event-driven indexing architecture.

## Document Overview & Structural Map

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                   Architecture Document Structure & Navigation                    │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 1: Backstage Search Architecture                                            │
│    ├── Section 1: Core Abstractions & Extension Points                            │
│    ├── Section 2: Query Dispatch                                                  │
│    ├── Section 3: Document Ingestion                                              │
│    └── Section 4: Architectural Constraints                                       │
│                                                                                   │
│  Part 2: Workspace Architecture & Backend Module Design                           │
│    ├── Section 1: Backend Modules Architecture                                    │
│    ├── Section 2: Hybrid Search Router                                            │
│    ├── Section 3: Typesense Search Module Architecture                            │
│    ├── Section 4: Vertex AI Search Backend Module Architecture                    │
│    └── Section 5: GCS Eventarc Ingestion Webhook Architecture                     │
└───────────────────────────────────────────────────────────────────────────────────┘
```

# Part 1: Backstage Search Architecture

## Section 1: Core Abstractions & Extension Points

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

## Section 2: Query Dispatch

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

## Section 3: Document Ingestion

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

## Section 2: Hybrid Search Router

### Sub-engine Registration

In Backstage's New Backend System, **Extension Points** serve as pluggable architectural boundaries that allow backend plugins to accept dynamic contributions from independent modules during server initialization.

Standard Backstage search uses a single-engine extension point (`searchEngineRegistryExtensionPoint`) that allows only one search engine to register for the entire portal. To bypass this limitation without modifying Backstage core, the hybrid search module (`plugin-search-backend-module-hybrid`) registers itself as the primary engine, while exposing a custom extension point (`hybridSearchEngineRegistryExtensionPoint`) to host downstream search backends.

At backend startup, modules like Typesense and Vertex AI Search register themselves with the hybrid engine through this extension point without hardcoded package coupling. Additional search backends can be added similarly by implementing a backend module that registers with the extension point.

### Query Dispatch

The core architectural solution to the limitations of standard Backstage search is **Federated Multi-Engine Routing**. Rather than forcing all portal document categories into a single, uniform search engine, the Hybrid Search Architecture introduces a dynamic query orchestrator (`HybridSearchEngine`) that intercepts incoming search requests, evaluates document category filters, dispatches queries to domain-specialized sub-engines, and consolidates the results into a unified response.

In a developer portal, search queries specify target document categories through request parameters (such as `types[]=software-catalog` or `types[]=techdocs`). Rather than executing every query against a single search backend, the router evaluates these category parameters against a configured routing matrix to select the optimal dispatch pattern. When a query targets a single category, the router forwards the request directly to the mapped search engine. Conversely, when a query spans multiple categories or requests a portal-wide search, the router broadcasts the query concurrently across all relevant sub-engines, aggregating and normalizing downstream responses into a unified result set.

If a search query requests an unmapped document category, the router checks for a registered default fallback engine. If present, the query is routed to that fallback backend; otherwise, the router returns an empty result set.

The following sequence illustrates how the `HybridSearchEngine` intercepts incoming HTTP queries, evaluates request parameters against the routing matrix, executes parallel or targeted dispatch, and returns consolidated results:

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                                HTTP Search Request                                │
│                               GET /api/search/query                               │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                            HybridSearchEngine Router                              │
│                                                                                   │
│      Evaluates requested document categories (`types`) against routing matrix     │
│                                         │                                         │
│                    ┌────────────────────┴────────────────────┐                    │
│                    ▼                                         ▼                    │
│         Single-Category Request                   Multi-Category Request          │
│       (Targeted Direct Dispatch)                (Federated Parallel Fan-Out)      │
└────────────────────┬─────────────────────────────────────────┬────────────────────┘
                     │                                         │
                     ▼                                         ▼
┌─────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│        Target Search Sub-Engine         │ │    Sub-Engine A    Sub-Engine B ...   │
│       (Direct Query Execution)          │ └──────────────────┬────────────────────┘
└────────────────────┬────────────────────┘                    │
                     │                                         ▼
                     │                      ┌───────────────────────────────────────┐
                     │                      │      Result Merger & Normalizer       │
                     │                      │     (Score Normalization & Sort)      │
                     │                      └──────────────────┬────────────────────┘
                     │                                         │
                     └────────────────────┬────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                            Consolidated Search Response                           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Parallel Execution & Fault Isolation

Querying multiple search backends in parallel introduces operational risks: slow network links can delay user responses, and individual backend failures can crash the search request. The hybrid router prevents this through two core mechanisms:

- **Parallel Execution**: Dispatches queries concurrently across sub-engines so overall latency is bounded by the slowest responding engine rather than the sum of all response times.
- **Fault Isolation**: Suppresses single-engine errors and enforces strict per-engine timeouts, ensuring that if one backend fails or responds slowly, the router still returns valid results from all healthy engines.

### Result Aggregation & Scores Normalization

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

### Pagination

Pagination mechanics in the hybrid architecture depend on whether a query targets a single engine or federates across multiple backends:

- **Single-Engine Queries**: Triggered when a query specifies a single category in the query string (e.g., `types[]=software-catalog`). The router forwards pagination parameters (`pageCursor`, `pageLimit`) directly to the mapped search engine, returning its native pagination token (`pageCursor`) for full multi-page navigation.

- **Multi-Engine Queries**: Triggered when a query specifies multiple categories (e.g., `types[]=software-catalog&types[]=techdocs`) or omits `types` parameters entirely from the query string (global portal search). Because pagination tokens across heterogeneous engines cannot be aligned once results are merged or score-normalized, the router slices the consolidated result set to `pageLimit` and explicitly sets `pageCursor` to `undefined`. This delivers top-relevance blended results on Page 1 while delegating deep pagination to single-category scoped views.

## Section 3: Typesense Search Module Architecture

### Architecture

The Typesense search backend module (`@backstage-community/plugin-search-backend-module-typesense`) provides an open-source, high-performance search backend for Backstage. Built on Typesense's in-memory engine, it delivers sub-millisecond keyword matching, typo tolerance, structured metadata filtering, and native vector search capabilities.

The module eliminates the scaling and heap memory limitations of Backstage's default Lunr in-memory engine while avoiding the heavy infrastructure footprint and operational complexity of Elasticsearch clusters.

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      Typesense Search Module Architecture                         │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  [ Extension Points ]                                                             │
│    ├── Standalone Mode       : searchEngineRegistryExtensionPoint                 │
│    └── Hybrid Sub-Engine Mode: hybridSearchEngineRegistryExtensionPoint           │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Ingestion & Query Pipeline                                                  │  │
│  │                                                                             │  │
│  │ Collator Streams ──► [ Batch Buffer (100 Docs) ] ──► [ Schema Auto-Mapper ] │  │
│  │                                                             │               │  │
│  │ SearchQuery       ──► [ Filter & DSL Translator ] ──────────┤               │  │
│  └─────────────────────────────────────────────────────────────┼───────────────┘  │
│                                                                │                  │
│                                                                ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Typesense Client (API Key Auth & Client-Side Load Balancer)                 │  │
│  └──────────────────────────────┬──────────────────────────────┬───────────────┘  │
│                                 │ (Failover & Health Check)    │                  │
│                                 ▼                              ▼                  │
│                      ┌─────────────────────┐        ┌─────────────────────┐       │
│                      │ Typesense Node 1    │        │ Typesense Node 2... │       │
│                      │  backstage_catalog  │        │  backstage_techdocs │       │
│                      └─────────────────────┘        └─────────────────────┘       │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Operational Modes

The Typesense module supports two operational modes depending on portal deployment requirements:

- **Standalone Mode (Primary Search Engine)**: Registers directly into Backstage's core `searchEngineRegistryExtensionPoint` as the portal's primary search engine. All collator indexing streams and search queries across all document categories are handled exclusively by Typesense.
- **Hybrid Sub-Engine Mode (Router Integration)**: Registers into the `hybridSearchEngineRegistryExtensionPoint` exposed by the hybrid search module. In this mode, Typesense functions as a specialized sub-engine assigned to specific document categories (such as catalog entities), coexisting with complementary backends (such as Vertex AI Search for TechDocs).

### Authentication

Authentication between the search module and external Typesense instances is secured via API key credentials (`apiKey`). The module supplies this key during client initialization to authenticate collection management, document indexing streams, and search query API calls.

### Cluster Topology

Connectivity is configured through an array of cluster node definitions (`nodes`), each specifying a host, port, protocol, and optional path prefix. The module's internal client uses this node topology to execute automatic client-side load balancing and failover routing across cluster nodes if an instance becomes unreachable.

### Schema Management & Document Indexing

Typesense organizes documents into collections, which require a defined schema before documents can be inserted. The Typesense search module manages collection setup automatically as Backstage collators run.

Collection names follow a `backstage_<type>` naming convention (such as `backstage_software-catalog`). When indexing starts, if a target collection does not exist, the module creates it automatically with a schema mapped to standard Backstage document fields (`title`, `text`, `location`, `namespace`, `entityRef`, and custom metadata).

To optimize indexing throughput, the module buffers incoming documents from collator streams in memory and writes them to Typesense in batch payloads of 100 items.

### Query Processing & Filtering

The module translates Backstage `SearchQuery` objects into native Typesense search requests. Search terms are mapped to keyword queries over target collection fields, while structured Backstage filter objects are converted into Typesense `filter_by` boolean expressions (such as `kind:=component AND namespace:=default`) to filter search results by document metadata.

## Section 4: Vertex AI Search Backend Module Architecture

### Architecture

The Vertex AI Search backend module (`@backstage-community/plugin-search-backend-module-vertexai`) integrates Backstage search with Google Cloud Vertex AI Search (Discovery Engine API). It provides fully managed enterprise search capabilities, leveraging machine learning for semantic relevance, natural language query understanding, and automated document indexing without requiring self-hosted search infrastructure.

The module enables Backstage deployments to offload search indexing and retrieval to Google Cloud, providing high scalability for large catalog and documentation workloads.

### Operational Modes

The Vertex AI Search module supports two operational modes depending on deployment needs:

- **Standalone Mode (Primary Search Engine)**: Registers directly into Backstage's core `searchEngineRegistryExtensionPoint` as the primary search engine for the portal. Collator streams index all Backstage document types into configured Google Cloud Data Stores, and all search queries are served through Vertex AI Search engines.
- **Hybrid Sub-Engine Mode (Router Integration)**: Registers into `hybridSearchEngineRegistryExtensionPoint` as a specialized sub-engine. In hybrid deployments, Vertex AI Search is assigned to specific document categories (for instance, TechDocs) to deliver semantic search over unstructured content, while structured entities are routed to complementary backends.

### Data Stores & App Engines

In Vertex AI Search, data storage and query execution are decoupled:

- **Data Stores**: Represent storage containers for indexed documents. Each document type is configured with a target GCP project ID, region/location (such as `global` or `europe-west4`), and Data Store ID (`datastoreId`).
- **App Engines**: Represent query-serving endpoints built over one or more Data Stores. The module supports per-type engines for category-specific search and a global blended search app engine (`blendedSearch`) that queries across multiple Data Stores for unified multi-category requests.

Authentication and request routing rely on Google Cloud Application Default Credentials (ADC). The module dynamically manages regionalized `SearchServiceClient` instances, routing requests to location-prefixed endpoints (`<location>-discoveryengine.googleapis.com`) or global endpoints to enforce data residency compliance.

### Schema & Document Indexing

Document ingestion into Vertex AI Search Data Stores is configurable per document type via two operational indexing modes:

- **Direct Ingestion Mode**: Backstage collators push document streams directly into the target Data Store using batch inline imports (up to 100 items per payload). Within a single document stream, batches are sent sequentially (with an optional configurable delay) to avoid exceeding Google Cloud API rate limits. Document location URIs are deterministically hashed to generate stable document IDs, enabling upsert operations during re-indexing runs. Direct ingestion is enforced as a safety guardrail for software catalog entities (`software-catalog`); because catalog entities originate directly within Backstage rather than external storage buckets (as with TechDocs documentation stored in Cloud Storage), collator streaming is required to keep the search index synchronized with live catalog changes.
- **Bypassed Ingestion Mode**: Local collator indexing in Backstage is completely bypassed by returning a dummy stream. This mode is used when content originates externally—such as TechDocs documentation generated by CI/CD build pipelines and published directly to Cloud Storage. Ingestion is offloaded to asynchronous pipelines that populate the Data Store out-of-band, eliminating CPU and memory overhead on the Backstage backend. The EventArc integration module that automates Cloud Storage ingestion is detailed in Section 5.

### Query Processing

Query translation converts generic Backstage `SearchQuery` objects into native Google Cloud Discovery Engine API requests. The translation process resolves target endpoints based on query scope, active deployment mode, and filter criteria.

When a query targets a single document category (such as TechDocs), the module routes the request to that category's designated backend. By default, queries target the underlying Data Store directly. If a category-specific App Engine is configured, the request routes through the App Engine endpoint instead, applying custom serving rules, tuning, and ranking configurations.

For multi-category queries—or global search requests that omit category filters—the module targets a unified `blendedSearch` App Engine. This blended app federates and ranks results across multiple underlying Data Stores in a single Discovery Engine API call. However, blended search execution applies exclusively when the module operates in Standalone Mode as the portal's primary search engine. In Hybrid Sub-Engine Mode, multi-category federation is managed upstream by the `HybridSearchEngine` router rather than an individual sub-engine.

Structured Backstage filter objects are converted into Discovery Engine filter expressions using `key: ANY("value")` syntax, mapping entity metadata fields (such as `kind`, `namespace`, or `owner`) directly into target query filters.

### Content Extraction

When converting search responses from Google Cloud Vertex AI Search into Backstage search results, the module normalizes multi-layered semantic content into Backstage's single unified result text field.

Vertex AI Search evaluates queries dynamically and returns content at multiple levels of granularity—ranging from direct natural language answers to paragraph-length passages and highlighted snippets. To balance relevance, contextual depth, and readability in the portal user interface, the module evaluates returned content using a strict **4-tier priority hierarchy**:

```
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Extractive Content Resolution Cascade                               │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  Priority 1: Extractive Answers    ──► Direct sentence answers to natural language queries    │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 2: Extractive Segments   ──► Multi-sentence paragraph blocks containing query terms │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 3: Search Snippets       ──► Traditional keyword match snippets                     │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 4: Fallback Document Body──► Raw body text of the indexed document                  │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

- **Extractive Answers**: High-precision, direct sentences that synthesize answers to natural language questions (for example, _"How do I configure OAuth in the auth-service?"_). Because extractive answers directly satisfy informational queries with minimal noise, they take highest priority over all other content types.
- **Extractive Segments**: Paragraph-length context blocks surrounding query terms. When no single-sentence direct answer exists, segments preserve larger contextual blocks so engineers can understand surrounding documentation without navigating away from search results.
- **Search Snippets**: Traditional keyword match fragments containing highlighted query terms bounded by contextual text. These apply when Vertex AI Search processes a targeted keyword lookup rather than a semantic question.
- **Fallback Document Body**: If Vertex AI Search returns no extractive answers, segments, or snippets for a matching record, the module falls back to the raw body text of the indexed document page. This acts as a safety guardrail to ensure every search result displays a non-empty summary.

## Section 5: GCS Eventarc Ingestion Webhook Architecture

### Architecture

The GCS Eventarc module (`@backstage-community/plugin-events-backend-module-gcs-eventarc`) replaces Backstage's default pull-based TechDocs indexer with an event-driven ingestion pipeline.

In standard Backstage deployments, TechDocs supports external site compilation—where CI/CD pipelines build static HTML and `search_index.json` manifests before uploading them to Google Cloud Storage (GCS). However, indexing those manifests into search backends still relies on in-process collators (`DefaultTechDocsCollatorFactory`) running inside the Node.js application server. These collators poll storage buckets on fixed schedules, downloading and parsing JSON manifests inside V8 heap memory.

The Eventarc module shifts index synchronization from scheduled polling to event-driven push processing:

- External compilation is a strict prerequisite. The pipeline relies on `google.cloud.storage.object.v1.finalized` events emitted by GCS when a `search_index.json` object is created or updated. Local, in-process documentation builds write directly to container disk, bypassing GCS and preventing Eventarc triggers from firing.
- Indexing is triggered instantly when documentation is published. When Cloud Storage receives an updated site manifest from CI/CD, Eventarc delivers a webhook payload to `/api/events/gcs`, initiating index synchronization out-of-band without blocking the application server or running recurring background polling loops.

### Webhook Ingress & Execution Flow

The module exposes a dedicated HTTP webhook endpoint mounted on the Backstage events router at `/api/events/gcs`:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Decoupled Eventarc Ingestion Sequence                             │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  CI/CD Pipeline ──► Upload search_index.json ──► GCS TechDocs Bucket                        │
│                                                        │                                    │
│                                                        ▼ (google.cloud.storage.object.v1.finalized)
│                                                Google Eventarc Trigger                      │
│                                                        │                                    │
│                                                        ▼                                    │
│                                            Private GKE / Cloud Run Webhook                  │
│                                            (HTTP POST /api/events/gcs)                      │
│                                                        │                                    │
│                                                        ▼ (Acknowledge HTTP 200 OK)          │
│                                            Internal Backstage Event Bus                     │
│                                                        │                                    │
│                                                        ▼ (Asynchronous Background Worker)   │
│                                            1. Download search_index.json (Gen N)            │
│                                            2. Enrich Docs via CatalogService                │
│                                            3. Compute Stable MD5 Document IDs               │
│                                            4. Calculate Delta vs Historical Gen N-1         │
│                                            5. Upsert Active & Purge Stale Documents         │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Storage Event Emission**: When a CI/CD pipeline uploads `search_index.json` to GCS, Cloud Storage emits a `google.cloud.storage.object.v1.finalized` event containing the target bucket name, object path, and generation ID ($N$).
2. **Eventarc Routing**: Google Cloud Eventarc intercepts the storage event and delivers an HTTP POST request to `/api/events/gcs`.
3. **Non-Blocking Webhook Acknowledgment**: The webhook endpoint validates request headers, acknowledges receipt immediately to Eventarc with HTTP 200 OK, and dispatches a background task (`gcs-notifications`) to the internal event bus. User HTTP traffic on the portal server is never blocked.
4. **Asynchronous Background Processing**: The background worker downloads the manifest, enriches documents, and synchronizes the search index out-of-band.

### Catalog Metadata Enrichment

Raw documentation manifests produced by site generators contain page titles and text, but lack portal context such as team ownership, component lifecycle, or authorization controls.

When processing an incoming documentation site (e.g., `default/component/auth-service/search_index.json`), the background worker queries the Backstage Catalog Service (`CatalogService`) to resolve the parent entity (`Component:default/auth-service`). It then enriches every document page before indexing:

- **Entity Metadata Enrichment**: Attaches `owner` (`spec.owner`), `lifecycle` (`spec.lifecycle`), `componentType` (`spec.type`), and `annotations` (`metadata.annotations`) to enable faceted search filtering on the portal UI.
- **Authorization Reference Enrichment**: Attaches the parent entity reference (`component:default/auth-service`) as an authorization resource tag to support downstream access control.

### Deterministic Path Hashing

To execute upsert operations and targeted deletions, search engines require stable, deterministic document identifiers. The module constructs stable document IDs by computing MD5 hashes over canonicalized document URIs:

$$\text{canonicalPath} = \text{`/docs/\${namespace.toLowerCase()}/\${kind.toLowerCase()}/\${name.toLowerCase()}/\${cleanLocation}`}$$

$$\text{docId} = \text{md5}(\text{canonicalPath})$$

- **Path Canonicalization**: Entity identifiers (`namespace`, `kind`, `name`) are explicitly lowercased, leading/trailing slashes are trimmed, and redundant filename suffixes (such as `index.html`) are stripped.
- **Idempotency Guarantee**: Re-indexing the same documentation page across multiple CI/CD deployments produces identical 32-character hexadecimal MD5 digests, allowing search engines to update existing entries without creating duplicate records.

### Differential Reconciliation

Standard pull indexers process data strictly as append/overwrite operations, leaving deleted or renamed documentation pages in search indices as orphaned "ghost results" that cause 404 links.

The GCS Eventarc module resolves this through **Differential Reconciliation**:

1. **Active Set Construction**: The worker parses the current `search_index.json` manifest (GCS Generation $N$), enriches active pages, and builds the active document ID set:
   $$Set_{\text{current}} = \{\text{docId}(p) \mid p \in D_{\text{current}}\}$$
2. **Historical Set Fetching**: The worker queries GCS object versioning history to download the preceding `search_index.json` manifest (GCS Generation $N-1$) and builds the historical document ID set:
   $$Set_{\text{previous}} = \{\text{docId}(p) \mid p \in D_{\text{previous}}\}$$
3. **Delta Set Subtraction**: The worker performs set subtraction to identify pages that existed in Generation $N-1$ but were removed in Generation $N$:
   $$Set_{\text{deleted}} = Set_{\text{previous}} \setminus Set_{\text{current}}$$
4. **Active Upsert & Throttled Purge**: Active documents ($Set_{\text{current}}$) are batch-ingested into Vertex AI Search in concurrent import requests (`batchSize: 100`). Deleted documents ($Set_{\text{deleted}}$) are issued to the search engine as explicit deletion requests regulated by a concurrency throttle (`maxConcurrency: 5`) to prevent rate limit exhaustion.

### Operational Modes & Security Models

The module supports two distinct authentication models depending on infrastructure deployment architecture:

- **Google OIDC ID Token Verification**: For public HTTPS endpoints or Cloud Run deployments, the webhook inspects incoming `Authorization: Bearer <ID_TOKEN>` headers. Using `google-auth-library`, it cryptographically validates token signatures, issuer (`https://accounts.google.com`), target audience (`${baseUrl}/api/events/gcs`), and expected service account email.
- **Private GKE VPC Network Isolation**: For private GKE cluster deployments, Eventarc provisions a cluster-local `gke-forwarder` pod that delivers events internally over VPC port 80. Because this local forwarder cannot generate Google OIDC tokens, OIDC verification is set to `false`. Endpoint security is enforced at the network layer using edge path blocking (Cloud Armor 403 policies, Gateway API path rewrites, NGINX `deny all`) and Kubernetes `NetworkPolicies` restricting port 80 access exclusively to Eventarc forwarder namespaces.
