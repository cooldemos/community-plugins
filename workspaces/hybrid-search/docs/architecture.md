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

- **Part 1: Backstage Search Architecture** analyzes core Backstage search abstractions, query lifecycles, and structural bottlenecks.
- **Part 2: Workspace Architecture & Backend Module Design** details the federated search router, engine modules, and offloaded event-driven indexing architecture.
- **Part 3: Deployment & Operations Manual** provides production configuration references, cloud infrastructure provisioning guides, network security policies, and operational runbooks.

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
│                                                                                   │
│  Part 3: Deployment & Operations Manual                                           │
│    ├── Section 1: Engine & Router Configuration Reference                         │
│    ├── Section 2: Decoupled TechDocs Ingestion Setup                              │
│    ├── Section 3: Webhook Network Security & Deployment Architecture              │
│    └── Section 4: Operational Runbooks & Diagnostics                              │
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

In standard Backstage deployments, TechDocs supports external site compilation—where CI/CD pipelines build static HTML and `search_index.json` files before uploading them to Google Cloud Storage (GCS). However, indexing those files into search backends still relies on in-process collators (`DefaultTechDocsCollatorFactory`) running inside the Node.js application server. These collators poll storage buckets on fixed schedules, downloading and parsing JSON files inside V8 heap memory.

The Eventarc module shifts index synchronization from scheduled polling to event-driven push processing:

- External compilation is a strict prerequisite. The pipeline relies on `google.cloud.storage.object.v1.finalized` events emitted by GCS when a `search_index.json` object is created or updated. Local, in-process documentation builds write directly to container disk, bypassing GCS and preventing Eventarc triggers from firing.
- Indexing is triggered instantly when documentation is published. When Cloud Storage receives an updated `search_index.json` file from CI/CD, Eventarc delivers a webhook payload to `/api/events/gcs`, initiating index synchronization out-of-band without blocking the application server or running recurring background polling loops.

### Webhook Ingress & Execution Flow

The module exposes a dedicated HTTP webhook endpoint mounted on the Backstage events router at `/api/events/gcs`:

