# @backstage-community/plugin-spanner-graph-backend

A Backstage backend plugin that executes parameterized ISO GQL (`MATCH p = ACYCLIC`) traversals against Google Cloud Spanner Graph, compiles natural-language catalog questions into validated GQL queries, and exposes read-only Backstage MCP actions.

## Why `MATCH p = ACYCLIC` Instead of `TRAIL`

Backstage's catalog stitcher stores reciprocal relation pairs as separate directed rows in `relations` (for example, `checkout-service -[dependsOn]-> orders-spanner-db` and `orders-spanner-db -[dependencyOf]-> checkout-service`).

ISO GQL's `TRAIL` path mode prevents repeating the same edge key, which still allows a multi-hop query to bounce `A -> B -> A` by walking `dependsOn` in one direction and `dependencyOf` back. Every multi-hop query compiled by this plugin uses `MATCH p = ACYCLIC` to enforce distinct vertices along every path, eliminating reciprocal ping-pong loops and cyclic blowups.

Each subgraph traversal also:

- Validates `graphName` against `/^[A-Za-z_][A-Za-z0-9_]*$/` and clamps requested depth to `1..spannerGraph.maxDepth` (default `5`).
- Caps returned paths with `LIMIT @maxPaths` (`500`), setting `truncated: true` when the cap is reached.
- Unwraps Cloud Spanner's `SAFE_TO_JSON(p)` path elements into deduplicated `nodes` and `edges`, dropping any dangling edges whose endpoint nodes are absent from `nodes`.
- Falls back to a single primary-key lookup against `entities` when an isolated root entity has zero matching edges so the root node still renders.

## Four-Stage Natural-Language-to-ISO-GQL Pipeline

Asking an LLM to write raw GQL strings directly is brittle: models routinely emit Cypher syntax, invent column names, omit cycle guards, or interpolate untrusted text into query clauses. Instead, `SpannerGraphService.executeNaturalQuery()` runs a four-stage compiler in process:

1. **Schema-constrained intent extraction**: Calls the configured LLM provider with `temperature: 0` and JSON output mode to extract a structured intent (`rootEntityRef`, `direction`, `maxDepth`, optional `relationTypes`, `entityKinds`, and `lifecycle`).
2. **Strict `zod` validation**: Validates the parsed JSON with `NaturalGraphQueryIntentSchema.safeParse()`, restricting `relationTypes` to Backstage's `ALLOWED_CATALOG_RELATIONS` allowlist and coercing JSON `null` optional fields to `undefined`. Malformed or hallucinated model output fails cleanly with HTTP `503 ServiceUnavailableError` before Spanner is queried.
3. **Covering-index short-name resolution**: Calls `resolveEntityRefInSpanner()` to resolve short names (such as `orders-spanner-db`) or partial references (`payments/orders-spanner-db`). It runs an exact point seek across `entities` (`entity_ref`) and `entities@{FORCE_INDEX=idx_entities_name}` (`name`, preserving explicit `kind:` or `namespace/` qualifiers) first, falling back to a case-insensitive `idx_entities_name` lookup only when needed.
4. **Parameterized `MATCH p = ACYCLIC` execution & grounded formatting**: `compileNaturalGraphQuery()` binds every filter value through query parameters (`@rootRef`, `@relationTypes`, `@entityKinds`, `@lifecycle`, `@maxPaths`) and returns `SAFE_TO_JSON(p) AS path, target.entity_ref AS target_ref`. `matchedNodes` is built strictly from target entities satisfying the compiled `WHERE` filters (while intermediate path vertices stay in `subgraph.nodes` so graph edges keep valid endpoints), and a deterministic summary is returned alongside `executedGql`.

## LLM Providers and External AI Escape Hatch

Select the translation backend with `spannerGraph.llm.provider` in `app-config.yaml` (all upstream LLM calls enforce a 20-second timeout and wrap network/timeout failures in `503 ServiceUnavailableError`):

- **`vertex` (default)**: Calls Vertex AI through `@google/genai` (`vertexai: true`), defaulting to `model: gemini-3-flash-preview` and `location: global`. Authenticates via Application Default Credentials (ADC) with `googleAuthOptions: { projectId }` (falling back to `GOOGLE_CLOUD_PROJECT` or `GCLOUD_PROJECT`), requiring no static API keys.
- **`gemini`**: Calls the Gemini Developer API via `@google/genai` using `spannerGraph.llm.apiKey` (or `GEMINI_API_KEY`), defaulting to `model: gemini-3-flash-preview`.
- **`litellm` / `openai`**: Sends JSON chat-completion requests to `<baseUrl>/chat/completions`. Requires both `spannerGraph.llm.baseUrl` and an explicit `spannerGraph.llm.model` (throwing `501 NotImplementedError` if either is unset), with optional `spannerGraph.llm.apiKey` (or `OPENAI_API_KEY`).
- **`disabled`**: Disables natural-language translation (returning HTTP `501 NotImplementedError`) while keeping `/subgraph` and `/health` active.
- **`spannerGraph.aiServiceUrl` (optional escape hatch)**: When set, `POST /api/spanner-graph/natural-query` proxies directly to `POST <aiServiceUrl>/v1/graph/natural-query` with a 15-second timeout instead of running the in-process LLM compiler (useful for custom GraphRAG or vector-first services).

