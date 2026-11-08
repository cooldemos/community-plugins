# Hybrid Search Backend Module for Backstage (`@backstage-community/plugin-search-backend-module-hybrid`)

Backstage's core search backend (`@backstage/plugin-search-backend`) allows only a single `SearchEngine` to register for the entire portal. `@backstage-community/plugin-search-backend-module-hybrid` lifts that constraint by acting as the primary search engine while exposing **`hybridSearchEngineRegistryExtensionPoint`** so multiple specialized backends (such as Typesense for catalog entities and Vertex AI Search for TechDocs) can serve queries side by side.

---

## Architecture & Query Dispatch

### Sub-Engine Extension Point Registry

At startup, the Hybrid Search module registers `HybridSearchEngine` into Backstage's core `searchEngineRegistryExtensionPoint`. Sub-engine modules attach themselves dynamically through `hybridSearchEngineRegistryExtensionPoint` without hardcoded dependencies between packages.

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Hybrid Search Extension Point Registry                            │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                             │
│  Backstage Core Search Plugin (@backstage/plugin-search-backend)                            │
│                                │                                                            │
│                                ▼ (Core Single-Engine Registration)                          │
│                   [ searchEngineRegistryExtensionPoint ]                                    │
│                                │                                                            │
│                                ▼                                                            │
│       Hybrid Search Router (@backstage-community/plugin-search-backend-module-hybrid)       │
│                                │                                                            │
│                                ▼ (Custom Extension Point)                                   │
│               [ hybridSearchEngineRegistryExtensionPoint ]                                  │
│                                │                                                            │
│        ┌───────────────────────┼───────────────────────┐                                    │
│        ▼                       ▼                       ▼                                    │
│  ┌────────────┐         ┌────────────┐         ┌──────────────────┐                         │
│  │ Typesense  │         │ Vertex AI  │         │ Custom Backend   │                         │
│  │ /hybrid    │         │ /hybrid    │         │ Module           │                         │
│  └────────────┘         └────────────┘         └──────────────────┘                         │
│                                                                                             │
└─────────────────────────────────────────────────────────────────────────────────────────────┘
```

### Targeted vs. Federated Dispatch

When a request arrives at `GET /api/search/query`, `HybridSearchEngine` inspects `query.types` against `search.engines.hybrid.routing`:

- **Single-engine dispatch**: When all requested types map to the same backend, the router delegates the query directly to that sub-engine and preserves its native `nextPageCursor`.
- **Federated parallel fan-out**: When `query.types` is empty (portal-wide search) or spans multiple backends, the router dispatches scoped queries concurrently across every target sub-engine.
- **Unmapped category fallback**: When a requested document type has no explicit entry in `routing`, the router falls back to `routing.default` if configured, or returns an empty result set.
- **Fault isolation**: Multi-engine queries execute via `Promise.allSettled`. If one backend throws an error, the router logs the failure and still returns results from all healthy sub-engines.

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                                HTTP Search Request                                │
│                               GET /api/search/query                               │
└─────────────────────────────────────────┬─────────────────────────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                            HybridSearchEngine Router                              │
│                                                                                   │
│      Evaluates requested document categories (types) against routing matrix       │
│                                         │                                         │
│                    ┌────────────────────┴────────────────────┐                    │
│                    ▼                                         ▼                    │
│         Single-Engine Request                      Multi-Engine Request           │
│       (Targeted Direct Dispatch)            (Promise.allSettled Parallel Fan-Out) │
└────────────────────┬─────────────────────────────────────────┬────────────────────┘
                     │                                         │
                     ▼                                         ▼
┌─────────────────────────────────────────┐ ┌───────────────────────────────────────┐
│        Target Search Sub-Engine         │ │    Sub-Engine A    Sub-Engine B ...   │
│    (Preserves Native nextPageCursor)    │ └──────────────────┬────────────────────┘
└────────────────────┬────────────────────┘                    │
                     │                                         ▼
                     │                      ┌───────────────────────────────────────┐
                     │                      │      Result Merger & Normalizer       │
                     │                      │  (interleave / score-normalized-sort) │
                     │                      └──────────────────┬────────────────────┘
                     │                                         │
                     └────────────────────┬────────────────────┘
                                          │
                                          ▼
┌───────────────────────────────────────────────────────────────────────────────────┐
│                            Consolidated Search Response                           │
└───────────────────────────────────────────────────────────────────────────────────┘
```

---

## Federated Result Merging & Pagination

Different search backends score hits on incompatible numerical scales (for example, Typesense text-match scores vs. Vertex AI Search `[0.0, 1.0]` relevance scores). Sorting raw scores directly would let one backend permanently dominate page one.

```text
┌─────────────────────────────────────────────────────────────────────────────────────────────┐
│                       Federated Result Merging Strategies (Example)                         │
├─────────────────────────────────────────────────────────────────────────────────────────────┤
│  Example Engine Responses (Heterogeneous Scoring Scales)                                    │
│  • Engine A Hits (e.g. BM25 / Text Match): [ Doc A1 (450),  Doc A2 (210),  Doc A3 (90) ]    │
│  • Engine B Hits (e.g. Semantic Score):    [ Doc B1 (0.92), Doc B2 (0.84), Doc B3 (0.61) ]  │
├─────────────────────────────────────────────┬───────────────────────────────────────────────┤
│  Strategy 1: interleave (Default)           │  Strategy 2: score-normalized-sort            │
├─────────────────────────────────────────────┼───────────────────────────────────────────────┤
│  • Ignores numerical scores                 │  • Scales scores onto [0.0, 1.0] per batch    │
│  • Alternates engines by rank position      │  • Sorts globally by normalized score         │
│                                             │                                               │
│  Merged Order:                              │  Normalized Scores:                           │
│  1. Doc A1 (Engine A, Rank 1)               │  • Engine A: A1 (1.00), A2 (0.47), A3 (0.20)  │
│  2. Doc B1 (Engine B, Rank 1)               │  • Engine B: B1 (1.00), B2 (0.91), B3 (0.66)  │
│  3. Doc A2 (Engine A, Rank 2)               │                                               │
│  4. Doc B2 (Engine B, Rank 2)               │  Merged Order (Descending):                   │
│  ...                                        │  1. Doc A1 (1.00) / Doc B1 (1.00)             │
│                                             │  2. Doc B2 (0.91), 3. Doc B3 (0.66) ...       │
└─────────────────────────────────────────────┴───────────────────────────────────────────────┘
```