```
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                           Decoupled Eventarc Ingestion Sequence                           │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  CI/CD Pipeline ──► Upload search_index.json ──► GCS TechDocs Bucket                      │
│                                                        │                                  │
│                                                        ▼                                  │
│                                     Google Eventarc Trigger                               │
│                                  (object.v1.finalized event)                              │
│                                                        │                                  │
│                                                        ▼                                  │
│                                 Private GKE / Cloud Run Webhook                           │
│                                   (HTTP POST /api/events/gcs)                             │
│                                                        │                                  │
│                                                        ▼ (Acknowledge HTTP 200 OK)        │
│                                   Internal Backstage Event Bus                            │
│                                                        │                                  │
│                                                        ▼ (Asynchronous Background Worker) │
│                                  1. Download search_index.json (Gen N)                    │
│                                  2. Enrich Docs via CatalogService                        │
│                                  3. Compute Stable MD5 Document IDs                       │
│                                  4. Calculate Delta vs Historical Gen N-1                 │
│                                  5. Upsert Active & Purge Stale Documents                 │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

1. **Storage Event Emission**: When a CI/CD pipeline uploads `search_index.json` to GCS, Cloud Storage emits a `google.cloud.storage.object.v1.finalized` event containing the target bucket name, object path, and generation ID ($N$).
2. **Eventarc Routing**: Google Cloud Eventarc intercepts the storage event and delivers an HTTP POST request to `/api/events/gcs`.
3. **Webhook Authentication & Acknowledgment**: The webhook endpoint authenticates the incoming request (verifying Google OIDC ID tokens when enabled), validates payload structure, acknowledges receipt immediately to Eventarc with HTTP 200 OK, and dispatches a background event (`gcs-notifications`) to the internal event bus. User HTTP traffic on the portal server is never blocked.
4. **Asynchronous Background Processing**: The background worker downloads the search index file, enriches each document page with Software Catalog metadata (attaching team ownership, component lifecycle, entity type, and access control tags), and synchronizes the search index out-of-band.

### Catalog Metadata Enrichment

Search index files generated by static site builders contain raw page titles and section text, but lack enterprise portal context. Without catalog metadata, search backends cannot enforce access permissions or support faceted filtering across organizational hierarchies.

When processing an incoming search index file, the background worker queries the Backstage Catalog Service (`CatalogService`) to resolve the target component's parent entity. It then enriches every document record before ingestion:

- **Entity Metadata**: Attaches team ownership, lifecycle stage, component type, and custom annotations to support faceted filtering and taxonomy navigation in the search portal.
- **Authorization Context**: Binds the canonical parent entity reference (`<kind>:<namespace>/<name>`) as a resource tag to enable downstream permission checks.

### Stable Document Identification

To avoid wiping and rebuilding an entire search index on every update, search backends require stable document identifiers to perform targeted upserts and deletions.

The module constructs deterministic document IDs by hashing normalized relative paths. Because a page's ID depends strictly on its canonical path rather than its content, updating a page modifies the existing document in-place, while deleted pages can be precisely identified and purged without full index re-indexing.

### Delta Synchronization & Cleanup

In standard Backstage deployments, pull-based collators execute on fixed schedules. Between scans, search indices serve stale content or route users to 404 links for deleted pages.

By leveraging GCS storage mutation events and object versioning, the Eventarc webhook triggers instant synchronization on publish and automatically purges obsolete entries through delta calculation:

1. **Index File Inspection**: When an updated `search_index.json` file is published, the background worker parses active pages and compiles the current document set.
2. **Historical Version Fetching**: Using GCS object versioning, the worker retrieves the preceding `search_index.json` file to build the historical document set.
3. **Delta Calculation**: By subtracting the active document set from the historical set, the worker identifies deleted or moved pages ($D_{\text{deleted}} = D_{\text{previous}} \setminus D_{\text{current}}$).
4. **Synchronized Ingestion & Purging**: Active pages are batch-ingested into the search backend, while deleted pages are explicitly removed using throttled deletion requests to avoid API rate limits.

### Operational Modes & Security Models

The module supports two distinct authentication models depending on infrastructure deployment architecture:

- **Google OIDC ID Token Verification**: For public HTTPS endpoints or Cloud Run deployments, the webhook inspects incoming `Authorization: Bearer <ID_TOKEN>` headers. Using `google-auth-library`, it cryptographically validates token signatures, issuer (`https://accounts.google.com`), target audience (`${baseUrl}/api/events/gcs`), and expected service account email.
- **Private GKE VPC Network Isolation**: For private GKE cluster deployments, Eventarc provisions a cluster-local `gke-forwarder` pod that delivers events internally over VPC port 80. Because this local forwarder cannot generate Google OIDC tokens, OIDC verification is set to `false`. Endpoint security is enforced at the network layer using edge path blocking (Cloud Armor 403 policies, Gateway API path rewrites, NGINX `deny all`) and Kubernetes `NetworkPolicies` restricting port 80 access exclusively to Eventarc forwarder namespaces.

# Part 3: Deployment & Operations Manual

## Section 1: Engine & Router Configuration Reference

This section provides configuration references for deploying search modules in production using Backstage's application configuration (`app-config.yaml`).

### Backend Registration

Search modules must be registered in the backend application entrypoint (`packages/backend/src/index.ts`). In Backstage's New Backend System, modules register automatically via dependency injection once added to the backend instance:

```typescript
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core search plugin
backend.add(import('@backstage/plugin-search-backend'));

// Hybrid Search Orchestration Module
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));

// Engine Sub-Modules
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense'),
);
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

// Decoupled Ingestion Webhook (optional, required for offloaded TechDocs)
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

### Hybrid Router Configuration (`search.engines.hybrid`)

The hybrid search router manages query routing and result score normalization across registered sub-engines. Configure the routing matrix under `search.engines.hybrid`:

```yaml
search:
  engines:
    hybrid:
      # Federated result consolidation strategy: 'score-normalized-sort' or 'interleave'
      mergeStrategy: score-normalized-sort
      routing:
        software-catalog: typesense
        techdocs: vertexai
        default: typesense # Fallback engine for unmapped document types
