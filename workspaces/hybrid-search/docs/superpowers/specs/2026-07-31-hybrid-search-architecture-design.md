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

---

## Executive Summary

The **Hybrid Search Workspace** provides multi-engine search routing and asynchronous index ingestion for Backstage developer portals. This document specifies the design, architecture, technical depth, diagrams, and operational guides to be written in `docs/architecture.md`.

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
  - _Relative Max-Score Normalization (`score-normalized-sort`)_: Standardizing relevance scores across distinct search backends using the ratio:
    $$score_{normalized} = \frac{raw\_score}{max\_score}$$
  - _Pagination Boundary Mechanics_: Direct cursor forwarding for single-engine queries vs. result array slicing and cursor omission for federated multi-engine queries.
- **Decoupled Asynchronous TechDocs Ingestion**:
  - Shifting TechDocs build and HTML parsing from the Node.js runtime to external CI/CD pipelines publishing to Google Cloud Storage (GCS).
  - Asynchronous event notifications using Google Cloud Eventarc.
- **Catalog Metadata Enrichment & Delta Reconciliation**:
  - Ingress webhook enriches raw TechDocs index manifests with live Catalog Service metadata (`owner`, `lifecycle`, `componentType`, `annotations`).
  - Stable MD5 document identifier hashing (`md5(namespace:kind:name:path)`).
  - Differential reconciliation comparing GCS file generation `N` against historical generation `N-1`, identifying removed pages, and issuing throttled API deletion requests to the search engine.

---

### Part 3: System Architecture & Package Specifications (Conceptual Breakdown & Diagrams)

- **Package Architecture Breakdown**:
  1. `@backstage-community/plugin-search-backend-module-hybrid`:
     - Router engine implementation (`HybridSearchEngine`) and extension point (`hybridSearchEngineRegistryExtensionPoint`) for backend module registration.
  2. `@backstage-community/plugin-search-backend-module-typesense`:
     - Multi-collection concurrent execution, memory-buffered writable streams (batching at 100 documents), auto-provisioning wildcard schemas (`.*`), and raw client/query passthrough capabilities.
  3. `@backstage-community/plugin-search-backend-module-vertexai`:
     - Google Cloud Discovery Engine API integration, direct local indexing vs. decoupled Eventarc mode, extractive content priority hierarchy (Answers > Segments > Snippets > Fallback Text), and background catalog cleanup sweeper.
  4. `@backstage-community/plugin-events-backend-module-gcs-eventarc`:
     - Webhook endpoint `/api/events/gcs`, dual security models (Google OIDC verification vs. GKE VPC network isolation), and Pub/Sub Dead-Letter Topic (DLQ) fault tolerance.
- **Deployment Topologies**:
  - Standalone Engine Mode vs. Federated Hybrid Router Mode.
- **Architecture Sequence Diagrams (Mermaid)**:
  - Federated Query Dispatch & Result Merging.
  - Decoupled Eventarc Ingestion & Catalog Enrichment.
  - Delta Reconciliation & Throttled Document Deletion.

---

### Part 4: Complete Operator & Implementation Guide (Low-Level Configuration & Code)

- **Backend Module Integration**:
  - TypeScript code for registering packages in `packages/backend/src/index.ts` under Backstage's New Backend System.
- **Annotated Configuration Reference (`app-config.yaml`)**:
  - Exhaustive configuration reference covering hybrid routing, Typesense cluster nodes, Vertex AI datastores/apps, and GCS Eventarc parameters.
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
