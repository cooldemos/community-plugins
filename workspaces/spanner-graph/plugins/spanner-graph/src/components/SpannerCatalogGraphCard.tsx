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
import { parseEntityRef, stringifyEntityRef } from '@backstage/catalog-model';
import {
  DependencyGraph,
  DependencyGraphTypes,
  InfoCard,
  InfoCardVariants,
  Link,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import { useRouteRef } from '@backstage/core-plugin-api';
import { entityRouteRef, useEntity } from '@backstage/plugin-catalog-react';
import {
  Box,
  FormControl,
  InputLabel,
  makeStyles,
  MenuItem,
  Select,
  Typography,
} from '@material-ui/core';
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { GraphDirection, GraphEdge, GraphNode } from '../api/types';
import { useSpannerGraph } from '../hooks/useSpannerGraph';

/**
 * Props for {@link SpannerCatalogGraphCard}.
 *
 * @public
 */
export interface SpannerCatalogGraphCardProps {
  variant?: InfoCardVariants;
  maxDepth?: number;
  direction?: GraphDirection;
  relationTypes?: string[];
  entityKinds?: string[];
  mergeRelations?: boolean;
  height?: number;
  title?: string;
}

/**
 * Operational dependency relation types used for blast-radius analysis,
 * excluding organizational ownership relations (`ownedBy` / `ownerOf`).
 *
 * @public
 */
export const BLAST_RADIUS_RELATIONS: string[] = [
  'dependsOn',
  'dependencyOf',
  'consumesApi',
  'apiConsumedBy',
  'providesApi',
  'apiProvidedBy',
  'partOf',
  'hasPart',
];

type RelationPreset =
  | 'all'
  | 'dependencies'
  | 'blast-radius'
  | 'hierarchy'
  | 'custom';

const DEPENDENCY_RELATIONS: string[] = [
  'dependsOn',
  'dependencyOf',
  'consumesApi',
  'apiConsumedBy',
  'providesApi',
  'apiProvidedBy',
];

const HIERARCHY_RELATIONS: string[] = [
  'partOf',
  'hasPart',
  'ownedBy',
  'ownerOf',
  'childOf',
  'parentOf',
];

/** Determines the initial relation preset matching the provided `relationTypes` array. */
function resolveInitialRelationPreset(
  relationTypes: string[] | undefined,
): RelationPreset {
  if (!relationTypes || relationTypes.length === 0) {
    return 'all';
  }
  const normalized = [...relationTypes].sort().join(',');
  if (normalized === [...BLAST_RADIUS_RELATIONS].sort().join(',')) {
    return 'blast-radius';
  }
  if (normalized === [...DEPENDENCY_RELATIONS].sort().join(',')) {
    return 'dependencies';
  }
  if (normalized === [...HIERARCHY_RELATIONS].sort().join(',')) {
    return 'hierarchy';
  }
  return 'custom';
}

const INVERSE_RELATION_MAP: Record<string, string> = {
  dependencyOf: 'dependsOn',
  hasPart: 'partOf',
  ownerOf: 'ownedBy',
  apiProvidedBy: 'providesApi',
  apiConsumedBy: 'consumesApi',
  parentOf: 'childOf',
};

const KIND_COLOR_MAP: Record<string, string> = {
  domain: '#5c6bc0',
  system: '#26a69a',
  component: '#1976d2',
  api: '#8e24aa',
  resource: '#ef6c00',
  group: '#546e7a',
  user: '#78909c',
};

/** Returns the fill color associated with an entity kind. */
export function getKindColor(kind: string): string {
  return KIND_COLOR_MAP[kind.toLocaleLowerCase('en-US')] ?? '#455a64';
}

/**
 * Merges parallel edges between the same `(from, to)` node pair into a single labeled edge
 * so Dagre's simple-graph layout does not overwrite multi-relation edges. When `options.mergeReciprocal`
 * is enabled (the default), inverse catalog relations (such as `dependencyOf` and `dependsOn`) are
 * normalized into a single canonical directed edge.
 *
 * @public
 */
export function mergeParallelEdges(
  edges: GraphEdge[],
  options?: { mergeReciprocal?: boolean },
): GraphEdge[] {
  const mergeReciprocal = options?.mergeReciprocal ?? true;
  const grouped = new Map<
    string,
    { from: string; to: string; types: string[] }
  >();

  for (const edge of edges) {
    const canonicalInverse =
      mergeReciprocal && edge.type in INVERSE_RELATION_MAP
        ? INVERSE_RELATION_MAP[edge.type]
        : undefined;
    const from = canonicalInverse ? edge.to : edge.from;
    const to = canonicalInverse ? edge.from : edge.to;
    const label = canonicalInverse ?? edge.label ?? edge.type;
    const key = `${from}::${to}`;
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, {
        from,
        to,
        types: [label],
      });
    } else if (!existing.types.includes(label)) {
      existing.types.push(label);
    }
  }

  return Array.from(grouped.values()).map(entry => {
    const combined = entry.types.join(' / ');
    return {
      from: entry.from,
      to: entry.to,
      type: combined,
      label: combined,
    };
  });
}

