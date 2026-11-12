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
    /**
     * Optional LLM configuration for direct natural-language-to-ISO-GQL translation.
     */
    llm?: {
      /**
       * LLM provider used to translate natural-language questions into structured graph intents.
       * @default 'vertex'
       */
      provider?: 'vertex' | 'gemini' | 'litellm' | 'openai' | 'disabled';
      /**
       * Model identifier used by the selected LLM provider.
       * @default 'gemini-3-flash-preview'
       */
      model?: string;
      /**
       * Vertex AI location used when `provider` is `'vertex'`.
       * @default 'global'
       */
      location?: string;
      /**
       * OpenAI/LiteLLM-compatible base URL when `provider` is `'litellm'` or `'openai'`.
       */
      baseUrl?: string;
      /**
       * API key used when `provider` is `'gemini'`, `'litellm'`, or `'openai'`.
       * @visibility secret
       */
      apiKey?: string;
    };
  };
}
