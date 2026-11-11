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
import { LoggerService } from '@backstage/backend-plugin-api';
import { Config } from '@backstage/config';
import { InputError } from '@backstage/errors';
import { Spanner } from '@google-cloud/spanner';

/**
 * Traversal direction for Cloud Spanner Graph subgraph queries.
 *
 * @public
 */
export type GraphDirection = 'outgoing' | 'incoming' | 'both';

/**
 * Configuration options for `SpannerGraphService`.
 *
 * @public
 */
export interface SpannerGraphConfig {
  projectId?: string;
  instanceId: string;
  databaseId: string;
  graphName?: string;
  maxDepth?: number;
  aiServiceUrl?: string;
}

/**
 * Query parameters for fetching a multi-hop subgraph from Cloud Spanner Graph.
 *
 * @public
 */
export interface SubgraphQueryOptions {
  root: string;
  maxDepth?: number;
  direction?: GraphDirection;
  relationTypes?: string[];
  entityKinds?: string[];
}

/**
 * Node representation returned in a Cloud Spanner Graph subgraph response.
 *
 * @public
 */
export interface GraphNode {
  id: string;
  kind: string;
  namespace: string;
  name: string;
  title?: string;
  description?: string;
  lifecycle?: string;
  ownerRef?: string;
  systemRef?: string;
}

/**
 * Directed edge representation returned in a Cloud Spanner Graph subgraph response.
 *
 * @public
 */
export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  label?: string;
}

/**
 * Subgraph payload returned by `SpannerGraphService.getSubgraph`.
 *
 * @public
 */
export interface SubgraphResponse {
  rootEntityRef: string;
  depth: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  truncated: boolean;
  queryDurationMs: number;
}

/**
 * Response payload returned by `SpannerGraphService.executeNaturalQuery`.
 *
 * @public
 */
export interface NaturalLanguageGraphResponse {
  answer: string;
  executedGql: string;
  matchedNodes: GraphNode[];
  subgraph?: SubgraphResponse;
}

const SAFE_SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const MAX_RETURNED_PATHS = 500;

/**
 * Normalizes a Backstage entity reference string into canonical `kind:namespace/name` form,
 * lowercasing `kind` and `namespace` while preserving entity `name` casing.
 *
 * @public
 */
export function normalizeEntityRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed) {
    throw new InputError('Entity reference cannot be empty');
  }

  let kind = 'component';
  let remainder = trimmed;

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1) {
    kind =
      trimmed.slice(0, colonIdx).trim().toLocaleLowerCase('en-US') ||
      'component';
    remainder = trimmed.slice(colonIdx + 1).trim();
  }

  let namespace = 'default';
  let name = remainder;

  const slashIdx = remainder.indexOf('/');
  if (slashIdx !== -1) {
    namespace =
      remainder.slice(0, slashIdx).trim().toLocaleLowerCase('en-US') ||
      'default';
    name = remainder.slice(slashIdx + 1).trim();
  }

  if (!name) {
    throw new InputError(
      `Invalid entity reference "${ref}": missing entity name`,
    );
  }

  return `${kind}:${namespace}/${name}`;
}

/** Extracts a plain object from a Spanner row or mock row. */
function rowToPlainObject(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') {
    return {};
  }
  const maybeJson = row as { toJSON?: () => Record<string, unknown> };
  if (typeof maybeJson.toJSON === 'function') {
    return maybeJson.toJSON();
  }
  return row as Record<string, unknown>;
}

/** Unwraps a Spanner SAFE_TO_JSON path payload into an array of path elements. */
function unwrapPathElements(rawPath: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(rawPath)) {
    return rawPath as Array<Record<string, unknown>>;
  }
  if (rawPath && typeof rawPath === 'object') {
    const wrapper = rawPath as { value?: unknown };
    if (Array.isArray(wrapper.value)) {
      return wrapper.value as Array<Record<string, unknown>>;
    }
    if (typeof wrapper.value === 'string') {
      try {
        const parsed = JSON.parse(wrapper.value);
        if (Array.isArray(parsed)) {
          return parsed as Array<Record<string, unknown>>;
        }
      } catch {
        return [];
      }
    }
  }
  if (typeof rawPath === 'string') {
    try {
      const parsed = JSON.parse(rawPath);
      if (Array.isArray(parsed)) {
        return parsed as Array<Record<string, unknown>>;
      }
    } catch {
      return [];
    }
  }
  return [];
}

