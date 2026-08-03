# Upstream Backstage Search Architecture & Technical Limitations

**Document Status**: Verified Reference  
**Source Repository**: `backstage/backstage` (latest stable commit)  
**Target Workspace**: `workspaces/hybrid-search/docs`

---

## Executive Overview

This document provides a technical analysis of the core search subsystem in upstream Backstage (`@backstage/plugin-search-backend`, `@backstage/plugin-search-backend-node`, `@backstage/plugin-search-common`). Based on a first-principles code and architectural evaluation of the official `backstage/backstage` public repository, this reference details the fundamental structural limitations in ingestion, query contracts, authorization processing, and engine extensibility.

---

## 1. Indexing & Ingestion Pipeline Constraints

### 1.1 Scheduled Bulk Polling vs. Real-Time Incremental Indexing

- **Scheduled Pipeline Model**: Upstream Backstage uses periodic background task runners (`SchedulerServiceTaskRunner`) that execute collator streams (e.g. re-indexing Catalog and TechDocs assets on fixed 10-minute intervals by default).
- **Architectural Non-Goal**: As defined in `docs/features/search/architecture.md`, event-driven or incremental index updates are explicit non-goals for upstream Backstage.
- **Full Index Replacement**: Search engine indexers (such as `ElasticSearchSearchEngineIndexer` or `PgSearchEngineIndexer`) compile a completely new index per run and perform atomic alias swapping upon completion.
- **Operational Impact**: Changes to Software Catalog entities or technical documentation pages incur an inherent staleness window governed by the scheduler frequency. Near real-time index synchronization when entities are modified in the catalog is not supported out of the box.

### 1.2 In-Process Memory Constraints (Lunr Engine)

- **In-Memory Store**: The default zero-config search engine implementation (`LunrSearchEngine.ts`) holds all indexed documents inside Node.js V8 heap memory (`this.docStore: Record<string, IndexableDocument>`).
- **Process & Multi-Replica Limits**: The Lunr engine cannot scale across multi-instance deployment topologies or support non-trivial catalog sizes without causing memory bloat, high garbage collection pauses, or process crashes.

---

## 2. Search Query API & Contract Limitations

### 2.1 Fixed `SearchQuery` Data Interface

The core query contract in `@backstage/plugin-search-common` (`src/types.ts`) is strictly constrained to the following fields:

```typescript
export interface SearchQuery {
  term: string;
  types?: string[];
  filters?: JsonObject;
  pageLimit?: number;
  pageCursor?: string;
}
```

This interface creates structural limitations for downstream search features:

1. **No Custom Sorting or Ordering (`sortBy` / `sortOrder`)**:

   - Results can only be sorted by the underlying engine's static relevance score (`rank`).
   - Sorting results by metadata attributes (e.g., `updatedAt`, `alphabetical`, `popularity`) is impossible via the standard query contract.

2. **No Field-Level Query-Time Weighting or Boosting**:

   - Callers cannot pass field-level boost parameters (e.g., weighting `title^3` vs `text^1`) dynamically at query time.

3. **No Facets or Aggregation Metrics**:

   - `SearchResultSet` only returns matching document items and page cursors.
   - There is no native contract for returning facet counts, category breakdown buckets, or filter aggregation counts.

4. **No Native Vector or Hybrid Search Abstractions**:

   - Upstream Backstage search is strictly **lexical (keyword-based)** across all built-in engine implementations (Lunr, Postgres `tsvector`/`tsquery`, and Elasticsearch match queries).
   - There are no abstractions or interfaces for embeddings, dense vector search (KNN), or hybrid BM25 + dense vector ranking.

5. **Filter Translation Limitations**:
   - Lunr logs warnings and degrades performance when non-scalar filter arrays are passed.
   - Postgres query translation (`PgSearchEngine.ts`) relies on basic string sanitization and string concatenation (`(${p} | ${p}:*)`).

---

## 3. Authorization & Access Control Constraints

In `AuthorizedSearchEngine.ts`, Backstage integrates document visibility with `@backstage/plugin-permission-common`:

### 3.1 Post-Query Filtering for Conditional Permissions

When a user's permissions for a document category are `CONDITIONAL` (e.g., user is restricted to viewing entities owned by their specific team):

- `AuthorizedSearchEngine` queries the underlying search engine for raw candidate results.
- It then filters the returned result array row-by-row in Node.js runtime memory (`filterResults`).
- If the number of authorized results is fewer than the requested page size, it enters a `do ... while` loop to fetch subsequent result pages sequentially from the engine.

### 3.2 Latency Budget Exhaustion & Unpredictable Result Counts

- **Query Latency Budget**: To prevent endless loop execution during post-filtering, `AuthorizedSearchEngine` enforces a latency budget (`queryLatencyBudgetMs`, default `1000ms`).
- **Result Truncation**: If a user has restricted access across a large document set, post-filtering can exhaust the latency budget before filling the target page, yielding truncated or incomplete result sets.
- **Loss of Total Count**: `numberOfResults` is explicitly set to `undefined` whenever conditional permission filtering is active because calculating total matching authorized documents would require fetching and evaluating the entire index.

---

## 4. Engine Infrastructure & Pagination Performance

### 4.1 Engine Module Landscape

Upstream core Backstage only maintains three official search engine modules:

- `@backstage/plugin-search-backend-node` (Lunr)
- `@backstage/plugin-search-backend-module-pg` (Postgres 12+)
- `@backstage/plugin-search-backend-module-elasticsearch` (Elasticsearch 7.x / OpenSearch)

Connecting third-party or specialized search platforms (such as Typesense, Algolia, Solr, Pinecone, or Qdrant) requires writing custom implementations for `SearchEngine`, `QueryTranslator`, and `SearchEngineIndexer`.

### 4.2 Offset Pagination Degradation

- While pagination relies on Base64 cursor strings (`pageCursor`), `decodePageCursor` simply unpacks a zero-based integer page index (`{ page: N }`).
- Under the hood, queries translate to offset fetching (`from: page * pageSize` in Elasticsearch, `OFFSET offset LIMIT limit` in Postgres).
- Deep pagination over large datasets suffers from standard database/Elasticsearch offset scan degradation.

### 4.3 Highlighting Overhead in Postgres

- `PgSearchEngine` uses PostgreSQL `ts_headline` for generating query term highlights. As noted in `docs/features/search/search-engines.md`, `ts_headline` can cause severe database CPU and query performance bottlenecks under load and frequently must be disabled in production (`useHighlight: false`).

---

## Summary Matrix

| Architectural Feature            | Upstream Backstage Support | Technical Bottleneck / Constraint                                         |
| :------------------------------- | :------------------------- | :------------------------------------------------------------------------ |
| **Real-Time Ingestion**          | ❌ Excluded                | Periodic polling; atomic full-index replacements                          |
| **Custom Sorting (`sortBy`)**    | ❌ Unsupported             | Missing from `SearchQuery` interface; score-only ranking                  |
| **Facets & Aggregations**        | ❌ Unsupported             | No facet counts or bucket contracts in `SearchResultSet`                  |
| **Vector / Hybrid Search**       | ❌ Unsupported             | Lexical keyword search only across all default engines                    |
| **Field Boosting at Query Time** | ❌ Unsupported             | Static engine-level field indexing rules only                             |
| **Fine-Grained Authorization**   | ⚠️ Post-Query Filtering    | In-memory loop with `queryLatencyBudgetMs`; `numberOfResults = undefined` |
| **Deep Pagination**              | ⚠️ Offset-based            | Cursors wrap `{ page: N }`; offset scan overhead at scale                 |
