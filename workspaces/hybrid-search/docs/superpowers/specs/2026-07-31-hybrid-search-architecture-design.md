# Design Specification: Master Architecture & Operator Guide (`docs/architecture.md`)

**Date**: 2026-07-31  
**Target File**: `workspaces/hybrid-search/docs/architecture.md`  
**Goal**: Completely rewrite `docs/architecture.md` from scratch to create an authoritative, comprehensive 4-part technical reference and operator manual for the Hybrid Search Workspace.

---

## Technical Tone & Style Guidelines

To ensure the resulting document provides maximum technical value, all sections must adhere strictly to these principles:

1. **Factual, Plain Language**: Zero sales or marketing language. Avoid terms like "seamless", "powerful", "game-changing", "revolutionary", or "state-of-the-art". State mechanisms, algorithms, behaviors, and trade-offs directly.
2. **Sufficiently Verbose Explanations**: Provide complete, detailed prose explaining _how_ and _why_ internal components operate. Avoid superficial high-level schematics or hand-waving bullet points that leave technical gaps.
3. **No Convoluted Expressions**: Use clear, direct sentences. Avoid unnecessary jargon, passive voice, or convoluted phrasing.
4. **Structural Split (Conceptual Core vs. Low-Level Operator Guide)**:
   - **Parts 1, 2, and 3 (Conceptual & Architectural Analysis)**: Must strictly favor high-level conceptual explanations, architectural mechanics, component roles, data flow, value propositions, and visual Mermaid diagrams. Avoid flooding prose with code snippets, line numbers, or raw implementation code.
   - **Part 4 (Operator & Implementation Manual)**: Contains all hands-on, low-level technical and operational details (TypeScript backend registration, full annotated `app-config.yaml`, Terraform HCL manifests, network security runbooks, Kubernetes Service mappings, and CLI testing commands) so operators can deploy and operate the solution.
5. **Leverage Installed Documentation Skill**: All section authoring must follow the principles of the installed `documentation` skill (`.agents/skills/documentation`): write directly for platform operators/architects, lead with high-value technical context, illustrate with diagrams and explicit configuration, link to reference materials without duplicating text, and structure architecture and runbook sections according to established documentation patterns.
6. **Fully Comprehensible for Non-Backstage Technical Audiences**: All explanations must build concepts from first principles so that technical readers (software engineers, system architects, DevOps leads) who have zero prior Backstage knowledge can fully understand _what_ each component is, _how_ the pipeline operates, and _why_ specific architectural decisions were taken. Avoid superficial or purely schematic summaries; provide complete, self-contained prose that bridges domain-specific Backstage concepts to general software engineering principles.

---

## Executive Summary

The **Hybrid Search Workspace** provides multi-engine search routing and asynchronous index ingestion for Backstage developer portals. This document specifies the design, architecture, technical depth, diagrams, and operational guides to be written in `docs/architecture.md`.

---

## Reference Source Materials

To ensure technical depth, architectural consistency, and factual accuracy, this specification and the resulting `docs/architecture.md` are grounded in the following reference sources:

1. **Workspace Package Documentation (`workspaces/hybrid-search`)**:

   - [Workspace Root README.md](../../README.md): Workspace architecture overview, deployment modes, and quickstart configuration.
   - [Plugins Overview README.md](../../plugins/README.md): Core architectural pillars, dynamic extension points, and module breakdown.
   - [Hybrid Router Module README.md](../../plugins/search-backend-module-hybrid/README.md): Federated routing algorithms, interleaving, max-score normalization, and pagination boundary mechanics.
   - [Typesense Module README.md](../../plugins/search-backend-module-typesense/README.md): Memory buffering (100 docs), auto-provisioning wildcard schemas, and client/query passthrough options.
   - [Vertex AI Module README.md](../../plugins/search-backend-module-vertexai/README.md): Discovery Engine API integration, extractive content priority hierarchy, blended search apps, and catalog cleanup sweeper.
   - [GCS Eventarc Webhook Module README.md](../../plugins/events-backend-module-gcs-eventarc/README.md): Webhook ingress `/api/events/gcs`, dual security models (Google OIDC vs. GKE VPC network policies), catalog enrichment, and MD5 delta reconciliation.

