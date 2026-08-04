# Master Architecture & Technical Specification: Hybrid Search Workspace

**Document Version**: 1.0.0  
**Target Architecture**: Backstage New Backend System (`@backstage/backend-plugin-api`)  
**Workspace**: `workspaces/hybrid-search`

## Executive Summary

Standard upstream Backstage search provides a foundational baseline for developer portals by organizing discovery around a central search backend plugin. The core system routes all portal queries through a single search engine backend, using background pipelines to collect software catalog entities, technical documentation, etc on periodic timer intervals.

However, as developer portals scale in size and complexity, organizations often encounter architectural trade-offs across three main areas. First, directing all portal queries to a single search engine can make it challenging to leverage specialized backends tailored to specific content types. Second, relying solely on lexical keyword matching can limit opportunities to combine keyword search with semantic vector retrieval for unstructured documentation. Finally, running background ingestion pipelines directly inside the application server can lead to resource contention within the single-threaded Node.js runtime during large-scale indexing operations.

The **Hybrid Search Workspace** extends baseline capabilities by introducing:

- A hybrid search router to dispatch search requests across different backends based on content type.
- Search backend modules for Typesense and Vertex AI Search that power semantic search and can run standalone or combined with the hybrid search router.
- An offloaded indexing implementation pattern (for Vertex AI Search) that shifts search indexing out of the application server process.

This document is written for engineers configuring search in Backstage. It explains how to use the solutions provided in this workspace, while providing foundational context on standard Backstage search to illustrate how this workspace builds upon and extends default capabilities. The guide is organized into three parts:

- **Part 1: Backstage Search Architecture** provides baseline context by analyzing core Backstage search abstractions, query lifecycles, and ingestion pipelines.
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
│    ├── Section 1: Standalone Typesense Search Engine                              │
│    ├── Section 2: Standalone Vertex AI Search Engine                              │
│    ├── Section 3: Hybrid Search Router                                            │
│    ├── Section 4: Integrating Search Backends with the Hybrid Search Router       │
│    └── Section 5: Operational Runbooks & Diagnostics                              │
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

1. **Client Dispatch**

   The frontend issues an HTTP `GET /api/search/query` request containing search terms, document category filters, entity filters, and pagination parameters.

2. **Backend Authentication & Engine Resolution**

   The search backend plugin authenticates the request, parses query parameters, and retrieves the active `SearchEngine` instance from the `SearchEngineRegistry`.

3. **Query Translation (`SearchQuery` → Native DSL)**

   The active `SearchEngine` receives the abstract `SearchQuery` object and translates its terms and filters into engine-native query syntax (such as Elasticsearch JSON DSL, SQL, or Lunr term queries).

4. **Target Execution & Retrieval**

   The `SearchEngine` dispatches the translated query to the underlying search service or datastore to fetch matching records.

5. **Response Normalization (`SearchResultSet`)**

   The raw search response—containing matching documents, relevance scores, and snippet highlights—is mapped into Backstage's standardized `SearchResult` payload structure.

6. **HTTP Response Serialization**

   The search backend returns a JSON payload to the client containing the normalized search results, total result count, and pagination cursors.

## Section 3: Document Ingestion

Standard Backstage manages document ingestion through an in-process, stream-based pull pipeline. Operating directly within the primary Node.js backend process, this pipeline periodically collects content from portal sources and indexes it into the active search engine.

To detect content changes, the backend relies on scheduled polling. At configured intervals, it extracts data from upstream services—such as Software Catalog entities or TechDocs search manifests (`search_index.json`, the JSON index generated during MkDocs site builds containing page paths, headings, and document text)—streams the documents through optional enrichment layers, and writes them in batches into the search store:

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

1. **Scheduled Task Trigger**

   The `Scheduler` fires a background re-indexing job based on the configured timer interval for a specific document type.

2. **Pipeline Construction**

   `IndexBuilder` instantiates the readable `Collator` stream, any transform `Decorator` streams, and the writable indexing stream of the registered `SearchEngine`, connecting them into a unified Node.js stream pipeline.

3. **Data Extraction**

   The `Collator` extracts records from its upstream source (such as Software Catalog entities or compiled TechDocs) and emits standardized `IndexableDocument` objects into the pipeline.

4. **Document Enrichment**

   As documents pass through transform `Decorators`, additional metadata is appended or modified (such as RBAC security tags or canonical URLs).

5. **Batch Indexing**

   The `SearchEngine` writable stream receives enriched documents, buffers them into memory batches, and writes them to the search engine.

6. **Pipeline Completion**

   Once the `Collator` finishes emitting documents, the readable stream closes, in-memory buffers flush to the search engine, and task completion is reported to the `Scheduler`.

## Section 4: Architectural Constraints

While standard Backstage search provides a clean and straightforward baseline for developer portals, expanding into high-volume production environments highlights four key architectural trade-offs regarding engine flexibility, search models, resource allocation, and index freshness:

- **Single Search Engine Binding**: The standard Backstage core search backend (`@backstage/plugin-search-backend`) enforces a strict single-engine registration pattern. The core `SearchEngineRegistry` design assumes that one, and only one, `SearchEngine` instance handles all search capabilities for the entire developer portal. If a second search engine module attempts to register itself during backend initialization, the core system throws a fatal startup exception. Furthermore, standard Backstage core possesses zero native routing logic to inspect document types or direct requests to distinct engines based on requested document categories, limiting the portal to a single monolithic discovery topology.

- **Built-In Search Engine Constraints**: Standard Backstage supports three search engines out of the box—**Lunr** (in-memory, non-persistent, non-scalable across replicas), **PostgreSQL** (relational full-text search with heavy database CPU load during text extraction), and **Elasticsearch** (lexical keyword matching). Across all three built-in engines, standard Backstage lacks native support for semantic vector search, neural embeddings, or category-tailored relevance scoring.

