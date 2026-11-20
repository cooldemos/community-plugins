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
import request from 'supertest';
import { spannerGraphPlugin } from './plugin';
import { SpannerGraphService } from './service/SpannerGraphService';

describe('spannerGraphPlugin', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('registers the spanner-graph backend plugin and serves /api/spanner-graph/health', async () => {
    jest.spyOn(SpannerGraphService, 'fromConfig').mockReturnValue({
      getSubgraph: jest.fn(),
      executeNaturalQuery: jest.fn(),
    } as unknown as SpannerGraphService);

    const { server } = await startTestBackend({
      features: [
        spannerGraphPlugin,
        mockServices.rootConfig.factory({
          data: {
            spannerGraph: {
              instanceId: 'test-instance',
              databaseId: 'test-db',
            },
          },
        }),
      ],
    });

    const response = await request(server).get('/api/spanner-graph/health');
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      status: 'ok',
      service: 'spanner-graph-backend',
    });
  });
});
