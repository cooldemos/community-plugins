# Spec: Document Standalone Deployment Mode for Search Engine Modules

## 1. Problem Statement

The high-level workspace documentation for the hybrid search plugins (`search-backend-module-typesense` and `search-backend-module-vertexai`) currently describes them solely as sub-engines to the Hybrid Router. However, both modules are designed to run standalone as the primary search engine for a Backstage instance, without needing the hybrid router orchestrator. We need to update the main README to clarify this standalone capability.

## 2. Proposed Changes

- In `workspaces/hybrid-search/README.md`, add a new subsection `### 🔌 Deployment Modes` under `## 🏛️ High-Level Architecture` to explain the Standalone and Hybrid deployment modes.
- Update the descriptions for the "Typesense Search Engine Module" and "Vertex AI Search Engine Module" in the `## 📦 Workspace Plugins & Modules` table.

## 3. Detailed Changes Reference

### New Subsection: `### 🔌 Deployment Modes`

```markdown
### 🔌 Deployment Modes

Each search engine module in this workspace is designed to be highly flexible and can be deployed in one of two modes:

1. **Standalone Mode (Primary Engine)**: The search module is registered directly as the primary search engine for Backstage (replacing default engines like Lunr). All query execution and indexing flow directly through it.
2. **Hybrid Mode (Federated Search)**: The [Hybrid Search Engine Router](./plugins/search-backend-module-hybrid/README.md) is registered as the primary search engine, and delegates queries to multiple sub-engines (like Typesense and Vertex AI Search) in parallel based on the requested categories, merging the results dynamically.
```

### Table Row updates:

- **Typesense Search Engine Module**:
  Update description to:
  "Integrates Typesense search capabilities into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Handles active document ingestion and query mapping for any standard/custom document types."
- **Vertex AI Search Engine Module**:
  Update description to:
  "Integrates Google Cloud Vertex AI Search into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Translates queries to Discovery Engine API requests and manages background catalog cleanup."

## 4. Verification Plan

- Verify markdown rendering and links.