const useStyles = makeStyles(theme => ({
  controlsRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.spacing(2),
    marginBottom: theme.spacing(2),
  },
  selectGroup: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(2),
  },
  formControl: {
    minWidth: 120,
  },
  graphContainer: {
    width: '100%',
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    overflow: 'hidden',
    backgroundColor: theme.palette.background.default,
    '& .fullscreen, & .fullscreen > div, & .fullscreen > div > svg': {
      width: '100% !important',
      height: '100% !important',
    },
  },
  footerRow: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: theme.spacing(1.5),
  },
  nodeCursor: {
    cursor: 'pointer',
  },
}));

/** Resolves the Catalog entity route ref when mounted, falling back to the standard `/catalog/:namespace/:kind/:name` path. */
export function useSafeEntityRoute() {
  try {
    const route = useRouteRef(entityRouteRef);
    if (route) {
      return route;
    }
  } catch {
    // Fallback when entityRouteRef is not registered in the test or host router.
  }
  return ({
    kind,
    namespace,
    name,
  }: {
    kind: string;
    namespace?: string;
    name: string;
  }) => `/catalog/${namespace ?? 'default'}/${kind}/${name}`;
}

/**
 * Interactive Entity Page dependency and blast-radius card powered by Cloud Spanner Graph.
 *
 * @public
 */
