# @backstage-community/plugin-spanner-graph

A Backstage frontend plugin for visualizing and exploring multi-hop dependencies, ownership hierarchies, and blast radius backed by Google Cloud Spanner Graph.

## Components

- `<SpannerCatalogGraphCard />`: Interactive Entity Page dependency and blast-radius card using `@backstage/core-components` `<DependencyGraph />` with configurable traversal depth (`1..5`), direction (`both`, `outgoing`, `incoming`), parallel edge label merging, and clickable entity routing.
- `<SpannerGraphPage />`: Full-screen multi-hop topology explorer with sidebar filters for root entity reference, depth, direction, relation types, and entity kinds.
- `<SpannerNaturalQueryCard />`: Natural-language graph query card displaying synthesized answers, executed ISO GQL statements, and clickable matched entity chips.
- `@backstage-community/plugin-spanner-graph/alpha`: New Frontend System blueprints (`spannerGraphApi`, `entitySpannerGraphCard`, `entitySpannerBlastRadiusContent`, and `spannerGraphPage`).

## Installation

```bash
yarn --cwd packages/app add @backstage-community/plugin-spanner-graph
```
