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
import {
  InputError,
  NotImplementedError,
  ServiceUnavailableError,
} from '@backstage/errors';
import { Spanner } from '@google-cloud/spanner';
import { GoogleGenAI } from '@google/genai';
import {
  ALLOWED_CATALOG_RELATIONS,
  compileNaturalGraphQuery,
  NaturalGraphQueryIntent,
  NaturalGraphQueryIntentSchema,
  normalizeEntityRef,
  resolveEntityRefInSpanner,
} from './naturalQueryCompiler';

export {
  ALLOWED_CATALOG_RELATIONS,
  compileNaturalGraphQuery,
  NaturalGraphQueryIntentSchema,
  normalizeEntityRef,
  resolveEntityRefInSpanner,
};
export type { NaturalGraphQueryIntent };

/**
 * Traversal direction for Cloud Spanner Graph subgraph queries.
 *
 * @public
 */
export type GraphDirection = 'outgoing' | 'incoming' | 'both';

/**
 * Supported LLM providers for natural-language-to-ISO-GQL translation.
 *
 * @public
 */
export type SpannerGraphLlmProvider =
  | 'vertex'
  | 'gemini'
  | 'litellm'
  | 'openai'
  | 'disabled';

/**
 * Configuration options for LLM-assisted natural-language graph queries.
 *
 * @public
 */
export interface SpannerGraphLlmConfig {
  provider?: SpannerGraphLlmProvider;
  model?: string;
  location?: string;
  baseUrl?: string;
  apiKey?: string;
}

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
  llm?: SpannerGraphLlmConfig;
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
const MAX_NATURAL_QUERY_LENGTH = 1000;

const NATURAL_QUERY_SYSTEM_PROMPT = `You are a Backstage Software Catalog graph query planner for Google Cloud Spanner Graph.
Given a user's natural-language question about services, APIs, resources, systems, domains, or ownership, output ONLY a JSON object matching this schema:
{
  "rootEntityRef": "<entity ref or short entity name mentioned in the question, e.g. resource:default/orders-spanner-db or orders-spanner-db>",
  "direction": "outgoing" | "incoming" | "both",
  "maxDepth": 1..5,
  "relationTypes": optional array of allowed relation types from [${ALLOWED_CATALOG_RELATIONS.join(
    ', ',
  )}],
  "entityKinds": optional array of target entity kinds from ["component", "api", "resource", "system", "domain", "group", "user"],
  "lifecycle": optional target lifecycle filter such as "production" or "experimental",
  "summaryTemplate": optional short description of what the query is finding
}
Direction rules:
- If the user asks "what depends on X", "which services use/consume X", or "what is the blast radius / downstream impact of X", set "direction": "incoming" and "relationTypes": ["dependsOn", "consumesApi", "apiProvidedBy", "partOf"] (unless they specifically ask about ownership).
- If the user asks "what does X depend on" or "what dependencies does X have", set "direction": "outgoing".
- Otherwise set "direction": "both".`;

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

/** Extracts nodes and edges from Spanner GQL path rows, filtering out any dangling edges. */
function extractNodesAndEdgesFromRows(rows: unknown[] | undefined): {
  nodesMap: Map<string, GraphNode>;
  edges: GraphEdge[];
} {
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

  const edges = Array.from(edgesMap.values()).filter(
    edge => nodesMap.has(edge.from) && nodesMap.has(edge.to),
  );

  return { nodesMap, edges };
}