- **In-Process Ingestion Bottlenecks**: Ingestion pipelines (`Collator → Decorators → Indexer`) execute directly inside the primary Node.js web server process. Heavy data parsing and transformation tasks compete for CPU time on the same single-threaded V8 event loop that handles user HTTP traffic. This introduces severe **CPU Contention** (blocking concurrent HTTP requests and causing latency spikes) and **Memory Saturation** (in-memory document buffering causing garbage collection freezes or out-of-memory process crashes as data volume grows).

- **Polling Delays & Lack of Real-Time Ingestion**: Standard Backstage ingestion relies on scheduled timer polling (`Scheduler`) rather than real-time event notifications. Because index updates occur only when a scheduled poll runs, search results suffer from a persistent freshness lag: newly published content remains unsearchable, while deleted or renamed items continue to produce temporary "ghost results" (leading to 404 links) until the next poll completes.

# Part 2: Workspace Architecture & Backend Module Design

## Section 1: Backend Modules Architecture

The Hybrid Search Workspace is architected as four modular, backend packages designed for Backstage's New Backend System (`@backstage/backend-plugin-api`). Each package encapsulates a distinct architectural responsibility:

| Package                                                              | Description                                                                                                                                                                                                                                  |
| :------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`@backstage-community/plugin-search-backend-module-hybrid`**       | Top-level federated query router and extension point registry. Intercepts search requests, routes queries to mapped sub-engines based on document type, manages parallel fan-out, and normalizes result scores across heterogeneous engines. |
| **`@backstage-community/plugin-search-backend-module-typesense`**    | Search engine module backed by Typesense, an open-source, fast in-memory search engine optimized for typo-tolerant keyword matching, structured metadata filtering, and vector search.                                                       |
| **`@backstage-community/plugin-search-backend-module-vertexai`**     | Search engine module backed by Google Cloud Vertex AI Search, a managed enterprise search service providing semantic vector retrieval, natural language understanding, and LLM-powered extractive answers.                                   |
| **`@backstage-community/plugin-events-backend-module-gcs-eventarc`** | Event-driven asynchronous ingestion webhook module (`/api/events/gcs`) used exclusively with the Vertex AI Search backend search module.                                                                                                     |

## Section 2: Hybrid Search Router

### Sub-engine Registration

In Backstage's New Backend System, **Extension Points** serve as pluggable architectural boundaries that allow backend plugins to accept dynamic contributions from independent modules during server initialization.

Standard Backstage search uses a single-engine extension point (`searchEngineRegistryExtensionPoint`) that allows only one search engine to register for the entire portal. To bypass this limitation without modifying Backstage core, the hybrid search module (`plugin-search-backend-module-hybrid`) registers itself as the primary engine, while exposing a custom extension point (`hybridSearchEngineRegistryExtensionPoint`) to host downstream search backends.

At backend startup, modules like Typesense and Vertex AI Search register themselves with the hybrid engine through this extension point without hardcoded package coupling. Additional search backends can be added similarly by implementing a backend module that registers with the extension point.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Hybrid Search Extension Point Registry                            │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  Backstage Core Search Plugin (`@backstage/plugin-search-backend`)                          │
│                                │                                                            │
│                                ▼ (Core Single-Engine Registration)                          │
│                   [ searchEngineRegistryExtensionPoint ]                                    │
│                                │                                                            │
│                                ▼                                                            │
│       Hybrid Search Router (`@backstage-community/plugin-search-backend-module-hybrid`)     │
│                                │                                                            │
│                                ▼ (Custom Extension Point)                                   │
│               [ hybridSearchEngineRegistryExtensionPoint ]                                  │
│                                │                                                            │
│        ┌───────────────────────┼───────────────────────┐                                    │
│        ▼                       ▼                       ▼                                    │
│  ┌────────────┐         ┌────────────┐         ┌──────────────────┐                         │
│  │ Typesense  │         │ Vertex AI  │         │ Custom Backend   │                         │
│  │ Module     │         │ Module     │         │ Module           │                         │
│  └────────────┘         └────────────┘         └──────────────────┘                         │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

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
│  └──────────────────────────┬───────────────────────────────────┬──────────────┘  │
│                             │ (Failover & Health Check)         │                 │
│                             ▼                                   ▼                 │
│           ┌────────────────────────────┐      ┌────────────────────────────┐      │
│           │ Typesense Node 1           │      │ Typesense Node 2...        │      │
│           │ (Full Replication)         │      │ (Full Replication)         │      │
│           │ backstage_software-catalog │      │ backstage_software-catalog │      │
│           │ backstage_techdocs         │      │ backstage_techdocs         │      │
│           │ ...                        │      │ ...                        │      │
│           └────────────────────────────┘      └────────────────────────────┘      │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Operational Modes

The Typesense module supports two operational modes depending on portal deployment requirements:

- **Standalone Mode**: Registers directly into Backstage's core `searchEngineRegistryExtensionPoint` as the portal's primary search engine. All collator indexing streams and search queries across all document categories are handled exclusively by Typesense.
- **Hybrid Mode**: Registers into the `hybridSearchEngineRegistryExtensionPoint` exposed by the hybrid search module. In this mode, Typesense functions as a specialized sub-engine assigned to specific document categories (such as catalog entities), coexisting with complementary backends (e.g., Vertex AI Search for TechDocs).

### Authentication

Authentication between the search module and external Typesense instances is secured via API key credentials (`apiKey`). The module supplies this key during client initialization to authenticate collection management, document indexing streams, and search query API calls.

### Cluster Topology

