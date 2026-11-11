# @backstage-community/plugin-catalog-backend-module-spanner-sync

A Backstage catalog backend module that synchronizes Backstage Software Catalog entities (`entities`) and relationships (`relations`) into [Google Cloud Spanner Graph](https://cloud.google.com/spanner/docs/graph/overview).

## Features

- **Zero-Touch Schema Provisioning**: Automatically creates `entities`, interleaved `relations` (`ON DELETE CASCADE`), secondary indexes (`idx_entities_ref`, `idx_entities_kind_ns`, `relations_by_target`), and the `BackstageCatalogGraph` property graph when `autoCreateSchema` is enabled (the default).
- **Idempotent Batch Upserts & Stale Reconciliation**: Normalizes entity references (`kind:namespace/name`), deduplicates composite relation keys, upserts entities and relations in configurable batches, and removes deleted entities and obsolete relations after each sync run.
- **Opt-In Vertex AI Embeddings**: Optionally generates vector embeddings in-database via `ML.PREDICT` when `enableEmbeddings: true` is configured.

## Installation

```bash
yarn --cwd packages/backend add @backstage-community/plugin-catalog-backend-module-spanner-sync
```

Register the module in `packages/backend/src/index.ts`:

```ts
backend.add(import('@backstage/plugin-catalog-backend'));
backend.add(
  import('@backstage-community/plugin-catalog-backend-module-spanner-sync'),
);
```

## Configuration

```yaml
catalog:
  spannerSync:
    enabled: true
    projectId: my-gcp-project
    instanceId: backstage-graph-instance
    databaseId: backstage-catalog
    autoCreateSchema: true
    enableEmbeddings: false
    batchSize: 500
    schedule:
      frequency: PT2M
      timeout: PT10M
```
