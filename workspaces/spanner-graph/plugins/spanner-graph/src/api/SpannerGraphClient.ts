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
import { DiscoveryApi, FetchApi } from '@backstage/core-plugin-api';
import { ResponseError } from '@backstage/errors';
import {
  NaturalLanguageGraphResponse,
  SpannerGraphApi,
  SubgraphQueryOptions,
  SubgraphResponse,
} from './types';

/**
 * Construction options for {@link SpannerGraphClient}.
 *
 * @public
 */
export interface SpannerGraphClientOptions {
  discoveryApi: DiscoveryApi;
  fetchApi: FetchApi;
}

/**
 * Default HTTP client implementation for {@link SpannerGraphApi}.
 *
 * @public
 */
export class SpannerGraphClient implements SpannerGraphApi {
  constructor(private readonly options: SpannerGraphClientOptions) {}

  /**
   * Queries the backend `/subgraph` endpoint for a multi-hop subgraph around `options.root`.
   */
  async getSubgraph(options: SubgraphQueryOptions): Promise<SubgraphResponse> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('spanner-graph');
    const searchParams = new URLSearchParams();
    searchParams.set('root', options.root);

    if (options.maxDepth !== undefined) {
      searchParams.set('maxDepth', String(options.maxDepth));
    }
    if (options.direction) {
      searchParams.set('direction', options.direction);
    }
    if (options.relationTypes && options.relationTypes.length > 0) {
      searchParams.set('relationTypes', options.relationTypes.join(','));
    }
    if (options.entityKinds && options.entityKinds.length > 0) {
      searchParams.set('entityKinds', options.entityKinds.join(','));
    }

    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/subgraph?${searchParams.toString()}`,
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return (await response.json()) as SubgraphResponse;
  }

  /**
   * Sends a natural-language graph query to the backend `/natural-query` endpoint.
   */
  async askNaturalLanguage(
    query: string,
  ): Promise<NaturalLanguageGraphResponse> {
    const baseUrl = await this.options.discoveryApi.getBaseUrl('spanner-graph');
    const response = await this.options.fetchApi.fetch(
      `${baseUrl}/natural-query`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      },
    );

    if (!response.ok) {
      throw await ResponseError.fromResponse(response);
    }

    return (await response.json()) as NaturalLanguageGraphResponse;
  }
}
