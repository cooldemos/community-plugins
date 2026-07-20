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

## 4. Verification Plan

- Verify markdown rendering and links.
