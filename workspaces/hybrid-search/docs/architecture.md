# Master Architecture & Technical Specification: Hybrid Search Workspace

**Document Version**: 1.0.0  
**Target Architecture**: Backstage New Backend System (`@backstage/backend-plugin-api`)  
**Workspace**: `workspaces/hybrid-search`

---

## Executive Summary

The **Hybrid Search Workspace** provides a federated multi-engine query router and decoupled asynchronous ingestion pipeline for Backstage developer portals. In modern enterprise developer portals, search demands vary dramatically across document categories: catalog entity lookups require high-throughput exact metadata matching, whereas technical documentation search requires deep semantic comprehension and long-form prose indexing. Standard single-engine Backstage deployments force operators into a compromise, routing all queries through a single search datastore and executing resource-intensive pull ingestion streams directly inside the Node.js web server process.

The Hybrid Search Workspace resolves these architectural trade-offs by introducing:

1. **Federated Query Orchestration**: A top-level search router engine that intercepts incoming search queries, maps document types to specialized search backends (such as Typesense for structured catalog lookups and Google Cloud Vertex AI Search for semantic documentation search), dispatches queries concurrently in parallel, and merges search results using configurable relevance strategies.
2. **Decoupled Asynchronous Ingestion**: A cloud-native event-driven ingestion model that offloads TechDocs site compilation and document parsing from the Node.js runtime to external CI/CD pipelines and cloud object storage (Google Cloud Storage), triggering instant webhook ingestion via Google Cloud Eventarc with live catalog metadata enrichment and automatic delta reconciliation.

This master architecture document serves as the comprehensive technical reference and operational manual for platform architects, software engineers, and DevOps leads. It is organized into four distinct parts:

- **Part 1: How Backstage Search Works (Conceptual & Architectural Analysis)** — A first-principles analysis of core Backstage search abstractions, query and stream mechanics, and fundamental architectural limitations of standard deployments.
- **Part 2: Value Proposition & Technical Mechanics of Hybrid Search (Conceptual Analysis)** — A conceptual breakdown of federated multi-engine routing, parallel dispatch, result score merging, decoupled ingestion, catalog enrichment, and MD5 delta reconciliation.
- **Part 3: System Architecture & Package Specifications (Conceptual Breakdown & Diagrams)** — A structural analysis of workspace packages, runtime conflict rules, deployment topologies (standalone vs. federated hybrid), and sequence flow diagrams.
- **Part 4: Complete Operator & Implementation Manual (Low-Level Configuration & Code)** — Low-level backend module TypeScript registration, annotated `app-config.yaml` manifests, Kubernetes service port mappings, GCP IAM role matrices, Terraform infrastructure, network security runbooks, and local testing procedures.

---

## Document Overview & Structural Map

```
┌───────────────────────────────────────────────────────────────────────────────────┐
│              Master Architecture Document Structure & Navigation                  │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 1: How Backstage Search Works (Conceptual Analysis)      [Active - Task 1] │
│  ├── Section 1: Core Architecture & Extension Points                              │
│  ├── Section 2: Query & Ingestion Execution Mechanics                             │
│  └── Section 3: Four Fundamental Architectural Limitations                        │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 2: Value Proposition & Technical Mechanics               [Active - Task 2]  │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 3: System Architecture & Package Specifications          [Active - Task 3]  │
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 4: Complete Operator & Implementation Manual             [Upcoming - Task 4]│
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

# Part 1: How Backstage Search Works (Conceptual & Architectural Analysis)

---

## Section 1: Backstage Search Core Architecture & Extension Points

To understand why a federated hybrid architecture is required, it is essential to first understand how the standard upstream Backstage search system operates. Backstage organizes search capabilities into a centralized search backend plugin (`@backstage/plugin-search-backend`) and a shared node library (`@backstage/plugin-search-backend-node`). Together, these packages provide an extensible abstraction framework for document ingestion and query processing across developer portal assets.

### 1. First-Principles Breakdown of Core Abstractions

Backstage search decomposes document discovery into five primary architectural abstractions:

#### A. `SearchEngine`

The `SearchEngine` interface represents the foundational contract between the generic Backstage search backend and a specific underlying search technology (such as Lunr, Elasticsearch, Postgres, Typesense, or Google Cloud Vertex AI Search).

The `SearchEngine` abstraction is responsible for three distinct operational duties:

1. **Query Translation & Execution**: Intercepting generic Backstage search query contracts and translating them into engine-specific query DSLs, database calls, or REST API payloads. It executes the query against the backend datastore and converts engine-native response payloads back into standard Backstage result objects.
2. **Indexer Creation**: Producing writable stream instances (`SearchEngineIndexer`) that receive indexed document payloads during ingestion pipelines and batch-write them into the underlying search index or database table.
3. **Index Management**: Handling schema provisioning, index initialization, and optional document deletion routines for specific document categories.

By insulating the rest of the portal from engine-specific query languages and index storage schemas, `SearchEngine` allows Backstage to remain engine-agnostic at its core layer.

#### B. `SearchEngineRegistry`

The `SearchEngineRegistry` acts as the extension point and central registry for search engine implementations within the Backstage backend system. During application initialization, backend modules register search engine instances with this registry.

Under standard Backstage architecture, `SearchEngineRegistry` manages engine resolution for the portal:

- It maintains a reference to the active primary search engine instance.
- It exposes lookup mechanisms for the search backend services to retrieve the registered engine during HTTP query handling and ingestion pipeline construction.

#### C. `IndexBuilder`

The `IndexBuilder` is the orchestration engine for document ingestion pipelines within the Backstage process. It acts as a builder class where developers and plugins register document sources (Collators) and document transformers (Decorators).

When triggered, `IndexBuilder` constructs end-to-end Node.js streaming pipelines:

- It connects readable collator streams to zero or more transform decorator streams.
- It pipes the final transformed document stream into the writable indexer stream provided by the registered `SearchEngine`.
- It manages pipeline lifecycle events, monitoring stream completion, backpressure, and pipeline error states.

#### D. `Scheduler`

The `Scheduler` is the background task orchestration service responsible for triggering periodic document ingestion jobs. In standard Backstage installations, search indexing is not real-time or event-driven; instead, it relies on time-based polling.

The `Scheduler` operates according to defined time intervals or cron expressions:

- It schedules recurrent background tasks for each registered document type (e.g., reindexing component catalog entities every 30 minutes, or reindexing documentation pages every hour).
- It executes task runners that invoke `IndexBuilder` streaming pipelines.
- In multi-replica Backstage deployments, it coordinates distributed task execution using database locks to prevent redundant concurrent indexing runs across portal backend instances.

#### E. `Collators`

A `Collator` is a specialized Readable Stream factory responsible for harvesting indexable content from upstream source systems and converting that content into standardized Backstage `IndexableDocument` objects.

Examples of standard collators include:

- **Catalog Collator (`DefaultCatalogCollatorFactory`)**: Queries the Backstage Software Catalog microservice to pull software entities (components, systems, domains, APIs, templates, locations), extracting metadata such as entity names, descriptions, owners, lifecycles, and tags.
- **TechDocs Collator (`DefaultTechDocsCollatorFactory`)**: Crawls compiled technical documentation sites stored in object storage buckets (or local disk), parsing compiled `search_index.json` manifests to extract page titles, text headers, section paragraphs, and canonical doc URIs.

Each collator encapsulates the logic required to authenticate with, read from, and paginate through its target upstream data source.

---

## Section 2: Standard Query & Ingestion Execution Mechanics

Understanding the operational runtime mechanics of standard Backstage search requires tracing two fundamental data paths: the synchronous HTTP Query Lifecycle and the asynchronous Pull-Indexing Stream Pipeline.

### 1. Synchronous Query Lifecycle (`GET /api/search/query`)

When a developer enters a search query into the Backstage portal user interface, the request executes through a synchronous HTTP lifecycle managed by the search backend plugin:

```
[ Backstage Search UI ]
          │
          │ 1. HTTP GET /api/search/query?term=auth&types[]=software-catalog&types[]=techdocs
          ▼
[ Search Backend Plugin Router ]
          │
          │ 2. Read parameters & resolve primary engine from SearchEngineRegistry
          ▼
[ Primary SearchEngine Implementation ]
          │
          │ 3. Translate SearchQuery into Engine DSL / API Payload
          ▼
[ Engine Datastore / Search Service ] (e.g., Lunr, Elasticsearch, Postgres)
          │
          │ 4. Execute Search & Return Native Match Payload
          ▼
[ Response Normalization Layer ]
          │
          │ 5. Convert Native Matches into Standard SearchResult Array
          ▼
