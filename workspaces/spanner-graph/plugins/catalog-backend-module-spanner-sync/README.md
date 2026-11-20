# @backstage-community/plugin-catalog-backend-module-spanner-sync

A Backstage catalog backend module that periodically mirrors stitched Backstage Software Catalog entities and relationships into [Google Cloud Spanner Graph](https://cloud.google.com/spanner/docs/graph/overview).

Because it reads entities through Backstage's supported `catalogServiceRef` API (`catalog.getEntities`) instead of querying internal PostgreSQL tables directly, it requires no external streaming infrastructure and stays insulated from upstream catalog database migrations.

## Schema and Indexing Design

When `autoCreateSchema` is enabled (the default), `SpannerSyncService.ensureSchema()` idempotently provisions two relational tables, five secondary indexes, and the `BackstageCatalogGraph` property graph:

- **`entities` (root node table)**: Uses the canonical `entity_ref` (`kind:namespace/name`) directly as its primary key, lowercasing `kind` and `namespace` while preserving entity `name` casing. Storing `metadata_json` and `spec_json` alongside indexed scalar columns (`owner_ref` normalized with default kind `group`, `system_ref` normalized with default kind `system`, `lifecycle`, `title`, and `description`) avoids surrogate-key translation joins.
- **`relations` (interleaved edge table)**: Declared with `PRIMARY KEY (entity_ref, relation_type, target_entity_ref, originating_entity_id)` and `INTERLEAVE IN PARENT entities ON DELETE CASCADE`. Interleaving physically co-locates every entity's outgoing edges inside the parent entity's storage split so forward traversals execute as local single-split joins, and deleting a parent entity removes its outgoing edges atomically.
- **`relations_by_target` reverse secondary index**: Indexes `relations(target_entity_ref, relation_type) STORING (source_entity_ref)`. Because base rows are physically ordered by source `entity_ref`, this covering index gives incoming traversals (`<-[:Relation]-`) direct `O(1)` reverse seeks without scanning across splits.
- **Entity secondary indexes**:
  - `idx_entities_id` on `entities(entity_id)` for UID lookups.
  - `idx_entities_kind_ns` on `entities(kind, namespace)` for kind and namespace filtering.
  - `idx_entities_name` on `entities(name) STORING (kind, namespace, title, lifecycle, owner_ref, system_ref)` for covering short-name resolution in graph and natural-language queries.
  - `idx_entities_owner` on `entities(owner_ref, kind, lifecycle) STORING (name, title, system_ref)` for team-scoped queries.
- **Opt-in vector embeddings (`description_embedding`)**: The `entities` table reserves a nullable `ARRAY<FLOAT32>(vector_length=>768)` column. When `enableEmbeddings: true` is configured alongside a registered Spanner remote Vertex AI model (`TextEmbeddingModel` by default), the sync service runs read-only `ML.PREDICT` queries in 500-row batches for rows with `description_embedding IS NULL` and commits the vectors in a separate write transaction.

## Synchronization Guarantees

Each scheduled run (`catalog-spanner-graph-sync`, coordinated across replicas by `coreServices.scheduler` with a 15-second initial delay) stamps a fresh UUID into `sync_run_id` and enforces four safeguards:

- **Composite primary-key deduplication**: Outgoing edges are deduplicated in memory against `(entity_ref, relation_type, target_entity_ref, originating_entity_id)` before writing so duplicate catalog relations never trigger Spanner batch mutation rejections.
- **Chunked node and edge upserts**: Both `entities` and `relations` `.upsert()` calls are chunked by `batchSize` (default `500`), keeping entities with high fan-out safely inside Spanner's per-transaction mutation limits.
- **Transactional stale reconciliation**: After all entity and relation chunks finish upserting, `reconcileStaleEntities()` runs a read-write transaction (`runTransactionAsync`) that deletes rows in `relations` and `entities` where `sync_run_id != @syncRunId`, removing both deleted entities and obsolete edges from active entities.
- **Empty-catalog wipe protection**: `reconcileStaleEntities()` runs only when the catalog returns at least one entity (`entities.length > 0`), preventing a transient empty catalog response from wiping Spanner.

## Installation

```bash
yarn --cwd packages/backend add @backstage-community/plugin-catalog-backend-module-spanner-sync
```

Register the module alongside `@backstage/plugin-catalog-backend` in `packages/backend/src/index.ts`:

```ts
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage-community/plugin-catalog-backend-module-spanner-sync'),
);
```

## Configuration

Add the `catalog.spannerSync` block to `app-config.yaml`. If the block is omitted or `enabled` is `false`, the module skips initialization cleanly.

```yaml
catalog:
  spannerSync:
    enabled: true
    projectId: ${GCP_PROJECT_ID}
    instanceId: backstage-graph-instance
    databaseId: backstage-catalog
    autoCreateSchema: true
    enableEmbeddings: false
    embeddingModel: TextEmbeddingModel
    batchSize: 500
    schedule:
      frequency: PT2M # Minute-based ISO-8601 duration (PT<n>M)
      timeout: PT10M
```

## Required GCP IAM Roles

- **Backstage runtime service account**: `roles/spanner.databaseUser` on the target Spanner database (required for DDL auto-provisioning, table upserts, and stale-row DML cleanup).
- **Cloud Spanner service agent (only when `enableEmbeddings: true`)**: Grant `roles/aiplatform.user` on the Vertex AI project to `service-<PROJECT_NUMBER>@gcp-sa-spanner.iam.gserviceaccount.com` so Spanner can invoke `ML.PREDICT` against your registered remote embedding model.