```

- **`mergeStrategy`**: Defines how multi-engine search results are combined on page 1:
  - `score-normalized-sort` _(Recommended)_: Scales raw match scores to a $[0.0, 1.0]$ range relative to each backend's top hit, sorting all results globally by normalized relevance.
  - `interleave`: Merges results using round-robin interleaving across engines (Engine A hit 0, Engine B hit 0, Engine A hit 1, Engine B hit 1...).
- **`routing`**: Key-value matrix mapping document category strings (`software-catalog`, `techdocs`) to engine names (`typesense`, `vertexai`). Unmapped categories route to the `default` fallback engine.

### Typesense Engine Configuration (`search.engines.typesense`)

Typesense powers high-speed keyword, metadata filter, and vector search. Configure connection parameters and collection schemas under `search.engines.typesense`:

```yaml
search:
  engines:
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: typesense.internal.example.com
          port: 8108
          protocol: https
      clientOptions:
        connectionTimeoutSeconds: 5
        numRetries: 3
        logLevel: info
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
            - name: 'embedding'
              type: 'float[]'
              num_dim: 384
              model_config:
                model_name: 'ts/all-MiniLM-L6-v2'
          searchOptions:
            query_by: 'title,text,location,embedding'
```

- **`apiKey`**: Administrative API key used to authenticate collection management, indexing, and search requests.
- **`nodes`**: Array of Typesense cluster host definitions. The client automatically load-balances requests and manages failover across configured nodes.
- **`collections.<type>.fields`**: Dynamic collection schema definition. Field name `.*` with type `auto` enables automatic schema detection for standard document attributes, while `float[]` defines vector embedding fields for hybrid keyword-vector search.

### Vertex AI Search Engine Configuration (`search.engines.vertexai`)

Vertex AI Search provides semantic retrieval, natural language query understanding, and extractive content summarization. Configure project parameters and Data Store IDs under `search.engines.vertexai`:

```yaml
search:
  engines:
    vertexai:
      types:
        techdocs:
          datastore:
            projectId: my-gcp-project-id
            datastoreId: techdocs-datastore
            location: global # GCP location: 'global', 'us', or 'eu'
          engine:
            projectId: my-gcp-project-id
            engineId: techdocs-search-app
            location: global
      cleanup:
        enabled: true
        frequency: { hours: 2 }
```

- **`datastore`**: Target GCP project, location, and Data Store ID hosting indexed documents.
- **`engine`** _(Optional)_: Target Search App Engine ID. If specified, search queries route through the App Engine endpoint to apply custom serving configs, tuning controls, and boost rules.
- **`cleanup`**: Periodic background task that sweeps orphaned records from Vertex AI Data Stores when catalog entities are deleted from Backstage.

---

## Section 2: Decoupled TechDocs Ingestion Setup

Offloading TechDocs search indexing to Google Cloud Storage (GCS) and Eventarc eliminates Node.js heap memory saturation during documentation builds.

### Mutual Exclusivity Constraint

The GCS Eventarc webhook module (`events-backend-module-gcs-eventarc`) and local in-process TechDocs indexing are **mutually exclusive**.

If local indexing is enabled for TechDocs while the Eventarc webhook module is registered, the backend throws a `BackendStartupError` during initialization to prevent duplicate indexing streams. When using Eventarc webhook ingestion, local indexing must be disabled in configuration:

```yaml
search:
  engines:
    vertexai:
      types:
        techdocs:
          indexing:
            enabled: false # Must be set to false when using GCS Eventarc webhook
```

### Infrastructure Provisioning (Terraform)

Eventarc triggers process GCS file updates and route HTTP notifications to Backstage. Provision the trigger and required IAM roles using Terraform:

```hcl
# 1. Eventarc Service Account
resource "google_service_account" "eventarc_sa" {
  account_id   = "backstage-eventarc-sa"
  display_name = "Backstage Eventarc Trigger Service Account"
}

# 2. Grant Eventarc Receiver role to SA
resource "google_project_iam_member" "eventarc_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.eventarc_sa.email}"
}

# 3. Grant Pub/Sub Publisher role to GCS Service Agent
resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}