[ Backstage Search UI ] (Renders unified result list with highlights)
```

#### Step-by-Step Query Execution Flow:

1. **HTTP Ingress**: The frontend component issues an HTTP `GET` request to the search backend endpoint `/api/search/query`. The query parameters encode search terms (e.g., `term=auth`), category filters (e.g., `types[]=software-catalog`), structural filters (e.g., `filters[kind]=Component`), pagination offsets, and page size limits.
2. **Request Resolution**: The search backend plugin parses the request context, validates authorization tokens, and retrieves the registered `SearchEngine` instance from the `SearchEngineRegistry`.
3. **Query Translation**: The `SearchEngine` implementation receives a standard `SearchQuery` object containing terms, filters, and pagination parameters. The engine translates these generic abstractions into its native query syntax (such as Elasticsearch JSON query DSL, SQL queries for Postgres, or Lunr term objects).
4. **Index Execution**: The search engine executes the query against its target datastore or remote search cluster.
5. **Response Normalization**: The raw search response (containing match hits, relevance scores, and text snippet highlights) is converted into Backstage's standardized `SearchResult` payload structure.
6. **HTTP Egress**: The search backend responds to the client with JSON containing the normalized result items, total result counts, and pagination tokens (`pageCursor`).

---

### 2. Standard Pull-Indexing Stream Mechanics (`Collator → Decorators → Indexer`)

Document ingestion in standard Backstage operates as an in-memory, stream-based pull pipeline running inside the Node.js backend process:

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

#### Step-by-Step Ingestion Stream Execution Flow:

1. **Scheduler Trigger**: The background `Scheduler` fires a scheduled indexing job based on the configured timer interval for a specific document type.
2. **Pipeline Assembly**: The `IndexBuilder` instantiates the registered `Collator` readable stream, constructs any registered `Decorator` transform streams, and requests a writable `SearchEngineIndexer` stream from the active `SearchEngine`.
3. **Stream Pipe Setup**: `IndexBuilder` pipes the streams together: `Collator.pipe(Decorator_1).pipe(Decorator_N).pipe(Indexer)`.
4. **Data Pulling & Emission**: The `Collator` issues network requests to its upstream source (e.g., fetching catalog entity pages from the Catalog microservice) and emits `IndexableDocument` objects down the pipeline.
5. **Transformation & Enrichment**: As documents pass through transform `Decorators`, additional attributes are appended or modified (such as decorating documents with RBAC security tags, canonical link URLs, or tenant identifiers).
6. **Batch Writing**: The `SearchEngineIndexer` receives decorated document objects, buffers them into memory batches (e.g., 100 documents per batch), and executes batch write operations into the target search datastore or index table.
7. **Stream Finalization**: Once the `Collator` reaches the end of its upstream dataset, it closes the readable stream. The pipeline flushes remaining in-memory batches, closes the indexer, and signals task completion to the `Scheduler`.

---

## Section 3: Four Fundamental Architectural Limitations of Standard Backstage Deployments

While standard Backstage search provides a simple baseline for small portal installations, analyzing its runtime behavior reveals four fundamental architectural limitations that severely impact scalability, search relevance, operational stability, and index freshness in production environments.

### 1. Single Search Engine Constraint in Backend Core

#### Architectural Limitation:

The standard Backstage core search backend (`@backstage/plugin-search-backend`) enforces a strict single-engine registration pattern. The core `SearchEngineRegistry` design assumes that one, and only one, `SearchEngine` instance handles all search capabilities for the entire developer portal. If a second search engine module attempts to register itself during backend initialization, the core system throws a fatal startup exception. Furthermore, standard Backstage core possesses zero native routing logic to inspect document types or direct requests to distinct engines based on query intent.

#### Practical Impact & Consequence:

This rigid constraint forces platform teams into a single-datastore compromise across fundamentally heterogeneous data domains:

- **Catalog Metadata vs. Documentation Prose**: Software catalog entries consist of short, highly structured metadata attributes (component names, team owners, lifecycle tags, system boundaries) where exact keyword matching and fast prefix filtering are critical. Conversely, technical documentation consists of unstructured, long-form markdown prose, conceptual guides, and architecture manuals where semantic search, synonym expansion, and vector embeddings yield far superior discovery.
- **Forced Infrastructure Trade-Offs**: If operators choose a fast keyword engine (such as Typesense or Lunr), catalog lookups perform exceptionally well, but documentation search fails to return relevant results for conceptual or semantic queries. If operators choose a vector/LLM-powered engine or cloud discovery service (such as Google Cloud Vertex AI Search), prose documentation search excels, but exact catalog entity lookups can suffer from semantic hallucination or lower precision on exact component names.
- **Inability to Leverage Specialized Engines**: Organizations are unable to route team directory queries to LDAP/Active Directory indices, code snippets to specialized code search engines, and component entities to lightweight key-value stores—all because core Backstage limits the entire portal to a single monolithic engine interface.

---

### 2. Single-Process Stream Bottlenecks & V8 Heap Memory Strain

#### Architectural Limitation:

In standard Backstage deployments, document ingestion pipelines (`Collator → Decorators → Indexer`) execute directly inside the primary Node.js web server process. Parsing, transforming, and streaming thousands of complex documentation pages or catalog entities occurs synchronously within the same single-threaded V8 JavaScript event loop that handles user HTTP traffic.

#### Practical Impact & Consequence:

- **Node.js Event Loop Starvation**: Large-scale TechDocs indexing requires fetching compiled `search_index.json` files, unpacking HTML string structures, executing regex text sanitization, stripping code blocks, and instantiating thousands of JavaScript document objects. This heavy CPU-bound parsing blocks the single-threaded Node.js event loop. As a result, concurrent user HTTP requests to the portal experience severe latency spikes, delayed responses, or request timeouts during indexing cycles.
- **V8 Heap Memory Pressure & Out-Of-Memory (OOM) Crashes**: Standard Node.js processes operate under strict default V8 heap memory limits (typically 2GB to 4GB). When an organization scales to thousands of microservices and documentation sites, streaming large document payloads into memory buffers causes extreme heap expansion. High memory consumption triggers frequent, long-duration V8 garbage collection (GC) pauses, further freezing the server. Under heavy reindexing loads, the backend process frequently exceeds V8 memory limits and crashes with `ERR_STRING_TOO_LONG` or `FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory`.
- **Blast Radius & System Instability**: Because search ingestion shares process memory with core portal capabilities (such as Software Catalog navigation, TechDocs rendering, and Scaffolder workflow execution), a heavy search reindex job can crash the entire portal backend, causing widespread downtime for all portal users.

---

### 3. Monolithic Query Translation & Uniform Relevance Scoring

#### Architectural Limitation:

Because standard Backstage routes all query requests to a single `SearchEngine` datastore, queries spanning multiple document categories (e.g. searching across both `software-catalog` entities and `techdocs` pages simultaneously) are subjected to a monolithic query translation scheme. The backend engine translates user search terms using a single, uniform set of tokenization, stemming, scoring, and ranking rules across all document indices.

#### Practical Impact & Consequence:

- **Incompatible Scoring Metrics**: Structured metadata entities and unstructured documentation prose evaluate relevance using opposing scoring dynamics:
  - Catalog entities rely on exact field matches (e.g. `name: "auth-service"`, `kind: "Component"`). A single matching token in a short entity name represents massive relevance density.
  - TechDocs prose pages rely on document-length normalized metrics (such as BM25 or TF-IDF), where keyword density across long paragraphs determines document relevance.
- **Relevance Distortion & Card Pollution**: When a unified search query executes against a monolithic datastore index containing both entity types, standard relevance algorithms fail to normalize scores across domains. Long-form documentation pages with frequent term repetitions often skew BM25 scores upward, completely overwhelming exact catalog entity matches. As a result, page 1 of user search results becomes polluted with obscure documentation sections while the exact target component entity is buried on page 3.
- **Lack of Category Boosting & Custom Normalization**: Standard monolithic translation prevents operators from applying fine-grained boosting rules tailored to specific document types. Operators cannot specify that entity name matches should carry 10x boosting weight over documentation text matches within the same query without breaking scoring semantics for documentation queries.

---

### 4. Scheduled Polling Delays & Lack of Delta Reconciliation

#### Architectural Limitation:

Standard Backstage ingestion relies strictly on timer-based polling (`Scheduler`). Document updates published in developer CI/CD pipelines must wait for the next scheduled cron poll interval before appearing in search results. More critically, standard pull-stream collators and indexers process datasets strictly as append/overwrite operations; they possess zero architectural capability to compute historical deltas between current ingestion runs and past index states.

#### Practical Impact & Consequence:

- **Indexing Delays & Stale Documentation**: When a developer updates technical documentation or catalog metadata in Git and merges a pull request, the changes are compiled and published immediately by CI/CD. However, because standard Backstage search relies on periodic `Scheduler` polling (which may run every 1 to 6 hours to minimize CPU strain), there is a significant temporal lag between publication and searchability. Developers searching for recently updated API specs or deployment guides are presented with outdated search results.
- **Orphaned Index Records ("Ghost Results")**: When a component is deleted from the catalog, or when documentation markdown files are renamed or removed in Git during repository restructuring, standard pull pipelines emit only the _currently existing_ documents. Because standard indexers do not track historical index state or compare generation `N` against generation `N-1`, deleted documents are never explicitly purged from the target search engine.
- **Accumulation of Broken Search Hits**: These deleted pages become permanent "orphaned" or "ghost" records in search indices. When users click on these orphaned search result cards, they are navigated to HTTP 404 pages. The only way to eliminate orphaned records in standard Backstage deployments is to execute a manual, destructive full-index wipe and rebuild—an operational task that causes search downtime and heavy infrastructure load.

---

# Part 2: Value Proposition & Technical Mechanics of Hybrid Search (Conceptual Analysis)

---

## Section 1: Federated Multi-Engine Search Routing & Engine Specialization

The core architectural solution to the limitations of standard Backstage search is **Federated Multi-Engine Routing**. Rather than forcing all portal document categories into a single, uniform search datastore, the Hybrid Search Architecture introduces a dynamic query orchestrator (`HybridSearchEngine`) that intercepts incoming search requests, evaluates document category filters, dispatches queries to domain-specialized sub-engines, and consolidates the results into a unified response.

### 1. The Principle of Categorical Query Routing

In a developer portal, incoming search queries convey explicit or implicit intent through document category filters (represented by the `types` query parameter in the Backstage search contract, such as `types[]=software-catalog` or `types[]=techdocs`).

The Hybrid Search Router operates a categorical routing matrix configured via application settings (`routing` map):

- **Targeted Single-Engine Routing**: When an incoming request contains a `types` array matching a single designated backend engine (e.g., `types: ['software-catalog']` mapped to Typesense), the router skips multi-engine federation. It forwards the request directly to the target sub-engine, preserving native engine features such as deep cursor-based pagination and specialized field filtering.
- **Federated Parallel Multi-Engine Routing**: When a search query specifies multiple category types (e.g., `types: ['software-catalog', 'techdocs']`) or omits the `types` parameter altogether (representing a global, portal-wide search query), the router broadcasts the query across all relevant sub-engines in parallel.

> [!NOTE] > **First-Principles Concept — Federated Routing**:
> Federated routing is a software architecture pattern where a top-level gateway or orchestrator delegates execution to specialized, autonomous downstream services rather than executing queries against a single monolithic datastore. The client interacts with a single unified interface, while the backend orchestrator handles query fan-out, backend translation, and result aggregation.

### 2. Engine Specialization Rationale

A fundamental premise of the Hybrid Search Workspace is that different developer portal assets possess radically different structural characteristics, query patterns, and discovery requirements.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Domain Engine Specialization Matrix                              │
├───────────────────────────────────────┬─────────────────────────────────────────────────────┤
│     Structured Catalog Entities       │             │  Unstructured Technical Documentation │
├───────────────────────────────────────┼─────────────────────────────────────────────────────┤
│ • Compact JSON Key-Value Schemas      │             │ • Long-Form Markdown Prose & Guides   │
│ • Exact Keyword & Prefix Matching     │             │ • Conceptual & Natural Language Intent│
│ • Low-Latency Faceted Filtering       │             │ • Semantic Embeddings & Neural Vector │
├───────────────────────────────────────┼─────────────────────────────────────────────────────┤
│    Typesense Search Engine            │             │  Google Cloud Vertex AI Search        │
│    (C++ In-Memory / Low-Latency)      │             │  (Discovery Engine / Vector LLM)      │
└───────────────────────────────────────┴─────────────────────────────────────────────────────┘
```

#### A. Typesense for Structured Catalog Entities

- **Data Characteristics**: The Backstage Software Catalog consists of highly structured microservice metadata: component names, team ownership, lifecycle states, system domains, and technical tags. These documents are short, field-centric JSON structures.
- **Query Patterns**: Developers searching the catalog typically expect exact string matching, prefix autocompletion (e.g., typing `auth-serv` to find `auth-service`), and strict key-value filtering (e.g., filtering for `kind: Component` and `spec.lifecycle: production`).
- **Engine Selection Mechanics**: Typesense is a lightweight, open-source C++ search engine optimized for fast in-memory indexing, typotolerant keyword lookups, and sub-10 millisecond response times. It excels at exact token matching and metadata filtering without the memory overhead of enterprise JVM search engines or the semantic ambiguity of vector models.

#### B. Google Cloud Vertex AI Search for Semantic Technical Documentation

- **Data Characteristics**: Technical documentation (TechDocs) consists of long-form, multi-paragraph markdown prose, architectural decision records (ADRs), installation guides, and API tutorials.
- **Query Patterns**: Developers searching documentation often formulate natural language questions (e.g., "how do I configure OAuth2 token refresh?") or use conceptual terminology that differs from the exact words written by the documentation author (vocabulary mismatch).
- **Engine Selection Mechanics**: Google Cloud Vertex AI Search (Discovery Engine) leverages advanced Google Large Language Models (LLMs) and neural vector embeddings to perform semantic search. It understands conceptual context beyond raw keyword matching, automatically generates extractive answers and snippets from prose text, and tolerates natural language variation across long-form documents.

### 3. Federated Query Dispatch Workflow & Decision Architecture

The following diagram illustrates how the `HybridSearchEngine` intercepts incoming HTTP queries, evaluates request parameters against the routing matrix, executes parallel or targeted dispatch, and returns consolidated results:

```mermaid
flowchart TD
    Client([Backstage Client / UI]) -->|"GET /api/search/query?term=auth&types[]=..."| Router[Search Backend Plugin]
    Router -->|SearchQuery| HybridEngine[Hybrid Search Engine Router]

    HybridEngine --> CategoryCheck{Evaluate Request 'types'}

    CategoryCheck -->|"Single Type (e.g., software-catalog)"| SinglePath[Targeted Single-Engine Dispatch]
    SinglePath -->|Direct Query| TypesenseEngine[Typesense Sub-Engine]
    TypesenseEngine -->|Native Results + Cursor| Client

    CategoryCheck -->|"Multiple Types OR Empty [] (Global Search)"| FederatedPath[Federated Multi-Engine Fan-Out]

    FederatedPath -->|Parallel Promise.allSettled| EngA[Typesense Sub-Engine\n(Catalog Entities)]
    FederatedPath -->|Parallel Promise.allSettled| EngB[Vertex AI Search Sub-Engine\n(TechDocs Prose)]

    EngA -->|Catalog Hits| Aggregator[Result Merging & Score Aggregator]
    EngB -->|TechDocs Hits| Aggregator

    Aggregator -->|Apply Strategy: interleave OR score-normalized-sort| Consolidated[Consolidated Result Array]
    Consolidated -->|Slice to Page Limit & Omit Cursor| Router
    Router -->|JSON SearchResultResponse| Client
```

