# @backstage-community/plugin-spanner-graph-backend

A Backstage backend plugin that executes parameterized ISO GQL (`MATCH TRAIL`) graph traversals against Google Cloud Spanner Graph to power multi-hop dependency visualization, blast-radius analysis, and natural-language graph search.

## Endpoints

- `GET /api/spanner-graph/health`: Returns service health status.
- `GET /api/spanner-graph/subgraph`: Queries a multi-hop subgraph rooted at `root` with optional `maxDepth`, `direction` (`outgoing`, `incoming`, `both`), `relationTypes`, and `entityKinds` filters. Isolated entities with zero edges still return their single root node.
- `POST /api/spanner-graph/natural-query`: Proxies natural-language topology questions to a configured `aiServiceUrl`.

## Installation

```bash
yarn --cwd packages/backend add @backstage-community/plugin-spanner-graph-backend
```

Register the plugin in `packages/backend/src/index.ts`:

```ts
backend.add(import('@backstage-community/plugin-spanner-graph-backend'));
```