Connectivity is configured through an array of cluster node definitions, each specifying a host, port, protocol, and optional path prefix. The module's internal client uses this node topology to execute automatic client-side load balancing and failover routing across cluster nodes if an instance becomes unreachable.

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

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      Vertex AI Search Module Architecture                         │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  [ Extension Points ]                                                             │
│    ├── Standalone Mode       : searchEngineRegistryExtensionPoint                 │
│    └── Hybrid Sub-Engine Mode: hybridSearchEngineRegistryExtensionPoint           │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Vertex AI Search Backend Module                                             │  │
│  │                                                                             │  │
│  │ SearchQuery ──► [ Filter Translator ] ──► [ SearchServiceClient ]           │  │
│  └──────────────────────────────────────────────────┬──────────────────────────┘  │
│                                                     │ (GCP ADC Auth)              │
│                                                     ▼                             │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Google Cloud Discovery Engine API (Location: global / regional)             │  │
│  │                                                                             │  │
│  │  ┌───────────────────────────────────┐    ┌──────────────────────────────┐  │  │
│  │  │ Global Blended Search App         │    │ Dedicated Search Apps        │  │  │
│  │  │ (Multi-Type Blended Querying)     │    │ (Category-Specific Tuning)   │  │  │
│  │  └─────────────────┬─────────────────┘    └──────────────┬───────────────┘  │  │
│  │                    │                                     │                  │  │
│  │                    ▼                                     ▼                  │  │
│  │  ┌───────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Google Cloud Data Stores                                              │  │  │
│  │  │  ├── backstage-techdocs   (Unstructured / Offloaded Ingestion)        │  │  │
│  │  │  └── backstage-software-catalog (Structured / Direct Ingestion)       │  │  │
│  │  └───────────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Operational Modes

The Vertex AI Search module supports two operational modes depending on deployment needs:

- **Standalone Mode**: Registers directly into Backstage's core `searchEngineRegistryExtensionPoint` as the primary search engine for the portal. Collator streams index all Backstage document types into configured Google Cloud Data Stores, and all search queries are served through Vertex AI Search engines.
- **Hybrid Mode**: Registers into `hybridSearchEngineRegistryExtensionPoint` as a specialized sub-engine. In hybrid deployments, Vertex AI Search is assigned to specific document categories (for instance, TechDocs) to deliver semantic search over unstructured content, while structured entities are routed to complementary backends.

### Data Stores & Search Engines

In Vertex AI Search, data storage and query execution are decoupled:

- **Data Stores**: Represent storage containers for indexed documents. Each document type is configured with a target Google Cloud project ID, region/location (such as `global` or `eu`), and Data Store ID (e.g., `backstage-techdocs`).
- **Search Engines**: Represent query-serving endpoints built over one or more Data Stores. The module can be configured with an engine per document type for category-specific search configurations and a global blended search engine (`blendedSearch`) that queries across multiple Data Stores for unified multi-category requests.

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

| Priority | Content Type               | Description & Behavior                                                                                                                                              |
| :------: | :------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
|  **1**   | **Extractive Answers**     | High-precision, direct sentences that synthesize answers to natural language questions (e.g., _"How do I configure OAuth?"_). Satisfies queries with minimal noise. |
|  **2**   | **Extractive Segments**    | Paragraph-length context blocks surrounding query terms. Preserves larger context when no single-sentence direct answer exists.                                     |
|  **3**   | **Search Snippets**        | Traditional keyword match fragments containing highlighted query terms. Used during targeted keyword lookups.                                                       |
|  **4**   | **Fallback Document Body** | Raw body text of the indexed document page. Acts as a safety guardrail when no extractive content is returned.                                                      |

### Catalog & Storage Reconciliation

Decoupled deployments offload documentation builds and search indexing to external CI/CD pipelines and storage webhooks (detailed in Section 5). Because in-process Backstage collators are bypassed, deleting an entity from the Software Catalog does not trigger automatic index cleanup. Without explicit reconciliation, removed components leave behind orphaned documentation files in Google Cloud Storage (GCS) and stale search records in Vertex AI Search.

To maintain index consistency, the Vertex AI Search module runs a background cleanup task (`techdocs-orphan-sweeper`) that purges orphaned documentation from GCS and Vertex AI Search.

The sweeper task runs as a background job managed by Backstage's `SchedulerService`. It automatically activates when decoupled ingestion and cleanup are enabled, and disables itself when direct collator indexing is active. To reduce resource usage, the task runs every two hours by default. It also includes an initial two-minute startup delay so `CatalogService` can finish initializing before orphan checks begin.

When executed, the sweeper reconciles live portal entities against the contents of the TechDocs Cloud Storage bucket to find orphaned documentation through a 5-step reconciliation pipeline:

1. **Fetch Active Catalog Entities**

   Queries the Catalog Service to construct a lookup set of active canonical entity references (`<namespace>/<kind>/<name>`).

2. **Scan Cloud Storage Assets**

   Scans directory prefixes in the TechDocs Cloud Storage bucket to discover all published documentation assets.

3. **Identify Orphaned Docs**

   Cross-references storage directory paths against live catalog references to isolate orphaned documentation folders.

4. **Resolve Document IDs**

   Reads the `search_index.json` file of each orphaned folder to derive the canonical page paths and deterministic document IDs generated during initial ingestion.

5. **Purge Data Store Documents & Cloud Storage Assets**

   Deletes matching document records from the Vertex AI Search Data Store, then purges the corresponding assets (HTML, CSS, images, etc.) from the Cloud Storage bucket.

   If an orphaned component's `search_index.json` file is missing or corrupted, the sweeper logs a warning, skips Discovery Engine document deletion calls, and proceeds directly to wiping the orphaned static files in the bucket.

Operating a background cleanup task complements Eventarc-driven ingestion without impacting server responsiveness. While the Eventarc webhook processes real-time index updates upon publication, the sweeper runs as an infrequent background job specifically to reconcile rare entity deletions. By executing on a low-frequency schedule, it maintains eventual index consistency without adding continuous overhead to the Backstage backend.

## Section 5: GCS Eventarc Ingestion Webhook Architecture

### Architecture

The GCS Eventarc module (`@backstage-community/plugin-events-backend-module-gcs-eventarc`) replaces standard scheduled polling with real-time, event-driven search indexing.

In traditional Backstage setups, TechDocs indexing relies on in-process collators (`DefaultTechDocsCollatorFactory`) that periodically poll Cloud Storage buckets to download and parse `search_index.json` manifest files inside the Node.js process, which can consume memory and delay search updates.

The Eventarc module shifts this into a real-time, push-driven pipeline:

- **External CI/CD Builds Required**: TechDocs sites must be compiled by external CI/CD pipelines and uploaded to Google Cloud Storage (GCS). Local container-disk builds bypass GCS, so GCS storage events will not fire.
- **Event-Driven Webhook Indexing**: When CI/CD publishes a new or updated `search_index.json` file to GCS, GCS emits a `google.cloud.storage.object.v1.finalized` storage event. Eventarc instantly routes a webhook push notification (`POST /api/events/gcs`) to Backstage, triggering real-time index synchronization upon publication.

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
3. **Delta Calculation**: By subtracting the active document set from the historical set, the worker identifies deleted or moved pages.
4. **Synchronized Ingestion & Purging**: Active pages are batch-ingested into the search backend, while deleted pages are explicitly removed using throttled deletion requests to avoid API rate limits.

### Authentication

The GCS Eventarc webhook module supports two authentication models depending on whether notifications are delivered to a public Cloud Run endpoint or a private GKE cluster destination:

- **Cloud Run**: When targeting Cloud Run, OIDC authentication should be enabled. Eventarc automatically generates and attaches a cryptographically signed Google OIDC ID token in the `Authorization: Bearer` request header. The webhook validates the token's signature, issuer (`https://accounts.google.com`), target audience URL, and service account email before accepting the event payload.
- **Private GKE Destinations**: When targeting GKE services, Eventarc routes events over internal network paths via an in-cluster `gke-forwarder` pod. Because `gke-forwarder` pods deliver traffic internally without generating Google OIDC tokens, OIDC verification must be disabled (`enabled: false`). Security is instead enforced at the network layer.

### Networking and Network Security

Deploying event-driven webhooks on Kubernetes requires aligning network transport constraints with edge security policies.

A critical architectural constraint when deploying Eventarc with GKE destinations is that Google Cloud Eventarc's GKE destination specification hardcodes HTTP event delivery strictly to **port 80** on target Kubernetes `Service` resources. The GCP Eventarc API schema does not support custom target port parameters for GKE destinations.

Because Backstage Node.js backend processes default to listening on container port `7007`, Eventarc's cluster-local forwarder pod cannot reach the backend process directly on port 7007. To bridge this constraint, operators must configure the Kubernetes `Service` manifest for Backstage to expose port 80 mapped to target port 7007.

Because OIDC verification is disabled for GKE deployments, public access to `/api/events/gcs` must be blocked at the edge layer to prevent unauthorized index updates.

Operators can enforce security using one of the following controls:

- **Edge Path Rewriting**: GKE Gateway API `URLRewrite` rules rewrite `/api/events/gcs` to an unmapped path, returning HTTP `404 Not Found` to public traffic while permitting internal Eventarc routing.
- **Cloud Armor Edge Blocking**: Google Cloud Armor security policies drop external HTTP requests matching `/api/events/gcs` with a 403 Forbidden rule at the edge load balancer.
- **Ingress Controller Path Blocking**: NGINX Ingress or cluster ingress rules block external traffic targeting `/api/events/gcs` before routing to backend services.
- **Kubernetes NetworkPolicies**: Cluster-level `NetworkPolicies` restrict port 80 ingress access exclusively to Eventarc's managed namespace (`eventarc-*`).

# Part 3: Deployment & Operations Manual

## Section 1: Standalone Typesense Search Engine

Deploying Typesense in standalone mode binds `@backstage-community/plugin-search-backend-module-typesense` as the primary search engine for all Backstage document types.

### Backend Module Registration

Register the Typesense search module (`@backstage-community/plugin-search-backend-module-typesense`) in the backend application entrypoint (`packages/backend/src/index.ts`). In standalone mode, the module binds directly to Backstage's core `searchEngineRegistryExtensionPoint`:

```typescript
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core search plugin
backend.add(import('@backstage/plugin-search-backend'));

// Standalone Typesense Search Engine Module
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense'),
);

backend.start();
```

### Application Configuration

Configure connection credentials, cluster node topology, dynamic field mappings, and vector embedding models in `app-config.yaml` under `search.engines.typesense`:

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

| Parameter                                                 | Type / Required      | Default  | Description                                                                                                                   |
| :-------------------------------------------------------- | :------------------- | :------- | :---------------------------------------------------------------------------------------------------------------------------- |
| **`apiKey`**                                              | `string` (Required)  | –        | Typesense administrative API key with permissions to manage collections, stream document indexes, and execute search queries. |
| **`nodes[].host`**                                        | `string` (Required)  | –        | Hostname or IP address of the Typesense cluster node (e.g. `typesense.internal.example.com`).                                 |
| **`nodes[].port`**                                        | `number` (Required)  | –        | Network port of the Typesense service (e.g. `8108` or `443`).                                                                 |
| **`nodes[].protocol`**                                    | `string` (Required)  | –        | Network protocol used for communication (`http` or `https`).                                                                  |
| **`nodes[].path`**                                        | `string` (Optional)  | `''`     | Optional URL path prefix (e.g. `/typesense`) when Typesense is deployed behind a reverse proxy or ingress path rewrite.       |
| **`clientOptions.connectionTimeoutSeconds`**              | `number` (Optional)  | `5`      | HTTP connection timeout in seconds for Typesense client requests.                                                             |
| **`clientOptions.healthcheckIntervalSeconds`**            | `number` (Optional)  | `15`     | Interval in seconds between node health checks performed by the Typesense client.                                             |
| **`clientOptions.numRetries`**                            | `number` (Optional)  | `3`      | Maximum number of request retry attempts before marking a cluster node unhealthy.                                             |
| **`clientOptions.logLevel`**                              | `string` (Optional)  | `'info'` | Logger verbosity level for the Typesense SDK (`'debug'`, `'info'`, `'warn'`, `'error'`).                                      |
| **`collections.<type>.fields[].name`**                    | `string` (Required)  | –        | Document field name or wildcard pattern (e.g. `.*`, `title`, `text`, `embedding`).                                            |
| **`collections.<type>.fields[].type`**                    | `string` (Required)  | –        | Typesense field data type (e.g. `auto`, `string`, `int32`, `float[]`).                                                        |
| **`collections.<type>.fields[].num_dim`**                 | `number` (Optional)  | –        | Vector embedding dimensionality for vector search fields (e.g. `384`).                                                        |
| **`collections.<type>.fields[].model_config.model_name`** | `string` (Optional)  | –        | Built-in ML model identifier for server-side auto-embedding (e.g. `ts/all-MiniLM-L6-v2`).                                     |
| **`collections.<type>.searchOptions.query_by`**           | `string` (Required)  | –        | Comma-separated list of target fields evaluated during search execution (e.g. `title,text,location,embedding`).               |
| **`collections.<type>.searchOptions.prefix`**             | `boolean` (Optional) | `true`   | Enables prefix matching for partial query words during search execution.                                                      |
| **`collections.<type>.searchOptions.filter_by`**          | `string` (Optional)  | –        | Typesense filter expression applied to query results (e.g. `kind:=component`).                                                |
| **`collections.<type>.searchOptions.sort_by`**            | `string` (Optional)  | –        | Sorting rule for query results (e.g. `_text_match:desc`).                                                                     |