---

## Section 2: Fault Isolation & Parallel Execution Mechanics

In a federated multi-engine architecture, querying downstream search backends over network links introduces risk: a single slow remote service or network failure could block or crash the entire search experience. The Hybrid Search Workspace addresses this risk through **Parallel Execution** and **Fault Isolation**.

### 1. Asynchronous Parallel Dispatch (`Promise.allSettled`)

When a global search query requires querying multiple search backends, executing requests sequentially (awaiting Engine A, then awaiting Engine B) would result in additive latency ($T_{\text{total}} = T_A + T_B$). To maximize responsiveness, the hybrid router dispatches queries concurrently across all mapped sub-engines. Total execution time is bounded by the slowest responding sub-engine ($\max(T_A, T_B)$) rather than the sum of latencies.

Crucially, the router manages concurrent sub-engine dispatches using a resilient aggregation pattern (`Promise.allSettled`) rather than a strict fail-fast pattern (`Promise.all`):

- **Fail-Fast Pattern (`Promise.all`)**: If any single sub-engine fails (e.g., due to a temporary network timeout or API rate limit), the entire promise rejects immediately. The portal search API responds with an HTTP 500 error, completely denying search results to the developer.
- **Resilient Aggregation Pattern (`Promise.allSettled`)**: The router collects the settlement state (either fulfilled with data or rejected with an error) of each sub-engine independently. If one backend fails, the router captures and logs the error, suppresses the isolated failure, and continues processing the fulfilled responses from the remaining backends.

> [!TIP] > **Operational Resiliency Impact**:
> If Google Cloud Vertex AI Search experiences an API interruption or quota restriction, a global search query will still succeed and immediately return catalog entity matches from Typesense. The developer receives partial, relevant results rather than an error page, ensuring high system availability.

### 2. Sub-Engine Timeout Isolation & Latency Budgeting

To prevent a degraded or unresponsive sub-engine from hanging the user's search request, the hybrid router enforces individual timeout isolation circuit breakers around every sub-engine invocation.

1. **Latency Budget Assignment**: Each sub-engine call is allocated a strict maximum response deadline (e.g., 2000 milliseconds).
2. **Abortion Signal**: If a sub-engine does not fulfill its request within the allocated deadline, the router cancels the pending request context locally and marks that specific engine's promise as rejected due to timeout.
3. **Blast Radius Minimization**: Fast local or in-cluster engines (such as a local Typesense cluster responding in 5ms) are completely shielded from latency spikes occurring in remote cloud APIs across WAN links. The user receives fast results from healthy engines without waiting for stalled backends.

---

## Section 3: Result Aggregation & Score Merging Mechanics

When a federated search query returns separate match arrays from multiple sub-engines, the hybrid router must consolidate these distinct payloads into a single, ordered result list for rendering in the developer portal interface.

### 1. The Heterogeneous Result Consolidation Problem

Directly merging results from heterogeneous search engines presents a fundamental scoring challenge: **incommensurate scoring scales**.

- **Typesense** computes keyword relevance scores using integer-based BM25/frequency metrics that often range from tens to hundreds (e.g., scores of `150` to `850`).
- **Vertex AI Search** evaluates semantic vector similarity using normalized probabilistic floats bounded between `0.0` and `1.0` (or returns raw extractive rank orderings without explicit numerical scores).

If a router simply concatenated raw results and sorted by raw score, Typesense hits would perpetually overwhelm Vertex AI Search hits, permanently burying documentation search results regardless of their actual relevance. To resolve this, the Hybrid Search Workspace provides two configurable result merging strategies.

### 2. Merging Strategy 1: Round-Robin Interleaving (`interleave`)

Round-Robin Interleaving is the default merging strategy (`mergeStrategy: interleave`). It consolidates result lists by sequentially selecting items from each sub-engine array in alternating order (e.g., Position 0: Engine A Item 0; Position 1: Engine B Item 0; Position 2: Engine A Item 1; Position 3: Engine B Item 1, and so on).

- **Mechanics**: The router maintains cursor pointers across each engine's returned result set, popping items in round-robin sequence until the global page limit is satisfied or all result sets are exhausted.
- **Architectural Rationale**: Interleaving is engine-agnostic and ignores underlying numerical scores entirely. It guarantees equal visual representation on Page 1 of search results for both catalog entities and documentation pages.
- **Primary Use Case**: Ideal for general portal search where operators want to ensure developers see a balanced cross-section of software catalog items and technical documentation cards without relying on cross-engine mathematical score comparison.

### 3. Merging Strategy 2: Relative Max-Score Normalization (`score-normalized-sort`)

Relative Max-Score Normalization (`mergeStrategy: score-normalized-sort`) standardizes scores across disparate search backends by calculating each document's relative relevance against the highest-scoring document returned by that specific engine in the current query batch.

#### Dual-Mode Score Normalization Equation

$$\text{score}_{\text{normalized}} = \begin{cases} \frac{\text{raw\_score}}{\text{max\_score}} & \text{if raw\_score exists} \\ 1.0 - \frac{\text{index}}{\text{total\_items}} & \text{if raw\_score is undefined/null} \end{cases}$$

#### Breakdown of Dual-Mode Mechanics:

1. **Scored Engines (Ratio Scaling)**: For sub-engines that provide explicit numerical relevance scores (such as Typesense or scored vector engines), the document's raw score ($\text{raw\_score}$) is divided by the maximum raw score ($\text{max\_score}$) present in that sub-engine's response set. The top hit for each engine receives a normalized score of $1.0$, while subsequent hits scale proportionally within the range $[0.0, 1.0]$.
2. **Unscored / Rank-Only Engines (Rank Fallback Scaling)**: Certain cloud search endpoints or blended Search Apps return ordered document lists without exposing raw numerical scores ($\text{raw\_score}$ is `undefined` or `null`). For these responses, a synthetic normalized score is generated based on the document's zero-based array position ($\text{index}$) relative to the total number of items returned ($\text{total\_items}$). The first document ($\text{index} = 0$) receives $1.0$, and subsequent documents decay linearly toward $0.0$.
3. **Consolidated Sorting**: Once all documents from all sub-engines have received a normalized score in the unified range $[0.0, 1.0]$, the router merges all documents into a single array and executes a global descending sort based on $\text{score}_{\text{normalized}}$.

> [!IMPORTANT] > **Value Proposition — Score Normalization**:
> Relative max-score normalization allows a highly confident documentation match from Vertex AI Search (ratio near 1.0) to rank above a low-confidence catalog entity match from Typesense (ratio near 0.2), achieving true relevance-based ranking across independent datastores.

### 4. Pagination Boundary Mechanics

Handling pagination in a search architecture requires distinguishing between single-engine targeted queries and multi-engine federated queries.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Pagination Routing Operational Modes                             │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Single-Engine Targeted Queries             │  Multi-Engine Federated Queries               │
│  (Scoped Tab Browsing)                      │  (Global Multi-Category Search)               │
├─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│  • Router forwards client cursor & limit    │  • Fan-out fetches top N items per engine     │
│  • Sub-engine returns native pagination token│  • Results merged & array-sliced to limit     │
│  • Response includes native 'pageCursor'    │  • Response explicitly omits 'pageCursor'     │
│  • Full native deep pagination enabled      │  • Capped Page 1 global discovery pattern     │
└─────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

#### A. Single-Engine Direct Cursor Forwarding

When a search query targets a single sub-engine (e.g., a developer browsing the "Software Catalog" tab), the router forwards the request parameters (`pageCursor`, `pageLimit`) directly to that sub-engine. The sub-engine executes native offset or cursor-based pagination and returns its native pagination token. The router passes this token directly back to the client in the HTTP response (`pageCursor`), enabling **100% native, deep multi-page navigation**.

#### B. Multi-Engine Array Slicing & Cursor Omission

When a search query is federated across multiple engines in parallel (e.g., global portal search), each sub-engine independently returns its top `pageLimit` results. Heterogeneous pagination cursors (e.g., Typesense offset numbers vs. Vertex AI Search opaque page tokens) cannot be mathematically combined or offset-aligned once documents from different engines have been interleaved or sorted together.

To handle this cleanly:

1. **Result Slicing**: The router consolidates the merged and scored result array, cuts the array at the client's requested `pageLimit` (e.g., returning the top 20 items), and discards remaining items.
2. **Cursor Omission**: The router explicitly sets `pageCursor` to `undefined` in the HTTP response payload.
3. **UX Design Alignment**: This follows standard enterprise search patterns: global search delivers top-relevance blended hits on Page 1. To explore deeper pages of a specific category, developers click the dedicated category tab, which transitions the UI into targeted single-engine mode with full deep pagination.

---

## Section 4: Decoupled Asynchronous TechDocs Ingestion

As established in Part 1, standard Backstage TechDocs ingestion runs directly inside the Node.js backend process memory, causing severe V8 heap memory expansion, long garbage collection pauses, and event loop blocking during document parsing.

The Hybrid Search Workspace resolves these bottlenecks by introducing **Decoupled Asynchronous Ingestion**.

### 1. Shifting Ingestion Out of Node.js Runtime Memory

Decoupled ingestion decouples the compilation, parsing, and indexing of technical documentation from the Backstage application server:

- **Compilation Offload**: Site compilation (converting markdown files to static HTML and generating `search_index.json` manifests) is removed entirely from the Node.js backend runtime.
- **Event-Driven Notification**: Instead of periodic polling streams inside Node.js memory, document updates are published via cloud storage events and processed asynchronously by lightweight webhooks.

### 2. External CI/CD Build & GCS Cloud Storage Publishing

In the decoupled architecture, documentation publishing is integrated directly into software repository CI/CD pipelines (e.g., GitHub Actions, GitLab CI, Google Cloud Build):

1. **CI/CD Build**: When documentation is updated in Git, the repository's CI/CD pipeline invokes standard MkDocs/TechDocs CLI tools to compile markdown into static HTML assets and build the local `search_index.json` search manifest.
2. **GCS Upload**: The pipeline uploads the compiled site directory directly to a designated Google Cloud Storage (GCS) bucket under a structured object path:
   `docs/{namespace}/{kind}/{name}/search_index.json`
3. **Zero Node.js Overhead**: The Backstage Node.js server consumes zero CPU cycles and zero V8 heap memory during site compilation and storage upload.

### 3. Event-Driven Webhook Processing via Google Cloud Eventarc

Once the documentation files are published to GCS, event-driven ingestion synchronizes the search indices automatically:

```mermaid
sequenceDiagram
    autonumber
    participant CICD as External CI/CD Pipeline
    participant GCS as Google Cloud Storage Bucket
    participant EA as GCP Eventarc Trigger
    participant FWD as GKE Eventarc Forwarder Pod
    participant BS as Backstage Webhook (/api/events/gcs)
    participant Cat as Backstage Catalog Service
    participant VAI as Vertex AI Search (Discovery Engine)

    CICD->>GCS: Upload search_index.json (Generation N)
    Note over GCS: GCS emits object.v1.finalized event
    GCS-->>EA: Trigger Event (object finalize)
    EA->>FWD: Publish to Eventarc Pub/Sub Topic
    FWD->>BS: Private HTTP POST /api/events/gcs (Port 80 -> Port 7007)
    Note over BS: Webhook validates request & responds HTTP 200 OK

    Note over BS: Asynchronous Background Ingestion
    BS->>GCS: Download search_index.json (Gen N)
    BS->>Cat: Lookup Entity (owner, lifecycle, type, annotations, auth)
    Cat-->>BS: Return Entity Metadata
    BS->>BS: Enrich Documents & Compute MD5 IDs

    BS->>GCS: Download Previous search_index.json (Gen N-1)
    BS->>BS: Calculate Delta (Identify Deleted Pages)

    par Parallel Processing
        BS->>VAI: Upsert Enriched Active Documents (Gen N)
        BS->>VAI: Purge Stale Deleted Documents (Gen N-1 Delta)
    end
```

#### Step-by-Step Eventarc Ingestion Execution Flow:

1. **Storage Event Emission**: When `search_index.json` is created or updated in GCS, GCS automatically emits a `google.cloud.storage.object.v1.finalized` storage event containing the bucket name, object path, and GCS generation ID ($N$).
2. **Eventarc Routing**: Google Cloud Eventarc intercepts the storage event and routes it to the Backstage webhook endpoint mounted at `/api/events/gcs`.
3. **Asynchronous Non-Blocking Webhook**: The Backstage webhook receives the JSON event payload, validates request headers, acknowledges receipt immediately with HTTP 200/202 to Eventarc, and queues an asynchronous background task to execute index synchronization. User HTTP traffic on the portal backend is never blocked.

---

## Section 5: Catalog Metadata Enrichment & Delta Reconciliation

Receiving raw TechDocs manifests at a webhook endpoint provides an opportunity to enrich documents with portal context and eliminate orphaned search records.

### 1. Catalog Service Metadata & Authorization Enrichment

Raw `search_index.json` manifests generated by documentation builders contain basic document titles and body text, but lack enterprise context such as team ownership, component lifecycle, or authorization controls.

When the GCS Eventarc module receives a webhook notification for a documentation site (e.g., `docs/default/component/auth-service/search_index.json`), it queries the Backstage Catalog Service (`CatalogService`) to resolve the parent software entity (`Component:default/auth-service`). It then enriches every document object before ingestion:

- **Entity Metadata Enrichment**:
  - `spec.owner` $\rightarrow$ Document field `owner` (e.g., `team-security`)
  - `spec.lifecycle` $\rightarrow$ Document field `lifecycle` (e.g., `production`)
  - `spec.type` $\rightarrow$ Document field `componentType` (e.g., `service`)
  - `metadata.annotations` $\rightarrow$ Document field `annotations`
- **Authorization Reference Enrichment**:
  - Entity primary key $\rightarrow$ Document field `authorization.resourceRef` (e.g., `component:default/auth-service`)

> [!NOTE] > **Faceted Discovery & Security Value**:
> Enriching TechDocs documents with catalog metadata enables powerful faceted search on the frontend (e.g., filtering documentation queries by `owner: team-security` AND `lifecycle: production`). Attaching `authorization.resourceRef` provides the foundation for downstream role-based access control (RBAC) filtering on search results.

### 2. Deterministic Canonical Path Hashing (MD5 Document IDs)

To update search indices or perform targeted deletions, search engines require stable, deterministic document identifiers. Relying on arbitrary incremental IDs or volatile array indices leads to document duplication and index corruption.

The Hybrid Search Workspace generates stable document identifiers by computing MD5 hashes over canonicalized URI paths:

#### Canonical Path Construction Formula

$$\text{canonicalPath} = \text{`/docs/\${namespace.toLowerCase()}/\${kind.toLowerCase()}/\${name.toLowerCase()}/\${cleanLocation}`}$$

#### Deterministic Document ID Formula

$$\text{docId} = \text{md5}(\text{canonicalPath})$$

#### Key Mechanics of Path Hashing:

1. **Path Canonicalization**: All path components (`namespace`, `kind`, `name`) are explicitly converted to lowercase. Leading and trailing slashes are trimmed, and redundant filename suffixes (such as `index.html`) are stripped from `cleanLocation`.
2. **MD5 Hashing**: The canonicalized path string is hashed using the MD5 digest algorithm, producing a fixed 32-character hexadecimal string (e.g., `a1b2c3d4e5f60718293a4b5c6d7e8f90`).
3. **Idempotency Guarantee**: Re-indexing the same documentation page across multiple CI/CD runs produces the exact same `docId`. The search engine overwrites the existing document entry cleanly without duplicating records.

### 3. Differential Reconciliation & Throttled Deletion Mechanics

A major limitation of standard Backstage search identified in Part 1 is the accumulation of **orphaned records ("ghost results")**: deleted or renamed documentation pages remain in search indices indefinitely because standard pull indexers process data strictly as append/overwrite operations.

The GCS Eventarc module resolves this through **Differential Reconciliation**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Differential Reconciliation Set Arithmetic                        │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Current Version (GCS Generation N)           Previous Version (GCS Generation N-1)         │
│  [ Page A, Page B, Page C ]                   [ Page A, Page B, Page OLD ]                  │
│  Set_current = { md5(A), md5(B), md5(C) }     Set_previous = { md5(A), md5(B), md5(OLD) }   │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Set Arithmetic Operations:                                                                 │
│  • Active Upsert Set  = Set_current                 => { md5(A), md5(B), md5(C) }          │
│  • Deleted Purge Set  = Set_previous \ Set_current  => { md5(OLD) }                          │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Differential Reconciliation Algorithm:

1. **Generation $N$ Processing**: The background worker downloads the current `search_index.json` (GCS Generation $N$), enriches the active pages, computes their MD5 document IDs, and constructs the active set:
   $$Set_{\text{current}} = \{\text{docId}(p) \mid p \in D_{\text{current}}\}$$
2. **Generation $N-1$ Fetching**: The worker queries GCS object versioning history to download the immediately preceding version of `search_index.json` (GCS Generation $N-1$), extracts historical page paths, and constructs the historical set:
   $$Set_{\text{previous}} = \{\text{docId}(p) \mid p \in D_{\text{previous}}\}$$
3. **Delta Computation**: The worker performs set subtraction to identify pages that existed in Generation $N-1$ but no longer exist in Generation $N$:
   $$Set_{\text{deleted}} = Set_{\text{previous}} \setminus Set_{\text{current}}$$
4. **Active Document Ingestion**: The active documents ($Set_{\text{current}}$) are batch-ingested into the target search engine (e.g., Vertex AI Search) in concurrent inline import requests (`batchSize: 100`).
5. **Throttled Purge Execution**: The deleted document IDs ($Set_{\text{deleted}}$) are issued to the search engine as explicit deletion API requests. Deletion calls are regulated by a concurrency throttle (`maxConcurrency: 5`) to prevent rate-limit exhaustion on downstream cloud search APIs.

> [!IMPORTANT] > **Operational Value — Index Hygiene**:
> Differential reconciliation guarantees that deleted markdown files or renamed documentation sections are immediately purged from search indices upon CI/CD deployment, entirely eliminating 404 "ghost results" without requiring destructive full-index wipes.

---

# Part 3: System Architecture & Package Specifications (Conceptual Breakdown & Diagrams)

---

## Section 1: Package Architecture Breakdown & Core Extension Points

The Hybrid Search Workspace is architected as four modular, loosely coupled backend packages designed for Backstage's New Backend System (`@backstage/backend-plugin-api`). Each package encapsulates a distinct architectural responsibility within the query routing and document ingestion ecosystem.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Workspace Package Architecture Map                               │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Top-Level Query Router & Extension Point Registry                                          │
│  └─► @backstage-community/plugin-search-backend-module-hybrid                              │
│      ├── Primary Search Engine Interface (registers with standard search core)              │
│      └── Custom Extension Point (hybridSearchEngineRegistryExtensionPoint)                  │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Domain-Specialized Sub-Engine Modules                                                      │
│  ├── @backstage-community/plugin-search-backend-module-typesense                            │
│  │   └── Structured Catalog Metadata Engine (Wildcard Schemas, 100-Doc Buffer Streams)     │
│  └── @backstage-community/plugin-search-backend-module-vertexai                             │
│      └── Semantic Documentation Prose Engine (Discovery Engine API, Extractive Answers)     │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Event-Driven Asynchronous Ingestion Webhook Module                                         │
│  └─► @backstage-community/plugin-events-backend-module-gcs-eventarc                          │
│      └── Cloud Storage Ingress Webhook (/api/events/gcs, MD5 Reconciliation, DLQ Topics)    │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### 1. `@backstage-community/plugin-search-backend-module-hybrid` (Federated Query Router)

The `@backstage-community/plugin-search-backend-module-hybrid` package provides the top-level federated query router engine (`HybridSearchEngine`) and defines the dynamic extension point through which sub-engines register themselves.

#### Core Architectural Mechanics:

- **Dynamic Orchestrator**: Intercepts search queries from the primary search backend router, evaluates category mapping rules (`routing`), dispatches queries concurrently to registered sub-engines, and consolidates heterogeneous result sets into a single response.
- **Upstream vs. Custom Extension Point Resolution**:
  - `searchEngineRegistryExtensionPoint`: The standard upstream Backstage extension point provided by `@backstage/plugin-search-backend`. Under standard Backstage rules, this registry accepts exactly one search engine instance for the entire portal. The hybrid module registers `HybridSearchEngine` directly into `searchEngineRegistryExtensionPoint` as the single primary search engine.
  - `hybridSearchEngineRegistryExtensionPoint`: A custom, multi-engine extension point exposed by the hybrid search module itself. It acts as a secondary registry where domain-specialized sub-engine modules (such as Typesense, Vertex AI, or custom third-party backends) register their engine instances alongside the document types they support (`supportsTypes: ['software-catalog', ...]`).
- **Core Extension Point Comparison**:

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                       Search Engine Registry Extension Point Matrix                         │
├──────────────────────────────────────┬──────────────────────────────────────────────────────┤
│ `searchEngineRegistryExtensionPoint` │ `hybridSearchEngineRegistryExtensionPoint`           │
│ (Standard Upstream Backstage Core)   │ (Hybrid Search Workspace Extension Point)            │
├──────────────────────────────────────┼──────────────────────────────────────────────────────┤
│ • Accepts only 1 primary engine      │ • Accepts N specialized sub-engines                  │
│ • Throws fatal error on duplicates   │ • Dynamically aggregates sub-engine instances        │
│ • Monolithic query dispatch          │ • Categorical query routing & parallel fan-out       │
│ • System-wide uniform scoring        │ • Heterogeneous score normalization & interleaving   │
└──────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

---

### 2. `@backstage-community/plugin-search-backend-module-typesense` (Structured Catalog Engine)

The `@backstage-community/plugin-search-backend-module-typesense` package connects Backstage search to Typesense, an open-source, fast in-memory search engine optimized for low-latency keyword matching and metadata filtering.

#### Core Architectural Mechanics:

- **Multi-Collection Concurrent Execution**: When a search query targets multiple document collections managed by Typesense, the engine executes query requests against each Typesense collection concurrently using `Promise.all`, preventing sequential network roundtrips.
- **Memory-Buffered Writable Indexing Stream**: During document ingestion (e.g. indexing Software Catalog entities), incoming documents are pushed into an in-memory array buffer. When the buffer reaches **100 documents**, the engine flushes the entire batch to Typesense in a single bulk HTTP POST request using `action: 'upsert'`. A final stream flush ensures zero document loss upon job completion.
- **Auto-Provisioning Wildcard Schemas (`.*`)**: When an indexing job starts for document type `T`, the engine verifies if collection `backstage_${T}` exists. If missing (404), the engine creates the collection automatically using a regex wildcard field rule (`{ "name": ".*", "type": "auto" }`), allowing Typesense to dynamically analyze and index document fields on-the-fly without requiring pre-defined static schemas.
- **Raw Passthrough Configuration**: Supports unconstrained customization by passing raw parameters straight through to underlying libraries:
  - `clientOptions`: Forwarded directly to the `typesense` JS client constructor (e.g. `connectionTimeoutSeconds`, `numRetries`, `logLevel`).
  - `collections`: Allows defining custom static field schemas, including built-in vector search models (e.g. `ts/all-MiniLM-L6-v2` embeddings).
  - `searchOptions`: Merged directly into outgoing search API payloads (e.g. custom `query_by` weightings).

---

### 3. `@backstage-community/plugin-search-backend-module-vertexai` (Semantic Documentation Engine)

The `@backstage-community/plugin-search-backend-module-vertexai` package integrates Google Cloud Vertex AI Search (Discovery Engine API) into Backstage to power semantic vector search, natural language question answering, and automated snippet generation.

#### Core Architectural Mechanics:

- **Dual Ingestion Operational Modes**:
  - _Direct Local Indexing (`indexing.enabled: true`)_: Standard Backstage collator streams build HTML and push document batches directly to the Discovery Engine API.
  - _Decoupled Eventarc Ingestion (`indexing.enabled: false`)_: Bypasses local HTML compilation on the Node.js server using throwaway no-op streams, relying instead on GCS storage events and Eventarc webhooks.
