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
  LoggerService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import {
  TypesenseSearchEngine,
  TypesenseEngineOptions,
} from './TypesenseSearchEngine';

// Standalone Search Engine registration
import { searchEngineRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';

/**
 * Helper function to parse configuration and instantiate the TypesenseSearchEngine.
 *
 * @internal
 */
export function createTypesenseEngine(
  config: Config,
  logger: LoggerService,
): TypesenseSearchEngine {
  const typesenseConfig = config.getConfig('search.engines.typesense');
  const apiKey = typesenseConfig.getString('apiKey');
  const clientOptions =
    typesenseConfig.getOptional<TypesenseEngineOptions['clientOptions']>(
      'clientOptions',
    );
  const collections =
    typesenseConfig.getOptional<TypesenseEngineOptions['collections']>(
      'collections',
    );

  const nodes = typesenseConfig.getConfigArray('nodes').map(node => {
    const path = node.getOptionalString('path');
    return {
      host: node.getString('host'),
      port: node.getNumber('port'),
      protocol: node.getString('protocol'),
      ...(path ? { path } : {}),
    };
  });

  return new TypesenseSearchEngine({
    apiKey,
    nodes,
    clientOptions,
    collections,
    logger,
  });
}

/**
 * Standalone Search module for Typesense Search.
 * Registers Typesense directly as the primary search engine.
 *
 * @public
 */
export const searchModuleTypesenseSearch = createBackendModule({
  pluginId: 'search',
  moduleId: 'typesense-search',
  register(env) {
    env.registerInit({
      deps: {
        searchEngineRegistry: searchEngineRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
      },
      async init({ searchEngineRegistry, config, logger }) {
        logger.info(
          'Initializing standalone Typesense Search Engine directly in Search Registry.',
        );

        const typesenseSearchEngine = createTypesenseEngine(config, logger);
        searchEngineRegistry.setSearchEngine(typesenseSearchEngine);
      },
    });
  },
});

export default searchModuleTypesenseSearch;
