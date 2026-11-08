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
import { searchEngineRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';
import {
  HybridSearchEngine,
  HybridSearchMergeStrategy,
} from './HybridSearchEngine';
import { SearchEngine } from '@backstage/plugin-search-backend-node';
import {
  hybridSearchEngineRegistryExtensionPoint,
  HybridSearchEngineRegistry,
} from './extensions';

/**
 * Implementation of the Hybrid Search Engine Registry.
 * Used by backend modules to register sub-engines dynamically via the extension point.
 */
class HybridSearchEngineRegistryImpl implements HybridSearchEngineRegistry {
  /**
   * Internal storage for registered engines.
   */
  readonly engines = new Map<
    string,
    { engine: SearchEngine; options: { supportsTypes: string[] } }
  >();

  /**
   * Registers a search sub-engine.
   *
   * @param name - Unique identifier for the sub-engine.
   * @param engine - The search engine implementation.
   * @param options - Additional registration parameters.
   * @param options.supportsTypes - The list of types this engine handles.
   */
  registerEngine(
    name: string,
    engine: SearchEngine,
    options: { supportsTypes: string[] },
  ) {
    this.engines.set(name, { engine, options });
  }
}

/**
 * Search module for the Hybrid Search engine orchestrator.
 * Registers the Hybrid Search extension point and configures the main orchestrator engine.
 *
 * @public
 */
export const searchModuleHybridSearch = createBackendModule({
  pluginId: 'search',
  moduleId: 'hybrid-search',
  register(env) {
    const registry = new HybridSearchEngineRegistryImpl();

    // Register our custom extension point
    env.registerExtensionPoint(
      hybridSearchEngineRegistryExtensionPoint,
      registry,
    );

    env.registerInit({
      deps: {
        searchEngineRegistry: searchEngineRegistryExtensionPoint,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
      },
      async init({ searchEngineRegistry, logger, config }) {
        logger.info(
          'Registering custom Hybrid Search Engine into search registry.',
        );

        const mergeStrategy = config.getOptionalString(
          'search.engines.hybrid.mergeStrategy',
        ) as HybridSearchMergeStrategy | undefined;

        const hybridEngine = new HybridSearchEngine(logger, { mergeStrategy });
        for (const [name, { engine, options }] of registry.engines.entries()) {
          hybridEngine.registerEngine(name, engine, options);
        }

        // Set the orchestrator hybridEngine in the main search backend
        searchEngineRegistry.setSearchEngine(hybridEngine);
      },
    });
  },
});

export default searchModuleHybridSearch;