- **4-Tier Extractive Content Priority Hierarchy**: When converting raw Discovery Engine API response payloads into Backstage `SearchResult` objects, the engine maps content into the Backstage `text` field using a strict priority order:
  1. _Extractive Answers_ (Highest Priority): Direct sentences answering natural language queries (joined with spaces `' '`).
  2. _Extractive Segments_ (Medium Priority): Paragraph-level context blocks containing query terms (joined with newlines and ellipses `\n...\n`).
  3. _Snippets_ (Lowest Priority): Text fragments containing highlighted search terms.
  4. _Fallback Text_: Raw body text of the indexed document page.
- **Background Catalog Cleanup Sweeper**: In decoupled mode (`indexing.enabled: false`), standard collator deletion tasks are bypassed. The module runs a background sweeper task (default frequency: 2 hours, initial startup delay: 2 minutes) that scans GCS storage and Vertex AI Search datastores to identify and purge orphaned document assets whose parent catalog entities have been deleted from Backstage.

---

### 4. `@backstage-community/plugin-events-backend-module-gcs-eventarc` (Decoupled Webhook Ingress)

The `@backstage-community/plugin-events-backend-module-gcs-eventarc` package provides an event-driven webhook endpoint (`/api/events/gcs`) that listens for GCS storage events emitted via Google Cloud Eventarc when TechDocs static assets (`search_index.json`) are published by CI/CD pipelines.

#### Core Architectural Mechanics:

- **Non-Blocking Asynchronous Webhook Ingress**: The webhook endpoint receives incoming JSON event payloads (`google.cloud.storage.object.v1.finalized`), acknowledges receipt immediately to Eventarc with HTTP 200/202 OK, and dispatches a background task (`gcs-notifications`) to perform index sync asynchronously without delaying user HTTP threads.
- **Dual Security & Network Authentication Models**:
  - _Google OIDC Verification (Public / Cloud Run)_: Uses `google-auth-library` to verify cryptographically signed bearer tokens, enforcing issuer (`https://accounts.google.com`), audience (`${baseUrl}/api/events/gcs`), and expected service account email (`serviceAccountEmail`).
  - _GKE VPC Network Isolation (Private GKE)_: For private GKE deployments where cluster-local `gke-forwarder` pods deliver events over internal VPC port 80 without OIDC tokens, OIDC verification is set to `false`. Endpoint security is enforced entirely at the network layer using Ingress rules, Cloud Armor edge policies, Gateway API path rewrites, and Kubernetes `NetworkPolicies`.
- **Pub/Sub Dead-Letter Topic (DLQ) Fault Tolerance**: If webhook delivery fails repeatedly due to transient Backstage server downtime, Eventarc routes unacknowledged event messages to a configured Pub/Sub Dead-Letter Topic (DLQ) for inspection and manual replay.

---

## Section 2: Runtime Conflict Rules & Architectural Constraints

To guarantee system stability, prevent data corruption, and eliminate security vulnerabilities, the Hybrid Search Workspace enforces four strict runtime conflict rules and architectural constraints. Violating these constraints triggers immediate validation errors or fatal startup exceptions during backend initialization.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Runtime Conflict & Constraint Matrix                             │
├──────────────────────────────────────┬──────────────────────────────────────────────────────┤
│ Architectural Constraint             │ Failure Impact / Enforcement Action                   │
├──────────────────────────────────────┼──────────────────────────────────────────────────────┤
│ Mutually Exclusive Ingestion Pathways│ Fatal `BackendStartupError` on server initialization │
│ `blendedSearch` Configuration Scope  │ Validation Error (restricted to Standalone mode)     │
│ GKE Private VPC vs Cloud Run OIDC    │ Security Bypass or Webhook 401 Rejection             │
│ Catalog Forced-Indexing Guardrail    │ Automatic Config Override to `enabled: true` + Warning│
└──────────────────────────────────────┴──────────────────────────────────────────────────────┘
```

### 1. Mutually Exclusive Ingestion Pathways (Local Indexing vs. GCS Eventarc)

#### Architectural Constraint Rule:

Direct local TechDocs indexing (`search.engines.vertexai.types.techdocs.indexing.enabled: true` or global `indexing.enabled: true`) and the `@backstage-community/plugin-events-backend-module-gcs-eventarc` webhook module are **strictly mutually exclusive**.

#### Technical Rationale:

If direct local indexing and decoupled Eventarc webhooks were active simultaneously:

1. Standard Backstage scheduled collator tasks would attempt to build TechDocs HTML files locally on the Node.js server and stream document batches directly into Vertex AI Search.
2. Concurrently, CI/CD pipeline uploads to GCS would emit Eventarc storage events, triggering the webhook module to parse `search_index.json` and ingest documents into the exact same Vertex AI Search Datastore.
3. This dual-ingestion loop results in severe V8 heap memory expansion on the Node.js server, concurrent write race conditions, API rate limit exhaustion, duplicate document records, and broken delta reconciliation calculations.

#### System Enforcement:

During backend module initialization, the system checks whether both local TechDocs indexing and the GCS Eventarc webhook module are registered. If both are detected, backend startup halts immediately with a fatal `BackendStartupError`.

---

### 2. `blendedSearch` Configuration Scope (Standalone Mode Only)

#### Architectural Constraint Rule:

The `blendedSearch` configuration block (which specifies `projectId`, `location`, `engineId` for a global Google Cloud Search App) is **strictly restricted to Standalone Vertex AI Search Engine mode** (`search.engine: vertexai`).

#### Technical Rationale:

- In **Standalone Mode**, Vertex AI Search is responsible for executing all search queries across the entire developer portal. When a developer submits a global query without category filters, Vertex AI Search delegates query blending across multiple underlying GCP Data Stores to a single, unified Google Cloud Search App (`engineId`).
- In **Federated Hybrid Mode** (`search.engine: hybrid`), query federation across distinct sub-engines (e.g. routing `software-catalog` to Typesense and `techdocs` to Vertex AI) is managed directly by the Backstage `HybridSearchEngine` router.
- If `blendedSearch` were configured under Vertex AI in Hybrid mode, a global query would trigger a double-federation loop: the Backstage router would query Typesense while simultaneously querying Vertex AI's global blended app (which itself queries catalog data stores inside GCP). This results in duplicated catalog results, distorted score normalization algorithms, and broken single-engine category filtering.

#### System Enforcement:

During hybrid router startup, the module validates sub-engine configurations. If `blendedSearch` is present under `search.engines.vertexai` while running in Hybrid mode, the backend throws a validation error and aborts initialization.

---

### 3. Network & Security Constraints: GKE Private VPC vs. Cloud Run Public Routing

#### Architectural Constraint Rule:

Google OIDC ID token verification (`events.modules.gcsEventarcWebhook.oidc.enabled`) **must be set to `false`** when deploying on Google Kubernetes Engine (GKE) via internal VPC routing, but **must be set to `true`** when deploying on Google Cloud Run or public HTTPS endpoints.

#### Technical Rationale:

- **GKE Private VPC Architecture**: When Eventarc delivers events to a GKE Service destination, Eventarc automatically provisions a cluster-local **`gke-forwarder`** pod inside a managed namespace (e.g., `eventarc-xxxx`). This forwarder pod subscribes to a Pub/Sub topic and issues direct internal HTTP POST requests across the cluster network to the Backstage Service. Because this forwarder operates entirely within the private VPC and cannot generate Google OIDC tokens, enabling OIDC token verification on the webhook causes all incoming Eventarc requests to be rejected with HTTP 401 Unauthorized errors.
- **Port 80 Mapping Constraint**: GCP Eventarc's GKE destination spec hardcodes event delivery to TCP port `80` and does not accept custom target port configurations. Therefore, the Kubernetes `Service` manifest for Backstage in GKE must explicitly map Service port `80` to container port `7007`.
- **Cloud Run Public Architecture**: When Backstage is deployed on Cloud Run, the webhook endpoint is exposed to the public internet via HTTPS. Enabling OIDC verification is mandatory to ensure that only authorized Eventarc triggers carrying cryptographically signed Google ID tokens can invoke the webhook, preventing unauthenticated public index spoofing.

#### System Security Blueprint:

When OIDC verification is disabled for GKE internal VPC routing, network security MUST be enforced at the ingress layer using edge path blocking (NGINX `deny all`, Cloud Armor `403 Forbidden` edge rules, Gateway API `URLRewrite`), combined with a Kubernetes `NetworkPolicy` restricting port `80` access exclusively to Eventarc forwarder namespaces.

---

### 4. Software Catalog Forced-Indexing Guardrail

#### Architectural Constraint Rule:

In the `@backstage-community/plugin-search-backend-module-vertexai` package, indexing for the `software-catalog` document category is **mandatory** (`software-catalog` forced enabled).

#### Technical Rationale:

The Software Catalog represents the fundamental backbone of the Backstage developer portal. Disabling search indexing for catalog entities breaks core portal capabilities, including component discovery, ownership tracking, API lookup, and system mapping.

#### System Enforcement:

During module initialization, the Vertex AI engine inspects configuration settings. If an operator specifies `search.engines.vertexai.types.software-catalog.indexing.enabled: false`, the engine ignores the setting, automatically forces indexing to `enabled: true`, and emits an explicit warning log (`WARNING: software-catalog indexing cannot be disabled; overriding configuration to enabled: true`).

---

## Section 3: Deployment Topologies & Architecture Scenarios

The Hybrid Search Workspace supports three distinct deployment topologies designed for different operational requirements, infrastructure environments, and organizational scales.

### 1. Standalone Typesense Topology

In the Standalone Typesense Topology, standard Backstage core delegates all document indexing and query processing directly to a single Typesense cluster.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Standalone Typesense Deployment Topology                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [ Client UI ] ────► HTTP GET /api/search/query                                             │
│                           │                                                                 │
│                           ▼                                                                 │
│              ┌───────────────────────────┐                                                  │
│              │ Backstage Search Backend  │                                                  │
│              │ (Primary Engine: Typesense)│                                                 │
│              └─────────────┬─────────────┘                                                  │
│                            │                                                                │
│             ┌──────────────┴──────────────┐                                                 │
│             │ Direct REST API Calls       │                                                 │
│             ▼                             ▼                                                 │
│  ┌───────────────────────┐   ┌───────────────────────┐                                      │
│  │ Typesense Collection  │   │ Typesense Collection  │                                      │
│  │ backstage_software-...│   │ backstage_techdocs    │                                      │
│  └───────────────────────┘   └───────────────────────┘                                      │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Architectural Characteristics:

- **Primary Engine**: `TypesenseSearchEngine` registered directly into `searchEngineRegistryExtensionPoint`.
- **Ingestion Mechanics**: Standard pull-indexing streams (`CatalogCollator`, `TechDocsCollator`) run inside the Node.js backend memory, buffering documents into 100-item batches and upserting them into `backstage_${type}` collections using wildcard schemas (`.*`).
- **Query Mechanics**: Queries are executed directly against Typesense collections in parallel (`Promise.all`). Cursor-based deep pagination (`pageCursor`) is natively passed back to the UI.
- **Trade-offs**: Delivers ultra-low query latency (<10ms) and exact keyword matching, but subjects the Node.js process to V8 heap memory strain during large TechDocs indexing runs and lacks natural language semantic search capabilities.

---

### 2. Standalone Vertex AI Topology

In the Standalone Vertex AI Topology, standard Backstage core delegates all query processing to Google Cloud Vertex AI Search (Discovery Engine API), utilizing a global blended Search App for portal-wide queries.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Standalone Vertex AI Deployment Topology                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [ Client UI ] ────► HTTP GET /api/search/query                                             │
│                           │                                                                 │
│                           ▼                                                                 │
│              ┌───────────────────────────┐                                                  │
│              │ Backstage Search Backend  │                                                  │
│              │ (Primary Engine: VertexAI)│                                                  │
│              └─────────────┬─────────────┘                                                  │
│                            │                                                                │
│                            ▼                                                                │
│              ┌───────────────────────────┐                                                  │
│              │ Global Blended Search App │                                                  │
│              │ (engineId: backstage-app) │                                                  │
│              └─────────────┬─────────────┘                                                  │
│                            │                                                                │
│             ┌──────────────┴──────────────┐                                                 │
│             ▼                             ▼                                                 │
│  ┌───────────────────────┐   ┌───────────────────────┐                                      │
│  │ Vertex AI Data Store  │   │ Vertex AI Data Store  │                                      │
│  │ backstage-catalog     │   │ backstage-techdocs    │                                      │
│  └───────────────────────┘   └───────────────────────┘                                      │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Architectural Characteristics:

- **Primary Engine**: `VertexAISearchEngine` registered directly into `searchEngineRegistryExtensionPoint`.
- **Global Blended Search App**: Global queries without type filters target `blendedSearch` (`engineId`), delegating multi-datastore query blending and ranking directly to Google Cloud.
- **Ingestion Mechanics**: Supports either Direct Local Pull Indexing or Decoupled GCS Eventarc Ingestion for TechDocs.
- **Trade-offs**: Delivers enterprise-grade semantic search, generative natural language answers, and automated snippet extraction across all documents, but requires Google Cloud infrastructure and returns `null` relevance scores for global blended search hits.

---

### 3. Federated Hybrid Search Topology

The Federated Hybrid Search Topology combines specialized sub-engines under the `HybridSearchEngine` orchestrator, routing catalog metadata to Typesense and technical documentation prose to Vertex AI Search with decoupled GCS Eventarc ingestion.

```
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                            Federated Hybrid Search Deployment Topology                      │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [ Client UI ] ────► HTTP GET /api/search/query                                             │
│                           │                                                                 │
│                           ▼                                                                 │
│              ┌───────────────────────────┐                                                  │
│              │   Hybrid Search Router    │ (Primary Engine in searchEngineRegistry)          │
│              │   (HybridSearchEngine)    │                                                  │
│              └─────────────┬─────────────┘                                                  │
│                            │                                                                │
│             ┌──────────────┴──────────────┐ (Delegates via hybridSearchEngineRegistry)      │
│             │ Categorical Query Routing   │                                                 │
│             ▼                             ▼                                                 │
│  ┌───────────────────────┐   ┌───────────────────────┐                                      │
│  │ Typesense Sub-Engine  │   │ Vertex AI Sub-Engine  │                                      │
│  │ (software-catalog)    │   │ (techdocs)            │                                      │
│  └──────────┬────────────┘   └──────────┬────────────┘                                      │
│             │                           │                                                   │
│             ▼                           ▼                                                   │
│  ┌───────────────────────┐   ┌───────────────────────┐                                      │
│  │ Typesense Cluster     │   │ Discovery Engine API  │                                      │
│  │ (In-Memory Keywords)  │   │ (Semantic Vectors)    │                                      │
│  └───────────────────────┘   └──────────▲────────────┘                                      │
│                                         │ Decoupled Async Ingestion                         │
│                              ┌──────────┴────────────┐                                      │
│                              │ GCS Eventarc Webhook  │                                      │
│                              │ (/api/events/gcs)     │                                      │
│                              └───────────────────────┘                                      │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

