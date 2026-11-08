# Typesense Search Backend Module for Backstage (`@backstage-community/plugin-search-backend-module-typesense`)

`@backstage-community/plugin-search-backend-module-typesense` integrates [Typesense](https://typesense.org) with Backstage Search. It delivers sub-millisecond typo-tolerant keyword matching, structured facet filtering, and optional built-in vector embeddings without the heap constraints of Lunr or the operational footprint of Elasticsearch.

The package can run standalone as the portal's primary search engine or attach as a sub-engine under `@backstage-community/plugin-search-backend-module-hybrid`.

---

## Architecture Overview

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      Typesense Search Module Architecture                         │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  [ Extension Points ]                                                             │
│    ├── Standalone Mode       : searchEngineRegistryExtensionPoint                 │
│    └── Hybrid Sub-Engine Mode: hybridSearchEngineRegistryExtensionPoint (/hybrid) │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Ingestion & Query Pipeline                                                  │  │
│  │                                                                             │  │
│  │ Collator Streams ──► [ Batch Buffer (100 Docs) ] ──► [ Schema Auto-Mapper ] │  │
│  │                                                             │               │  │
│  │ SearchQuery      ──► [ Filter & DSL Translator ] ───────────┤               │  │
│  └─────────────────────────────────────────────────────────────┼───────────────┘  │
│                                                                │                  │
│                                                                ▼                  │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Typesense Client (API Key Auth, Health Checks & Client-Side Failover)       │  │
│  └──────────────────────────┬───────────────────────────────────┬──────────────┘  │
│                             ▼                                   ▼                 │
│           ┌────────────────────────────┐      ┌────────────────────────────┐      │
│           │ Typesense Node 1           │      │ Typesense Node 2...        │      │
│           │ backstage_software-catalog │      │ backstage_software-catalog │      │
│           │ backstage_techdocs         │      │ backstage_techdocs         │      │
│           └────────────────────────────┘      └────────────────────────────┘      │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Core Capabilities

1. **Multi-Collection Parallel Search**: Queries spanning multiple Backstage document types execute concurrently across `backstage_<type>` collections via `Promise.all` and translate Backstage filters into Typesense `filter_by` expressions (preserving exact field values such as `` kind:=`Component`  ``).
2. **Buffered Bulk Upserts**: Collator streams buffer documents in memory and flush them in bulk batches of `100` using `action: 'upsert'`, flushing any trailing items when the stream closes.
3. **Auto-Dynamic Collection Provisioning**: Before indexing into `backstage_<type>`, the engine checks whether the collection exists and automatically creates it on `404` using a wildcard schema (`{ "name": ".*", "type": "auto" }`) merged with any custom fields configured in `app-config.yaml`.
4. **Raw SDK & Vector Passthroughs**: `clientOptions`, `collections.<type>.fields`, and `collections.<type>.searchOptions` pass straight through to the Typesense client so operators can tune timeouts, retries, `query_by` weights, or server-side embedding models (`ts/all-MiniLM-L6-v2`).

---

## Installation & Backend Integration

Install the package in `packages/backend`:

```bash
yarn --cwd packages/backend add @backstage-community/plugin-search-backend-module-typesense
```

### 1. Standalone Mode (Primary Search Engine)

Use the default package export when Typesense serves every search category in your Backstage portal:

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense'),
);

backend.start();
```

### 2. Hybrid Mode (Sub-Engine under Hybrid Router)

Use the `/hybrid` subpath export when pairing Typesense with `@backstage-community/plugin-search-backend-module-hybrid`:

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));
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

### 1. Standalone Configuration

```yaml
search:
  engines:
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: ${TYPESENSE_HOST}
          port: 8108
          protocol: http
      clientOptions:
        connectionTimeoutSeconds: 5
        numRetries: 3
        logLevel: info
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
          searchOptions:
            query_by: 'title,text,location'
```

### 2. Hybrid Router Configuration

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
        - host: ${TYPESENSE_HOST}
          port: 8108
          protocol: http
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
          searchOptions:
            query_by: 'title,text,location'
```

### 3. Vector / Semantic Search Configuration

Typesense can compute embeddings automatically on ingestion using built-in ML models:

```yaml
search:
  engines:
    typesense:
      apiKey: ${TYPESENSE_API_KEY}
      nodes:
        - host: ${TYPESENSE_HOST}
          port: 8108
          protocol: http
      collections:
        software-catalog:
          fields:
            - name: '.*'
              type: 'auto'
            - name: embedding
              type: 'float[]'
              num_dim: 384
              embed:
                from:
                  - title
                  - text
                model_config:
                  model_name: 'ts/all-MiniLM-L6-v2'
          searchOptions:
            query_by: 'title,text,location,embedding'
```

### Parameter Reference Matrix

| Parameter                              | Type / Required       | Default                               | Description                                                                                                                                               |
| :------------------------------------- | :-------------------- | :------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **`apiKey`**                           | `string` (Required)   | –                                     | Typesense API key with permissions to manage collections, import documents, and run searches.                                                             |
| **`nodes[].host`**                     | `string` (Required)   | –                                     | Hostname or IP address of a Typesense cluster node.                                                                                                       |
| **`nodes[].port`**                     | `number` (Required)   | –                                     | Port exposed by the Typesense service (e.g., `8108` or `443`).                                                                                            |
| **`nodes[].protocol`**                 | `string` (Required)   | –                                     | Transport protocol (`http` or `https`).                                                                                                                   |
| **`nodes[].path`**                     | `string` (Optional)   | `''`                                  | Optional URL path prefix when Typesense sits behind a reverse proxy.                                                                                      |
| **`clientOptions`**                    | `object` (Optional)   | –                                     | Raw options forwarded to the `Typesense.Client` constructor (such as `connectionTimeoutSeconds`, `healthcheckIntervalSeconds`, `numRetries`, `logLevel`). |
| **`collections.<type>.fields`**        | `object[]` (Optional) | `[{ name: '.*', type: 'auto' }]`      | Custom Typesense field definitions created when provisioning `backstage_<type>`.                                                                          |
| **`collections.<type>.searchOptions`** | `object` (Optional)   | `{ query_by: 'title,text,location' }` | Raw Typesense search parameters merged into queries for `<type>` (such as `query_by`, `prefix`, `filter_by`, `sort_by`).                                  |