# 4. Eventarc Trigger for GKE Service Destination
resource "google_eventarc_trigger" "gcs_techdocs_trigger" {
  name     = "gcs-techdocs-to-backstage"
  location = var.region
  project  = var.project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }

  matching_criteria {
    attribute = "bucket"
    value     = var.techdocs_bucket_name
  }

  destination {
    gke {
      cluster   = var.gke_cluster_name
      location  = var.gke_cluster_location
      namespace = "backstage"
      service   = "backstage"
      path      = "/api/events/gcs"
    }
  }

  service_account = google_service_account.eventarc_sa.email
}
```

### Pub/Sub Dead-Letter Queue (DLQ) & CMEK Encryption

To ensure webhook delivery failures (such as temporary backend downtime) do not lose search updates, configure a Dead-Letter Queue (DLQ) on the underlying Pub/Sub subscription managed by Eventarc:

```bash
# Create DLQ Pub/Sub Topic
gcloud pubsub topics create gcs-eventarc-dlq

# Grant Pub/Sub Publisher role to Pub/Sub Service Agent
gcloud pubsub topics add-iam-policy-binding gcs-eventarc-dlq \
  --member="serviceAccount:service-${PROJECT_NUMBER}@gcp-sa-pubsub.iam.gserviceaccount.com" \
  --role="roles/pubsub.publisher"

# Attach Dead-Letter Policy to Eventarc Subscription
gcloud pubsub subscriptions update <EVENTARC_SUBSCRIPTION_NAME> \
  --dead-letter-topic=gcs-eventarc-dlq \
  --max-delivery-attempts=5
```

If organizational policy requires Customer-Managed Encryption Keys (CMEK), bind your Cloud KMS key to the regional Eventarc channel:

```hcl
resource "google_eventarc_google_channel_config" "default" {
  provider        = google-beta
  location        = var.region
  project         = var.project_id
  name            = "googleChannelConfig"
  crypto_key_name = var.kms_key_id
}
```

---

## Section 3: Webhook Network Security & Deployment Architecture

Because the `/api/events/gcs` webhook receives external storage triggers, securing the ingress path is essential to prevent index spoofing or unauthorized ingestion requests.

### Authentication Model Selection

The webhook supports two authentication modes configured under `events.modules.gcsEventarcWebhook.oidc`:

```yaml
events:
  modules:
    gcsEventarcWebhook:
      oidc:
        enabled: false # Set to false for GKE VPC routing; set to true for Cloud Run
        audience: https://backstage.example.com/api/events/gcs
        serviceAccountEmail: backstage-eventarc-sa@my-project.iam.gserviceaccount.com
```

- **Cloud Run / Public Endpoints (`enabled: true`)**: Eventarc includes a cryptographically signed Google OIDC ID token in the `Authorization: Bearer` header. The webhook validates token signature, issuer (`https://accounts.google.com`), target audience, and service account email before accepting the payload.
- **Private GKE VPC Environments (`enabled: false`)**: Eventarc delivers events via an internal cluster-local `gke-forwarder` pod using HTTP POST over private VPC network lines. Because `gke-forwarder` pods run inside the cluster and cannot generate Google OIDC tokens, OIDC verification must be disabled (`false`). Security is enforced at the network layer instead.

### GKE Kubernetes Service Port Mapping

When routing Eventarc triggers to GKE Service destinations (`destination.gke`), GCP Eventarc strictly routes HTTP traffic to **port 80** and does not permit custom target port overrides.

To accept Eventarc traffic alongside standard application traffic, expose port 80 in your Backstage Kubernetes Service manifest, mapping it to container target port 7007:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backstage
  namespace: backstage
spec:
  type: ClusterIP
  ports:
    - port: 7007
      targetPort: 7007
      name: http
    - port: 80
      targetPort: 7007
      name: eventarc # Maps Eventarc port 80 traffic to container port 7007
  selector:
    app: backstage
