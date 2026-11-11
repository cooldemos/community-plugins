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
import { useApi } from '@backstage/core-plugin-api';
import { useCallback, useEffect, useState } from 'react';
import {
  spannerGraphApiRef,
  SubgraphQueryOptions,
  SubgraphResponse,
} from '../api/types';

/**
 * State returned by the {@link useSpannerGraph} hook.
 *
 * @public
 */
export interface UseSpannerGraphResult {
  data?: SubgraphResponse;
  loading: boolean;
  error?: Error;
  retry: () => void;
}

/**
 * React hook that fetches a multi-hop subgraph from {@link spannerGraphApiRef} whenever query options change.
 *
 * @public
 */
export function useSpannerGraph(
  options: SubgraphQueryOptions,
): UseSpannerGraphResult {
  const api = useApi(spannerGraphApiRef);
  const [data, setData] = useState<SubgraphResponse | undefined>(undefined);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [reloadTick, setReloadTick] = useState<number>(0);

  const relationKey = (options.relationTypes ?? []).join(',');
  const kindKey = (options.entityKinds ?? []).join(',');

  const retry = useCallback(() => {
    setReloadTick(prev => prev + 1);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (!options.root.trim()) {
      setData(undefined);
      setLoading(false);
      setError(undefined);
      return () => {
        cancelled = true;
      };
    }

    setLoading(true);
    setError(undefined);

    api
      .getSubgraph({
        root: options.root,
        maxDepth: options.maxDepth,
        direction: options.direction,
        relationTypes: relationKey ? relationKey.split(',') : undefined,
        entityKinds: kindKey ? kindKey.split(',') : undefined,
      })
      .then(result => {
        if (!cancelled) {
          setData(result);
          setLoading(false);
        }
      })
      .catch(err => {
        if (!cancelled) {
          setError(err instanceof Error ? err : new Error(String(err)));
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    api,
    options.root,
    options.maxDepth,
    options.direction,
    relationKey,
    kindKey,
    reloadTick,
  ]);

  return { data, loading, error, retry };
}
