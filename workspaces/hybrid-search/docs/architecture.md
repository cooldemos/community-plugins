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
│  Part 2: Value Proposition & Technical Mechanics               [Upcoming - Task 2]│
├───────────────────────────────────────────────────────────────────────────────────┤
│  Part 3: System Architecture & Package Specifications          [Upcoming - Task 3]│
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