/** Converts a raw Spanner node property map into a GraphNode if valid. */
function parseGraphNode(props: Record<string, unknown>): GraphNode | undefined {
  const entityRef =
    typeof props.entity_ref === 'string' ? props.entity_ref : undefined;
  const kind =
    typeof props.kind === 'string'
      ? props.kind.toLocaleLowerCase('en-US')
      : undefined;
  const namespace =
    typeof props.namespace === 'string'
      ? props.namespace.toLocaleLowerCase('en-US')
      : 'default';
  const name = typeof props.name === 'string' ? props.name : undefined;

  if (!entityRef || !kind || !name) {
    return undefined;
  }

  return {
    id: entityRef,
    kind,
    namespace,
    name,
    title: typeof props.title === 'string' ? props.title : undefined,
    description:
      typeof props.description === 'string' ? props.description : undefined,
    lifecycle:
      typeof props.lifecycle === 'string' ? props.lifecycle : undefined,
    ownerRef: typeof props.owner_ref === 'string' ? props.owner_ref : undefined,
    systemRef:
      typeof props.system_ref === 'string' ? props.system_ref : undefined,
  };
}

/** Converts a raw Spanner edge property map into a GraphEdge if valid. */
function parseGraphEdge(props: Record<string, unknown>): GraphEdge | undefined {
  let from: string | undefined;
  if (typeof props.source_entity_ref === 'string') {
    from = props.source_entity_ref;
  } else if (typeof props.entity_ref === 'string') {
    from = props.entity_ref;
  }
  const to =
    typeof props.target_entity_ref === 'string'
      ? props.target_entity_ref
      : undefined;
  const type =
    typeof props.relation_type === 'string' ? props.relation_type : undefined;

  if (!from || !to || !type) {
    return undefined;
  }

  return {
    from,
    to,
    type,
    label: type,
  };
}

interface SpannerQueryDatabase {
  run: (query: {
    sql: string;
    params?: Record<string, unknown>;
  }) => Promise<[unknown[], ...unknown[]]>;
}

/**
 * Executes parameterized ISO GQL subgraph and blast-radius queries against Google Cloud Spanner Graph.
 *
 * @public
 */
export class SpannerGraphService {
  private readonly database: SpannerQueryDatabase;

  /**
   * Constructs a `SpannerGraphService` from the Backstage root configuration.
   */
  static fromConfig(
    config: Config,
    logger: LoggerService,
    databaseOverride?: unknown,
  ): SpannerGraphService {
    const graphConfig = config.getOptionalConfig('spannerGraph');
    const parsedConfig: SpannerGraphConfig = {
      projectId: graphConfig?.getOptionalString('projectId'),
      instanceId:
        graphConfig?.getOptionalString('instanceId') ??
        'backstage-graph-instance',
      databaseId:
        graphConfig?.getOptionalString('databaseId') ?? 'backstage-catalog',
      graphName:
        graphConfig?.getOptionalString('graphName') ?? 'BackstageCatalogGraph',
      maxDepth: graphConfig?.getOptionalNumber('maxDepth') ?? 5,
      aiServiceUrl: graphConfig?.getOptionalString('aiServiceUrl'),
    };

    return new SpannerGraphService(parsedConfig, logger, databaseOverride);
  }

  constructor(
    public readonly config: SpannerGraphConfig,
    private readonly logger: LoggerService,
    databaseOverride?: unknown,
  ) {
    if (databaseOverride) {
      this.database = databaseOverride as SpannerQueryDatabase;
      return;
    }

    const spanner = new Spanner(
      config.projectId ? { projectId: config.projectId } : undefined,
    );
    const instance = spanner.instance(config.instanceId);
    this.database = instance.database(
      config.databaseId,
    ) as unknown as SpannerQueryDatabase;
  }

