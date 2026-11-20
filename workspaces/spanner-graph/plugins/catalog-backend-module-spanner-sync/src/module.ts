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
  coreServices,
  createBackendModule,
} from '@backstage/backend-plugin-api';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';
import { SpannerSyncService } from './service/SpannerSyncService';

/** Parses an ISO-8601 minute duration (e.g. PT2M) into a Backstage scheduler DurationObject. */
function parseMinutesDuration(
  isoDuration: string | undefined,
  fallbackMinutes: number,
): { minutes: number } {
  if (!isoDuration) {
    return { minutes: fallbackMinutes };
  }
  const match = /^PT(\d+)M$/i.exec(isoDuration.trim());
  if (!match) {
    return { minutes: fallbackMinutes };
  }
  const parsed = Number.parseInt(match[1], 10);
  return { minutes: parsed > 0 ? parsed : fallbackMinutes };
}

/**
 * Backstage catalog backend module that synchronizes catalog entities and relations into Google Cloud Spanner Graph.
 *
 * @public
 */
export const catalogModuleSpannerSync = createBackendModule({
  pluginId: 'catalog',
  moduleId: 'spanner-sync',
  register(env) {
    env.registerInit({
      deps: {
        config: coreServices.rootConfig,
        logger: coreServices.logger,
        scheduler: coreServices.scheduler,
        auth: coreServices.auth,
        catalog: catalogServiceRef,
      },
      async init({ config, logger, scheduler, auth, catalog }) {
        if (!config.has('catalog.spannerSync')) {
          logger.info(
            'Cloud Spanner Graph catalog sync is not configured; skipping initialization.',
          );
          return;
        }

        const enabled =
          config.getOptionalBoolean('catalog.spannerSync.enabled') ?? true;
        if (!enabled) {
          logger.info(
            'Cloud Spanner Graph catalog sync module is disabled via configuration.',
          );
          return;
        }

        const syncService = SpannerSyncService.fromConfig(config, logger);

        try {
          await syncService.ensureSchema();
        } catch (error) {
          logger.warn(
            'Failed to auto-provision Cloud Spanner Graph schema at startup; sync task will still be scheduled.',
            error instanceof Error ? error : new Error(String(error)),
          );
        }

        const frequency = parseMinutesDuration(
          syncService.config.scheduleFrequency,
          2,
        );
        const timeout = parseMinutesDuration(
          syncService.config.scheduleTimeout,
          10,
        );

        await scheduler.scheduleTask({
          id: 'catalog-spanner-graph-sync',
          frequency,
          timeout,
          initialDelay: { seconds: 15 },
          fn: async () => {
            try {
              const credentials = await auth.getOwnServiceCredentials();
              const { items } = await catalog.getEntities({}, { credentials });
              await syncService.runSync(items);
            } catch (error) {
              logger.error(
                'Cloud Spanner Graph periodic catalog sync failed.',
                error instanceof Error ? error : new Error(String(error)),
              );
            }
          },
        });
      },
    });
  },
});

export default catalogModuleSpannerSync;
