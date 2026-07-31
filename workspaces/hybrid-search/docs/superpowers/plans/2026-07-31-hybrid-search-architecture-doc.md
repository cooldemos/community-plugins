# Hybrid Search Architecture Document Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Completely rewrite `workspaces/hybrid-search/docs/architecture.md` from scratch to create an authoritative, comprehensive 4-part technical reference and operator manual for the Hybrid Search Workspace.

**Architecture:** The document is structured into a 4-part master guide. Parts 1, 2, and 3 prioritize deep conceptual analysis, component mechanics, system boundaries, mathematical equations, and Mermaid sequence diagrams without code clutter. Part 4 serves as the low-level operator manual containing full TypeScript backend registration snippets, annotated YAML configurations, Terraform HCL manifests, Kubernetes Service port mappings, GCP IAM matrices, network hardening runbooks, and CLI execution scripts.

**Tech Stack:** Backstage New Backend System (`@backstage/backend-plugin-api`), Typesense (`@backstage-community/plugin-search-backend-module-typesense`), Google Cloud Vertex AI Search (`@backstage-community/plugin-search-backend-module-vertexai`), GCS Eventarc (`@backstage-community/plugin-events-backend-module-gcs-eventarc`), Mermaid Diagrams, Terraform, Kubernetes, Markdown.

## Global Constraints

- Target File: `workspaces/hybrid-search/docs/architecture.md`
- Design Spec: `workspaces/hybrid-search/docs/superpowers/specs/2026-07-31-hybrid-search-architecture-design.md`
- Factual plain language: Zero sales or marketing buzzwords.
- Tone & Style: Verbose, thorough prose explaining _how_ and _why_ internal components operate.
- Structural Split: Parts 1-3 are strictly conceptual prose, LaTeX math, and Mermaid diagrams (no implementation code blocks). Part 4 contains all low-level technical code, YAML configs, Terraform manifests, and CLI commands.

---

### Task 1: Part 1 - How Backstage Search Works (Conceptual & Architectural Analysis)

**Files:**

- Modify: `workspaces/hybrid-search/docs/architecture.md`

**Interfaces:**

- Consumes: Grounded concepts from official upstream `@backstage/plugin-search-backend` and `@backstage/plugin-search-backend-node` (`/usr/local/google/home/mirene/git/backstage-public`).
- Produces: Part 1 section of `docs/architecture.md`.

- [ ] **Step 1: Write Title, Executive Summary, and Document Overview**

  - Add document title, metadata, and executive summary introducing the Hybrid Search Workspace.

- [ ] **Step 2: Write Section 1 - Backstage Search Core Architecture & Extension Points**

  - Detail core search abstractions: `SearchEngine`, `SearchEngineRegistry`, `IndexBuilder`, `Scheduler`, and `Collators`. Explain their responsibilities and interactions conceptually.

- [ ] **Step 3: Write Section 2 - Standard Query & Ingestion Execution Mechanics**

  - Explain the query lifecycle (`GET /api/search/query`) and the pull-indexing stream pipeline (`Collator → Decorators → Indexer`) running synchronously in Node.js event loop memory.

- [ ] **Step 4: Write Section 3 - Four Fundamental Architectural Limitations**

  - Provide complete conceptual analysis of the 4 standard Backstage limitations:
    1. Single Search Engine Constraint in Backend Core
    2. Single-Process Stream Bottlenecks & V8 Heap Memory Strain
    3. Monolithic Query Translation & Uniform Relevance Scoring
    4. Scheduled Polling Delays & Stale Index Orphanage (lack of delta reconciliation)

- [ ] **Step 5: Verify Part 1 Content**
  - Ensure zero code snippet dumps exist in Part 1 and all explanations are verbosely detailed in plain language.

---

### Task 2: Part 2 - Value Proposition & Technical Mechanics of Hybrid Search (Conceptual Analysis)

**Files:**

- Modify: `workspaces/hybrid-search/docs/architecture.md`

**Interfaces:**

- Consumes: Technical specifications from `search-backend-module-hybrid` README and spec.
- Produces: Part 2 section of `docs/architecture.md`.

- [ ] **Step 1: Write Federated Multi-Engine Search Routing & Engine Specialization**

  - Detail category-based routing (`types`), parallel dispatch, and engine specialization (Typesense for structured catalog entities, Vertex AI Search for semantic documentation).

- [ ] **Step 2: Write Fault Isolation & Parallel Execution Mechanics**

  - Detail asynchronous parallel dispatch (`Promise.allSettled`) and individual sub-engine timeout isolation.

- [ ] **Step 3: Write Result Aggregation & Score Merging Mechanics**

  - Explain Round-Robin Interleaving (`interleave`).
  - Explain Relative Max-Score Normalization (`score-normalized-sort`) with LaTeX dual-mode equations (ratio scaling for scored engines vs. rank-based fallback for unscored engines).
  - Explain Pagination Boundary Mechanics (direct cursor forwarding for single-engine vs. array slicing / cursor omission for multi-engine federated queries).

- [ ] **Step 4: Write Decoupled Asynchronous TechDocs Ingestion**

  - Explain shifting TechDocs building/parsing from Node.js runtime to external CI/CD pipelines publishing to GCS, and event notifications via GCS Eventarc.