2. **Official Upstream Backstage Codebase (`backstage/backstage@v1.53.1`)**:
   - Cloned official repository location: `/usr/local/google/home/mirene/git/backstage-public`
   - `@backstage/plugin-search-backend`: Core backend search plugin (`plugins/search-backend/src/plugin.ts`).
   - `@backstage/plugin-search-backend-node`: Standard node search abstractions including `SearchEngine` interface (`types.ts`), `IndexBuilder` streaming builder (`IndexBuilder.ts`), and `Scheduler` task runner (`Scheduler.ts`).

---

## Document Structure & Outline

### Part 1: How Backstage Search Works (Conceptual & Architectural Analysis)

- **Backstage Search Core Architecture & Extension Points**:
  - Conceptual breakdown of core search abstractions in `@backstage/plugin-search-backend` and `@backstage/plugin-search-backend-node`:
    - `SearchEngine`: Interface defining query translation, indexer stream creation, and query execution.
    - `SearchEngineRegistry`: The backend extension point for registering search engines.
    - `IndexBuilder`: The central builder that registers collators and decorators to construct streaming indexing pipelines.
    - `Scheduler`: Background service scheduling ingestion tasks on defined cron intervals.
    - `Collators`: Readable stream factories (e.g. catalog and TechDocs collators) emitting indexable document streams.
- **Standard Query & Ingestion Execution Mechanics**:
  - Conceptual sequence flow of an incoming query (`GET /api/search/query`) delegated to `SearchEngine.query`.
  - Standard pull-indexing pipeline flow: `collator → decorators → indexer` transform streams executing inside the Node.js backend process memory.
- **Conceptual & Architectural Limitations of Standard Backstage Deployments**:
  1. _Single Search Engine Constraint in Backend Core_:
     - Standard Backstage core restricts registration to a single search engine instance and explicitly throws an error if multiple engines attempt to register. Core Backstage lacks native categorical routing to direct `software-catalog` queries to Engine A and `techdocs` queries to Engine B.
  2. _Single-Process Stream Bottlenecks & V8 Heap Memory Strain_:
     - Ingestion streams run synchronously inside the Node.js backend process memory. Parsing, compiling, and streaming thousands of TechDocs HTML pages in Node.js consumes heavy CPU and memory (V8 heap), causing event-loop lag for incoming HTTP requests on the portal backend.
  3. _Monolithic Query Translation & Uniform Relevance Scoring_:
     - Queries are handled by a single `SearchEngine` against one datastore or table schema. When querying across multiple categories (e.g. catalog entities and TechDocs prose), uniform query translation applies identical tokenization, ranking, and normalization rules to both structured metadata and unstructured prose documentation.
  4. _Scheduled Polling Delays & Lack of Delta Reconciliation_:
     - Ingestion relies strictly on timer-based polling (`Scheduler`). Document updates published in CI/CD pipelines must wait for the next scheduled cron poll. Pull streams emit current documents but do not calculate historical deltas against deleted pages, leaving orphaned documents in search indices unless manual full-reindexing or custom purge logic is implemented.

---

### Part 2: Value Proposition & Technical Mechanics of Hybrid Search (Conceptual Analysis)

- **Federated Multi-Engine Search Routing**:
  - Categorical query routing based on document `types`.
  - Engine specialization (e.g., Typesense for exact keyword lookups on catalog entities, Google Cloud Vertex AI Search for semantic vector lookups on TechDocs).
- **Fault Isolation & Parallel Execution**:
  - Asynchronous parallel dispatch using `Promise.allSettled`.
  - Individual engine timeout handling: latency or failure in one engine does not block responses from remaining engines.
