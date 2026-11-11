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
import { mockServices, startTestBackend } from '@backstage/backend-test-utils';
import { catalogServiceMock } from '@backstage/plugin-catalog-node/testUtils';
import { catalogModuleSpannerSync } from './module';
import { SpannerSyncService } from './service/SpannerSyncService';

describe('catalogModuleSpannerSync', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips scheduling when catalog.spannerSync.enabled is false', async () => {
    const logger = mockServices.logger.mock();
    const scheduler = mockServices.scheduler.mock();

    await startTestBackend({
      features: [
        catalogModuleSpannerSync,
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              spannerSync: {
                enabled: false,
                instanceId: 'test-instance',
                databaseId: 'test-db',
              },
            },
          },
        }),
        logger.factory,
        scheduler.factory,
        catalogServiceMock.factory(),
      ],
    });

    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('disabled'),
    );
    expect(scheduler.scheduleTask).not.toHaveBeenCalled();
  });

  it('provisions schema at startup and schedules periodic catalog sync', async () => {
    const ensureSchema = jest.fn().mockResolvedValue(true);
    const runSync = jest.fn().mockResolvedValue({
      syncRunId: 'run-1',
      entitiesSynced: 1,
      relationsSynced: 0,
      staleEntitiesDeleted: 0,
      embeddingsGenerated: 0,
      durationMs: 12,
    });
    jest.spyOn(SpannerSyncService, 'fromConfig').mockReturnValue({
      config: {
        instanceId: 'test-instance',
        databaseId: 'test-db',
        scheduleFrequency: 'PT5M',
        scheduleTimeout: 'PT10M',
      },
      ensureSchema,
      runSync,
    } as unknown as SpannerSyncService);

    const logger = mockServices.logger.mock();
    const scheduler = mockServices.scheduler.mock();

    await startTestBackend({
      features: [
        catalogModuleSpannerSync,
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              spannerSync: {
                enabled: true,
                instanceId: 'test-instance',
                databaseId: 'test-db',
              },
            },
          },
        }),
        logger.factory,
        scheduler.factory,
        catalogServiceMock.factory({
          entities: [
            {
              apiVersion: 'backstage.io/v1alpha1',
              kind: 'Component',
              metadata: { name: 'checkout-service' },
            },
          ],
        }),
      ],
    });

    expect(ensureSchema).toHaveBeenCalledTimes(1);
    expect(scheduler.scheduleTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'catalog-spanner-graph-sync',
        frequency: { minutes: 5 },
        timeout: { minutes: 10 },
      }),
    );

    const scheduledTask = scheduler.scheduleTask.mock.calls[0][0];
    await scheduledTask.fn(new AbortController().signal);
    expect(runSync).toHaveBeenCalledWith([
      expect.objectContaining({
        kind: 'Component',
        metadata: { name: 'checkout-service' },
      }),
    ]);
  });

  it('logs a warning instead of crashing startup when ensureSchema fails due to unreachable Spanner', async () => {
    const ensureSchema = jest
      .fn()
      .mockRejectedValue(
        new Error('UNAVAILABLE: Spanner endpoint unreachable'),
      );
    const runSync = jest.fn();
    jest.spyOn(SpannerSyncService, 'fromConfig').mockReturnValue({
      config: {
        instanceId: 'test-instance',
        databaseId: 'test-db',
      },
      ensureSchema,
      runSync,
    } as unknown as SpannerSyncService);

    const logger = mockServices.logger.mock();
    const scheduler = mockServices.scheduler.mock();

    await startTestBackend({
      features: [
        catalogModuleSpannerSync,
        mockServices.rootConfig.factory({
          data: {
            catalog: {
              spannerSync: {
                enabled: true,
                instanceId: 'test-instance',
                databaseId: 'test-db',
              },
            },
          },
        }),
        logger.factory,
        scheduler.factory,
        catalogServiceMock.factory(),
      ],
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'Failed to auto-provision Cloud Spanner Graph schema at startup',
      ),
      expect.any(Error),
    );
    expect(scheduler.scheduleTask).toHaveBeenCalledTimes(1);
  });
});
