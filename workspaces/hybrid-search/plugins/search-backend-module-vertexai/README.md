# Vertex AI Search Backend Module for Backstage (`@backstage-community/plugin-search-backend-module-vertexai`)

`@backstage-community/plugin-search-backend-module-vertexai` integrates Google Cloud Vertex AI Search (Discovery Engine API) with Backstage Search. It brings managed semantic retrieval, natural-language query understanding, and extractive answers to Backstage without requiring self-hosted search infrastructure.

The module can run standalone as the portal's primary search engine or attach as a sub-engine under `@backstage-community/plugin-search-backend-module-hybrid`.

---

## Architecture Overview

```text
┌───────────────────────────────────────────────────────────────────────────────────┐
│                      Vertex AI Search Module Architecture                         │
├───────────────────────────────────────────────────────────────────────────────────┤
│                                                                                   │
│  [ Extension Points ]                                                             │
│    ├── Standalone Mode       : searchEngineRegistryExtensionPoint                 │
│    └── Hybrid Sub-Engine Mode: hybridSearchEngineRegistryExtensionPoint (/hybrid) │
│                                                                                   │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Query & Reconciling Indexer Pipeline                                        │  │
│  │                                                                             │  │
│  │ Collator Streams ──► [ BatchSearchEngineIndexer (contentHash + Eviction) ]  │  │
│  │ SearchQuery      ──► [ AIP-160 Filter Translator (autoPaginate: false) ]    │  │
│  └──────────────────────────────────────────────────┬──────────────────────────┘  │
│                                                     │ (GCP ADC + Regional gRPC)   │
│                                                     ▼                             │
│  ┌─────────────────────────────────────────────────────────────────────────────┐  │
│  │ Google Cloud Discovery Engine API (global / regional endpoints)             │  │
│  │                                                                             │  │
│  │  ┌───────────────────────────────────┐    ┌──────────────────────────────┐  │  │
│  │  │ Global Blended Search App         │    │ Dedicated Search Apps        │  │  │
│  │  │ (Standalone Multi-Type Queries)   │    │ (Per-Type Serving Configs)   │  │  │
│  │  └─────────────────┬─────────────────┘    └──────────────┬───────────────┘  │  │
│  │                    ▼                                     ▼                  │  │
│  │  ┌───────────────────────────────────────────────────────────────────────┐  │  │
│  │  │ Google Cloud Data Stores                                              │  │  │
│  │  │  ├── backstage-techdocs         (Direct or Eventarc Ingestion)        │  │  │
│  │  │  └── backstage-software-catalog (Direct Reconciling Ingestion)        │  │  │
│  │  └───────────────────────────────────────────────────────────────────────┘  │  │
│  └─────────────────────────────────────────────────────────────────────────────┘  │
│                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────┘
```

### Core Capabilities

- **Regional & Global Endpoint Routing**: Dynamically routes `SearchServiceClient` and `DocumentServiceClient` instances to `<location>-discoveryengine.googleapis.com` or `global` endpoints based on each configured Data Store and Search App.
- **Single-Page Query Execution (`autoPaginate: false`)**: Disables GAX auto-pagination so each Backstage query fetches only the requested page (`pageSize`, `pageToken`) and returns Discovery Engine's `nextPageToken` as Backstage's `nextPageCursor`.
- **Canonical Filter Translation**: Converts Backstage filter predicates into AIP-160 expressions (`namespace: ANY("default") AND kind: ANY("Component", "API")`) while preserving exact entity casing required by Discovery Engine string filters.
- **Three-Phase Reconciling Indexer (`BatchSearchEngineIndexer`)**: When direct indexing is enabled, skips unchanged documents via SHA-256 `contentHash` comparison, retries transient gRPC errors with exponential backoff and jitter, verifies LRO `failureCount`, evicts deleted documents only on clean stream completion, and closes gRPC channels on teardown.

---

## Ingestion Modes

By default, local collator indexing is disabled (`indexing.enabled: false`). You can enable direct collator indexing globally or per document type depending on your architecture.

### Option A: Direct Reconciling Collator Indexing