#### Architectural Characteristics:

- **Orchestration Layer**: `HybridSearchEngine` registered as primary engine, hosting specialized sub-engines via `hybridSearchEngineRegistryExtensionPoint`.
- **Domain Engine Specialization**:
  - `software-catalog` $\rightarrow$ Typesense Sub-Engine (low-latency exact keyword lookups, prefix autocompletion, metadata filtering).
  - `techdocs` $\rightarrow$ Vertex AI Sub-Engine (decoupled GCS Eventarc ingestion, vector embeddings, extractive answers).
- **Execution & Consolidation**: Targeted single-engine dispatch for category tabs (with full native pagination), parallel `Promise.allSettled` fan-out for global queries (with `interleave` or `score-normalized-sort` merging and single-page slicing).
- **Ingestion & Process Isolation**: Software catalog indexed via lightweight pull streams into Typesense. TechDocs compiled in CI/CD, published to GCS, and ingested via Eventarc webhooks with MD5 delta reconciliation, completely offloading prose compilation and parsing from the Node.js backend memory.

---

## Section 4: Comprehensive Architecture Sequence Flow Diagrams

The following Mermaid sequence diagrams illustrate the runtime execution flows for query dispatch, decoupled event-driven ingestion, and delta reconciliation.

### Diagram 1: Federated Query Dispatch & Result Merging Flow

This diagram details how an incoming search query is received by the `HybridSearchEngine`, evaluated for categorical routing, dispatched concurrently across sub-engines with timeout isolation, normalized, merged, and returned to the client.

```mermaid
sequenceDiagram
    autonumber
    actor User as Client / Search UI
    participant Router as Search Backend Router
    participant Hybrid as HybridSearchEngine Orchestrator
    participant TS as Typesense Sub-Engine
    participant VAI as Vertex AI Sub-Engine
    participant Merger as Result Score Merger

    User->>Router: GET /api/search/query?term=auth&types[]=software-catalog&types[]=techdocs
    Router->>Hybrid: query(SearchQuery { term: 'auth', types: ['software-catalog', 'techdocs'] })

    Note over Hybrid: Evaluate Request Document Types

    alt Single Type Mapped (Targeted Direct Dispatch)
        Hybrid->>TS: query(SearchQuery) [Targeted Engine]
        TS-->>Hybrid: Return Native Matches + pageCursor
        Hybrid-->>Router: Return SearchResultResponse (Native Cursor Preserved)
        Router-->>User: HTTP 200 OK (Full Native Pagination Enabled)
    else Multiple Types or Empty Types (Federated Multi-Engine Fan-Out)
        Note over Hybrid: Initiate Asynchronous Parallel Dispatch (Promise.allSettled)

        par Parallel Execution with Timeout Isolation
            Hybrid->>TS: query(SearchQuery) [Software Catalog]
            Note over TS: Fast In-Memory Search (BM25 Keywords)
            TS-->>Hybrid: Fulfilled: Catalog Matches (Raw Scores e.g. [450, 210])
        and
            Hybrid->>VAI: query(SearchQuery) [TechDocs Prose]
            Note over VAI: Vector Semantic Search & Extractive Answers
            VAI-->>Hybrid: Fulfilled: TechDocs Matches (Raw Scores e.g. [0.92, 0.78])
        end

        Note over Hybrid: Fault Isolation: Suppress Rejected Promises / Timeouts

        Hybrid->>Merger: merge(Results, strategy: 'score-normalized-sort')

        Note over Merger: Apply Dual-Mode Score Normalization<br/>Ratio: raw_score / max_score<br/>Rank Fallback: 1.0 - (index / total)
        Merger-->>Hybrid: Consolidated Ordered Result Array

        Note over Hybrid: Slice Array to pageLimit & Omit pageCursor (undefined)
        Hybrid-->>Router: Return SearchResultResponse (pageCursor: undefined)
        Router-->>User: HTTP 200 OK (Consolidated Blended Page 1 Results)
    end
```

---

### Diagram 2: Decoupled Eventarc Ingestion & Catalog Enrichment Flow

This diagram illustrates how a TechDocs documentation update published by CI/CD triggers a GCS storage event, passes through Eventarc routing, hits the private Backstage webhook endpoint, enriches documents with Catalog Service metadata, and ingests active documents into Vertex AI Search.

```mermaid
sequenceDiagram
    autonumber
    actor CICD as External CI/CD Pipeline
    participant GCS as GCS Storage Bucket
    participant Eventarc as GCP Eventarc Trigger
    participant FWD as GKE Eventarc Forwarder Pod
    participant Webhook as Webhook Endpoint (/api/events/gcs)
    participant EventBus as Internal Event Bus
    participant Catalog as Backstage Catalog Service
    participant VAI as Vertex AI Search API

    CICD->>GCS: Upload search_index.json (GCS Generation N)
    Note over GCS: GCS emits google.cloud.storage.object.v1.finalized event
    GCS-->>Eventarc: Trigger Storage Event (Bucket, Object Path, Gen N)
    Eventarc->>FWD: Publish to Managed Pub/Sub Topic

    Note over FWD: Forwarder Pod pulls from Pub/Sub
    FWD->>Webhook: Private HTTP POST /api/events/gcs (Port 80 -> Port 7007)

    Note over Webhook: Validate Request (Skip OIDC for GKE VPC)
    Webhook-->>FWD: Respond HTTP 200 OK (Non-Blocking Ingress)

    Webhook->>EventBus: Publish 'gcs-notifications' Event

    Note over EventBus: Asynchronous Background Ingestion Task Starts
    EventBus->>GCS: Download search_index.json (Generation N)
    GCS-->>EventBus: Return Raw Document Pages Array

    EventBus->>Catalog: Lookup Parent Entity (Component:default/auth-service)
    Catalog-->>EventBus: Return Catalog Entity Metadata (owner, lifecycle, type, annotations)

    Note over EventBus: Enrich Documents & Compute MD5 Document IDs<br/>canonicalPath = /docs/default/component/auth-service/index.html<br/>docId = md5(canonicalPath)

    EventBus->>VAI: Import Enriched Active Documents (batchSize: 100)
    VAI-->>EventBus: Acknowledge Active Document Ingestion
```

---

### Diagram 3: Delta Reconciliation & Throttled Document Deletion Flow

This diagram details the differential reconciliation algorithm executed during asynchronous background ingestion. The worker fetches historical GCS generation $N-1$, computes set differences against current generation $N$, and issues throttled API deletion calls to purge stale, deleted documentation pages.

```mermaid
sequenceDiagram
    autonumber
    participant Worker as Background Ingestion Worker
    participant GCS as GCS Object Versioning History
    participant Reconciler as Delta Set Reconciler
    participant VAI as Vertex AI Search API

    Note over Worker: Generation N Active Ingestion Complete
    Worker->>GCS: Query Historical Generation (Gen N-1) for search_index.json
    GCS-->>Worker: Return Generation N-1 Document Manifest

    Worker->>Reconciler: computeDelta(Gen_N_Docs, Gen_N-1_Docs)

    Note over Reconciler: Build Document ID Sets<br/>Set_current = { md5(p) for p in Gen_N }<br/>Set_previous = { md5(p) for p in Gen_N-1 }

    Note over Reconciler: Set Arithmetic Subtraction<br/>Set_deleted = Set_previous \ Set_current
    Reconciler-->>Worker: Return Set_deleted (IDs of Deleted / Renamed Pages)

    alt Set_deleted is Non-Empty
        Note over Worker: Initiate Throttled Document Purge (maxConcurrency: 5)

        loop For Each Batch of Deleted Document IDs
            Worker->>VAI: Delete Document Request (docId)
            VAI-->>Worker: HTTP 200 OK (Document Purged)
        end

        Note over Worker: Log Reconciliation Summary:<br/>Ingested N Active Docs, Purged M Stale Docs
    else Set_deleted is Empty
        Note over Worker: Zero Deleted Pages Detected; Reconciliation Complete
    end
```

---

# Part 4: Complete Operator & Implementation Manual (Low-Level Configuration & Code)

---

## Section 1: Backend Module Integration Code & Deployment Scenarios

This section provides complete TypeScript registration patterns for integrating the Hybrid Search Workspace packages into Backstage using the New Backend System (`@backstage/backend-plugin-api`).

### 1. Scenario A: Standalone Typesense Engine Registration

In a Standalone Typesense deployment, the Typesense search engine is registered directly as the primary search engine for the portal backend. It intercepts all incoming search queries and handles pull-indexing streams for catalog metadata and documentation.

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core portal plugins
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-techdocs-backend'));

// Register Typesense directly as the primary search engine (default export)
// This module binds Typesense to searchEngineRegistryExtensionPoint
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense'),
);

backend.start();
```

---

### 2. Scenario B: Standalone Vertex AI Engine Registration

In a Standalone Vertex AI deployment, Google Cloud Vertex AI Search serves as the primary search engine for all document categories across the portal, leveraging a global blended Search App for portal-wide homepage queries.

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// Core portal plugins
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-techdocs-backend'));

// Register Vertex AI Search directly as the primary search engine (default export)
// This module binds Vertex AI Search to searchEngineRegistryExtensionPoint
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

backend.start();
```