---

## Section 2: Standalone Vertex AI Search Search Engine

Deploying Vertex AI Search in standalone mode binds `@backstage-community/plugin-search-backend-module-vertexai` as the primary search engine for all Backstage document types.

### Global Blended Search Architecture (`blendedSearch`)

In standalone mode, Backstage homepage queries execute across multiple document categories (e.g. searching across both `techdocs` and `software-catalog` simultaneously). To support multi-category search, Google Cloud Vertex AI Search uses a **Global Blended Search App**.

- **Multi-Datastore Consolidation**: The Blended Search App links all individual per-type Data Stores into a unified Search Engine. The Google Cloud Discovery Engine API queries all linked Data Stores in parallel and returns a unified, ranked result list.
- **Standalone Requirement**: The `blendedSearch` block in `app-config.yaml` is **mandatory** when operating in standalone mode.
- **Hybrid Router Conflict**: In a Hybrid Search Router setup (Section 3), `blendedSearch` **must be omitted**. Query blending across engines is managed by the Backstage Hybrid Search Router itself; configuring `blendedSearch` in hybrid mode results in a startup configuration error.

### Infrastructure Provisioning (Terraform)

All Google Cloud infrastructure required for Vertex AI Search and event-driven TechDocs ingestion can be provisioned using a single, unified Terraform module.

The manifest below organizes resources into logical blocks, with explicit comments indicating **when** each resource is required based on your deployment choices (Standalone vs. Hybrid Router mode, and Direct Collator vs. Decoupled Eventarc Ingestion):

```hcl
locals {
  # Define all Backstage document categories/types to index in your portal
  datastores = {
    techdocs = {
      display_name         = "Backstage TechDocs Store"
      create_dedicated_app = true # Set true if a dedicated Search App is needed for custom query tuning
    }
    catalog = {
      display_name         = "Backstage Catalog Store"
      create_dedicated_app = false # Uses global blended Search App
    }
    # Other document types here
  }
}

# ============================================================================
# 1. BASE DATA STORES & SCHEMAS (REQUIRED for all deployment modes)
# Provisions one datastore & schema per configured content type.
# ============================================================================

resource "google_discovery_engine_data_store" "backstage" {
  for_each          = local.datastores
  project           = var.project_id
  location          = var.region # 'global', 'us', or 'eu'
  data_store_id     = "backstage-${each.key}"
  display_name      = each.value.display_name
  industry_vertical = "GENERIC"
  solution_types    = ["SOLUTION_TYPE_SEARCH"]
  content_config    = "NO_CONTENT" # Ingested in-memory via JSON payload
}

resource "google_discovery_engine_schema" "backstage_schema" {
  for_each      = local.datastores
  project       = var.project_id
  location      = google_discovery_engine_data_store.backstage[each.key].location
  data_store_id = google_discovery_engine_data_store.backstage[each.key].data_store_id
  schema_id     = "default_schema"

  # Standardized schema template (maps core search & filterable catalog attributes)
  json_schema = jsonencode({
    "$schema" = "https://json-schema.org/draft/2020-12/schema"
    type      = "object"
    dynamic   = "true"
    properties = {
      title         = { type = "string", keyPropertyMapping = "title", retrievable = true }
      text          = { type = "string", keyPropertyMapping = "description", retrievable = true }
      kind          = { type = "string", indexable = true, retrievable = true }
      namespace     = { type = "string", indexable = true, retrievable = true }
      location      = { type = "string", indexable = true, retrievable = true }
      owner         = { type = "string", indexable = true, retrievable = true }
      lifecycle     = { type = "string", indexable = true, retrievable = true }
      componentType = { type = "string", indexable = true, retrievable = true }
    }
  })
}

# ============================================================================
# 2. GLOBAL BLENDED SEARCH APP
# REQUIRED for Standalone Mode portal-wide homepage search.
# OMIT in Hybrid Search Router Mode to avoid config errors.
# ============================================================================

resource "google_discovery_engine_search_engine" "blended_search_engine" {
  project        = var.project_id
  engine_id      = "backstage-global-search-app"
  collection_id  = "default_collection"
  location       = var.region
  display_name   = "Backstage Global Blended Search App"
  # Automatically resolves and links all dynamically provisioned Data Stores
  data_store_ids = [for ds in google_discovery_engine_data_store.backstage : ds.data_store_id]

  search_engine_config {
    search_tier = "SEARCH_TIER_STANDARD"
  }
}

# ============================================================================
# 3. DEDICATED SEARCH APP ENGINE (OPTIONAL)
# Provision ONLY for datastores explicitly requesting create_dedicated_app = true.
# ============================================================================

resource "google_discovery_engine_search_engine" "dedicated" {
  for_each       = { for k, v in local.datastores : k => v if lookup(v, "create_dedicated_app", false) }
  project        = var.project_id
  engine_id      = "backstage-${each.key}-search"
  collection_id  = "default_collection"
  location       = var.region
  display_name   = "Backstage ${each.value.display_name} Dedicated App"
  data_store_ids = [google_discovery_engine_data_store.backstage[each.key].data_store_id]

  search_engine_config {
    search_tier = "SEARCH_TIER_STANDARD"
  }
}

# ============================================================================
# 4. BACKSTAGE SERVICE ACCOUNT IAM ROLES (REQUIRED for all modes)
# ============================================================================

# Admin role is required to purge/delete indexed documents during cleanup
resource "google_project_iam_member" "backstage_discovery_engine" {
  project = var.project_id
  role    = "roles/discoveryengine.admin"
  member  = "serviceAccount:${var.backstage_sa_email}"
}

# Object Admin role is required for orphan TechDocs folder cleanup in GCS
resource "google_storage_bucket_iam_member" "backstage_techdocs_gcs" {
  bucket = var.techdocs_bucket_name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${var.backstage_sa_email}"
}

# ============================================================================
# 5. EVENTARC PIPELINE RESOURCES
# REQUIRED if decoupled Eventarc ingestion.
# OMIT if using direct Collator ingestion.
# ============================================================================

# Eventarc Trigger Service Account
resource "google_service_account" "eventarc_sa" {
  account_id   = "backstage-eventarc-sa"
  display_name = "Backstage Eventarc Trigger Service Account"
}

# Grant Eventarc Receiver role to Service Account
resource "google_project_iam_member" "eventarc_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.eventarc_sa.email}"
}

# Grant Pub/Sub Publisher role to Google Cloud Storage Service Agent
resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${var.project_number}@gs-project-accounts.iam.gserviceaccount.com"
}

# Eventarc Trigger routing GCS object updates to Backstage webhook
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

# ============================================================================
# 6. CUSTOMER-MANAGED ENCRYPTION KEYS / CMEK (OPTIONAL)
# Provision ONLY if organizational compliance requires CMEK encryption.
# ============================================================================

resource "google_eventarc_google_channel_config" "cmek_config" {
  provider        = google-beta
  location        = var.region
  project         = var.project_id
  name            = "googleChannelConfig"
  crypto_key_name = var.kms_key_id
}
```