  /**
   * Queries a multi-hop subgraph rooted at `options.root` using parameterized ISO GQL `MATCH TRAIL`.
   * Falls back to a single-row `entities` lookup when the root entity has zero matching edges.
   */
  async getSubgraph(options: SubgraphQueryOptions): Promise<SubgraphResponse> {
    const startTime = Date.now();
    const rootRef = normalizeEntityRef(options.root);
    const graphName = this.config.graphName ?? 'BackstageCatalogGraph';
    if (!SAFE_SQL_IDENTIFIER.test(graphName)) {
      throw new InputError(`Invalid Spanner Graph identifier "${graphName}".`);
    }

    const maxAllowedDepth = Math.max(1, this.config.maxDepth ?? 5);
    const depth = Math.min(
      Math.max(1, Math.trunc(options.maxDepth ?? 2)),
      maxAllowedDepth,
    );
    const direction: GraphDirection = options.direction ?? 'both';

    const relationTypes = (options.relationTypes ?? [])
      .map(t => t.trim())
      .filter(Boolean);
    const entityKinds = (options.entityKinds ?? [])
      .map(k => k.trim().toLocaleLowerCase('en-US'))
      .filter(Boolean);

    const params: Record<string, unknown> = {
      rootRef,
      maxPaths: MAX_RETURNED_PATHS,
    };

    const edgeFilter =
      relationTypes.length > 0
        ? ' WHERE e.relation_type IN UNNEST(@relationTypes)'
        : '';
    if (relationTypes.length > 0) {
      params.relationTypes = relationTypes;
    }

    let edgePattern = `(-[e:Relation${edgeFilter}]-){1,${depth}}`;
    if (direction === 'outgoing') {
      edgePattern = `(-[e:Relation${edgeFilter}]->){1,${depth}}`;
    } else if (direction === 'incoming') {
      edgePattern = `(<-[e:Relation${edgeFilter}]-){1,${depth}}`;
    }

    const whereClauses: string[] = [];
    if (entityKinds.length > 0) {
      whereClauses.push('target.kind IN UNNEST(@entityKinds)');
      params.entityKinds = entityKinds;
    }

    const whereClause =
      whereClauses.length > 0 ? `\nWHERE ${whereClauses.join(' AND ')}` : '';

    const gql = `GRAPH ${graphName}
MATCH p = TRAIL (start:Entity {entity_ref: @rootRef})${edgePattern}(target:Entity)${whereClause}
RETURN SAFE_TO_JSON(p) AS path
LIMIT @maxPaths`;

    const [rows] = await this.database.run({
      sql: gql,
      params,
    });

    const nodesMap = new Map<string, GraphNode>();
    const edgesMap = new Map<string, GraphEdge>();

    for (const row of rows ?? []) {
      const plainRow = rowToPlainObject(row);
      const elements = unwrapPathElements(plainRow.path);
      for (const element of elements) {
        const props =
          element.properties && typeof element.properties === 'object'
            ? (element.properties as Record<string, unknown>)
            : element;

        if (element.kind === 'edge' || 'relation_type' in props) {
          const edge = parseGraphEdge(props);
          if (edge) {
            edgesMap.set(`${edge.from}::${edge.type}::${edge.to}`, edge);
          }
        } else {
          const node = parseGraphNode(props);
          if (node) {
            nodesMap.set(node.id, node);
          }
        }
      }
    }

    // When an isolated entity has zero matching edges, fall back to looking up the root node directly.
    if (nodesMap.size === 0) {
      const [rootRows] = await this.database.run({
        sql: `SELECT entity_ref, kind, namespace, name, title, description, lifecycle, owner_ref, system_ref
FROM entities
WHERE entity_ref = @rootRef
LIMIT 1`,
        params: { rootRef },
      });

      for (const rootRow of rootRows ?? []) {
        const plainRoot = rowToPlainObject(rootRow);
        const isolatedNode = parseGraphNode(plainRoot);
        if (isolatedNode) {
          nodesMap.set(isolatedNode.id, isolatedNode);
        }
      }
    }

    return {
      rootEntityRef: rootRef,
      depth,
      nodes: Array.from(nodesMap.values()),
      edges: Array.from(edgesMap.values()),
      truncated: (rows?.length ?? 0) >= MAX_RETURNED_PATHS,
      queryDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Proxies a natural-language topology question to the configured `aiServiceUrl`.
   */
  async executeNaturalQuery(
    query: string,
  ): Promise<NaturalLanguageGraphResponse> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new InputError('Natural language query cannot be empty');
    }

    const aiServiceUrl = this.config.aiServiceUrl?.trim();
    if (!aiServiceUrl) {
      throw new InputError(
        'Natural language graph queries require spannerGraph.aiServiceUrl to be configured.',
      );
    }

    const endpoint = `${aiServiceUrl.replace(
      /\/+$/,
      '',
    )}/v1/graph/natural-query`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: trimmedQuery }),
    });

    if (!response.ok) {
      this.logger.warn('AI natural query service returned non-OK status', {
        status: response.status,
      });
      throw new Error(
        `AI graph query service failed with HTTP ${response.status}`,
      );
    }

    const payload =
      (await response.json()) as Partial<NaturalLanguageGraphResponse>;
    return {
      answer: typeof payload.answer === 'string' ? payload.answer : '',
      executedGql:
        typeof payload.executedGql === 'string' ? payload.executedGql : '',
      matchedNodes: Array.isArray(payload.matchedNodes)
        ? payload.matchedNodes
        : [],
      subgraph: payload.subgraph,
    };
  }
}