---

### 3. Scenario C: Federated Hybrid Search Topology Registration

In a Federated Hybrid Search deployment, the `HybridSearchEngine` router is registered as the primary search engine. Sub-engines (Typesense for structured catalog entities, Vertex AI Search for semantic TechDocs) are registered via the hybrid search extension point. Decoupled GCS Eventarc webhook ingress is enabled for event-driven TechDocs updates.

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

// 1. Core Backstage Backend Services
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-techdocs-backend'));
backend.add(import('@backstage/plugin-events-backend'));

// 2. Hybrid Search Router Orchestrator
// Binds HybridSearchEngine as the primary search engine in searchEngineRegistryExtensionPoint
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));

// 3. Typesense Sub-Engine Registration
// Binds TypesenseSearchEngine to hybridSearchEngineRegistryExtensionPoint
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense/hybrid'),
);

// 4. Vertex AI Search Sub-Engine Registration
// Binds VertexAISearchEngine to hybridSearchEngineRegistryExtensionPoint
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai/hybrid'),
);

// 5. Decoupled GCS Eventarc Webhook Ingress Module
// Binds /api/events/gcs endpoint to the events router for event-driven TechDocs ingestion
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

---

### 4. Custom Sub-Engine Registration Pattern

To integrate custom search backends (such as Elasticsearch, OpenSearch, or PostgreSQL) into the Hybrid Search Router, create a custom backend module that consumes `hybridSearchEngineRegistryExtensionPoint`:

```typescript
// packages/backend/src/modules/searchModuleCustomHybrid.ts
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';
import { CustomSearchEngine } from './CustomSearchEngine';

export const searchModuleCustomHybrid = createBackendModule({
  pluginId: 'search',
  moduleId: 'custom-hybrid-engine',
  register(env) {
    env.registerInit({
      deps: {
        hybridRegistry: hybridSearchEngineRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ hybridRegistry, config, logger }) {
        logger.info(
          'Initializing Custom Search Engine for Hybrid Search Router.',
        );

        const customEngine = new CustomSearchEngine({ logger, config });

        // Register custom engine with the hybrid registry
        hybridRegistry.registerEngine('custom-engine-name', customEngine, {
          supportsTypes: ['software-catalog', 'custom-type'],
        });
      },
    });
  },
});
```

---

## Section 2: Annotated Configuration Reference (`app-config.yaml`)

This section provides exhaustive, annotated YAML configuration references across all deployment scenarios.

### 1. Standalone Typesense Configuration

```yaml
search:
  engine: typesense
  engines:
    typesense:
      # API Key for Typesense cluster authentication
      apiKey: ${TYPESENSE_API_KEY}

      # Cluster nodes definition
      nodes:
        - host: ${TYPESENSE_HOST} # e.g. typesense.search.svc.cluster.local or localhost
          port: 8108
          protocol: http

      # Raw options passed directly to the Typesense JS client SDK
      clientOptions:
        connectionTimeoutSeconds: 5
        numRetries: 3
        logLevel: info

      # Dynamic schema provisioning & collection query configuration
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto' # Wildcard regex auto-schema creation on 404
            - name: embedding
              type: 'float[]'
              num_dim: 384
              embed:
                from:
                  - text
                model_config:
                  model_name: 'ts/all-MiniLM-L6-v2' # Optional built-in vector search model
          searchOptions:
            query_by: 'title,text,location,embedding'
        techdocs:
          fields:
            - name: '.*'
              type: 'auto'
          searchOptions:
            query_by: 'title,text,path'
```

---

### 2. Standalone Vertex AI Configuration

```yaml
search:
  engine: vertexai
  engines:
    vertexai:
      # MANDATORY for Standalone mode: Global blended Search App for portal-wide queries
      blendedSearch:
        projectId: company-portal-prod
        location: europe-west4
        engineId: backstage-global-search-app
        searchOptions:
          contentSearchSpec:
            extractiveContentSpec:
              maxExtractiveAnswerCount: 1
              maxExtractiveSegmentCount: 2

      # Enable direct local pull-indexing streams for catalog and techdocs
      indexing:
        enabled: true

      # Datastore & serving Engine mapping per document category
      types:
        techdocs:
          datastore:
            projectId: company-core-prod
            datastoreId: backstage-techdocs
            location: europe-west4
          engine:
            projectId: company-portal-prod
            engineId: backstage-techdocs-app
            location: europe-west4
        software-catalog:
          datastore:
            projectId: company-catalog-prod
            datastoreId: backstage-catalog
            location: europe-west4

      # Catalog cleanup task (automatically disabled if indexing.enabled is true)
      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }

techdocs:
  publisher:
    googleGcs:
      bucketName: company-backstage-techdocs-prod
```

---

### 3. Federated Hybrid Search Configuration

```yaml
search:
  engine: hybrid
  engines:
    hybrid:
      # Merging strategy: 'interleave' (round-robin) or 'score-normalized-sort' (ratio & rank scaling)
      mergeStrategy: score-normalized-sort

      # Category routing mapping document types to sub-engine identifiers
      routing:
        software-catalog: typesense
        techdocs: vertexai
        default: typesense # Fallback engine for unmapped categories

    # Typesense sub-engine configuration
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: typesense-service.search.svc.cluster.local
          port: 8108
          protocol: http
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
          searchOptions:
            query_by: 'title,text,location'

    # Vertex AI sub-engine configuration
    # FORBIDDEN: Do NOT include 'blendedSearch' here! In hybrid mode, query blending is managed by the Hybrid Search Router.
    vertexai:
      types:
        techdocs:
          datastore:
            projectId: company-core-prod
            datastoreId: backstage-techdocs
            location: europe-west4
          engine:
            projectId: company-portal-prod
            engineId: backstage-techdocs-app
            location: europe-west4
          # Disable local TechDocs indexing (handled via GCS Eventarc webhook)
          indexing:
            enabled: false

      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }

# Decoupled GCS Eventarc Webhook Ingress Parameters
events:
  modules:
    gcsEventarcWebhook:
      oidc:
        enabled: false # MUST be false for private GKE internal VPC routing; true for public Cloud Run
        audience: https://portal.company.com/api/events/gcs
        serviceAccountEmail: eventarc-trigger-sa@company-portal-prod.iam.gserviceaccount.com
      maxConcurrency: 5 # Max parallel deletion / import worker tasks
      payloadSizeLimit: '100kb'
      batchSize: 100 # Documents per inline import batch to Vertex AI Search

techdocs:
  publisher:
    googleGcs:
      bucketName: company-backstage-techdocs-prod
```

> [!WARNING] > **Forbidden `blendedSearch` Guardrail in Hybrid Mode**:
> In a Federated Hybrid Search deployment (`search.engine: hybrid`), configuring a `blendedSearch` block under `search.engines.vertexai` is strictly forbidden. The `VertexAISearchEngine` detects this conflict during backend initialization and throws a fatal `ConfigurationError`, preventing server startup. Global query blending in hybrid mode must be managed exclusively by the `HybridSearchEngine` orchestrator.

---

## Section 3: Kubernetes Service & Network Port Mapping

When GKE Eventarc triggers are configured with a GKE Service destination, Google's Eventarc agent deploys an internal `gke-forwarder` pod that routes events to Service Port `80`. The Backstage backend container runs on Port `7007`.

To support both internal Eventarc traffic and standard developer HTTP traffic, the Kubernetes `Service` manifest exposes dual ports:

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backstage
  namespace: backstage
  labels:
    app.kubernetes.io/name: backstage
    app.kubernetes.io/component: backend
spec:
  type: ClusterIP
  selector:
    app: backstage
  ports:
    - name: http
      port: 7007
      targetPort: 7007
      protocol: TCP
    - name: eventarc # Mandated port 80 target for GKE Eventarc Forwarder pods
      port: 80
      targetPort: 7007
      protocol: TCP
```

> [!IMPORTANT] > **The Port 80 Constraint**:
> GKE Eventarc trigger routing hardcodes event delivery to Port `80` on target GKE services. Mapping Service Port `80` to Container Port `7007` allows the internal Eventarc forwarder to deliver `/api/events/gcs` POST requests directly to the Backstage container without modifying application port bindings.

---

## Section 4: GCP IAM Roles Matrix

The following matrix defines the exact GCP IAM roles required across the four service account personas operating in the Hybrid Search Workspace:

| Service Account Persona                                                                              | Target GCP Resource            | Required GCP IAM Role                        | Operational Justification & Technical Necessity                                                                                                                                                                |
| :--------------------------------------------------------------------------------------------------- | :----------------------------- | :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1. Backstage Backend SA**<br/>`backstage-backend-sa@<project>.iam.gserviceaccount.com`             | GCP Project / Discovery Engine | `roles/discoveryengine.admin`                | Full administrative control required to execute document imports, schema updates, and document purge/delete calls via the Discovery Engine API. _(Note: Lower viewer/editor roles lack deletion permissions)._ |
|                                                                                                      | TechDocs GCS Bucket            | `roles/storage.objectAdmin`                  | Required to read `search_index.json` files, inspect generation metadata, and scan/delete orphaned documentation folders during catalog cleanup sweeps.                                                         |
| **2. Eventarc Trigger SA**<br/>`eventarc-trigger-sa@<project>.iam.gserviceaccount.com`               | Eventarc Trigger Resource      | `roles/eventarc.eventReceiver`               | Permits the trigger service account to receive GCS `object.v1.finalized` storage events from Cloud Pub/Sub.                                                                                                    |
|                                                                                                      | Destination Cloud Run Service  | `roles/run.invoker`                          | _(Cloud Run deployments only)_ Grants permission to invoke the private Backstage Cloud Run HTTPS endpoint with OIDC tokens.                                                                                    |
| **3. GCS Service Agent**<br/>`service-<project-number>@gs-project-accounts.iam.gserviceaccount.com`  | GCP Project / Pub/Sub Topics   | `roles/pubsub.publisher`                     | Enables the automated GCS system agent to publish object finalize notifications to Eventarc's Google-managed Pub/Sub topics.                                                                                   |
| **4. Eventarc Service Agent**<br/>`service-<project-number>@gcp-sa-eventarc.iam.gserviceaccount.com` | GCP Project                    | `roles/compute.viewer`                       | Allows the Eventarc system agent to query cluster VPC network details for GKE trigger destination setup.                                                                                                       |
|                                                                                                      | GKE Cluster                    | `roles/container.developer`                  | Grants permission to automatically provision and manage `gke-forwarder` pods inside dedicated `eventarc-*` namespaces.                                                                                         |
|                                                                                                      | Eventarc Trigger SA            | `roles/iam.serviceAccountAdmin`              | Permits the Eventarc system agent to bind the Trigger Service Account identity to managed `gke-forwarder` pods.                                                                                                |
|                                                                                                      | Cloud KMS Key                  | `roles/cloudkms.cryptoKeyEncrypterDecrypter` | _(CMEK deployments only)_ Allows Eventarc to encrypt/decrypt Pub/Sub topic channels using Customer-Managed Keys.                                                                                               |

---

## Section 5: GCP Infrastructure Provisioning (Terraform)

This section provides complete, production-grade Terraform HCL manifests to provision all GCP infrastructure components required by the Hybrid Search Workspace.

```hcl
# main.tf - Hybrid Search GCP Infrastructure Provisioning

terraform {
  required_version = ">= 1.5.0"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 5.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 5.0"
    }
  }
}

variable "project_id" {
  type        = string
  description = "GCP Project ID"
}

variable "region" {
  type        = string
  default     = "europe-west4"
  description = "GCP Region for Discovery Engine and Storage"
}

variable "techdocs_bucket_name" {
  type        = string
  description = "Name of the TechDocs GCS storage bucket"
}

variable "gke_cluster_name" {
  type        = string
  default     = "backstage-production"
  description = "Name of the GKE Cluster hosting Backstage"
}

variable "gke_cluster_location" {
  type        = string
  default     = "europe-west4-a"
  description = "GKE Cluster location"
}

variable "kms_key_id" {
  type        = string
  default     = ""
  description = "Optional Customer-Managed KMS Key ID for CMEK encryption"
}