### Option A – Direct Collator Ingestion Mode

In direct ingestion mode, Backstage collators run inside the Node.js backend and push document streams directly into Google Cloud Discovery Engine API endpoints using batch inline imports (up to 100 items per payload).

#### Backend Module Registration

Register only the Vertex AI Search module (`@backstage-community/plugin-search-backend-module-vertexai`) in `packages/backend/src/index.ts`:

```typescript
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core search plugin
backend.add(import('@backstage/plugin-search-backend'));

// Standalone Vertex AI Search Module
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

backend.start();
```

#### Configuration

Configure direct collator ingestion in `app-config.yaml`:

```yaml
search:
  engines:
    vertexai:
      # MANDATORY for Standalone Mode: Global Blended Search App for portal-wide queries
      blendedSearch:
        projectId: my-gcp-project-id
        location: global
        engineId: backstage-global-search-app
        searchOptions:
          contentSearchSpec:
            extractiveContentSpec:
              maxExtractiveAnswerCount: 1
              maxExtractiveSegmentCount: 2

      types:
        techdocs:
          indexing:
            enabled: true
          datastore:
            projectId: my-gcp-project-id
            datastoreId: techdocs-datastore
            location: global
          # Optional: Dedicated Search App Engine (falls back to querying datastore directly if omitted)
          engine:
            projectId: my-gcp-project-id
            engineId: techdocs-search-app
            location: global

        software-catalog:
          indexing:
            enabled: true
          datastore:
            projectId: my-gcp-project-id
            datastoreId: catalog-datastore
            location: global
```

### Option B – Decoupled Eventarc Ingestion

To prevent Node.js V8 memory strain during documentation builds, local collator indexing is completely bypassed for TechDocs by setting `indexing.enabled: false`. Ingestion is offloaded to CI/CD pipelines publishing to Google Cloud Storage (GCS), triggering real-time index updates via Eventarc notifications. When entities disappear from the catalog, the background `techdocs-orphan-sweeper` task maintains index consistency by automatically cleaning up the corresponding orphaned documentation files from both GCS and the Vertex AI Search datastore.

#### Backend Module Registration

Register both the Vertex AI Search module (`@backstage-community/plugin-search-backend-module-vertexai`) and the GCS Eventarc webhook module (`@backstage-community/plugin-events-backend-module-gcs-eventarc`) in `packages/backend/src/index.ts`:

```typescript
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core search plugin
backend.add(import('@backstage/plugin-search-backend'));

// Vertex AI Search Engine Module
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

// Decoupled GCS Eventarc Ingestion Webhook Module
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

#### Configuration

Configure offloaded TechDocs ingestion and catalog orphan cleanup in `app-config.yaml`:

```yaml
search:
  engines:
    vertexai:
      # MANDATORY for Standalone Mode: Global Blended Search App for portal-wide queries
      blendedSearch:
        projectId: my-gcp-project-id
        location: global
        engineId: backstage-global-search-app

      types:
        techdocs:
          indexing:
            enabled: false # Bypasses local collator streaming for TechDocs
          datastore:
            projectId: my-gcp-project-id
            datastoreId: techdocs-datastore
            location: global
          # Optional: Dedicated Search App Engine (falls back to querying datastore directly if omitted)
          engine:
            projectId: my-gcp-project-id
            engineId: techdocs-search-app
            location: global

        software-catalog:
          indexing:
            enabled: true # Catalog collator streams directly
          datastore:
            projectId: my-gcp-project-id
            datastoreId: catalog-datastore
            location: global

      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }
