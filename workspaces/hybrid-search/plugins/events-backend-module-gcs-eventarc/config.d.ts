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
  events?: {
    modules?: {
      gcsEventarcWebhook?: {
        oidc?: {
          enabled?: boolean;
          audience: string;
          serviceAccountEmail?: string;
        };
        /**
         * The maximum number of concurrent document deletion operations permitted during delta-reconciliation.
         * @visibility backend
         */
        maxConcurrency?: number;
        /**
         * The Express body-parser size limit for the incoming webhook payload (e.g. '100kb', '1mb').
         * @visibility backend
         */
        payloadSizeLimit?: string;
        /**
         * The maximum number of documents to import in a single inline request.
         * Must be between 1 and 100.
         * @visibility backend
         */
        batchSize?: number;
      };
    };
  };
  search?: {
    engines?: {
      vertexai?: {
        indexing?: {
          /**
           * Global local indexing toggle read to detect conflicts with Eventarc ingestion.
           */
          enabled?: boolean;
        };
        types?: {
          techdocs?: {
            indexing?: {
              /**
               * Per-type local indexing toggle for TechDocs. Must be false or omitted when Eventarc ingestion is active.
               */
              enabled?: boolean;
            };
            datastore: {
              /**
               * The Google Cloud Project ID where the TechDocs data store is located.
               */
              projectId: string;
              /**
               * The target TechDocs Data Store ID.
               */
              datastoreId: string;
              /**
               * The geographic location/region of the TechDocs data store (e.g. 'global', 'europe-west4').
               */
              location: string;
            };
          };
        };
      };
    };
  };
}