Enable `indexing.enabled: true` when Backstage collators (such as `software-catalog` or smaller `techdocs` deployments) should stream directly from the Node.js backend into Vertex AI Search.

`VertexAISearchEngine` returns a `BatchSearchEngineIndexer` implementation that executes a three-phase reconciliation cycle on every scheduled collator run:

1. **`initialize()` — Snapshot Stored Hashes**: Pages through `client.listDocuments` (`pageSize: 1000`, `autoPaginate: false`) to populate a map of existing document IDs and stored `contentHash` digests.
2. **`index(documents)` — Delta Import & Validation**:
   - Requires `title` and `location`, while normalizing missing or empty `text` to `""` so catalog entities without descriptions remain searchable.
   - Computes deterministic `docId = md5(location)` and `contentHash = sha256(canonicalJson)` (sorted keys over normalized fields, excluding `contentHash`), recording every valid `docId` in `seenIds`.
   - Imports only documents whose `contentHash` differs from the pre-run snapshot. When a batch has zero changed documents, both `importDocuments` and `throttleMs` sleep are skipped.
   - Inspects `[response, metadata]` from `operation.promise()`. If `metadata.failureCount > 0`, logs `response.errorSamples` and throws an error so `BatchSearchEngineIndexer` aborts before `_final` and skips eviction.
3. **`finalize()` & `_destroy()` — Clean-End Eviction & Channel Cleanup**:
   - `finalize()` runs **only** when the collator stream ends cleanly without upstream or import errors, deleting every stored document ID absent from `seenIds` (ignoring `NOT_FOUND` gRPC status `5`).
   - Transient gRPC status codes `4` (`DEADLINE_EXCEEDED`), `8` (`RESOURCE_EXHAUSTED`), and `14` (`UNAVAILABLE`) are retried with exponential backoff and random jitter across `listDocuments`, `importDocuments`, and `deleteDocument`.
   - `_destroy()` always closes `DocumentServiceClient` to prevent gRPC channel leaks.

### Option B: Decoupled Eventarc Ingestion & Orphan Sweeper (Recommended for Large TechDocs)

Keep `indexing.enabled: false` on `techdocs` when TechDocs sites are built in CI/CD and published to Google Cloud Storage (GCS):

1. **No-Op Collator Bypass**: `getIndexer('techdocs')` returns a lightweight no-op stream so Backstage never downloads or parses HTML archives on the Node.js event loop.
2. **Real-Time Webhook Sync**: Publishing `search_index.json` to GCS triggers [`@backstage-community/plugin-events-backend-module-gcs-eventarc`](../events-backend-module-gcs-eventarc/README.md), which enriches pages with Catalog metadata and imports them into Vertex AI Search.
3. **Orphaned TechDocs Sweeper (`techdocs-orphan-sweeper`)**: When `techdocs` local indexing is disabled and `cleanup.enabled` is not `false`, a scheduled background task reconciles GCS prefixes against active Catalog entities, purges deleted components' pages from Vertex AI Search using a single shared `DocumentServiceClient` per sweep (closed in `finally`), and removes orphaned files from GCS.

> [!IMPORTANT]
>
> **Startup Grace Period**: `techdocs-orphan-sweeper` waits `cleanup.initialDelay` (default `{ minutes: 2 }`) before its first run so `CatalogService` finishes bootstrapping before orphan checks execute.

---

## Extractive Content Resolution Cascade

Vertex AI Search returns match previews at multiple levels of granularity. The engine maps each hit into Backstage's `document.text` preview field using a strict four-tier priority cascade:

```text
┌───────────────────────────────────────────────────────────────────────────────────────────────┐
│                           Extractive Content Resolution Cascade                               │
├───────────────────────────────────────────────────────────────────────────────────────────────┤
│  Priority 1: Extractive Answers     ──► Direct sentence answers to natural-language questions │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 2: Extractive Segments    ──► Paragraph blocks surrounding matching concepts        │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 3: Highlighted Snippets   ──► Keyword-matched text fragments                        │
│                 │ (If missing / empty)                                                        │
│                 ▼                                                                             │
│  Priority 4: Fallback Document Body ──► Indexed document text (structData.text)               │
└───────────────────────────────────────────────────────────────────────────────────────────────┘
```

