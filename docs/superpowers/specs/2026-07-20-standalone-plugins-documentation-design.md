# Spec: Document Standalone Deployment Mode for Search Engine Modules

## 1. Problem Statement

The high-level workspace documentation for the hybrid search plugins (`search-backend-module-typesense` and `search-backend-module-vertexai`) currently describes them solely as sub-engines to the Hybrid Router. However, both modules are designed to run standalone as the primary search engine for a Backstage instance, without needing the hybrid router orchestrator. We need to update the main README to clarify this standalone capability.

## 2. Proposed Changes

- In `workspaces/hybrid-search/README.md`, add a new subsection `### 🔌 Deployment Modes` under `## 🏛️ High-Level Architecture` to explain the Standalone and Hybrid deployment modes.
- Update the descriptions for the "Typesense Search Engine Module" and "Vertex AI Search Engine Module" in the `## 📦 Workspace Plugins & Modules` table.
- In `plugins/search-backend-module-hybrid/README.md`, fix the example code blocks for Typesense and Vertex AI search engine registration under the `### Concrete Examples` subsection to use the correct module names (`searchModuleTypesenseHybridSearch` and `searchModuleVertexAISearchHybrid`) and structure.
- In `plugins/README.md`, update the module table entries for Typesense and Vertex AI search engines to rename them to match the module names and mention their standalone deployment capability.
- In `plugins/README.md`, update the introductory paragraph to explain both standalone and hybrid modules capabilities.
- In `plugins/README.md`, rename the bullet points under `### 1. Dynamic Engine Registry via Extension Points` from "Sub-Engine" to "Engine Module".
- In `plugins/README.md`, simplify the "Event-Driven Delta Ingestion" section to remove code-level details like `asyncPool`, `Promise.all()`, and backend service references.
- In `plugins/search-backend-module-vertexai/README.md`, rewrite the documentation to remove salesy or marketing-oriented language, sticking purely to factual, technical descriptions.

## 3. Detailed Changes Reference

### New Subsection: `### 🔌 Deployment Modes`

```markdown
### 🔌 Deployment Modes

Each search engine module in this workspace is designed to be highly flexible and can be deployed in one of two modes:

1. **Standalone Mode (Primary Engine)**: The search module is registered directly as the primary search engine for Backstage (replacing default engines like Lunr). All query execution and indexing flow directly through it.
2. **Hybrid Mode (Federated Search)**: The [Hybrid Search Engine Router](./plugins/search-backend-module-hybrid/README.md) is registered as the primary search engine, and delegates queries to multiple sub-engines (like Typesense and Vertex AI Search) in parallel based on the requested categories, merging the results dynamically.
```

### Table Row updates (workspaces/hybrid-search/README.md):

- **Typesense Search Engine Module**:
  Update description to:
  "Integrates Typesense search capabilities into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Handles active document ingestion and query mapping for any standard/custom document types."
- **Vertex AI Search Engine Module**:
  Update description to:
  "Integrates Google Cloud Vertex AI Search into Backstage. Can be deployed as a standalone primary search engine or registered as a sub-engine to the Hybrid Router. Translates queries to Discovery Engine API requests and manages background catalog cleanup."

### Plugins README Introduction and Table updates (workspaces/hybrid-search/plugins/README.md):

- **Introductory Paragraph**:
  Replace with:
  "This directory houses a collection of highly flexible search modules for Backstage. It supports standalone deployment of modern search backends (e.g. structured Typesense search or semantic Vertex AI Search) as primary engines, alongside an optional Hybrid Search Router that orchestrates parallel federated queries and dynamic result merging."

- **Bullet points (Lines 14-15)**:
  Replace with:

  ```markdown
  - **Vertex AI Search Engine Module** ([`search-backend-module-vertexai`](./search-backend-module-vertexai))
  - **Typesense Search Engine Module** ([`search-backend-module-typesense`](./search-backend-module-typesense))
  ```

- **Query Orchestration & Consolidation Strategies section (Lines 17-25)**:
  Replace with:

  ```markdown
  ### 2. Query Orchestration & Consolidation Strategies

  When a user executes a search, the **`HybridSearchEngine`** queries all matching registered backends in parallel and merges the results based on the configured strategy:

  - `interleave` (Default): Blends search results round-robin style to give developers a diverse first page of mixed results.
  - `score-normalized-sort`: Normalizes search relevance scores from different engines to a `[0, 1]` scale and sorts them descending.
  ```

