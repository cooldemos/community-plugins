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
export interface Config {
  /**
   * Cloud Spanner Graph synchronization configuration for the Backstage Catalog.
   * @visibility backend
   */
  catalog?: {
    spannerSync?: {
      /**
       * Whether periodic synchronization to Cloud Spanner Graph is enabled.
       * @default true
       */
      enabled?: boolean;
      /**
       * Google Cloud project ID hosting the Spanner instance.
       */
      projectId?: string;
      /**
       * Cloud Spanner instance ID.
       */
      instanceId: string;
      /**
       * Cloud Spanner database ID.
       */
      databaseId: string;
      /**
       * Whether to automatically create missing Spanner Graph DDL tables and property graph at startup.
       * @default true
       */
      autoCreateSchema?: boolean;
      /**
       * Whether to generate Vertex AI vector embeddings in-database during sync.
       * @default false
       */
      enableEmbeddings?: boolean;
      /**
       * Vertex AI embedding model identifier registered in Spanner.
       * @default 'TextEmbeddingModel'
       */
      embeddingModel?: string;
      /**
       * Maximum number of entities per Spanner mutation batch.
       * @default 500
       */
      batchSize?: number;
      /**
       * Synchronization schedule configuration.
       */
      schedule?: {
        /**
         * ISO-8601 duration between sync runs (e.g., PT2M).
         */
        frequency?: string;
        /**
         * ISO-8601 duration timeout for a single sync run (e.g., PT10M).
         */
        timeout?: string;
      };
    };
  };
}