1. **`interleave` (Default)**: Pulls one hit from each engine's result list in round-robin order. Choose this when you want guaranteed equal representation from every category on the first page.
2. **`score-normalized-sort`**: Divides each hit's score by the maximum score in that engine's batch (`score / maxScore`). When an engine returns hits without numerical scores, the router assigns linear rank-decay fallback scores (`1 - index / length`) to preserve internal rank order before sorting all hits descending.

> [!IMPORTANT]
>
> **Pagination Behavior**:
>
> - **Single-engine queries** forward `pageLimit` and `pageCursor` directly to the target sub-engine and return its `nextPageCursor` unchanged for full multi-page navigation.
> - **Multi-engine federated queries** slice the merged array to `pageLimit` (default `25`) and omit `nextPageCursor` because engine-specific cursors cannot be offset-aligned across separate backends after interleaving or score normalization. Users paginate deeply by selecting a category tab, which routes through the single-engine path.

---

## Installation

Install the router and desired sub-engine packages in `packages/backend`:

```bash
yarn --cwd packages/backend add \
  @backstage-community/plugin-search-backend-module-hybrid \
  @backstage-community/plugin-search-backend-module-typesense \
  @backstage-community/plugin-search-backend-module-vertexai
```

Register the router alongside the `/hybrid` entry points of each sub-engine in `packages/backend/src/index.ts`:

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));

// Sub-engines MUST use their /hybrid subpath exports in Hybrid mode
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense/hybrid'),
);
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai/hybrid'),
);

backend.start();
```

---

## Configuration

Configure `search.engines.hybrid` alongside your sub-engines in `app-config.yaml`:

```yaml
search:
  engines:
    hybrid:
      mergeStrategy: score-normalized-sort
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
      types:
        techdocs:
          indexing:
            enabled: false
          datastore:
            projectId: ${GCP_PROJECT_ID}
            datastoreId: ${VERTEX_TECHDOCS_DATASTORE_ID}
            location: europe-west4
      cleanup:
        enabled: true
        frequency: { hours: 2 }

techdocs:
  publisher:
    googleGcs:
      bucketName: ${TECHDOCS_GCS_BUCKET}
```

### Parameter Reference Matrix

| Parameter                                   | Type / Required                                      | Default        | Description                                                                                                                                 |
| :------------------------------------------ | :--------------------------------------------------- | :------------- | :------------------------------------------------------------------------------------------------------------------------------------------ |
| **`search.engines.hybrid.mergeStrategy`**   | `'interleave' \| 'score-normalized-sort'` (Optional) | `'interleave'` | Algorithm used to consolidate multi-engine search responses.                                                                                |
| **`search.engines.hybrid.routing.<type>`**  | `string` (Optional)                                  | –              | Maps a Backstage document type (e.g., `software-catalog`, `techdocs`) to a registered sub-engine name (`typesense`, `vertexai`, or custom). |
| **`search.engines.hybrid.routing.default`** | `string` (Optional)                                  | –              | Fallback sub-engine name used for collator indexing and queries targeting unmapped document types.                                          |

---

## Integrating a Custom Sub-Engine (`hybridSearchEngineRegistryExtensionPoint`)

Pre-built `/hybrid` modules are already included for Typesense and Vertex AI Search. To integrate another search backend (such as Elasticsearch or OpenSearch), implement Backstage's `SearchEngine` interface and register it with `hybridRegistry.registerEngine`:

```typescript
import { Writable } from 'node:stream';
import {
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import {
  QueryTranslator,
  SearchEngine,
} from '@backstage/plugin-search-backend-node';
import {
  IndexableResultSet,
  SearchQuery,
} from '@backstage/plugin-search-common';
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';

export class CustomSearchEngine implements SearchEngine {
  setTranslator(_translator: QueryTranslator): void {}

  async getIndexer(_type: string): Promise<Writable> {
    return new Writable({
      objectMode: true,
      write(_chunk, _encoding, callback) {
        callback();
      },
    });
  }

  async query(_query: SearchQuery): Promise<IndexableResultSet> {
    return { results: [] };
  }
}

export const searchModuleCustomHybrid = createBackendModule({
  pluginId: 'search',
  moduleId: 'custom-hybrid-search',
  register(env) {
    env.registerInit({
      deps: {
        hybridRegistry: hybridSearchEngineRegistryExtensionPoint,
        logger: coreServices.logger,
      },
      async init({ hybridRegistry, logger }) {
        logger.info('Registering custom sub-engine with Hybrid Search Router.');
        const engine = new CustomSearchEngine();

        hybridRegistry.registerEngine('custom-engine', engine, {
          supportsTypes: ['software-catalog', 'custom-type'],
        });
      },
    });
  },
});
```
