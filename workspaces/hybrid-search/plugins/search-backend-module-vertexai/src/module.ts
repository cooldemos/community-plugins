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
  SchedulerService,
  AuthService,
} from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { searchEngineRegistryExtensionPoint } from '@backstage/plugin-search-backend-node/alpha';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';

import {
  VertexAISearchEngine,
  VertexAIEngineOptions,
} from './VertexAISearchEngine';
import { runCatalogCleanupSweeper } from './catalogCleanup';

/**
 * Shared helper to construct and initialize the VertexAISearchEngine from config.
 */
export function createVertexAiSearchEngine(
  config: Config,
  logger: LoggerService,
): VertexAISearchEngine {
  const vertexAiConfig = config.getConfig('search.engines.vertexai');
  const blendedSearch =
    vertexAiConfig.getOptional<VertexAIEngineOptions['blendedSearch']>(
      'blendedSearch',
    );
  const types = vertexAiConfig.get<VertexAIEngineOptions['types']>('types');

  return new VertexAISearchEngine({
    blendedSearch,
    types,
    logger,
  });
}

/**
 * Shared helper to schedule the background catalog cleanup sweeper task if appropriate.
 */
export async function scheduleCleanupIfNeeded(options: {
  config: Config;
  logger: LoggerService;
  scheduler: SchedulerService;
  catalog: any;
  auth: AuthService;
}): Promise<void> {
  const { config, logger, scheduler, catalog, auth } = options;
  const vertexAiConfig = config.getConfig('search.engines.vertexai');
  const types = vertexAiConfig.get<VertexAIEngineOptions['types']>('types');

  const indexingConfig = vertexAiConfig.getOptionalConfig('indexing');
  const globalIndexingEnabled =
    indexingConfig?.getOptionalBoolean('enabled') === true;

  // Resolve whether techdocs specifically has indexing enabled (falls back to global)
  const techdocsConfig = types.techdocs;
  const techdocsIndexingEnabled =
    techdocsConfig?.indexing?.enabled !== undefined
      ? techdocsConfig.indexing.enabled === true
      : globalIndexingEnabled;

  const cleanupConfig = vertexAiConfig.getOptionalConfig('cleanup');
  const isCleanupExplicitlyDisabled =
    cleanupConfig?.getOptionalBoolean('enabled') === false;
  const isCleanupEnabled =
    !techdocsIndexingEnabled && !isCleanupExplicitlyDisabled;

  if (isCleanupEnabled) {
    const frequencyHours = cleanupConfig?.getOptionalNumber('frequency.hours');
    const frequencyMinutes =
      cleanupConfig?.getOptionalNumber('frequency.minutes');
    const frequencySeconds =
      cleanupConfig?.getOptionalNumber('frequency.seconds');

    const frequency: {
      hours?: number;
      minutes?: number;
      seconds?: number;
    } = {};

    if (frequencySeconds !== undefined) {
      frequency.seconds = frequencySeconds;
    } else if (frequencyHours !== undefined || frequencyMinutes !== undefined) {
      if (frequencyHours !== undefined) frequency.hours = frequencyHours;
      if (frequencyMinutes !== undefined) frequency.minutes = frequencyMinutes;
    } else {
      frequency.hours = 2;
    }

    const initialDelayMinutes =
      cleanupConfig?.getOptionalNumber('initialDelay.minutes') ?? 2;
    const initialDelaySeconds = cleanupConfig?.getOptionalNumber(
      'initialDelay.seconds',
    );

    const initialDelay: {
      minutes?: number;
      seconds?: number;
    } = {};

    if (initialDelaySeconds !== undefined) {
      initialDelay.seconds = initialDelaySeconds;
    } else {
      initialDelay.minutes = initialDelayMinutes;
    }

    logger.info(
      `Registering TechDocs Catalog Cleanup task with frequency: ${JSON.stringify(
        frequency,
      )}, initialDelay: ${JSON.stringify(initialDelay)}.`,
    );

    await scheduler.scheduleTask({
      id: 'techdocs-orphan-sweeper',
      frequency: frequency,
      timeout: { minutes: 30 },
      initialDelay: initialDelay,
      fn: () => runCatalogCleanupSweeper({ config, logger, catalog, auth }),
    });
  } else {
    if (techdocsIndexingEnabled) {
      logger.info(
        'TechDocs Catalog Cleanup task is disabled because direct local indexing is enabled for techdocs (collator sync is active).',
      );
    } else {
      logger.info('TechDocs Catalog Cleanup task is disabled in config.');
    }
  }
}

/**
 * Standard Standalone Search Module for Vertex AI Search.
 * Registers Vertex AI Search as the primary, sole search engine for the Backstage backend.
 *
 * @public
 */
export const searchModuleVertexAISearch = createBackendModule({
  pluginId: 'search',
  moduleId: 'vertexai-search',
  register(env) {
    env.registerInit({
      deps: {
        searchEngineRegistry: searchEngineRegistryExtensionPoint,
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({
        searchEngineRegistry,
        config,
        logger,
        scheduler,
        catalog,
        auth,
      }) {
        logger.info(
          'Initializing Vertex AI Search Engine as the primary search engine.',
        );
        const vertexAiSearchEngine = createVertexAiSearchEngine(config, logger);

        searchEngineRegistry.setSearchEngine(vertexAiSearchEngine);

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

export default searchModuleVertexAISearch;