## Backstage MCP Actions

At startup, the plugin wires `actionsRegistryServiceRef` (`@backstage/backend-plugin-api/alpha`) to register three read-only MCP tools (`readOnly: true`, `idempotent: true`, `destructive: false`) exposed through Backstage's MCP backend at `/api/mcp-actions/v1`:

| Action Name              | Inputs                                                                            | Behavior                                                                                                                                                                               |
| :----------------------- | :-------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query-catalog-subgraph` | `root`, optional `maxDepth` (`1..5`), `direction`, `relationTypes`, `entityKinds` | Runs `getSubgraph()` and returns `rootEntityRef`, `depth`, node/edge counts, `nodes`, and `edges`.                                                                                     |
| `analyze-blast-radius`   | `entityRef`, optional `maxDepth` (`1..5`, default `4`)                            | Runs an `incoming` traversal over canonical operational relations (`dependsOn`, `consumesApi`, `apiProvidedBy`, `partOf`) and returns all impacted entities excluding the root itself. |
| `ask-catalog-graph`      | `query` (`1..1000` chars)                                                         | Runs `executeNaturalQuery()` and returns `{ answer, executedGql, matchedEntityIds }`.                                                                                                  |

## HTTP Endpoints and Error Mapping

`/health` is unauthenticated; `/subgraph` and `/natural-query` require Backstage `user` or `service` credentials via `coreServices.httpAuth`.

| Method & Path                           | Parameters / Body                                                                                                           | Response                                                                                  |
| :-------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------- |
| `GET /api/spanner-graph/health`         | None                                                                                                                        | `{ status: "ok", service: "spanner-graph-backend" }`                                      |
| `GET /api/spanner-graph/subgraph`       | `root` (required), `maxDepth`, `direction` (`outgoing` \| `incoming` \| `both`), `relationTypes` (CSV), `entityKinds` (CSV) | `SubgraphResponse` (`{ rootEntityRef, depth, nodes, edges, truncated, queryDurationMs }`) |
| `POST /api/spanner-graph/natural-query` | `{ query: string }` (`1..1000` trimmed chars)                                                                               | `NaturalLanguageGraphResponse` (`{ answer, executedGql, matchedNodes, subgraph }`)        |

Known Backstage errors map directly to structured `{ error: { name, message } }` JSON responses:

| HTTP Status | Backstage Error           | Trigger                                                                                                                                             |
| :---------- | :------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| `400`       | `InputError`              | Missing/invalid `root`, out-of-range `maxDepth`, invalid `direction`, empty or >1,000-char `query`, or unsafe `graphName`.                          |
| `401`       | `AuthenticationError`     | Missing or invalid Backstage credentials on `/subgraph` or `/natural-query`.                                                                        |
| `403`       | `NotAllowedError`         | Caller credentials rejected by authorization policy.                                                                                                |
| `501`       | `NotImplementedError`     | Natural-language queries disabled (`provider: disabled`) or missing required provider configuration (`projectId`, `apiKey`, `baseUrl`, or `model`). |
| `503`       | `ServiceUnavailableError` | Upstream LLM or `aiServiceUrl` timeout, network failure, non-OK HTTP status, non-JSON payload, or Zod schema validation error.                      |

## Installation

```bash
yarn --cwd packages/backend add @backstage-community/plugin-spanner-graph-backend
```

Register the plugin in `packages/backend/src/index.ts`:

```ts
backend.add(import('@backstage-community/plugin-spanner-graph-backend'));
```

## Configuration

```yaml
spannerGraph:
  projectId: ${GCP_PROJECT_ID}
  instanceId: backstage-graph-instance
  databaseId: backstage-catalog
  graphName: BackstageCatalogGraph
  maxDepth: 5
  llm:
    provider: vertex # vertex | gemini | litellm | openai | disabled
    model: gemini-3-flash-preview
    location: global
  # Optional external AI service escape hatch:
  # aiServiceUrl: https://your-graph-ai-service.internal
```

## Required GCP IAM Roles

- **`roles/spanner.databaseReader`** on the target Cloud Spanner database (or `roles/spanner.databaseUser` if sharing a service account with the sync module).
- **`roles/aiplatform.user`** on the target Google Cloud project when using `llm.provider: vertex`.
