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

- **`@backstage-community/plugin-search-backend-module-hybrid`**: Top-level federated query router and extension point registry. Intercepts search requests, routes queries to mapped sub-engines based on document type, manages parallel fan-out, and normalizes result scores across heterogeneous engines.
- **`@backstage-community/plugin-search-backend-module-typesense`**: Search engine module backed by Typesense supporting keyword, metadata, and vector/semantic search. Optimized for fast token matching, prefix autocompletion, typotolerance, vector embeddings, and low-latency faceted filtering over structured Software Catalog entities.
- **`@backstage-community/plugin-search-backend-module-vertexai`**: Managed search engine module integrating Google Cloud Vertex AI Search to power semantic search, natural language queries, and extractive answers.
- **`@backstage-community/plugin-events-backend-module-gcs-eventarc`**: Event-driven asynchronous ingestion webhook module (`/api/events/gcs`). Receives Google Cloud Storage events via Eventarc when documentation assets are published by CI/CD pipelines, performing background index updates, catalog metadata enrichment, and differential reconciliation.

## Section 2: Federated Multi-Engine Search Routing

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

Querying multiple search backends in parallel introduces operational risks: slow network links can delay user responses, and individual backend failures can crash the search request. The hybrid router prevents this through two core mechanisms:

- **Parallel Execution**: Dispatches queries concurrently across sub-engines so overall latency is bounded by the slowest responding engine rather than the sum of all response times.
- **Fault Isolation**: Suppresses single-engine errors and enforces strict per-engine timeouts, ensuring that if one backend fails or responds slowly, the router still returns valid results from all healthy engines.

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

Pagination mechanics in the hybrid architecture depend on whether a query targets a single engine or federates across multiple backends:

- **Single-Engine Queries**: Triggered when a query specifies a single category in the query string (e.g., `types[]=software-catalog`). The router forwards pagination parameters (`pageCursor`, `pageLimit`) directly to the mapped search engine, returning its native pagination token (`pageCursor`) for full multi-page navigation.

- **Multi-Engine Queries**: Triggered when a query specifies multiple categories (e.g., `types[]=software-catalog&types[]=techdocs`) or omits `types` parameters entirely from the query string (global portal search). Because pagination tokens across heterogeneous engines cannot be aligned once results are merged or score-normalized, the router slices the consolidated result set to `pageLimit` and explicitly sets `pageCursor` to `undefined`. This delivers top-relevance blended results on Page 1 while delegating deep pagination to single-category scoped views.

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

# Option B: Cloud Run Destination (Public HTTPS Routing)
resource "google_eventarc_trigger" "gcs_to_backstage_cloudrun" {
  name     = "gcs-to-backstage-cloudrun"
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
    cloud_run_service {
      service = "backstage-backend"
      region  = var.region
      path    = "/api/events/gcs"
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
