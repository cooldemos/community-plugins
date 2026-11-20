# @backstage-community/plugin-spanner-graph

A Backstage frontend plugin for interactive multi-hop dependency visualization, operational blast-radius analysis, and natural-language topology discovery backed by Google Cloud Spanner Graph.

## How It Eliminates the Browser Crawl Waterfall

Backstage's built-in `@backstage/plugin-catalog-graph` plugin discovers multi-hop links in the browser by issuing sequential `POST /api/catalog/entities/by-refs` requests for each depth tier and downloading full entity JSON documents.

This plugin replaces that multi-step crawl with a single `GET /api/spanner-graph/subgraph` request through `SpannerGraphClient` (`spannerGraphApiRef`) and the `useSpannerGraph` hook, then passes the resolved lightweight `{ nodes, edges }` payload into Backstage's standard `@backstage/core-components` `<DependencyGraph />` canvas.

## Components and Design Details

- **`<SpannerCatalogGraphCard />`**: Interactive Entity Page dependency and blast-radius card with depth (`1..5`), direction (`both`, `outgoing`, `incoming`), and relation preset selectors.
  - **Canonical forward `BLAST_RADIUS_RELATIONS`**: Exports `['dependsOn', 'consumesApi', 'apiProvidedBy', 'partOf']`. Excluding inverse relations (`dependencyOf`, `apiConsumedBy`, `providesApi`, `hasPart`) from incoming blast-radius queries prevents a multi-hop walk from stepping sideways into unrelated sibling dependencies (such as `db <-[dependsOn]- service <-[dependencyOf]- cache`).
  - **Reciprocal edge merging and SVG tooltips**: Collapses parallel and reciprocal edge pairs (such as `dependsOn` / `dependencyOf`) via `mergeParallelEdges()` by default, truncates long node labels to 20 characters with an ellipsis, and attaches native SVG `<title>` tooltips displaying the full `entityRef` and title.
  - **Route-aware explorer deep-links**: Resolves the _Open in Spanner Graph Explorer_ base path from `spannerGraphRouteRef` / `spannerGraphNewRouteRef` (falling back to `/spanner-graph`) so custom mounts like `path: /catalog-graph` work without 404s.
- **`<SpannerGraphPage />`**: Full-screen topology explorer with sidebar controls (`Root Entity Reference`, `Max Depth`, `Traversal Direction`, `Merge reciprocal relations`, `Relation Types`, and `Entity Kinds`) and an optional `children` slot. Keeps URL `searchParams` synchronized with external `?root=` updates and highlights the resolved `data?.rootEntityRef ?? activeRoot` node even when a user searches by short entity name.
- **`<SpannerNaturalQueryCard />`**: Natural-language query card wired to `POST /api/spanner-graph/natural-query`. Renders a grounded `Synthesized Answer`, clickable `Matched Entities` chips that update `?root=<entityRef>` via `useSearchParams` (or invoke `onSelectEntityRef`) to pivot `<SpannerGraphPage />` immediately, a collapsible `Show Executed ISO GQL` `<CodeSnippet />` viewer, and copyable `spannerGraph.llm` setup guidance when the backend returns `501 NotImplementedError`.

## Installation

```bash
yarn --cwd packages/app add @backstage-community/plugin-spanner-graph
```

## New Frontend System Usage (`/alpha`)

`@backstage-community/plugin-spanner-graph/alpha` exports `spannerGraphAlphaPlugin`, `spannerGraphNewRouteRef`, and four declarative blueprints:

| Extension ID                                     | Blueprint                | Default Behavior                                                                                                                                                                |
| :----------------------------------------------- | :----------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `api:spanner-graph`                              | `ApiBlueprint`           | Binds `SpannerGraphClient` to `spannerGraphApiRef` using `discoveryApiRef` and `fetchApiRef`.                                                                                   |
| `entity-card:spanner-graph/spanner-dependencies` | `EntityCardBlueprint`    | Mounts `<SpannerCatalogGraphCard />` on entity dashboards (`maxDepth: 2`, `direction: 'both'`, `height: 380`).                                                                  |
| `entity-content:spanner-graph/blast-radius`      | `EntityContentBlueprint` | Mounts a full-height Blast Radius tab at `/blast-radius` on `resource` and `system` entities (`maxDepth: 4`, `direction: 'incoming'`, `relationTypes: BLAST_RADIUS_RELATIONS`). |
| `page:spanner-graph`                             | `PageBlueprint`          | Mounts `<SpannerGraphPage noHeader />` at `/spanner-graph` bound to `spannerGraphNewRouteRef` (`initialMaxDepth: 3`).                                                           |

Once the plugin is registered in your New Frontend System app, replace the native catalog-graph extensions and customize paths declaratively in `app-config.yaml`:

```yaml
app:
  extensions:
    # 1. Disable the native client-side crawler visualizers
    - page:catalog-graph: false
    - entity-card:catalog-graph/relations: false

    # 2. Mount the Spanner Graph explorer at /catalog-graph
    - page:spanner-graph:
        config:
          path: /catalog-graph
          initialMaxDepth: 3

    # 3. Configure the entity overview card
    - entity-card:spanner-graph/spanner-dependencies:
        config:
          maxDepth: 2
          direction: both
          height: 380

    # 4. Mount the Blast Radius tab on Resource and System pages
    - entity-content:spanner-graph/blast-radius:
        config:
          title: Blast Radius (Spanner Graph)
          path: /blast-radius
          filter: 'kind:resource,system'
          maxDepth: 4
          direction: incoming
```

## Legacy Frontend System Usage

Register the plugin and explorer route in `packages/app/src/App.tsx`:

```tsx
import {
  SpannerGraphExplorerPage,
  SpannerNaturalQueryCard,
  spannerGraphPlugin,
} from '@backstage-community/plugin-spanner-graph';

// Include spannerGraphPlugin in createApp({ plugins: [spannerGraphPlugin] })
<Route
  path="/spanner-graph"
  element={
    <SpannerGraphExplorerPage>
      <SpannerNaturalQueryCard />
    </SpannerGraphExplorerPage>
  }
/>;
```

Add the dependency card and Blast Radius tab in `packages/app/src/components/EntityPage.tsx`:

```tsx
import {
  BLAST_RADIUS_RELATIONS,
  EntitySpannerGraphCard,
} from '@backstage-community/plugin-spanner-graph';

// Entity overview card
<EntitySpannerGraphCard
  variant="gridItem"
  maxDepth={2}
  direction="both"
  height={380}
/>;

// Blast Radius tab
<EntitySpannerGraphCard
  variant="gridItem"
  maxDepth={4}
  direction="incoming"
  relationTypes={BLAST_RADIUS_RELATIONS}
  height={560}
  title="Downstream Blast Radius & Impact Analysis"
/>;
```