| Priority | Source Field                            | Formatting Behavior                                                               |
| :------: | :-------------------------------------- | :-------------------------------------------------------------------------------- |
|  **1**   | `derivedStructData.extractive_answers`  | Non-empty answers joined with `' '` (Enterprise tier Search App required).        |
|  **2**   | `derivedStructData.extractive_segments` | Non-empty segments joined with `'\n...\n'` (Enterprise tier Search App required). |
|  **3**   | `derivedStructData.snippets`            | Non-empty snippets joined with `' '` (Standard and Enterprise tiers).             |
|  **4**   | `structData.text`                       | Raw indexed document text (or `""` when empty).                                   |

---

## Installation

Install the package in `packages/backend`:

```bash
yarn --cwd packages/backend add @backstage-community/plugin-search-backend-module-vertexai
```

### 1. Standalone Mode (Primary Search Engine)

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai'),
);

backend.start();
```

### 2. Hybrid Mode (Sub-Engine under Hybrid Router)

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-search-backend'));
backend.add(import('@backstage-community/plugin-search-backend-module-hybrid'));
backend.add(
  import('@backstage-community/plugin-search-backend-module-vertexai/hybrid'),
);
backend.add(
  import('@backstage-community/plugin-search-backend-module-typesense/hybrid'),
);

backend.start();
```

---

## Configuration

> [!WARNING]
>
> **`blendedSearch` Applies Only to Standalone Mode**:
> Configure `blendedSearch` only when Vertex AI Search is the standalone primary search engine serving multi-type queries. In Hybrid Router mode, omit `blendedSearch` when other sub-engines participate in `search.engines.hybrid.routing`; otherwise startup throws a configuration conflict error.

> [!NOTE]
>
> **Blended Search Relevance Scores**:
> Discovery Engine blended Search Apps merge hits across multiple Data Stores without populating `rankSignals.relevanceScore`, so `score` is `undefined` on blended responses. Single-datastore queries populate `relevanceScore` normally.

### 1. Standalone Configuration (Direct Catalog Indexing + Eventarc TechDocs)

```yaml
search:
  engines:
    vertexai:
      blendedSearch:
        projectId: company-portal-prod
        location: europe-west4
        engineId: backstage-global-search-app
        searchOptions:
          contentSearchSpec:
            extractiveContentSpec:
              maxExtractiveAnswerCount: 1
              maxExtractiveSegmentCount: 2

      # Engine-level indexing defaults and rate-limit/retry tuning
      indexing:
        enabled: false
        batchSize: 100
        throttleMs: 0
        maxRetries: 3
        initialRetryDelayMs: 500

      types:
        techdocs:
          indexing:
            enabled: false # Offloaded to GCS Eventarc webhook
          datastore:
            projectId: company-core-prod
            datastoreId: backstage-techdocs
            location: europe-west4
          engine:
            projectId: company-core-prod
            engineId: backstage-techdocs-search
            location: europe-west4
        software-catalog:
          indexing:
            enabled: true # Reconciled directly via BatchSearchEngineIndexer
          datastore:
            projectId: company-catalog-prod
            datastoreId: backstage-catalog
            location: europe-west4

      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }

techdocs:
  publisher:
    type: googleGcs
    googleGcs:
      bucketName: my-techdocs-bucket
```

### 2. Hybrid Router Configuration

```yaml
search:
  engines:
    hybrid:
      mergeStrategy: score-normalized-sort
      routing:
        techdocs: vertexai
        software-catalog: typesense
        default: typesense
    vertexai:
      types:
        techdocs:
          indexing:
            enabled: false
          datastore:
            projectId: company-core-prod
            datastoreId: backstage-techdocs
            location: europe-west4
          engine:
            projectId: company-core-prod
            engineId: backstage-techdocs-search
            location: europe-west4
          searchOptions:
            contentSearchSpec:
              snippetSpec:
                maxSnippetCount: 1
      cleanup:
        enabled: true
        frequency: { hours: 2 }
        initialDelay: { minutes: 2 }

techdocs:
  publisher:
    type: googleGcs
    googleGcs:
      bucketName: my-techdocs-bucket
```