/** Strips optional markdown code fences around a JSON response from an LLM. */
function stripJsonCodeFences(rawText: string): string {
  const trimmed = rawText.trim();
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  return match ? match[1].trim() : trimmed;
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
    const llmConfig = graphConfig?.getOptionalConfig('llm');
    const rawProvider = llmConfig?.getOptionalString('provider');
    const provider: SpannerGraphLlmProvider | undefined =
      rawProvider === 'vertex' ||
      rawProvider === 'gemini' ||
      rawProvider === 'litellm' ||
      rawProvider === 'openai' ||
      rawProvider === 'disabled'
        ? rawProvider
        : undefined;

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
      llm: llmConfig
        ? {
            provider,
            model: llmConfig.getOptionalString('model'),
            location: llmConfig.getOptionalString('location'),
            baseUrl: llmConfig.getOptionalString('baseUrl'),
            apiKey: llmConfig.getOptionalString('apiKey'),
          }
        : undefined,
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
   * Queries a multi-hop subgraph rooted at `options.root` using parameterized ISO GQL `MATCH p = ACYCLIC`.
   * Falls back to a single-row `entities` lookup when the root entity has zero matching edges.
   */
  async getSubgraph(options: SubgraphQueryOptions): Promise<SubgraphResponse> {
    const startTime = Date.now();
    const rootRef = await resolveEntityRefInSpanner(
      this.database,
      options.root,
    );
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

    const { sql: gql, params } = compileNaturalGraphQuery({
      graphName,
      rootEntityRef: rootRef,
      intent: {
        rootEntityRef: rootRef,
        direction,
        maxDepth: depth,
        relationTypes: relationTypes.length > 0 ? relationTypes : undefined,
        entityKinds: entityKinds.length > 0 ? entityKinds : undefined,
      },
      maxAllowedDepth,
      maxPaths: MAX_RETURNED_PATHS,
    });

    const [rows] = await this.database.run({
      sql: gql,
      params,
    });

    const { nodesMap, edges } = extractNodesAndEdgesFromRows(rows);

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
      edges,
      truncated: (rows?.length ?? 0) >= MAX_RETURNED_PATHS,
      queryDurationMs: Date.now() - startTime,
    };
  }

  /**
   * Translates a natural-language topology question into a parameterized ISO GQL `MATCH p = ACYCLIC`
   * query (or proxies to `aiServiceUrl` when configured) and executes it against Cloud Spanner Graph.
   */
  async executeNaturalQuery(
    query: string,
  ): Promise<NaturalLanguageGraphResponse> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      throw new InputError('Natural language query cannot be empty');
    }
    if (trimmedQuery.length > MAX_NATURAL_QUERY_LENGTH) {
      throw new InputError(
        `Natural language query cannot exceed ${MAX_NATURAL_QUERY_LENGTH} characters`,
      );
    }

    const aiServiceUrl = this.config.aiServiceUrl?.trim();
    if (aiServiceUrl) {
      return this.proxyNaturalQueryToAiService(aiServiceUrl, trimmedQuery);
    }

    if (this.config.llm?.provider === 'disabled') {
      throw new NotImplementedError(
        'Natural language graph queries are disabled via spannerGraph.llm.provider.',
      );
    }

    const intent = await this.extractNaturalQueryIntent(trimmedQuery);
    const resolvedRootRef = await resolveEntityRefInSpanner(
      this.database,
      intent.rootEntityRef,
    );
    const graphName = this.config.graphName ?? 'BackstageCatalogGraph';
    const maxAllowedDepth = Math.max(1, this.config.maxDepth ?? 5);

    const { sql, params, depth } = compileNaturalGraphQuery({
      graphName,
      rootEntityRef: resolvedRootRef,
      intent,
      maxAllowedDepth,
      maxPaths: MAX_RETURNED_PATHS,
    });

    const startTime = Date.now();
    const [rows] = await this.database.run({ sql, params });
    const { nodesMap, edges } = extractNodesAndEdgesFromRows(rows);

    const allNodes = Array.from(nodesMap.values());
    const nonRootNodes = allNodes.filter(node => node.id !== resolvedRootRef);
    const matchedNodes = nonRootNodes.length > 0 ? nonRootNodes : allNodes;

    const answer = this.formatSynthesizedAnswer(
      resolvedRootRef,
      intent,
      matchedNodes,
      depth,
    );

    return {
      answer,
      executedGql: sql,
      matchedNodes,
      subgraph: {
        rootEntityRef: resolvedRootRef,
        depth,
        nodes: allNodes,
        edges,
        truncated: (rows?.length ?? 0) >= MAX_RETURNED_PATHS,
        queryDurationMs: Date.now() - startTime,
      },
    };
  }

  /** Proxies a natural-language query to an external AI microservice when `aiServiceUrl` is set. */
  private async proxyNaturalQueryToAiService(
    aiServiceUrl: string,
    trimmedQuery: string,
  ): Promise<NaturalLanguageGraphResponse> {
    const endpoint = `${aiServiceUrl.replace(
      /\/+$/,
      '',
    )}/v1/graph/natural-query`;
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: trimmedQuery }),
      signal: AbortSignal.timeout(15_000),
    });

    if (!response.ok) {
      this.logger.warn('AI natural query service returned non-OK status', {
        status: response.status,
      });
      throw new ServiceUnavailableError(
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

  /** Uses the configured LLM provider (defaulting to Vertex AI Gemini via `@google/genai`) to extract a structured graph intent. */
  private async extractNaturalQueryIntent(
    question: string,
  ): Promise<NaturalGraphQueryIntent> {
    const provider = this.config.llm?.provider ?? 'vertex';
    const model = this.config.llm?.model ?? 'gemini-3-flash-preview';

    let rawJsonText: string;

    if (provider === 'litellm' || provider === 'openai') {
      const baseUrl = this.config.llm?.baseUrl?.trim();
      if (!baseUrl) {
        throw new NotImplementedError(
          `Natural language graph queries with provider "${provider}" require spannerGraph.llm.baseUrl to be configured.`,
        );
      }
      const apiKey =
        this.config.llm?.apiKey?.trim() ?? process.env.OPENAI_API_KEY ?? '';
      const response = await fetch(
        `${baseUrl.replace(/\/+$/, '')}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
          },
          body: JSON.stringify({
            model,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: NATURAL_QUERY_SYSTEM_PROMPT },
              { role: 'user', content: question },
            ],
          }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok) {
        throw new ServiceUnavailableError(
          `LLM provider "${provider}" returned HTTP ${response.status}`,
        );
      }
      const payload = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      rawJsonText = payload.choices?.[0]?.message?.content ?? '';
    } else if (provider === 'gemini') {
      const apiKey =
        this.config.llm?.apiKey?.trim() ?? process.env.GEMINI_API_KEY;
      if (!apiKey) {
        throw new NotImplementedError(
          'Natural language graph queries with provider "gemini" require spannerGraph.llm.apiKey to be configured.',
        );
      }
      const ai = new GoogleGenAI({ apiKey });
      const result = await ai.models.generateContent({
        model,
        contents: question,
        config: {
          systemInstruction: NATURAL_QUERY_SYSTEM_PROMPT,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      });
      rawJsonText = result.text ?? '';
    } else {
      const projectId =
        this.config.projectId ??
        process.env.GOOGLE_CLOUD_PROJECT ??
        process.env.GCLOUD_PROJECT;
      if (!projectId) {
        throw new NotImplementedError(
          'Natural language graph queries require spannerGraph.projectId or spannerGraph.aiServiceUrl to be configured.',
        );
      }
      const ai = new GoogleGenAI({
        vertexai: true,
        project: projectId,
        location: this.config.llm?.location ?? 'global',
        googleAuthOptions: {
          projectId,
        },
      });
      const result = await ai.models.generateContent({
        model,
        contents: question,
        config: {
          systemInstruction: NATURAL_QUERY_SYSTEM_PROMPT,
          temperature: 0,
          responseMimeType: 'application/json',
        },
      });
      rawJsonText = result.text ?? '';
    }

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(stripJsonCodeFences(rawJsonText));
    } catch (error) {
      throw new ServiceUnavailableError(
        `LLM returned non-JSON intent payload: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    return NaturalGraphQueryIntentSchema.parse(parsedJson);
  }

  /** Formats a deterministic human-readable summary of the matched Cloud Spanner Graph entities. */
  private formatSynthesizedAnswer(
    rootEntityRef: string,
    intent: NaturalGraphQueryIntent,
    matchedNodes: GraphNode[],
    depth: number,
  ): string {
    if (matchedNodes.length === 0) {
      return `No matching catalog entities were found within ${depth} ${
        depth === 1 ? 'hop' : 'hops'
      } of ${rootEntityRef}.`;
    }

    const preview = matchedNodes
      .slice(0, 6)
      .map(node => `${node.id}${node.lifecycle ? ` (${node.lifecycle})` : ''}`)
      .join(', ');
    const suffix =
      matchedNodes.length > 6 ? ` and ${matchedNodes.length - 6} more` : '';

    let directionPhrase = 'are connected to';
    if (intent.direction === 'incoming') {
      directionPhrase = 'depend on or are impacted by';
    } else if (intent.direction === 'outgoing') {
      directionPhrase = 'are dependencies of';
    }

    return `Found ${matchedNodes.length} catalog ${
      matchedNodes.length === 1 ? 'entity' : 'entities'
    } within ${depth} ${
      depth === 1 ? 'hop' : 'hops'
    } that ${directionPhrase} ${rootEntityRef}: ${preview}${suffix}.`;
  }
}