data "google_project" "project" {
  project_id = var.project_id
}

# ============================================================================
# 1. DISCOVERY ENGINE DATA STORES & SCHEMAS
# ============================================================================

locals {
  datastores = {
    techdocs = {
      display_name         = "Backstage TechDocs Store"
      create_dedicated_app = true
    }
    catalog = {
      display_name         = "Backstage Catalog Store"
      create_dedicated_app = false
    }
  }
}

resource "google_discovery_engine_data_store" "backstage" {
  for_each          = local.datastores
  project           = var.project_id
  location          = var.region
  data_store_id     = "backstage-${each.key}"
  display_name      = each.value.display_name
  industry_vertical = "GENERIC"
  content_config    = "NO_CONTENT"
  solution_types    = ["SOLUTION_TYPE_SEARCH"]
}

resource "google_discovery_engine_schema" "backstage_schema" {
  for_each      = local.datastores
  project       = var.project_id
  location      = google_discovery_engine_data_store.backstage[each.key].location
  data_store_id = google_discovery_engine_data_store.backstage[each.key].data_store_id
  schema_id     = "default_schema"

  json_schema = jsonencode({
    "$schema": "https://json-schema.org/draft/2020-12/schema",
    "type": "object",
    "dynamic": "true",
    "properties": {
      "title":         { "type": "string", "keyPropertyMapping": "title", "retrievable": true },
      "text":          { "type": "string", "keyPropertyMapping": "description", "retrievable": true },
      "kind":          { "type": "string", "indexable": true, "retrievable": true },
      "namespace":     { "type": "string", "indexable": true, "retrievable": true },
      "location":      { "type": "string", "indexable": true, "retrievable": true },
      "owner":         { "type": "string", "indexable": true, "retrievable": true },
      "lifecycle":     { "type": "string", "indexable": true, "retrievable": true },
      "componentType": { "type": "string", "indexable": true, "retrievable": true }
    }
  })
}

# ============================================================================
# 2. DEDICATED & BLENDED SEARCH APPS
# ============================================================================

resource "google_discovery_engine_app" "dedicated" {
  for_each          = { for k, v in local.datastores : k => v if lookup(v, "create_dedicated_app", false) }
  project           = var.project_id
  location          = var.region
  collection_id     = "default_collection"
  app_id            = "backstage-${each.key}-app"
  display_name      = "Backstage ${each.value.display_name} App"
  industry_vertical = "GENERIC"
  solution_type     = "SOLUTION_TYPE_SEARCH"
  data_store_ids    = [google_discovery_engine_data_store.backstage[each.key].data_store_id]
}

resource "google_discovery_engine_app" "global_blended" {
  project           = var.project_id
  location          = var.region
  collection_id     = "default_collection"
  app_id            = "backstage-global-search-app"
  display_name      = "Backstage Global Search App"
  industry_vertical = "GENERIC"
  solution_type     = "SOLUTION_TYPE_SEARCH"
  data_store_ids    = [for ds in google_discovery_engine_data_store.backstage : ds.data_store_id]
}

# ============================================================================
# 3. SERVICE ACCOUNTS & IAM BINDINGS
# ============================================================================

resource "google_service_account" "eventarc_trigger_sa" {
  project      = var.project_id
  account_id   = "backstage-eventarc-trigger-sa"
  display_name = "Backstage Eventarc Trigger Service Account"
}

resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gs-project-accounts.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "eventarc_agent_compute_viewer" {
  project = var.project_id
  role    = "roles/compute.viewer"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

resource "google_project_iam_member" "eventarc_agent_container_dev" {
  project = var.project_id
  role    = "roles/container.developer"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

resource "google_service_account_iam_member" "eventarc_agent_sa_admin" {
  service_account_id = google_service_account.eventarc_trigger_sa.name
  role               = "roles/iam.serviceAccountAdmin"
  member             = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

# ============================================================================
# 4. EVENTARC TRIGGERS (GKE Internal VPC vs Cloud Run)
# ============================================================================

# Option A: GKE Destination (Internal VPC Routing)
resource "google_eventarc_trigger" "gcs_to_backstage_gke" {
  name     = "gcs-to-backstage-gke"
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

  service_account = google_service_account.eventarc_trigger_sa.email
}

# ============================================================================
# 5. CUSTOMER-MANAGED ENCRYPTION KEYS (CMEK KMS Support)
# ============================================================================

resource "google_eventarc_google_channel_config" "cmek" {
  count           = var.kms_key_id != "" ? 1 : 0
  provider        = google-beta
  location        = var.region
  project         = var.project_id
  name            = "googleChannelConfig"
  crypto_key_name = var.kms_key_id
}

resource "google_kms_crypto_key_iam_member" "eventarc_kms" {
  count         = var.kms_key_id != "" ? 1 : 0
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}

# ============================================================================
# 6. PUB/SUB DEAD-LETTER TOPIC (DLQ)
# ============================================================================

resource "google_pubsub_topic" "eventarc_dlq" {
  name    = "gcs-eventarc-dlq"
  project = var.project_id
}

resource "google_pubsub_topic_iam_member" "pubsub_dlq_publisher" {
  project = var.project_id
  topic   = google_pubsub_topic.eventarc_dlq.name
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
```

#### Attaching DLQ Policy to Eventarc Subscription via CLI:

```bash
# 1. Retrieve the Pub/Sub subscription managed by Eventarc
SUBSCRIPTION_NAME=$(gcloud eventarc triggers describe gcs-to-backstage-gke \
  --location=europe-west4 \
  --format="value(transport.pubsub.subscription)")

# 2. Attach Dead-Letter Policy with 5 max delivery attempts
gcloud pubsub subscriptions update ${SUBSCRIPTION_NAME} \
  --dead-letter-topic=gcs-eventarc-dlq \
  --max-delivery-attempts=5
```

---

## Section 6: Network Security & Hardening Runbooks

Because Google OIDC verification must be disabled for GKE internal VPC Eventarc routing (`events.modules.gcsEventarcWebhook.oidc.enabled: false`), access to `/api/events/gcs` must be hardened at the network layer. This runbook provides a 4-layer defense-in-depth security model.

### 1. Layer 1: NGINX Ingress Path Blocking (`403 Forbidden`)

If using NGINX Ingress Controller, block external access to `/api/events/gcs` using a configuration snippet annotation:

```yaml
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backstage-ingress
  namespace: backstage
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      location /api/events/gcs {
        deny all;
        return 403;
      }
spec:
  ingressClassName: nginx
  rules:
    - host: portal.company.com
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: backstage
                port:
                  number: 7007
```

---

### 2. Layer 2: GKE Gateway API + Cloud Armor (`GCPBackendPolicy` Edge 403)

For GKE Gateway API deployments, drop malicious external requests at the Cloud Load Balancer edge before they reach the cluster.

```bash
# 1. Create Cloud Armor Policy
gcloud compute security-policies create backstage-armor-policy \
  --description="Block public webhook access to Eventarc endpoint"

# 2. Add rule denying access to /api/events/gcs
gcloud compute security-policies rules create 1000 \
  --security-policy=backstage-armor-policy \
  --expression="request.path.matches('/api/events/gcs')" \
  --action="deny-403"
```

Bind the policy to the Backstage Service using a `GCPBackendPolicy`:

```yaml
apiVersion: networking.gke.io/v1
kind: GCPBackendPolicy
metadata:
  name: backstage-security-policy
  namespace: backstage
spec:
  default:
    securityPolicy: backstage-armor-policy
  targetRef:
    group: ''
    kind: Service
    name: backstage
```

---

### 3. Layer 3: GKE Gateway API `URLRewrite` to 404

Use GKE Gateway `HTTPRoute` rules to rewrite incoming external `/api/events/gcs` paths to a non-existent URL, forcing Backstage to respond with `404 Not Found`:

```yaml
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backstage-route
  namespace: backstage
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: external-http-gateway
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
              replaceFullPath: /invalid-blocked-route
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

---

### 4. Layer 4: Kubernetes `NetworkPolicy` (Port 80 VPC Isolation)

Restrict Port `80` (the GKE Eventarc forwarder ingress port) so that only pods inside dynamic `eventarc-*` namespaces can initiate TCP connections to it:

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: restrict-webhook-to-eventarc-only
  namespace: backstage
spec:
  podSelector:
    matchLabels:
      app: backstage
  policyTypes:
    - Ingress
  ingress:
    # Allow Eventarc forwarder pods in eventarc-* namespaces to access Port 80
    - from:
        - namespaceSelector:
            matchExpressions:
              - key: kubernetes.io/metadata.name
                operator: In
                values: ['eventarc-*']
      ports:
        - protocol: TCP
          port: 80

    # Allow standard ingress controller traffic on Port 7007
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: ingress-nginx
      ports:
        - protocol: TCP
          port: 7007
```

---

## Section 7: Operations & Local Testing Guide

This section provides operational CLI guides for bulk-bootstrapping historical documentation and testing Eventarc webhooks locally.

### 1. Bulk-Bootstrapping Historical TechDocs (`bootstrap.ts`)

When migrating an existing Backstage portal to Vertex AI Search, historical TechDocs compiled in GCS must be imported into the Vertex AI Search Datastore. The `bootstrap.ts` CLI script handles extraction, enrichment, NDJSON formatting, and batch importing.

#### Prerequisites:

1. Authenticate ADC: `gcloud auth application-default login`
2. Provision a temporary GCS staging bucket: `gsutil mb gs://company-techdocs-staging-tmp`

#### Step 1: Execute `prepare-docs`

Scans the source TechDocs bucket, parses `search_index.json` manifests, queries the Backstage catalog API for component metadata, formats documents into Vertex AI structured JSON, and uploads `.ndjson` files to staging:

```bash
npx ts-node plugins/search-backend-module-vertexai/scripts/bootstrap.ts prepare-docs \
  --techdocsBucket company-backstage-techdocs-prod \
  --stagingBucket company-techdocs-staging-tmp \
  --backstageUrl http://localhost:7007
```

#### Step 2: Execute `import-docs`

Triggers batch import operations from the staging bucket into the Discovery Engine Datastore in chunks of 100 files:

```bash
npx ts-node plugins/search-backend-module-vertexai/scripts/bootstrap.ts import-docs \
  --projectId company-core-prod \
  --location europe-west4 \
  --datastoreId backstage-techdocs \
  --stagingBucket company-techdocs-staging-tmp
```

---

### 2. Local `curl` Eventarc Webhook Testing Workflow

Operators can test the GCS Eventarc webhook end-to-end on a local developer machine without cloud triggers or GKE clusters.

#### Step 1: Local Authentication & Configuration

1. Authenticate Application Default Credentials:

   ```bash
   gcloud auth application-default login
   ```

2. Disable OIDC verification in `app-config.local.yaml`:
   ```yaml
   events:
     modules:
       gcsEventarcWebhook:
         oidc:
           enabled: false
   ```

#### Step 2: Start Local Backstage Backend

```bash
yarn start
```

#### Step 3: Trigger Simulated Eventarc Notification via `curl`

Send a CloudEvents-formatted HTTP `POST` request simulating a GCS file upload:

```bash
curl -X POST http://localhost:7007/api/events/gcs \
  -H "Content-Type: application/json" \
  -H "ce-type: google.cloud.storage.object.v1.finalized" \
  -d '{
    "bucket": "company-backstage-techdocs-prod",
    "name": "default/component/auth-service/search_index.json",
    "generation": 100042
  }'
```

#### Step 4: Verify Console Logs

Verify that the local backend intercepts the event, downloads `search_index.json`, enriches documents via Catalog Service, ingests active pages, and executes delta reconciliation:

```text
[1] info: Starting search-index synchronization for: default/component/auth-service/search_index.json
[1] info: Ingesting 14 pages into dataStore: backstage-techdocs by spawning 1 import operations (concurrency limit: 5)...
[1] info: Waiting for all 1 import operations to complete in parallel...
[1] info: Bulk document ingestion completed.
[1] info: Successfully synchronized search index for Component:default/auth-service
[1] info: Reconciling generation 100042 against previous generation 100041...
[1] info: Delta reconciliation complete: 0 stale documents purged.
```
