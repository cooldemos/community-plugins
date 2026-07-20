# Document Standalone Deployment Mode for Search Engine Modules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Update the high-level hybrid search workspace documentation to reflect that Typesense and Vertex AI search modules can work as standalone search engines.

**Architecture:** Add a "Deployment Modes" section under "High-Level Architecture" in the workspace README, and update the descriptions of the search module entries in the main plugins table.

**Tech Stack:** Markdown

## Global Constraints

- Follow exact copy and wording from the approved design spec.

---

### Task 1: Update High-Level README Documentation

**Files:**

- Modify: `workspaces/hybrid-search/README.md:46-61`

**Interfaces:**

- N/A

- [ ] **Step 1: Modify workspaces/hybrid-search/README.md**

Modify `workspaces/hybrid-search/README.md` to:

1. Add a new `### 🔌 Deployment Modes` subsection immediately before the `## 📦 Workspace Plugins & Modules` section.
2. Update the description columns of the "Typesense Search Engine Module" and "Vertex AI Search Engine Module" rows in the plugins table.

Specifically, replace:

```markdown
---

## 📦 Workspace Plugins & Modules

This workspace contains four specialized plugins:

| Plugin / Module                    | Directory                                                                                        | Purpose                                                                                                                                                                                                                                                                                                                        |
| :--------------------------------- | :----------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Engine Router**    | [`plugins/search-backend-module-hybrid`](./plugins/search-backend-module-hybrid/README.md)       | The core router that delegates queries to registered sub-engines in parallel based on document categories, then aggregates and interleaves the results.                                                                                                                                                                        |
| **Typesense Search Engine Module** | [`plugins/search-backend-module-typesense`](./plugins/search-backend-module-typesense/README.md) | Integrates Typesense by registering a sub-engine to the Hybrid Router. Handles active document ingestion and query mapping for any standard/custom document types (e.g. catalog, templates, APIs).                                                                                                                             |
| **Vertex AI Search Engine Module** | [`plugins/search-backend-module-vertexai`](./plugins/search-backend-module-vertexai/README.md)   | Integrates Google Cloud Vertex AI Search by registering a query-only sub-engine (local indexing is bypassed). Translates Backstage queries to unstructured Discovery Engine API requests and schedules a task to purge orphaned documents and static GCS files when their corresponding entities are deleted from the catalog. |
```

With:

```markdown
---
### 🔌 Deployment Modes

Each search engine module in this workspace is designed to be highly flexible and can be deployed in one of two modes:

1. **Standalone Mode (Primary Engine)**: The search module is registered directly as the primary search engine for Backstage (replacing default engines like Lunr). All query execution and indexing flow directly through it.
2. **Hybrid Mode (Federated Search)**: The [Hybrid Search Engine Router](./plugins/search-backend-module-hybrid/README.md) is registered as the primary search engine, and delegates queries to multiple sub-engines (like Typesense and Vertex AI Search) in parallel based on the requested categories, merging the results dynamically.
---

## 📦 Workspace Plugins & Modules

This workspace contains four specialized plugins:

| Plugin / Module                    | Directory                                                                                        | Purpose                                                                                                                                                                                                                                                        |
| :--------------------------------- | :----------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Engine Router**    | [`plugins/search-backend-module-hybrid`](./plugins/search-backend-module-hybrid/README.md)       | The core router that delegates queries to registered sub-engines in parallel based on document categories, then aggregates and interleaves the results.                                                                                                        |
| **Typesense Search Engine Module** | [`plugins/search-backend-module-typesense`](./plugins/search-backend-module-typesense/README.md) | Integrates Typesense search capabilities into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Handles active document ingestion and query mapping for any standard/custom document types. |
| **Vertex AI Search Engine Module** | [`plugins/search-backend-module-vertexai`](./plugins/search-backend-module-vertexai/README.md)   | Integrates Google Cloud Vertex AI Search into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Translates queries to Discovery Engine API requests and manages background catalog cleanup. |
```

- [ ] **Step 2: Run prettier to format the updated markdown file**

Run: `yarn prettier:fix` in the `workspaces/hybrid-search/` directory.

- [ ] **Step 3: Run prettier check to verify formatting is clean**

Run: `yarn prettier:check` in `workspaces/hybrid-search/`.
Expected: `README.md` is fully formatted and passes the check.

- [ ] **Step 4: Commit the changes**

Run:

```bash
git add README.md
git commit -m "docs: document standalone deployment mode in hybrid search workspace README"
```

---

### Task 2: Fix Hybrid Module README Examples

**Files:**

- Modify: `workspaces/hybrid-search/plugins/search-backend-module-hybrid/README.md:161-215`

**Interfaces:**

- N/A

- [ ] **Step 1: Modify workspaces/hybrid-search/plugins/search-backend-module-hybrid/README.md**

Modify `workspaces/hybrid-search/plugins/search-backend-module-hybrid/README.md` to:
Replace the Concrete Examples section (Lines 159-253) with a single example showing how to write a custom search engine module (`searchModuleCustomHybridSearch`) using `CustomSearchEngine` that registers to the `hybridSearchEngineRegistryExtensionPoint`.

- [ ] **Step 2: Run prettier to format the updated markdown file**

Run: `npx prettier --write plugins/search-backend-module-hybrid/README.md` in `workspaces/hybrid-search/`.

- [ ] **Step 3: Run prettier check to verify formatting is clean**

Run: `npx prettier --check plugins/search-backend-module-hybrid/README.md` in `workspaces/hybrid-search/`.
Expected: `README.md` is fully formatted and passes the check.

- [ ] **Step 4: Commit the changes**

Run:

```bash
git add plugins/search-backend-module-hybrid/README.md
git commit -m "docs: replace concrete sub-engine registration examples with hypothetical custom engine example"
```

---

### Task 3: Update plugins/README.md Table and Introduction

**Files:**

- Modify: `workspaces/hybrid-search/plugins/README.md:1-32, 37-42`

**Interfaces:**

- N/A

- [ ] **Step 1: Modify workspaces/hybrid-search/plugins/README.md**

Modify `workspaces/hybrid-search/plugins/README.md` to:

1. Replace the introductory paragraph on Line 3 to explain standalone deployment options.
2. Rename the sub-engine list items on Lines 14-15 to use "Engine Module".
3. Replace the "Parallel Query Orchestration & Consolidating Strategies" section (Lines 17-25) to simplify the parallel execution wording into a single intro sentence.
4. Replace the "Event-Driven Delta Ingestion" section (Lines 26-32) to simplify the description to conceptual features, removing code-level details.
5. Update the table rows for Vertex AI Search and Typesense Search (Lines 37-42) to rename them and describe standalone capabilities.

Specifically:

- Intro paragraph (Line 3) replacement:

```markdown
This directory houses a collection of highly flexible search modules for Backstage. It supports standalone deployment of modern search backends (e.g. structured Typesense search or semantic Vertex AI Search) as primary engines, alongside an optional Hybrid Search Router that orchestrates parallel federated queries and dynamic result merging.
```

- List items replacement (Lines 14-15):

```markdown
- **Vertex AI Search Engine Module** ([`search-backend-module-vertexai`](./search-backend-module-vertexai))
- **Typesense Search Engine Module** ([`search-backend-module-typesense`](./search-backend-module-typesense))
```

- Query Orchestration & Consolidation Strategies section (Lines 17-25) replacement:

```markdown
### 2. Query Orchestration & Consolidation Strategies

When a user executes a search, the **`HybridSearchEngine`** queries all matching registered backends in parallel and merges the results based on the configured strategy:

- `interleave` (Default): Blends search results round-robin style to give developers a diverse first page of mixed results.
- `score-normalized-sort`: Normalizes search relevance scores from different engines to a `[0, 1]` scale and sorts them descending.
```

- Event-Driven Delta Ingestion section (Lines 26-32) replacement:

```markdown
### 3. Event-Driven Ingestion & Reconciliation (Vertex AI & TechDocs Specific)

For TechDocs document indexing in Vertex AI Search, synchronization is real-time, decentralized, and event-driven:

- **Real-time Webhook**: Listens to bucket upload notifications from Google Eventarc to trigger document indexing immediately upon publication.
- **Throttled Batch Ingestion**: Processes changed files, maps them to stable document IDs, and performs batch imports within API rate limits to protect resource bounds.
- **Catalog Metadata Enrichment**: Automatically associates indexed documents with their Backstage catalog metadata to enrich search results with owner, lifecycle, and component annotations.
- **Delta Reconciliation**: Compares current and historic index states to automatically detect and purge stale or deleted pages.
```

- Table rows replacement (Lines 39-41):

```markdown
| **Vertex AI Search Engine Module** | [`search-backend-module-vertexai`](./search-backend-module-vertexai/README.md) | **Semantic Search**: Integrates Google Cloud Vertex AI Search. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Translates Backstage queries to Discovery Engine API calls. |
| **Typesense Search Engine Module** | [`search-backend-module-typesense`](./search-backend-module-typesense/README.md) | **Structured Search**: Integrates Typesense capabilities. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Indexes and searches structured Backstage entities with typo-tolerance. |
```

- [ ] **Step 2: Run prettier to format the updated markdown file**

Run: `npx prettier --write plugins/README.md` in `workspaces/hybrid-search/`.

- [ ] **Step 3: Run prettier check to verify formatting is clean**

Run: `npx prettier --check plugins/README.md` in `workspaces/hybrid-search/`.
Expected: `README.md` is fully formatted and passes the check.

- [ ] **Step 4: Commit the changes**

Run:

```bash
git add plugins/README.md
git commit -m "docs: document standalone deployment mode and simplify query orchestration and event-driven sections in plugins README"
```

---

### Task 4: De-salesify Vertex AI Search Backend Module README

**Files:**

- Modify: `workspaces/hybrid-search/plugins/search-backend-module-vertexai/README.md`

**Interfaces:**

- N/A

- [ ] **Step 1: Modify workspaces/hybrid-search/plugins/search-backend-module-vertexai/README.md**
      Rewrite the file to remove salesy or promotional wording:

1. Replace emojis from header titles and bullet points.
2. Rephrase sentences to be passive, technical, and objective (e.g., replace "Zero hardcoding!" with configuration details).
3. Update the ingestion bypass diagram and description to focus on decoupled flow without hype terms.
4. Restructure the "Required Integration Dependencies" section to clearly separate general configuration settings from TechDocs Ingestion Modes (Direct Local Indexing vs. Decoupled Ingestion Pipeline).

- [ ] **Step 2: Run prettier to format the updated markdown file**
      Run: `npx prettier --write plugins/search-backend-module-vertexai/README.md` in `workspaces/hybrid-search/`.

- [ ] **Step 3: Run prettier check to verify formatting is clean**
      Run: `npx prettier --check plugins/search-backend-module-vertexai/README.md` in `workspaces/hybrid-search/`.
      Expected: file passes the check.

- [ ] **Step 4: Commit the changes**
      Run:

```bash
git add plugins/search-backend-module-vertexai/README.md
git commit -m "docs: remove salesy tone and stick to technical facts in Vertex AI search engine README"
```