```

##### Parameter Reference Matrix

| Parameter                                | Type / Required       | Default           | Description                                                                                                       |
| :--------------------------------------- | :-------------------- | :---------------- | :---------------------------------------------------------------------------------------------------------------- |
| **`blendedSearch.projectId`**            | `string` (Required)   | –                 | GCP Project ID hosting the global blended Search App Engine (Standalone Mode).                                    |
| **`blendedSearch.location`**             | `string` (Required)   | `'global'`        | Regional location of the global blended Search App Engine (`'global'`, `'us'`, `'eu'`, `'europe-west4'`).         |
| **`blendedSearch.engineId`**             | `string` (Required)   | –                 | Search App Engine ID for multi-type global blended search.                                                        |
| **`blendedSearch.searchOptions`**        | `object` (Optional)   | –                 | Raw query options passed to Discovery Engine blended search calls (`servingConfig`, `filter`, `boostSpec`).       |
| **`types.<type>.datastore.projectId`**   | `string` (Required)   | –                 | Target GCP Project ID hosting the Vertex AI Search Data Store.                                                    |
| **`types.<type>.datastore.datastoreId`** | `string` (Required)   | –                 | Target Discovery Engine Data Store ID storing indexed documents.                                                  |
| **`types.<type>.datastore.location`**    | `string` (Optional)   | `'global'`        | Regional location of the Data Store (`'global'`, `'us'`, `'eu'`, `'europe-west4'`).                               |
| **`types.<type>.engine.projectId`**      | `string` (Optional)   | Same as datastore | GCP Project ID hosting the dedicated Search App Engine.                                                           |
| **`types.<type>.engine.engineId`**       | `string` (Optional)   | –                 | Dedicated Search App Engine ID for custom serving configs, tuning rules, and boost controls.                      |
| **`types.<type>.engine.location`**       | `string` (Optional)   | Same as datastore | Regional location of the dedicated Search App Engine.                                                             |
| **`types.<type>.indexing.enabled`**      | `boolean` (Optional)  | `true`            | Controls in-process collator streaming (`true` for direct ingestion; `false` when using GCS Eventarc webhook).    |
| **`types.<type>.indexing.batchSize`**    | `number` (Optional)   | `100`             | Maximum number of documents per inline import payload to Discovery Engine API (1–100).                            |
| **`types.<type>.indexing.throttleMs`**   | `number` (Optional)   | `0`               | Delay in milliseconds between inline batch uploads to throttle ingestion rate.                                    |
| **`types.<type>.searchOptions`**         | `object` (Optional)   | –                 | Type-specific raw query options passed to Discovery Engine search client calls (`servingConfig`, `filter`, etc.). |
| **`indexing.enabled`**                   | `boolean` (Optional)  | `true`            | Global default setting for in-process collator streaming across all document types.                               |
| **`indexing.batchSize`**                 | `number` (Optional)   | `100`             | Global default inline batch upload size across all document types (1–100).                                        |
| **`indexing.throttleMs`**                | `number` (Optional)   | `0`               | Global default delay in milliseconds between inline batch uploads.                                                |
| **`cleanup.enabled`**                    | `boolean` (Optional)  | `true`            | Enables periodic `techdocs-orphan-sweeper` background task to purge deleted catalog documents from GCP.           |
| **`cleanup.frequency`**                  | `Duration` (Optional) | `{ hours: 2 }`    | Frequency schedule for running the catalog orphan reconciliation task (`hours`, `minutes`, `seconds`).            |
| **`cleanup.initialDelay`**               | `Duration` (Optional) | `{ minutes: 2 }`  | Startup delay before executing the initial catalog orphan reconciliation task (`minutes`, `seconds`).             |

#### Pub/Sub Dead-Letter Queue (DLQ) Operational Configuration

Configure a Pub/Sub Dead-Letter Queue (DLQ) to preserve failed notifications during backend downtime:

```bash
# Create DLQ Topic
gcloud pubsub topics create gcs-eventarc-dlq

# Attach Dead-Letter Policy to Eventarc Subscription
gcloud pubsub subscriptions update <EVENTARC_SUBSCRIPTION_NAME> \
  --dead-letter-topic=gcs-eventarc-dlq \
  --max-delivery-attempts=5
```

#### Webhook Networking & Security Hardening

Securing the `/api/events/gcs` webhook path requires aligning network routing constraints with edge security policies.

##### Webhook Parameter Reference Matrix

| Parameter                                                        | Type / Required             | Default   | Description                                                                                                |
| :--------------------------------------------------------------- | :-------------------------- | :-------- | :--------------------------------------------------------------------------------------------------------- |
| **`events.modules.gcsEventarcWebhook.oidc.enabled`**             | `boolean` (Optional)        | `false`   | Enables Google OIDC Bearer token verification (`true` for Cloud Run; `false` for private GKE VPC routing). |
| **`events.modules.gcsEventarcWebhook.oidc.audience`**            | `string` (Required if OIDC) | –         | Expected OIDC target audience URL (e.g., `https://backstage.example.com/api/events/gcs`).                  |
| **`events.modules.gcsEventarcWebhook.oidc.serviceAccountEmail`** | `string` (Optional)         | –         | Expected service account email signing the incoming OIDC Bearer token.                                     |
| **`events.modules.gcsEventarcWebhook.maxConcurrency`**           | `number` (Optional)         | `5`       | Maximum concurrent deletion operations permitted during delta reconciliation.                              |
| **`events.modules.gcsEventarcWebhook.batchSize`**                | `number` (Optional)         | `100`     | Maximum number of documents imported per batch request to Vertex AI Search (1–100).                        |
| **`events.modules.gcsEventarcWebhook.payloadSizeLimit`**         | `string` (Optional)         | `'100kb'` | Express body-parser size limit for incoming GCS Eventarc push notifications.                               |

##### Backstage Kubernetes Service Mapping (Port 80 Constraint)

Configure the Kubernetes `Service` manifest for Backstage to expose port 80 mapped to container target port 7007:

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

##### Edge Ingress Protection Policies

Because OIDC verification is disabled for GKE deployments, public access to `/api/events/gcs` must be blocked at the edge layer to prevent unauthorized index updates.

Operators can enforce security using one of the following controls:

###### 1. GKE Gateway API Path Rewrite (`HTTPRoute`)

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

###### 2. Cloud Armor Edge Policy (Deny 403)

```bash
gcloud compute security-policies rules create 1000 \
    --security-policy=backstage-armor-policy \
    --expression="request.path.matches('/api/events/gcs')" \
    --action="deny-403"
```