export function SpannerCatalogGraphCard(props: SpannerCatalogGraphCardProps) {
  const {
    variant = 'gridItem',
    maxDepth: initialDepth = 2,
    direction: initialDirection = 'both',
    relationTypes,
    entityKinds,
    mergeRelations = true,
    height = 380,
    title = 'Spanner Graph Dependencies',
  } = props;

  const classes = useStyles();
  const { entity } = useEntity();
  const navigate = useNavigate();
  const catalogEntityRoute = useSafeEntityRoute();

  const rootEntityRef = useMemo(() => stringifyEntityRef(entity), [entity]);
  const initialPreset = useMemo(
    () => resolveInitialRelationPreset(relationTypes),
    [relationTypes],
  );
  const [depth, setDepth] = useState<number>(initialDepth);
  const [direction, setDirection] = useState<GraphDirection>(initialDirection);
  const [relationPreset, setRelationPreset] =
    useState<RelationPreset>(initialPreset);

  const activeRelationTypes = useMemo(() => {
    switch (relationPreset) {
      case 'dependencies':
        return DEPENDENCY_RELATIONS;
      case 'blast-radius':
        return BLAST_RADIUS_RELATIONS;
      case 'hierarchy':
        return HIERARCHY_RELATIONS;
      case 'custom':
        return relationTypes;
      case 'all':
      default:
        return undefined;
    }
  }, [relationPreset, relationTypes]);

  const { data, loading, error } = useSpannerGraph({
    root: rootEntityRef,
    maxDepth: depth,
    direction,
    relationTypes: activeRelationTypes,
    entityKinds,
  });

  const mergedEdges = useMemo(
    () =>
      mergeParallelEdges(data?.edges ?? [], {
        mergeReciprocal: mergeRelations,
      }),
    [data?.edges, mergeRelations],
  );

  const dependencyNodes: Array<DependencyGraphTypes.DependencyNode<GraphNode>> =
    useMemo(
      () =>
        (data?.nodes ?? []).map(node => ({
          ...node,
          id: node.id,
        })),
      [data?.nodes],
    );

  const dependencyEdges: Array<
    DependencyGraphTypes.DependencyEdge<{ label: string }>
  > = useMemo(
    () =>
      mergedEdges.map(edge => ({
        from: edge.from,
        to: edge.to,
        label: edge.label ?? edge.type,
      })),
    [mergedEdges],
  );

  const relationTypesParam =
    activeRelationTypes && activeRelationTypes.length > 0
      ? `&relationTypes=${encodeURIComponent(activeRelationTypes.join(','))}`
      : '';
  const explorerUrl = `/spanner-graph?root=${encodeURIComponent(
    rootEntityRef,
  )}&maxDepth=${depth}&direction=${direction}${relationTypesParam}`;

  const handleNodeClick = (nodeId: string) => {
    try {
      const parsed = parseEntityRef(nodeId);
      const path = catalogEntityRoute({
        kind: parsed.kind.toLocaleLowerCase('en-US'),
        namespace: parsed.namespace.toLocaleLowerCase('en-US'),
        name: parsed.name,
      });
      navigate(path);
    } catch {
      // Ignore navigation if entity ref cannot be parsed.
    }
  };

  return (
    <InfoCard title={title} variant={variant}>
      <Box className={classes.controlsRow}>
        <Box className={classes.selectGroup}>
          <FormControl
            variant="outlined"
            size="small"
            className={classes.formControl}
          >
            <InputLabel id="spanner-card-depth-label">Max Depth</InputLabel>
            <Select
              labelId="spanner-card-depth-label"
              id="spanner-card-depth-select"
              label="Max Depth"
              value={depth}
              onChange={event => setDepth(Number(event.target.value))}
            >
              {[1, 2, 3, 4, 5].map(d => (
                <MenuItem key={d} value={d}>
                  {d} {d === 1 ? 'Hop' : 'Hops'}
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl
            variant="outlined"
            size="small"
            className={classes.formControl}
          >
            <InputLabel id="spanner-card-direction-label">Direction</InputLabel>
            <Select
              labelId="spanner-card-direction-label"
              id="spanner-card-direction-select"
              label="Direction"
              value={direction}
              onChange={event =>
                setDirection(event.target.value as GraphDirection)
              }
            >
              <MenuItem value="both">Both Directions</MenuItem>
              <MenuItem value="outgoing">Outgoing (Dependencies)</MenuItem>
              <MenuItem value="incoming">Incoming (Dependents)</MenuItem>
            </Select>
          </FormControl>

          <FormControl
            variant="outlined"
            size="small"
            className={classes.formControl}
          >
            <InputLabel id="spanner-card-relations-label">Relations</InputLabel>
            <Select
              labelId="spanner-card-relations-label"
              id="spanner-card-relations-select"
              label="Relations"
              value={relationPreset}
              onChange={event =>
                setRelationPreset(event.target.value as RelationPreset)
              }
            >
              <MenuItem value="all">All Relations</MenuItem>
              <MenuItem value="dependencies">Dependencies & APIs</MenuItem>
              <MenuItem value="blast-radius">
                Blast Radius (Operational)
              </MenuItem>
              <MenuItem value="hierarchy">Hierarchy & Ownership</MenuItem>
              {initialPreset === 'custom' && (
                <MenuItem value="custom">Custom Filter</MenuItem>
              )}
            </Select>
          </FormControl>
        </Box>

        <Box display="flex" alignItems="center" style={{ gap: 8 }}>
          <Typography variant="caption" color="textSecondary">
            {`${dependencyNodes.length} nodes`}
          </Typography>
          <Typography variant="caption" color="textSecondary">
            ·
          </Typography>
          <Typography variant="caption" color="textSecondary">
            {`${dependencyEdges.length} edges`}
          </Typography>
          {data?.queryDurationMs !== undefined && (
            <>
              <Typography variant="caption" color="textSecondary">
                ·
              </Typography>
              <Typography variant="caption" color="textSecondary">
                {`${data.queryDurationMs} ms`}
              </Typography>
            </>
          )}
        </Box>
      </Box>

      {loading && <Progress />}
      {!loading && error && <ResponseErrorPanel error={error} />}
      {!loading && !error && dependencyNodes.length === 0 && (
        <Typography variant="body2" color="textSecondary">
          No graph nodes found for {rootEntityRef}.
        </Typography>
      )}
      {!loading && !error && dependencyNodes.length > 0 && (
        <Box className={classes.graphContainer} style={{ height }}>
          <DependencyGraph
            nodes={dependencyNodes}
            edges={dependencyEdges}
            direction={DependencyGraphTypes.Direction.LEFT_RIGHT}
            zoom="enable-on-click"
            renderNode={({ node }) => {
              const fillColor = getKindColor(node.kind ?? 'component');
              const isRoot =
                node.id.toLocaleLowerCase('en-US') ===
                rootEntityRef.toLocaleLowerCase('en-US');
              return (
                <g
                  className={classes.nodeCursor}
                  onClick={() => handleNodeClick(node.id)}
                >
                  <rect
                    width={160}
                    height={52}
                    rx={8}
                    fill={fillColor}
                    stroke={isRoot ? '#ffd54f' : '#ffffff'}
                    strokeWidth={isRoot ? 3 : 1.5}
                  />
                  <text
                    x={80}
                    y={22}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize={10}
                    fontWeight="bold"
                  >
                    {(node.kind ?? 'entity').toLocaleUpperCase('en-US')}
                  </text>
                  <text
                    x={80}
                    y={39}
                    textAnchor="middle"
                    fill="#ffffff"
                    fontSize={12}
                  >
                    {node.name}
                  </text>
                </g>
              );
            }}
            renderLabel={({ edge }) => (
              <g>
                <text
                  x={0}
                  y={-4}
                  textAnchor="middle"
                  fontSize={10}
                  fill="#546e7a"
                >
                  {edge.label}
                </text>
              </g>
            )}
          />
        </Box>
      )}

      <Box className={classes.footerRow}>
        <Typography variant="caption" color="textSecondary">
          Root: {rootEntityRef}
        </Typography>
        <Link to={explorerUrl}>Open in Spanner Graph Explorer</Link>
      </Box>
    </InfoCard>
  );
}
