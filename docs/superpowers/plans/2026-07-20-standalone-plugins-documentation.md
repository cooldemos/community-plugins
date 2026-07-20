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

### Task 3: Update plugins/README.md Table

**Files:**

- Modify: `workspaces/hybrid-search/plugins/README.md:37-42`

**Interfaces:**

- N/A

- [ ] **Step 1: Modify workspaces/hybrid-search/plugins/README.md**

Modify the table rows for Vertex AI Search and Typesense Search in `workspaces/hybrid-search/plugins/README.md`:
Rename the columns and rewrite the descriptions to emphasize their standalone capabilities and correct naming.

Specifically, replace:

```markdown
| **Vertex AI Search Sub-Engine** | [`search-backend-module-vertexai`](./search-backend-module-vertexai/README.md) | **Semantic Search**: Sub-engine that translates Backstage search queries to Google Discovery Engine API calls, supporting semantic search across any configured unstructured or structured indices. |
| **Typesense Search Sub-Engine** | [`search-backend-module-typesense`](./search-backend-module-typesense/README.md) | **Structured Search**: Sub-engine that indexes and searches structured Backstage entities (such as catalog components, API definitions, or custom indices) with typo-tolerance. |
```

With:

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
git commit -m "docs: document standalone deployment mode in plugins README table"
```