###### 3. Kubernetes NetworkPolicy (VPC Namespace Isolation)

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

## Section 3: Hybrid Search Router

Deploying the hybrid search router orchestrates multi-engine search across registered sub-engines.

### Backend Module Registration

Register the hybrid router along with both sub-engine modules in `packages/backend/src/index.ts`:

```typescript
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core search plugin
backend.add(import('@backstage/plugin-search-backend'));

// Hybrid Search Router Orchestration Module
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));

// Sub-Engine Modules
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense'),
);
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

// Decoupled Ingestion Webhook (For offloaded TechDocs)
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

### Configuration

Configure the hybrid router and sub-engine mappings in `app-config.yaml` to route `software-catalog` queries to Typesense (for typo-tolerant keyword search) and `techdocs` queries to Vertex AI Search (for semantic vector search):

```yaml
search:
  engines:
    hybrid:
      mergeStrategy: score-normalized-sort
      routing:
        software-catalog: typesense
        techdocs: vertexai
        default: typesense
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: typesense.internal.example.com
          port: 8108
          protocol: https
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
    vertexai:
      types:
        techdocs:
          indexing:
            enabled: false
          datastore:
            projectId: my-gcp-project-id
            datastoreId: techdocs-datastore
            location: global
      cleanup:
        enabled: true
        frequency: { hours: 2 }
```

##### Parameter Reference Matrix

| Parameter             | Type / Required     | Default        | Description                                                                                                                                            |
| :-------------------- | :------------------ | :------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`search.engine`**   | `string` (Required) | –              | Must be set to `'hybrid'` in `app-config.yaml` to activate the Hybrid Search Router as the primary backend search engine.                              |
| **`mergeStrategy`**   | `string` (Optional) | `'interleave'` | Federated result consolidation algorithm: `'score-normalized-sort'` (recommended relative score scaling) or `'interleave'` (round-robin rank merging). |
| **`routing.<type>`**  | `string` (Required) | –              | Maps Backstage document type/category strings (`software-catalog`, `techdocs`) to registered sub-engine identifiers (`typesense`, `vertexai`).         |
| **`routing.default`** | `string` (Required) | –              | Fallback sub-engine identifier for queries targeting unmapped document types/categories.                                                               |

---

## Section 4: Integrating Search Backends with the Hybrid Search Router

Other search backends can be integrated with the hybrid search router by implementing Backstage's `SearchEngine` interface and registering via `hybridSearchEngineRegistryExtensionPoint`.

Author a custom engine class extending Backstage's `SearchEngine` abstract class:

```typescript
import {
  SearchEngine,
  SearchQuery,
  SearchResultSet,
} from '@backstage/plugin-search-backend-node';
import { Readable, Writable } from 'stream';

export class CustomSearchEngine extends SearchEngine {
  async query(query: SearchQuery): Promise<SearchResultSet> {
    // Translate SearchQuery terms & filters into native vector DB API requests
    // Map response hits to Backstage SearchResult format
    return {
      results: [
        /* Normalized SearchResult objects */
      ],
    };
  }

  getIndexer(type: string): Promise<Writable> {
    // Return a Writable stream to handle collator batch indexing payloads
    return Promise.resolve(
      new Writable({
        /* batch write logic */
      }),
    );
  }
}
```

Then create a new backend system module that injects the custom engine into `hybridSearchEngineRegistryExtensionPoint`:

```typescript
import { createBackendModule } from '@backstage/backend-plugin-api';
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';
import { CustomSearchEngine } from './CustomSearchEngine';

export const customSearchModule = createBackendModule({
  pluginId: 'search',
  moduleId: 'custom-search-engine',
  register(reg) {
    reg.registerInit({
      deps: {
        hybridRegistry: hybridSearchEngineRegistryExtensionPoint,
      },
      async init({ hybridRegistry }) {
        const engine = new CustomSearchEngine();
        // Register the engine under the identifier 'custom-search-engine'
        hybridRegistry.registerEngine('custom-search-engine', engine);
      },
    });
  },
});
```

Once registered, map custom document categories to it in `app-config.yaml`:

---

## Section 5: Operational Runbooks & Diagnostics

### Local Development & Webhook Testing

Test index synchronization locally without provisioning Eventarc triggers or GCP infrastructure.

#### Step 1: Authenticate Local Terminal

Authenticate local terminal sessions with Google Cloud Application Default Credentials (ADC):

```bash
gcloud auth application-default login
```

#### Step 2: Configure Local Environment

Disable OIDC verification in `app-config.local.yaml` for local development testing:

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

### Production Troubleshooting Scenarios

| Scenario                    | Symptom                                            | Root Cause                                                                                                            | Resolution                                                                                                                      |
| :-------------------------- | :------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------ |
| **Conflicting Indexing**    | Backend startup fails with `BackendStartupError`.  | Local TechDocs indexing (`indexing.enabled: true`) and Eventarc webhook module are both active.                       | Set `search.engines.vertexai.types.techdocs.indexing.enabled: false`.                                                           |
| **401 Unauthorized**        | Eventarc triggers fail with HTTP `401`.            | OIDC verification is enabled (`oidc.enabled: true`) on a GKE VPC route where `gke-forwarder` pods omit Bearer tokens. | Set `events.modules.gcsEventarcWebhook.oidc.enabled: false` and enforce edge security via NetworkPolicies or Gateway API rules. |
| **Global Endpoint Warning** | Console logs warn `Defaulted to Global Endpoint`.  | Missing or mismatched `location` in Vertex AI Data Store configuration.                                               | Match `search.engines.vertexai.types.<type>.datastore.location` to your regional GCP Data Store location (e.g. `europe-west4`). |
| **Orphan Files in GCS**     | Deleted catalog components still appear in search. | Sweeper task is disabled or startup delay has not elapsed.                                                            | Verify `search.engines.vertexai.cleanup.enabled: true` and inspect logs for `techdocs-orphan-sweeper` task execution.           |
