# Cloud Spanner Graph Workspace for Backstage

This workspace contains Backstage plugins that mirror the Software Catalog into [Google Cloud Spanner Graph](https://cloud.google.com/spanner/docs/graph/overview) and serve multi-hop dependency, ownership, blast-radius, and natural-language queries over ISO GQL.

## Architecture (CQRS Split)

Backstage's native catalog engine is tightly coupled to relational SQL semantics, locking, and stitching tables (`refresh_state`, `relations`, `final_entities`, and `search`). Replacing PostgreSQL directly would require forking `@backstage/plugin-catalog-backend`.

Instead, this workspace separates catalog writes from graph reads using a Command Query Responsibility Segregation (CQRS) pattern:

- **Write path (PostgreSQL / SQLite)**: Backstage continues to ingest, validate, process, and stitch catalog entities in its primary database without any core modifications.
- **Read path (Cloud Spanner Graph)**: A scheduled backend module replicates stitched entities into `entities` and interleaved `relations` tables exposed through the `BackstageCatalogGraph` property graph. A dedicated backend plugin then runs parameterized ISO GQL (`MATCH p = ACYCLIC`) traversals in a single database round-trip.

This eliminates the browser-side `POST /api/catalog/entities/by-refs` crawl waterfall on dense catalogs while keeping Backstage's standard ingestion pipeline intact.

## Packages

| Package                                                                                                            | Role                                                                                                                                                                                                                                                                                          |
| :----------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`@backstage-community/plugin-catalog-backend-module-spanner-sync`](./plugins/catalog-backend-module-spanner-sync) | Scheduled catalog backend module that provisions the Cloud Spanner Graph schema (`entities`, interleaved `relations`, secondary indexes, and `BackstageCatalogGraph`), writes chunked node/edge upserts, and reconciles stale rows with empty-catalog protection.                             |
| [`@backstage-community/plugin-spanner-graph-backend`](./plugins/spanner-graph-backend)                             | Backend plugin that executes parameterized multi-hop ISO GQL (`MATCH p = ACYCLIC`) traversals, compiles natural-language questions into validated GQL via `@google/genai` + `zod`, exposes `/subgraph`, `/natural-query`, and `/health`, and registers three read-only Backstage MCP actions. |
| [`@backstage-community/plugin-spanner-graph`](./plugins/spanner-graph)                                             | Frontend plugin providing `<SpannerCatalogGraphCard />`, `<SpannerGraphPage />`, `<SpannerNaturalQueryCard />`, and New Frontend System blueprints via `@backstage-community/plugin-spanner-graph/alpha`.                                                                                     |

## Local Development

Install dependencies and launch the local Backstage development portal from inside this workspace:

```bash
cd workspaces/spanner-graph
yarn install
yarn start
```

### Connecting to a Live Cloud Spanner Instance

1. Provision an `ENTERPRISE` edition Cloud Spanner instance, the `backstage-catalog` schema, Vertex AI API enablement, and least-privilege IAM bindings using the Terraform configuration in [`./examples/terraform`](./examples/terraform).
2. Authenticate locally with Application Default Credentials (`gcloud auth application-default login`).
3. Create `workspaces/spanner-graph/app-config.local.yaml` with your Google Cloud project, instance, and database IDs:

```yaml
catalog:
  spannerSync:
    enabled: true
    projectId: your-gcp-project
    instanceId: backstage-graph-instance
    databaseId: backstage-catalog
    autoCreateSchema: true
    enableEmbeddings: false
    batchSize: 500
    schedule:
      frequency: PT2M
      timeout: PT10M

spannerGraph:
  projectId: your-gcp-project
  instanceId: backstage-graph-instance
  databaseId: backstage-catalog
  graphName: BackstageCatalogGraph
  maxDepth: 5
  llm:
    provider: vertex
    model: gemini-3-flash-preview
    location: global
```

4. Start the portal with `yarn start`. The sync module runs its first catalog sync 15 seconds after startup, populating Spanner with the sample catalog in [`./examples/entities.yaml`](./examples/entities.yaml).