### Parameter Reference Matrix

| Parameter                                | Type / Required                            | Default                                      | Description                                                                                                      |
| :--------------------------------------- | :----------------------------------------- | :------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| **`blendedSearch.projectId`**            | `string` (Required if `blendedSearch` set) | –                                            | GCP Project ID hosting the global blended Search App (Standalone mode only).                                     |
| **`blendedSearch.location`**             | `string` (Required if `blendedSearch` set) | –                                            | Location of the global blended Search App (e.g., `'global'`, `'eu'`, `'europe-west4'`).                          |
| **`blendedSearch.engineId`**             | `string` (Required if `blendedSearch` set) | –                                            | Discovery Engine Search App ID linking multiple Data Stores.                                                     |
| **`blendedSearch.searchOptions`**        | `object` (Optional)                        | –                                            | Default Discovery Engine `ISearchRequest` options merged into queries.                                           |
| **`indexing.enabled`**                   | `boolean` (Optional)                       | `false`                                      | Global default for direct collator indexing across configured types.                                             |
| **`indexing.batchSize`**                 | `number` (Optional)                        | `100`                                        | Number of documents buffered per inline `importDocuments` batch (recommended max `100`).                         |
| **`indexing.throttleMs`**                | `number` (Optional)                        | `0`                                          | Delay in milliseconds after each non-empty batch import.                                                         |
| **`indexing.maxRetries`**                | `number` (Optional)                        | `3`                                          | Maximum retry attempts on transient gRPC status codes (`4`, `8`, `14`).                                          |
| **`indexing.initialRetryDelayMs`**       | `number` (Optional)                        | `500`                                        | Initial exponential backoff delay in milliseconds before retrying transient gRPC errors.                         |
| **`types.<type>.datastore.projectId`**   | `string` (Required)                        | –                                            | GCP Project ID hosting the Data Store for `<type>`.                                                              |
| **`types.<type>.datastore.datastoreId`** | `string` (Required)                        | –                                            | Discovery Engine Data Store ID for `<type>`.                                                                     |
| **`types.<type>.datastore.location`**    | `string` (Required)                        | –                                            | Explicit Data Store location (e.g., `'global'`, `'us'`, `'eu'`, `'europe-west4'`).                               |
| **`types.<type>.engine.projectId`**      | `string` (Required if `engine` set)        | –                                            | GCP Project ID hosting the dedicated Search App for `<type>`.                                                    |
| **`types.<type>.engine.engineId`**       | `string` (Required if `engine` set)        | –                                            | Dedicated Search App ID queried for single-category `<type>` searches.                                           |
| **`types.<type>.engine.location`**       | `string` (Required if `engine` set)        | –                                            | Explicit location of the dedicated Search App for `<type>`.                                                      |
| **`types.<type>.indexing.enabled`**      | `boolean` (Optional)                       | Inherits `indexing.enabled`                  | Per-type toggle overriding `indexing.enabled` (`true` for direct collator sync; `false` for external ingestion). |
| **`types.<type>.searchOptions`**         | `object` (Optional)                        | –                                            | Type-specific Discovery Engine `ISearchRequest` options overriding `blendedSearch.searchOptions`.                |
| **`cleanup.enabled`**                    | `boolean` (Optional)                       | `true` (when `techdocs` indexing is `false`) | Enables the `techdocs-orphan-sweeper` task when external TechDocs ingestion is used.                             |
| **`cleanup.frequency`**                  | `object` (Optional)                        | `{ hours: 2 }`                               | Schedule interval (`hours`, `minutes`, or `seconds`) for `techdocs-orphan-sweeper`.                              |
| **`cleanup.initialDelay`**               | `object` (Optional)                        | `{ minutes: 2 }`                             | Startup delay (`minutes` or `seconds`) before the first orphan sweep runs.                                       |

---

## Bulk-Bootstrapping Existing TechDocs (`bootstrap.ts`)

When migrating an existing GCS TechDocs bucket to Vertex AI Search, run `scripts/bootstrap.ts` in two stages:

1. **`prepare-docs`**: Scans the TechDocs GCS bucket for `*/search_index.json`, queries the Backstage Catalog REST API to enrich each page with `owner`, `lifecycle`, `componentType`, `annotations`, and canonical `entity.kind` casing, and writes `.ndjson` files to a temporary staging GCS bucket.
2. **`import-docs`**: Imports staging `.ndjson` files in chunks of `100` via `gcsSource`, checks every LRO's `metadata.failureCount` (logging `errorSamples` on partial failures), and closes `DocumentServiceClient` cleanly on completion.

```bash
# 1. Generate enriched NDJSON files in an empty staging bucket
npx ts-node plugins/search-backend-module-vertexai/scripts/bootstrap.ts prepare-docs \
  --techdocsBucket <your-techdocs-gcs-bucket> \
  --stagingBucket <your-staging-gcs-bucket> \
  --backstageUrl <http://127.0.0.1:7007>

# 2. Import staged NDJSON files into Vertex AI Search
npx ts-node plugins/search-backend-module-vertexai/scripts/bootstrap.ts import-docs \
  --projectId <your-gcp-project-id> \
  --location <global-or-region> \
  --datastoreId <your-techdocs-datastore-id> \
  --stagingBucket <your-staging-gcs-bucket>
```

---

## Infrastructure Provisioning (Terraform)

Enable `discoveryengine.googleapis.com` and `cloudresourcemanager.googleapis.com` on your GCP project before applying Terraform.

### Data Store JSON Schema (`contentHash` + Filterable Attributes)

Declare `title` and `text` key property mappings, mark filterable fields as `"indexable": true`, and mark `"contentHash"` as `"retrievable": true` so `BatchSearchEngineIndexer` can read stored hashes during `initialize()` and skip unchanged documents:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "dynamic": "true",
  "properties": {
    "title": {
      "type": "string",
      "keyPropertyMapping": "title",
      "retrievable": true
    },
    "text": {
      "type": "string",
      "keyPropertyMapping": "description",
      "retrievable": true
    },
    "contentHash": {
      "type": "string",
      "retrievable": true
    },
    "kind": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    },
    "namespace": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    },
    "location": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    },
    "owner": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    },
    "lifecycle": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    },
    "componentType": {
      "type": "string",
      "indexable": true,
      "retrievable": true
    }
  }
}
```

### Terraform Blueprint

```hcl
locals {
  datastores = {
    techdocs = {
      display_name         = "Backstage TechDocs Store"
      create_dedicated_app = true
    }
    catalog = {
      display_name         = "Backstage Catalog Store"
      create_dedicated_app = false
    }
  }
}

# 1. Per-type Data Stores
resource "google_discovery_engine_data_store" "backstage" {
  for_each          = local.datastores
  project           = var.project_id
  location          = var.region
  data_store_id     = "backstage-${each.key}"
  display_name      = each.value.display_name
  industry_vertical = "GENERIC"
  content_config    = "NO_CONTENT"
  solution_types    = ["SOLUTION_TYPE_SEARCH"]
}

# 2. Semi-dynamic Schemas (including retrievable contentHash for delta indexing)
resource "google_discovery_engine_schema" "backstage_schema" {
  for_each      = local.datastores
  project       = var.project_id
  location      = google_discovery_engine_data_store.backstage[each.key].location
  data_store_id = google_discovery_engine_data_store.backstage[each.key].data_store_id
  schema_id     = "default_schema"

  json_schema = jsonencode({
    "$schema" = "https://json-schema.org/draft/2020-12/schema"
    type      = "object"
    dynamic   = "true"
    properties = {
      title         = { type = "string", keyPropertyMapping = "title", retrievable = true }
      text          = { type = "string", keyPropertyMapping = "description", retrievable = true }
      contentHash   = { type = "string", retrievable = true }
      kind          = { type = "string", indexable = true, retrievable = true }
      namespace     = { type = "string", indexable = true, retrievable = true }
      location      = { type = "string", indexable = true, retrievable = true }
      owner         = { type = "string", indexable = true, retrievable = true }
      lifecycle     = { type = "string", indexable = true, retrievable = true }
      componentType = { type = "string", indexable = true, retrievable = true }
    }
  })
}