- **Result Aggregation & Score Merging Mechanics**:
  - _Round-Robin Interleaving (`interleave`)_: Alternating document selection across sub-engine result lists to balance category visibility on page 1.
  - _Relative Max-Score Normalization (`score-normalized-sort`)_: Standardizing relevance scores across distinct search backends. Handled via a dual-mode calculation (ratio scaling for scored engines vs. rank-based fallback scaling for unscored engines such as blended Search Apps):
    $$score_{normalized} = \begin{cases} \frac{raw\_score}{max\_score} & \text{if } raw\_score \text{ exists} \\ 1.0 - \frac{index}{total\_items} & \text{if } raw\_score \text{ is undefined/null} \end{cases}$$
  - _Pagination Boundary Mechanics_: Direct cursor forwarding for single-engine queries vs. result array slicing and cursor omission for federated multi-engine queries.
- **Decoupled Asynchronous TechDocs Ingestion**:
  - Shifting TechDocs build and HTML parsing from the Node.js runtime to external CI/CD pipelines publishing to Google Cloud Storage (GCS).
  - Asynchronous event notifications using Google Cloud Eventarc.
- **Catalog Metadata Enrichment & Delta Reconciliation**:
  - Ingress webhook enriches raw TechDocs index manifests with live Catalog Service metadata (`owner`, `lifecycle`, `componentType`, `annotations`) and authorization fields (`authorization.resourceRef`).
  - Deterministic MD5 document identifier hashing computed from canonical lowercased URI paths:
    $$canonicalPath = \text{`/docs/\${namespace.toLowerCase()}/\${kind.toLowerCase()}/\${name.toLowerCase()}/\${cleanLocation}`}$$
    $$docId = \text{md5}(canonicalPath)$$
  - Differential reconciliation comparing GCS file generation `N` against historical generation `N-1`, identifying removed pages, and issuing throttled API deletion requests to the search engine.

---

### Part 3: System Architecture & Package Specifications (Conceptual Breakdown & Diagrams)

- **Package Architecture Breakdown**:
  1. `@backstage-community/plugin-search-backend-module-hybrid`:
     - Router engine implementation (`HybridSearchEngine`) and extension point (`hybridSearchEngineRegistryExtensionPoint`) for backend module registration.
  2. `@backstage-community/plugin-search-backend-module-typesense`:
     - Multi-collection concurrent execution, memory-buffered writable streams (batching at 100 documents), auto-provisioning wildcard schemas (`.*`), and raw client/query passthrough capabilities.
  3. `@backstage-community/plugin-search-backend-module-vertexai`:
     - Google Cloud Discovery Engine API integration, direct local indexing vs. decoupled Eventarc mode, 4-tier extractive content priority hierarchy (Answers > Segments > Snippets > Fallback Text), and background catalog cleanup sweeper.
  4. `@backstage-community/plugin-events-backend-module-gcs-eventarc`:
     - Webhook endpoint `/api/events/gcs`, dual security models (Google OIDC verification vs. GKE VPC network isolation), and Pub/Sub Dead-Letter Topic (DLQ) fault tolerance.
- **Runtime Conflict Rules & Architectural Constraints**:
  - _Mutually Exclusive Ingestion Pipelines_: Direct local TechDocs indexing (`indexing.enabled: true`) and GCS Eventarc webhook module are strictly mutually exclusive; concurrent activation triggers a fatal initialization startup error.
  - _`blendedSearch` Configuration Scope_: `blendedSearch` configuration is strictly restricted to Standalone mode; configuring it in Hybrid mode violates federated routing and triggers a validation error.
  - _GKE Private VPC vs. Cloud Run Security Constraints_: OIDC token verification is mandatory for public Cloud Run routes, but must be set to `false` for internal GKE VPC routing because GKE managed forwarder pods do not attach OIDC tokens over cluster-local port 80.