```

### Ingress & Network Isolation Policies

When OIDC verification is disabled for private GKE VPC routing, public access to `/api/events/gcs` must be blocked at the edge ingress layer.

#### 1. GKE Gateway API Path Rewrite (URLRewrite)

Use GKE Gateway API rules to rewrite public requests targeting `/api/events/gcs` to an invalid route, causing Backstage to return a `404 Not Found`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backstage-external-route
  namespace: backstage
spec:
  parentRefs:
    - kind: Gateway
      name: external-gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/events/gcs
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplaceFullPath
              replaceFullPath: /blocked-internal-route
      backendRefs:
        - name: backstage
          port: 7007
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: backstage
          port: 7007
```

#### 2. Cloud Armor Edge Policy (Deny 403)

Block external webhook access at the Google Cloud Load Balancer edge using Cloud Armor:

```bash
gcloud compute security-policies rules create 1000 \
    --security-policy=backstage-armor-policy \
    --expression="request.path.matches('/api/events/gcs')" \
    --action="deny-403"
```

#### 3. Kubernetes NetworkPolicy (VPC Namespace Isolation)

Restrict port 80 ingress access exclusively to Eventarc's managed namespaces (`eventarc-*`):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: isolate-eventarc-port-80
  namespace: backstage
spec:
  podSelector:
    matchLabels:
      app: backstage
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchExpressions:
              - key: kubernetes.io/metadata.name
                operator: In
                values: ['eventarc-gcs-techdocs-trigger']
      ports:
        - protocol: TCP
          port: 80
    - ports:
        - protocol: TCP
          port: 7007
```

---

## Section 4: Operational Runbooks & Diagnostics

### Local Development & Webhook Testing

Test index synchronization locally without provisioning Eventarc triggers or GCP infrastructure.

#### Step 1: Authenticate Local Terminal

Authenticate local terminal sessions with Google Cloud Application Default Credentials (ADC):

```bash
gcloud auth application-default login
```

#### Step 2: Configure Local Environment (`app-config.local.yaml`)

Disable OIDC verification for local development testing:

```yaml
events:
  modules:
    gcsEventarcWebhook:
      oidc:
        enabled: false
```

#### Step 3: Simulate Eventarc Webhook Notification

Start Backstage locally (`yarn start`) and trigger a mock Eventarc notification using `curl`:

```bash
curl -X POST http://localhost:7007/api/events/gcs \
  -H "Content-Type: application/json" \
  -H "ce-type: google.cloud.storage.object.v1.finalized" \
  -d '{
    "bucket": "my-techdocs-bucket",
    "name": "default/component/auth-service/search_index.json",
    "generation": 100002
  }'
```

Inspect local backend console logs to verify that the webhook intercepted the event, resolved component metadata from the Software Catalog, calculated index deltas, and updated Vertex AI Search:

```text
[1] info: Starting search-index synchronization for: default/component/auth-service/search_index.json
[1] info: Ingesting 14 pages into dataStore: techdocs-datastore via 1 parallel import batch...
[1] info: Successfully synchronized search index for Component:default/auth-service
```

### Common Troubleshooting Scenarios

#### Scenario 1: `BackendStartupError: Conflicting Indexing Configurations`

- **Symptom**: The Backstage backend fails to start and logs a `BackendStartupError`.
- **Root Cause**: Local TechDocs indexing (`search.engines.vertexai.types.techdocs.indexing.enabled: true`) and the Eventarc webhook module are active simultaneously.
- **Resolution**: Set local TechDocs indexing to `false` in `app-config.yaml`.

#### Scenario 2: Webhook Returns `401 Unauthorized`

- **Symptom**: Eventarc trigger executions fail with HTTP `401` status codes.
- **Root Cause**: OIDC verification is enabled (`enabled: true`), but the request originates from a GKE `gke-forwarder` pod that does not attach Google OIDC tokens.
- **Resolution**: Set `events.modules.gcsEventarcWebhook.oidc.enabled` to `false` for GKE deployments and enforce security via network policies.

#### Scenario 3: `Defaulted to Global Endpoint` Warning

- **Symptom**: Console logs display warnings indicating Vertex AI Search clients defaulted to global API endpoints.
- **Root Cause**: Missing or mismatched `location` setting in Vertex AI Data Store configuration.
- **Resolution**: Ensure `search.engines.vertexai.types.<type>.datastore.location` explicitly matches the regional location of your GCP Data Store (e.g. `europe-west4` or `global`).
