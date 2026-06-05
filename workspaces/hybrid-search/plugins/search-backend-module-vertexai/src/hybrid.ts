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

import {
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { hybridSearchEngineRegistryExtensionPoint } from '@backstage-community/plugin-search-backend-module-hybrid';
import { createVertexAiSearchEngine, scheduleCleanupIfNeeded } from './module';
import { VertexAIEngineOptions } from './VertexAISearchEngine';

/**
 * Hybrid Search Module for Vertex AI Search.
 * Registers Vertex AI Search as a sub-engine inside the Hybrid Search Router.
 *
 * @public
 */
export const searchModuleVertexAISearchHybrid = createBackendModule({
  pluginId: 'search',
  moduleId: 'vertexai-search-hybrid',
  register(env) {
    env.registerInit({
      deps: {
        hybridRegistry: hybridSearchEngineRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({ hybridRegistry, config, logger, scheduler, catalog, auth }) {
        logger.info(
          'Initializing Vertex AI Search Engine for the Hybrid Search Router.',
        );
        const vertexAiSearchEngine = createVertexAiSearchEngine(config, logger);

        // 1. Enforce global blended search app check in hybrid mode
        const vertexAiConfig = config.getConfig('search.engines.vertexai');
        const blendedSearchConfig =
          vertexAiConfig.getOptional<VertexAIEngineOptions['blendedSearch']>(
            'blendedSearch',
          );
        const engineId = blendedSearchConfig?.engineId;
        const routing = config.getOptional('search.engines.hybrid.routing') as
          | Record<string, string>
          | undefined;

        if (routing && engineId) {
          const hasOtherEngines = Object.values(routing).some(
            engineName => engineName !== 'vertexai',
          );
          if (hasOtherEngines) {
            throw new Error(
              'Configuration conflict: "search.engines.vertexai.blendedSearch.engineId" (global blended search app) cannot be configured when hybrid search routing is active and delegating types to other engines. In a hybrid search setup, global query blending is managed by the Backstage Hybrid Search Router, and Vertex AI Search must only query its type-specific datastores. Please remove the "blendedSearch" config block from your "vertexai" configuration.',
            );
          }
        }

        // 2. Discover supported types from hybrid routing config
        const supportedTypes: string[] = [];
        if (routing) {
          for (const [type, engine] of Object.entries(routing)) {
            if (engine === 'vertexai') {
              supportedTypes.push(type);
            }
          }
        }

        if (supportedTypes.length === 0) {
          supportedTypes.push('techdocs');
        }

        logger.info(
          `Registering Vertex AI search engine as sub-engine for types: ${JSON.stringify(
            supportedTypes,
          )}`,
        );

        hybridRegistry.registerEngine('vertexai', vertexAiSearchEngine, {
          supportsTypes: supportedTypes,
        });

        await scheduleCleanupIfNeeded({
          config,
          logger,
          scheduler,
          catalog,
          auth,
        });
      },
    });
  },
});

export default searchModuleVertexAISearchHybrid;