- **Deployment Topologies & Architecture Scenarios**:
  - _Standalone Engine Topologies_:
    1. _Standalone Typesense Engine Topology_: Core Backstage backend delegating all document indexing and search queries directly to a single Typesense cluster.
    2. _Standalone Vertex AI Engine Topology_: Core Backstage backend delegating search queries to Google Cloud Discovery Engine API (supporting direct pull indexing vs. decoupled GCS Eventarc ingestion, with native `blendedSearch` datastore aggregation).
  - _Federated Hybrid Search Topology_:
    - Top-level `HybridSearchEngine` router registered as the primary search engine, orchestrating categorical query routing, asynchronous parallel sub-engine dispatch (`Promise.allSettled`), result score merging (`interleave` vs `score-normalized-sort`), and decoupled event-driven ingestion across specialized sub-engines.
- **Architecture Sequence Diagrams (Mermaid)**:
  - Federated Query Dispatch & Result Merging.
  - Decoupled Eventarc Ingestion & Catalog Enrichment.
  - Delta Reconciliation & Throttled Document Deletion.

---

### Part 4: Complete Operator & Implementation Guide (Low-Level Configuration & Code)

- **Backend Module Integration & Deployment Scenarios**:
  - TypeScript code for registering packages in `packages/backend/src/index.ts` under Backstage's New Backend System across 3 distinct deployment scenarios:
    1. _Scenario A: Standalone Typesense Plugin_: Registering `@backstage-community/plugin-search-backend-module-typesense` as the primary single search engine.
    2. _Scenario B: Standalone Vertex AI Plugin_: Registering `@backstage-community/plugin-search-backend-module-vertexai` as the primary single search engine (with native `blendedSearch` support).
    3. _Scenario C: Federated Hybrid Search Topology_: Registering `@backstage-community/plugin-search-backend-module-hybrid` as the top-level router engine alongside registered sub-engine modules.
- **Annotated Configuration Reference (`app-config.yaml`)**:
  - Exhaustive, fully commented `app-config.yaml` reference divided by deployment scenarios:
    1. Standalone Typesense configuration (`search.engines.typesense`).
    2. Standalone Vertex AI configuration (`search.engines.vertexai` including `blendedSearch` datastores/apps).
    3. Federated Hybrid Search configuration (`search.engine: hybrid`, type routing maps, merge strategies `interleave` vs `score-normalized-sort`, sub-engine collections, and forbidden `blendedSearch` validation guardrails).
    4. Decoupled GCS Eventarc parameters (`events.modules.gcsEventarc`).
- **Kubernetes Service & Network Port Mapping**:
  - Kubernetes `Service` manifest explicitly mapping port `80` (GKE Eventarc Forwarder target) to container port `7007`.
- **Complete GCP IAM Roles Matrix**:
  - Table mapping service account personas (Backstage Backend SA, Eventarc Trigger SA, GCS Service Agent, Eventarc Service Agent) to exact required GCP IAM roles (`roles/discoveryengine.admin`, `roles/storage.objectAdmin`, `roles/eventarc.eventReceiver`, `roles/run.invoker`, `roles/pubsub.publisher`).
- **GCP Infrastructure Provisioning (Terraform)**:
  - Terraform manifests for Discovery Engine Data Stores and blended Search Apps.
  - Eventarc Trigger resources for GKE internal VPC routing and Cloud Run HTTPS routing.
  - Customer-Managed Encryption Keys (CMEK KMS) channel setup.
  - Pub/Sub Dead-Letter Topic (DLQ) configuration.
- **Network Security & Hardening Runbooks**:
  - Restricting public access to `/api/events/gcs`:
    1. NGINX Ingress path blocking (`403 Forbidden`).
    2. GKE Gateway API + Cloud Armor `GCPBackendPolicy` rule.
    3. GKE Gateway API `URLRewrite` rule.
    4. Kubernetes `NetworkPolicy` isolating port `80` to Eventarc namespaces.
- **Operations & Local Testing**:
  - Bulk-bootstrapping historical TechDocs using `scripts/bootstrap.ts` (`prepare-docs` and `import-docs`).
  - Local development workflow and `curl` command for testing Eventarc notifications.