- **Event-Driven Delta Ingestion section (Lines 26-32)**:
  Replace with:

  ```markdown
  ### 3. Event-Driven Ingestion & Reconciliation (Vertex AI & TechDocs Specific)

  For TechDocs document indexing in Vertex AI Search, synchronization is real-time, decentralized, and event-driven:

  - **Real-time Webhook**: Listens to bucket upload notifications from Google Eventarc to trigger document indexing immediately upon publication.
  - **Throttled Batch Ingestion**: Processes changed files, maps them to stable document IDs, and performs batch imports within API rate limits to protect resource bounds.
  - **Catalog Metadata Enrichment**: Automatically associates indexed documents with their Backstage catalog metadata to enrich search results with owner, lifecycle, and component annotations.
  - **Delta Reconciliation**: Compares current and historic index states to automatically detect and purge stale or deleted pages.
  ```

- **Vertex AI Search Engine Module (Table)**:
  Rename to: `**Vertex AI Search Engine Module**`
  Update description to:
  `**Semantic Search**: Integrates Google Cloud Vertex AI Search. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Translates Backstage queries to Discovery Engine API calls.`
- **Typesense Search Engine Module (Table)**:
  Rename to: `**Typesense Search Engine Module**`
  Update description to:
  `**Structured Search**: Integrates Typesense capabilities. Can run standalone as the primary engine or register as a sub-engine to the Hybrid Router. Indexes and searches structured Backstage entities with typo-tolerance.`

### Hybrid Module README Example Fixes:

In `plugins/search-backend-module-hybrid/README.md`, update the `### Concrete Examples` section to replace the two concrete examples with a single hypothetical custom engine example:

```typescript
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';
import { CustomSearchEngine } from './CustomSearchEngine'; // Your custom search engine class

export const searchModuleCustomHybridSearch = createBackendModule({
  pluginId: 'search',
  moduleId: 'custom-hybrid-search',
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

        // Instantiate your custom search engine implementation
        const customSearchEngine = new CustomSearchEngine({
          logger,
          config,
        });

        // Register the engine instance to the Hybrid Registry,
        // specifying the document types (categories) it supports.
        hybridRegistry.registerEngine(
          'custom-engine-name',
          customSearchEngine,
          {
            supportsTypes: ['software-catalog', 'custom-type'],
          },
        );
      },
    });
  },
});
```

### Vertex AI Search Backend Module README Tone Adjustments:

In `plugins/search-backend-module-vertexai/README.md`:

- Eliminate marketing emojis (e.g. 🌟, ⚡, 🔀, 🧹, 🔌, 🔍, 🏛️, ⚙️, 🔗, 📦, 📄, ❓, 🔑).
- Remove words like "seamlessly", "high-performance", "Zero hardcoding!", "Infinite Custom Type Extensibility", "Infinite", "beautifully blended", "massive CPU/memory overhead", "effortless", etc.
- Stick to factual descriptions. Instead of "Zero hardcoding! You can dynamically map...", say: "Maps custom Backstage document types (e.g., `techdocs`, `software-catalog`) to individual Google Cloud Data Stores and Search Apps in the configuration."
- In the Ingestion Bypass section, explain standard TechDocs parsing and indexing in Backstage compared to the decoupled mode without using terms like "Safely Discarded / Black-Hole" or "No CPU Overhead".
- Restructure the "Required Integration Dependencies" section to clearly separate general configuration settings from TechDocs Ingestion Modes (Direct Local Indexing vs. Decoupled Ingestion Pipeline), clarifying that Eventarc and GCS publisher settings are only needed for Decoupled mode.
- In the Core Features list, refine the "Direct Local Indexing" description to explain the behavior conceptually without mentioning the `VertexAIWritableStream` class name.
- Combine the "Ingestion Bypass & Decoupled Indexing" section and the "TechDocs Ingestion Modes" section under a unified "TechDocs Ingestion Architecture & Modes" header, nesting the bypass explanation, mermaid diagram, and decoupled pipeline requirements cleanly under Option B (Decoupled Ingestion Pipeline).
- Under Option B's "How it Works" section, remove the misplaced "Semantic Querying" step, since query serving is identical across both modes and is not a part of decoupled ingestion.
- Remove the redundant "General Configuration" section and snippet from the top of the README, keeping only the detailed config examples under the main Configuration section.
- Reposition the Catalog Cleanup Sweeper feature entirely from the Core Features list down to a dedicated section under Option B (Decoupled Ingestion Pipeline), since it is only active and relevant in decoupled mode.
- Standardize markdown alert syntax across the modified documentation to use proper multiline blocks.
- In the Decoupled Ingestion Pipeline (Option B) description, add a brief explanation of Eventarc (identifying it as a GCP event routing service that triggers Backstage webhooks upon GCS uploads).
- Omit snippetSpec from the Standalone configuration example, showing only the recommended extractiveContentSpec block. Document snippetSpec and its format under the Extractive Content & Snippet Priority section as a basic-tier alternative.
- In the Typesense Search module README, add an example showing how to configure a custom collection schema (including a vector/semantic search field configuration) in the Configuration section under a dedicated sub-section, and reference it from the Custom Collection Schemas feature description.

## 4. Verification Plan

- Verify markdown rendering and links.