- [ ] **Step 5: Write Catalog Metadata Enrichment & MD5 Delta Reconciliation**
  - Detail Catalog Service entity metadata lookup (`owner`, `lifecycle`, `componentType`, `annotations`) and authorization fields (`authorization.resourceRef`).
  - Detail MD5 document ID hashing formula computed from lowercased canonical URI paths (`/docs/{namespace}/{kind}/{name}/{cleanLocation}`).
  - Detail generation `N` vs `N-1` GCS differential reconciliation and throttled deletion batching.

---

### Task 3: Part 3 - System Architecture & Package Specifications (Conceptual Breakdown & Mermaid Diagrams)

**Files:**

- Modify: `workspaces/hybrid-search/docs/architecture.md`

**Interfaces:**

- Consumes: Package architecture from all 4 workspace READMEs and spec.
- Produces: Part 3 section of `docs/architecture.md`.

- [ ] **Step 1: Write Package Architecture Breakdown**

  - Conceptually specify the 4 workspace packages:
    1. `@backstage-community/plugin-search-backend-module-hybrid`
    2. `@backstage-community/plugin-search-backend-module-typesense`
    3. `@backstage-community/plugin-search-backend-module-vertexai`
    4. `@backstage-community/plugin-events-backend-module-gcs-eventarc`

- [ ] **Step 2: Write Runtime Conflict Rules & Architectural Constraints**

  - Document Mutually Exclusive Ingestion Pathways (local indexing vs GCS Eventarc webhook).
  - Document `blendedSearch` Configuration Scope (Standalone mode only).
  - Document GKE Private VPC (OIDC disabled, Port 80 mapping) vs. Cloud Run Public Routing (OIDC enabled).

- [ ] **Step 3: Write Deployment Topologies**

  - Detail Standalone Engine Mode vs. Federated Hybrid Router Mode with architecture diagrams.

- [ ] **Step 4: Add Architecture Sequence Diagrams (Mermaid)**
  - Construct 3 detailed Mermaid diagrams:
    1. Federated Query Dispatch & Result Merging.
    2. Decoupled Eventarc Ingestion & Catalog Enrichment.
    3. Delta Reconciliation & Throttled Document Deletion.

---

### Task 4: Part 4 - Complete Operator & Implementation Guide (Low-Level Configuration & Code)

**Files:**

- Modify: `workspaces/hybrid-search/docs/architecture.md`

**Interfaces:**

- Consumes: Low-level configuration, code, and infrastructure runbooks from package READMEs.
- Produces: Part 4 section of `docs/architecture.md`.

- [ ] **Step 1: Write Backend Module Integration Code**

  - Provide full TypeScript code for registering packages in `packages/backend/src/index.ts` under Backstage's New Backend System.

- [ ] **Step 2: Write Annotated Configuration Reference (`app-config.yaml`)**

  - Write exhaustive, fully commented YAML configuration reference covering hybrid routing, Typesense cluster nodes, Vertex AI datastores/apps, and GCS Eventarc parameters.

- [ ] **Step 3: Write Kubernetes Service & Network Port Mapping**

  - Provide Kubernetes `Service` manifest mapping Service Port `80` (GKE Eventarc Forwarder target) to Pod Container Port `7007`.

- [ ] **Step 4: Write GCP IAM Roles Matrix**

  - Provide comprehensive table mapping the 4 service account personas (Backstage Backend SA, Eventarc Trigger SA, GCS Service Agent, Eventarc Service Agent) to exact required GCP IAM roles.

- [ ] **Step 5: Write GCP Infrastructure Provisioning (Terraform)**

  - Provide complete Terraform HCL manifests for Discovery Engine Data Stores, blended Search Apps, Eventarc Triggers (GKE internal VPC vs Cloud Run), CMEK KMS channels, and Pub/Sub Dead-Letter Topics (DLQ).

- [ ] **Step 6: Write Network Security & Hardening Runbooks**

  - Provide runbook manifests for NGINX Ingress path blocking (`403 Forbidden`), GKE Gateway API + Cloud Armor (`GCPBackendPolicy`), GKE Gateway API `URLRewrite` to 404, and Kubernetes `NetworkPolicy` isolating port 80.

- [ ] **Step 7: Write Operations & Local Testing Guide**
  - Provide step-by-step CLI commands for bulk-bootstrapping historical TechDocs (`scripts/bootstrap.ts` `prepare-docs` & `import-docs`) and local `curl` testing workflows.

---

### Task 5: Final Review & Quality Verification

**Files:**

- Review: `workspaces/hybrid-search/docs/architecture.md`

- [ ] **Step 1: Spec Coverage & Completeness Verification**

  - Verify every section in `workpowers/hybrid-search/docs/superpowers/specs/2026-07-31-hybrid-search-architecture-design.md` is fully addressed.

- [ ] **Step 2: Structural Split Verification**

  - Confirm Parts 1-3 contain zero code blocks and Part 4 contains all technical code/manifests.

- [ ] **Step 3: Markdown Formatting & Link Validation**
  - Verify Mermaid diagrams render cleanly, LaTeX math blocks format correctly, and all markdown links use proper file/relative schemes.
