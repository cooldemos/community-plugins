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
import { HttpAuthService, LoggerService } from '@backstage/backend-plugin-api';
import {
  AuthenticationError,
  InputError,
  NotAllowedError,
  NotImplementedError,
  ServiceUnavailableError,
} from '@backstage/errors';
import express, { NextFunction, Request, Response } from 'express';
import Router from 'express-promise-router';
import { GraphDirection, SpannerGraphService } from './SpannerGraphService';

/**
 * Options required to build the Spanner Graph Express router.
 *
 * @public
 */
export interface RouterOptions {
  logger: LoggerService;
  httpAuth: HttpAuthService;
  graphService: SpannerGraphService;
}

const VALID_DIRECTIONS = new Set<GraphDirection>([
  'outgoing',
  'incoming',
  'both',
]);

const ERROR_STATUS_BY_NAME: Record<string, number> = {
  InputError: 400,
  AuthenticationError: 401,
  NotAllowedError: 403,
  NotImplementedError: 501,
  ServiceUnavailableError: 503,
};

/** Maps known Backstage error instances or error names to an HTTP status code. */
function resolveKnownErrorStatus(
  err: unknown,
): { statusCode: number; name: string; message: string } | undefined {
  if (!err || typeof err !== 'object') {
    return undefined;
  }

  const errorName = (err as { name?: string }).name;
  const message =
    err instanceof Error ? err.message : 'Request could not be processed';

  if (err instanceof InputError || errorName === 'InputError') {
    return { statusCode: 400, name: 'InputError', message };
  }
  if (
    err instanceof AuthenticationError ||
    errorName === 'AuthenticationError'
  ) {
    return { statusCode: 401, name: 'AuthenticationError', message };
  }
  if (err instanceof NotAllowedError || errorName === 'NotAllowedError') {
    return { statusCode: 403, name: 'NotAllowedError', message };
  }
  if (
    err instanceof NotImplementedError ||
    errorName === 'NotImplementedError'
  ) {
    return { statusCode: 501, name: 'NotImplementedError', message };
  }
  if (
    err instanceof ServiceUnavailableError ||
    errorName === 'ServiceUnavailableError'
  ) {
    return { statusCode: 503, name: 'ServiceUnavailableError', message };
  }
  if (errorName && errorName in ERROR_STATUS_BY_NAME) {
    return {
      statusCode: ERROR_STATUS_BY_NAME[errorName],
      name: errorName,
      message,
    };
  }
  return undefined;
}

/** Splits a comma-separated query parameter into trimmed non-empty values. */
function parseCsvParam(raw: unknown): string[] | undefined {
  if (typeof raw !== 'string' || !raw.trim()) {
    return undefined;
  }
  return raw
    .split(',')
    .map(item => item.trim())
    .filter(Boolean);
}

/**
 * Creates the Express HTTP router for `/health`, `/subgraph`, and `/natural-query`.
 *
 * @public
 */
export async function createRouter(
  options: RouterOptions,
): Promise<express.Router> {
  const { logger, httpAuth, graphService } = options;
  const router = Router();
  router.use(express.json());

  router.get('/health', (_req, res) => {
    res.status(200).json({
      status: 'ok',
      service: 'spanner-graph-backend',
    });
  });

  router.get('/subgraph', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });

    const root =
      typeof req.query.root === 'string' ? req.query.root.trim() : '';
    if (!root) {
      throw new InputError('Missing required query parameter: root');
    }

    let maxDepth: number | undefined;
    if (req.query.maxDepth !== undefined) {
      const parsedDepth = Number(req.query.maxDepth);
      if (!Number.isInteger(parsedDepth) || parsedDepth < 1) {
        throw new InputError(
          'Query parameter maxDepth must be a positive integer',
        );
      }
      maxDepth = parsedDepth;
    }

    let direction: GraphDirection | undefined;
    if (req.query.direction !== undefined) {
      const rawDirection = String(req.query.direction).trim() as GraphDirection;
      if (!VALID_DIRECTIONS.has(rawDirection)) {
        throw new InputError(
          'Query parameter direction must be one of: outgoing, incoming, both',
        );
      }
      direction = rawDirection;
    }

    const relationTypes = parseCsvParam(req.query.relationTypes);
    const entityKinds = parseCsvParam(req.query.entityKinds);

    const subgraph = await graphService.getSubgraph({
      root,
      maxDepth,
      direction,
      relationTypes,
      entityKinds,
    });

    res.status(200).json(subgraph);
  });

  router.post('/natural-query', async (req, res) => {
    await httpAuth.credentials(req, { allow: ['user', 'service'] });

    const query =
      typeof req.body?.query === 'string' ? req.body.query.trim() : '';
    if (!query) {
      throw new InputError('Missing required body field: query');
    }
    if (query.length > 1000) {
      throw new InputError('Body field query cannot exceed 1000 characters');
    }

    const result = await graphService.executeNaturalQuery(query);
    res.status(200).json(result);
  });

  router.use(
    (err: unknown, _req: Request, res: Response, next: NextFunction) => {
      if (res.headersSent) {
        next(err);
        return;
      }
      const mapped = resolveKnownErrorStatus(err);
      if (mapped) {
        res.status(mapped.statusCode).json({
          error: { name: mapped.name, message: mapped.message },
        });
        return;
      }
      logger.error(
        'Unhandled error in spanner-graph-backend router',
        err instanceof Error ? err : new Error(String(err)),
      );
      res.status(500).json({
        error: {
          name: 'InternalServerError',
          message:
            err instanceof Error ? err.message : 'Unexpected server error',
        },
      });
    },
  );

  return router;
}
