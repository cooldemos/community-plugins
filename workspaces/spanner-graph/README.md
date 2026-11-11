# Cloud Spanner Graph Workspace for Backstage

This workspace provides plugins for synchronizing a Backstage Software Catalog into [Google Cloud Spanner Graph](https://cloud.google.com/spanner/docs/graph/overview) and exploring multi-hop dependency, ownership, and blast-radius graphs using ISO GQL.

## Packages

- [`@backstage-community/plugin-catalog-backend-module-spanner-sync`](./plugins/catalog-backend-module-spanner-sync): Catalog backend module that periodically mirrors catalog entities and relations into Cloud Spanner Graph tables (`entities` and interleaved `relations`) and automatically provisions the `BackstageCatalogGraph` property graph schema.
- [`@backstage-community/plugin-spanner-graph-backend`](./plugins/spanner-graph-backend): Backend plugin that executes parameterized multi-hop ISO GQL graph traversals (`MATCH TRAIL`) against `BackstageCatalogGraph` and exposes `/subgraph`, `/natural-query`, and `/health` REST endpoints.
- [`@backstage-community/plugin-spanner-graph`](./plugins/spanner-graph): Frontend plugin providing `<SpannerCatalogGraphCard />` for Entity Pages, `<SpannerGraphPage />` for full-screen multi-hop topology exploration, `<SpannerNaturalQueryCard />` for natural-language graph queries, and New Frontend System blueprints via `@backstage-community/plugin-spanner-graph/alpha`.

## Local Development

Install dependencies and launch the local Backstage portal:

```bash
cd workspaces/spanner-graph
yarn install
yarn start
```

To point the local development portal at a live Cloud Spanner instance, create `app-config.local.yaml` with your `catalog.spannerSync` and `spannerGraph` project, instance, and database settings, or provision an instance using the standard `hashicorp/google` configuration in [`examples/terraform`](./examples/terraform).
