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
Update the Typesense and Vertex AI search module registration code blocks under `### Concrete Examples` with the correct module names and registration formats matching their hybrid entry points.

- [ ] **Step 2: Run prettier to format the updated markdown file**

Run: `npx prettier --write workspaces/hybrid-search/plugins/search-backend-module-hybrid/README.md` in `workspaces/hybrid-search/`.

- [ ] **Step 3: Run prettier check to verify formatting is clean**

Run: `npx prettier --check workspaces/hybrid-search/plugins/search-backend-module-hybrid/README.md` in `workspaces/hybrid-search/`.
Expected: `README.md` is fully formatted and passes the check.

- [ ] **Step 4: Commit the changes**

Run:

```bash
git add plugins/search-backend-module-hybrid/README.md
git commit -m "docs: fix hybrid registry code examples in hybrid plugin README"
```
