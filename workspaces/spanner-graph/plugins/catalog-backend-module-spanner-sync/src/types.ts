/*
 * Copyright 2026 The Backstage Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/**
 * Configuration options for synchronizing the Backstage Catalog into Cloud Spanner Graph.
 *
 * @public
 */
export interface SpannerSyncConfig {
  /** Whether periodic synchronization to Cloud Spanner Graph is enabled (defaults to true). */
  enabled?: boolean;
  /** Google Cloud project ID hosting the Spanner instance. Omit to rely on Application Default Credentials. */
  projectId?: string;
  /** Cloud Spanner instance ID. */
  instanceId: string;
  /** Cloud Spanner database ID. */
  databaseId: string;
  /** Whether to automatically create missing Spanner Graph DDL tables and property graph at startup (defaults to true). */
  autoCreateSchema?: boolean;
  /** Whether to generate Vertex AI vector embeddings in-database during sync (defaults to false). */
  enableEmbeddings?: boolean;
  /** Vertex AI embedding model identifier registered in Spanner (defaults to 'TextEmbeddingModel'). */
  embeddingModel?: string;
  /** Maximum number of entities per Spanner mutation batch (defaults to 500). */
  batchSize?: number;
  /** ISO-8601 duration between sync runs (defaults to 'PT2M'). */
  scheduleFrequency?: string;
  /** ISO-8601 duration timeout for a single sync run (defaults to 'PT10M'). */
  scheduleTimeout?: string;
}

/**
 * Row representation of a Backstage catalog entity stored in the Spanner `entities` node table.
 *
 * @public
 */
export interface SpannerEntityRow {
  entity_id: string;
  entity_ref: string;
  api_version: string;
  kind: string;
  namespace: string;
  name: string;
  title: string | null;
  description: string | null;
  lifecycle: string | null;
  owner_ref: string | null;
  system_ref: string | null;
  metadata_json: Record<string, unknown>;
  spec_json: Record<string, unknown>;
  etag: string | null;
  updated_at: string;
  sync_run_id: string;
}

/**
 * Row representation of a directed Backstage catalog relation stored in the interleaved Spanner `relations` edge table.
 *
 * @public
 */
export interface SpannerRelationRow {
  entity_ref: string;
  relation_type: string;
  target_entity_ref: string;
  originating_entity_id: string;
  source_entity_ref: string;
  updated_at: string;
  sync_run_id: string;
}

/**
 * Summary telemetry returned after a completed Cloud Spanner Graph catalog sync run.
 *
 * @public
 */
export interface SyncSummary {
  syncRunId: string;
  entitiesSynced: number;
  relationsSynced: number;
  staleEntitiesDeleted: number;
  embeddingsGenerated: number;
  durationMs: number;
}