# 3. Optional Dedicated Search Apps (per Data Store)
resource "google_discovery_engine_search_engine" "dedicated" {
  for_each       = { for k, v in local.datastores : k => v if lookup(v, "create_dedicated_app", false) }
  project        = var.project_id
  location       = var.region
  collection_id  = "default_collection"
  engine_id      = "backstage-${each.key}-search"
  display_name   = "Backstage ${each.value.display_name} Dedicated App"
  data_store_ids = [google_discovery_engine_data_store.backstage[each.key].data_store_id]

  search_engine_config {
    search_tier = "SEARCH_TIER_STANDARD" # Use SEARCH_TIER_ENTERPRISE for extractive answers/segments
  }
}

# 4. Global Blended Search App (Standalone mode only; omit in Hybrid Router mode)
resource "google_discovery_engine_search_engine" "blended_search_engine" {
  project        = var.project_id
  location       = var.region
  collection_id  = "default_collection"
  engine_id      = "backstage-global-search-app"
  display_name   = "Backstage Global Blended Search App"
  data_store_ids = [for ds in google_discovery_engine_data_store.backstage : ds.data_store_id]

  search_engine_config {
    search_tier = "SEARCH_TIER_STANDARD"
  }
}

# 5. Backstage Backend Service Account IAM Roles
resource "google_project_iam_member" "backstage_discovery_engine" {
  project = var.project_id
  role    = "roles/discoveryengine.admin" # Required to import and delete/evict documents
  member  = "serviceAccount:${var.backstage_sa_email}"
}

resource "google_storage_bucket_iam_member" "backstage_techdocs_gcs" {
  bucket = var.techdocs_bucket_name
  role   = "roles/storage.objectAdmin" # Required when techdocs-orphan-sweeper purges GCS folders
  member  = "serviceAccount:${var.backstage_sa_email}"
}
```

---

## Troubleshooting

| Scenario                                        | Symptom                                                                                                | Root Cause                                                                                                       | Resolution                                                                                                      |
| :---------------------------------------------- | :----------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------- |
| **Hybrid `blendedSearch` Conflict**             | Backend startup fails with `Configuration conflict: "search.engines.vertexai.blendedSearch.engineId"`. | `blendedSearch` is configured while `hybrid.routing` delegates categories to other engines.                      | Remove `blendedSearch` in Hybrid mode so `HybridSearchEngine` manages cross-engine blending.                    |
| **Missing `location` Error**                    | Startup throws `Location is missing. Every individual type must explicitly specify a location`.        | A `datastore` or `engine` block under `types.<type>` omitted `location`.                                         | Set an explicit `location` (such as `'global'`, `'eu'`, or `'europe-west4'`) on every `datastore` and `engine`. |
| **Every Collator Run Re-Imports All Docs**      | `Flushing N changed documents` logs appear on every run even when nothing changed.                     | `contentHash` is not marked `"retrievable": true` in the Discovery Engine schema.                                | Add `"contentHash": { "type": "string", "retrievable": true }` to `google_discovery_engine_schema`.             |
| **Partial Import Failure (`failureCount > 0`)** | Logs show `importDocuments reported X failed document(s)` with `errorSamples`.                         | Document fields violate a static schema type constraint in Discovery Engine (eviction is automatically skipped). | Inspect the logged `errorSamples`, align the Data Store JSON schema, and let the next collator run reconcile.   |
| **Kind Filter Returns Zero Hits**               | Filtering by `kind` (e.g., `Component`, `API`) returns empty results on legacy TechDocs pages.         | Documents were previously ingested with lowercase path `kind` instead of canonical `entity.kind`.                | Re-run `bootstrap.ts` or republish `search_index.json` so canonical `kind` values are stored.                   |
| **Deleted Entities Remain in TechDocs Search**  | Removed catalog components still return TechDocs hits when `indexing.enabled: false`.                  | `techdocs-orphan-sweeper` is disabled or `techdocs.publisher.googleGcs.bucketName` is unset.                     | Ensure `cleanup.enabled: true` and `techdocs.publisher.googleGcs.bucketName` points to your TechDocs bucket.    |
