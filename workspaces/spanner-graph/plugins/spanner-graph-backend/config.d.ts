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
   * Cloud Spanner Graph backend query service configuration.
   * @visibility backend
   */
  spannerGraph?: {
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
     * Spanner Property Graph name queried via ISO GQL.
     * @default 'BackstageCatalogGraph'
     */
    graphName?: string;
    /**
     * Maximum traversal depth allowed per subgraph query.
     * @default 5
     */
    maxDepth?: number;
    /**
     * Optional AI microservice endpoint for natural-language graph queries.
     */
    aiServiceUrl?: string;
  };
}
