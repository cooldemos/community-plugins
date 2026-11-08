# Hybrid Search Workspace (`workspaces/hybrid-search`)

Standard Backstage search routes every query through a single search engine and runs document ingestion inside the main Node.js backend process. As a developer portal grows, that single-engine design creates three trade-offs:

1. **Single-engine routing**: Every document type must live in one backend, preventing teams from pairing fast keyword search for catalog entities with semantic retrieval for documentation.
2. **Keyword-only matching**: Built-in engines (Lunr, PostgreSQL, Elasticsearch) do not natively combine typo-tolerant entity lookup with managed LLM extractive answers.
3. **In-process ingestion contention**: Polling and parsing large TechDocs archives inside the Node.js event loop competes directly with user HTTP traffic for CPU and memory.

The **Hybrid Search Workspace** extends Backstage's New Backend System (`@backstage/backend-plugin-api`) with a federated query router, standalone-or-hybrid search modules for **Typesense** and **Google Cloud Vertex AI Search**, and an event-driven ingestion webhook that moves TechDocs indexing out of the Node.js request loop.

---

## High-Level Architecture

Incoming search requests hit the Hybrid Search Router, which evaluates the requested document categories (`types`) and dispatches queries in parallel to the mapped search backends before consolidating and normalizing the results.

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                             Federated Hybrid Search Architecture                            │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  [ Query Pipeline ]                                                                         │
│                                                                                             │
│  Backstage UI ──► GET /api/search/query ──► Hybrid Search Router                            │
│                                                    │                                        │
│                        ┌───────────────────────────┴───────────────────────────┐            │
│                        │ ('software-catalog')                                  │ ('techdocs')
│                        ▼                                                       ▼            │
│           Typesense Search Module                                 Vertex AI Search Module   │
│                        │                                                       │            │
│                        ▼                                                       ▼            │
│             Typesense Cluster Nodes                               Google Discovery Engine   │
│                                                                                ▲            │
│  [ Ingestion Pipelines ]                                                       │            │
│                                                                                │            │
│  • Direct Reconciling Collator (BatchSearchEngineIndexer + contentHash) ───────┤            │
│  • Decoupled CI/CD ──► GCS Bucket ──► Eventarc Trigger ──► /api/events/gcs ────┘            │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Deployment Modes

Every search engine module in this workspace supports two deployment modes:

1. **Standalone Mode (Primary Engine)**: Register either Typesense or Vertex AI Search directly into Backstage's core `searchEngineRegistryExtensionPoint`. All queries and collator streams flow through that single engine.
2. **Hybrid Mode (Federated Search)**: Register the [Hybrid Search Router](./plugins/search-backend-module-hybrid/README.md) as the primary search engine and attach sub-engines through `hybridSearchEngineRegistryExtensionPoint` using their `/hybrid` entry points.

---

## Workspace Plugins & Modules

| Plugin / Module                    | Directory                                                                                              | Purpose                                                                                                                                                                 |
| :--------------------------------- | :----------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hybrid Search Engine Router**    | [`plugins/search-backend-module-hybrid`](./plugins/search-backend-module-hybrid/README.md)             | Federated orchestrator that routes queries across registered sub-engines in parallel with `Promise.allSettled` fault isolation and merges heterogeneous result sets.    |
| **Typesense Search Engine Module** | [`plugins/search-backend-module-typesense`](./plugins/search-backend-module-typesense/README.md)       | Integrates Typesense for typo-tolerant keyword search, structured metadata filtering, auto-dynamic `backstage_<type>` schemas, and optional vector embeddings.          |
| **Vertex AI Search Engine Module** | [`plugins/search-backend-module-vertexai`](./plugins/search-backend-module-vertexai/README.md)         | Integrates Google Cloud Vertex AI Search with extractive answer cascades, three-phase `contentHash` collator reconciliation, and orphaned TechDocs cleanup.             |
| **GCS Eventarc Ingestion Webhook** | [`plugins/events-backend-module-gcs-eventarc`](./plugins/events-backend-module-gcs-eventarc/README.md) | Receives Google Eventarc notifications when `search_index.json` is finalized in Cloud Storage, enriches pages with Catalog metadata, and synchronizes Vertex AI Search. |

---

## Installation & Backend Integration

Add the Hybrid Search Router and the sub-engine `/hybrid` entry points to `packages/backend/src/index.ts`:

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage/plugin-search-backend-module-catalog'));
backend.add(import('@backstage/plugin-search-backend-module-techdocs'));

// 1. Register the Hybrid Search Router as the primary search engine
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));

// 2. Register sub-engines via their /hybrid subpath exports
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense/hybrid'),
);
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai/hybrid'),
);

// 3. Optional: Register the Eventarc webhook when offloading TechDocs ingestion to GCS
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

---

## Quick Start Configuration

Configure category routing and sub-engine settings in `app-config.yaml`:

```yaml
search:
  engines:
    hybrid:
      mergeStrategy: score-normalized-sort # 'interleave' (default) or 'score-normalized-sort'
      routing:
        software-catalog: typesense
        techdocs: vertexai
        default: typesense
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: localhost
          port: 8108
          protocol: http
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
          searchOptions:
            query_by: 'title,text,location'
    vertexai:
      indexing:
        enabled: false # Offload TechDocs indexing to the GCS Eventarc webhook
      types:
        techdocs:
          datastore:
            projectId: ${GCP_PROJECT_ID}
            datastoreId: ${VERTEX_TECHDOCS_DATASTORE_ID}
            location: europe-west4
          engine:
            projectId: ${GCP_PROJECT_ID}
            engineId: ${VERTEX_TECHDOCS_ENGINE_ID}
            location: europe-west4
          searchOptions:
            contentSearchSpec:
              extractiveContentSpec:
                maxExtractiveAnswerCount: 1
                maxExtractiveSegmentCount: 2
      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }

techdocs:
  publisher:
    type: googleGcs
    googleGcs:
      bucketName: ${TECHDOCS_GCS_BUCKET}
```

---

## Development & Verification Commands

Run all workspace commands from `workspaces/hybrid-search`:

```bash
# Install workspace dependencies
yarn install

# Full TypeScript type-checking
yarn tsc:full

# Lint all packages
yarn lint:all

# Run unit and integration test suites
yarn test:all

# Regenerate and validate public API reports
yarn build:api-reports

# Check Markdown and source formatting
yarn prettier:check
```
