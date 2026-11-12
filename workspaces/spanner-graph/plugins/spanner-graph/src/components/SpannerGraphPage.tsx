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
import { parseEntityRef } from '@backstage/catalog-model';
import {
  Content,
  DependencyGraph,
  DependencyGraphTypes,
  Header,
  HeaderLabel,
  InfoCard,
  Page,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import {
  Box,
  Button,
  Chip,
  FormControl,
  FormControlLabel,
  Grid,
  InputLabel,
  makeStyles,
  MenuItem,
  Select,
  Switch,
  TextField,
  Typography,
} from '@material-ui/core';
import { ReactNode, useEffect, useMemo, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { GraphDirection, GraphNode } from '../api/types';
import { useSpannerGraph } from '../hooks/useSpannerGraph';
import {
  getKindColor,
  mergeParallelEdges,
  truncateNodeLabel,
  useSafeEntityRoute,
} from './SpannerCatalogGraphCard';

/**
 * Props for {@link SpannerGraphPage}.
 *
 * @public
 */
export interface SpannerGraphPageProps {
  initialRootRef?: string;
  initialMaxDepth?: number;
  initialDirection?: GraphDirection;
  mergeRelations?: boolean;
  noHeader?: boolean;
  children?: ReactNode;
}

const AVAILABLE_RELATIONS = [
  'dependsOn',
  'dependencyOf',
  'partOf',
  'hasPart',
  'ownedBy',
  'ownerOf',
  'providesApi',
  'apiProvidedBy',
  'consumesApi',
  'apiConsumedBy',
] as const;

const AVAILABLE_KINDS = [
  'domain',
  'system',
  'component',
  'api',
  'resource',
  'group',
  'user',
] as const;

const useStyles = makeStyles(theme => ({
  filterSection: {
    display: 'flex',
    flexDirection: 'column',
    gap: theme.spacing(2),
  },
  chipGroup: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(0.75),
    marginTop: theme.spacing(0.5),
  },
  canvasBox: {
    width: '100%',
    height: 560,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    overflow: 'hidden',
    backgroundColor: theme.palette.background.default,
    '& .fullscreen, & .fullscreen > div, & .fullscreen > div > svg': {
      width: '100% !important',
      height: '100% !important',
    },
  },
  statsBar: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginBottom: theme.spacing(1.5),
  },
  nodeCursor: {
    cursor: 'pointer',
  },
}));

/**
 * Full-screen interactive multi-hop graph explorer backed by Google Cloud Spanner Graph.
 *
 * @public
 */
export function SpannerGraphPage(props: SpannerGraphPageProps) {
  const {
    initialRootRef = 'component:default/checkout-service',
    initialMaxDepth = 3,
    initialDirection = 'both',
    mergeRelations: initialMergeRelations = true,
    noHeader = false,
    children,
  } = props;

  const classes = useStyles();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const catalogEntityRoute = useSafeEntityRoute();

  const rootFromQuery = searchParams.get('root') ?? initialRootRef;
  const depthFromQuery = Number(
    searchParams.get('maxDepth') ?? initialMaxDepth,
  );
  const rawDirection = searchParams.get('direction');
  const directionFromQuery: GraphDirection =
    rawDirection === 'outgoing' ||
    rawDirection === 'incoming' ||
    rawDirection === 'both'
      ? rawDirection
      : initialDirection;
  const relationsFromQuery =
    searchParams
      .get('relationTypes')
      ?.split(',')
      .map(item => item.trim())
      .filter(Boolean) ?? [];

  const [rootInput, setRootInput] = useState<string>(rootFromQuery);
  const [activeRoot, setActiveRoot] = useState<string>(rootFromQuery);
  const [maxDepth, setMaxDepth] = useState<number>(
    Number.isInteger(depthFromQuery) &&
      depthFromQuery >= 1 &&
      depthFromQuery <= 5
      ? depthFromQuery
      : initialMaxDepth,
  );
  const [direction, setDirection] =
    useState<GraphDirection>(directionFromQuery);
  const [mergeRelations, setMergeRelations] = useState<boolean>(
    initialMergeRelations ?? true,
  );
  const [selectedRelations, setSelectedRelations] =
    useState<string[]>(relationsFromQuery);
  const [selectedKinds, setSelectedKinds] = useState<string[]>([]);

  useEffect(() => {
    const queryRoot = searchParams.get('root');
    if (queryRoot && queryRoot !== activeRoot) {
      setRootInput(queryRoot);
      setActiveRoot(queryRoot);
    }
  }, [searchParams, activeRoot]);

  const { data, loading, error } = useSpannerGraph({
    root: activeRoot,
    maxDepth,
    direction,
    relationTypes: selectedRelations.length > 0 ? selectedRelations : undefined,
    entityKinds: selectedKinds.length > 0 ? selectedKinds : undefined,
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

  const handleApplyRoot = () => {
    const trimmed = rootInput.trim();
    if (!trimmed) {
      return;
    }
    setActiveRoot(trimmed);
    const nextParams: Record<string, string> = {
      root: trimmed,
      maxDepth: String(maxDepth),
      direction,
    };
    if (selectedRelations.length > 0) {
      nextParams.relationTypes = selectedRelations.join(',');
    }
    setSearchParams(nextParams);
  };

  const toggleRelation = (relation: string) => {
    setSelectedRelations(prev =>
      prev.includes(relation)
        ? prev.filter(item => item !== relation)
        : [...prev, relation],
    );
  };

  const toggleKind = (kind: string) => {
    setSelectedKinds(prev =>
      prev.includes(kind)
        ? prev.filter(item => item !== kind)
        : [...prev, kind],
    );
  };

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
    <Page themeId="tool">
      {!noHeader && (
        <Header
          title="Cloud Spanner Graph Explorer"
          subtitle="Multi-hop ISO GQL dependency, ownership, and blast-radius analysis"
        >
          <HeaderLabel label="Engine" value="Google Cloud Spanner Graph" />
          <HeaderLabel label="Query Language" value="ISO GQL" />
        </Header>
      )}
      <Content>
        <Grid container spacing={3}>
          <Grid item xs={12} md={4} lg={3}>
            <InfoCard title="Traversal Controls">
              <Box className={classes.filterSection}>
                <TextField
                  id="spanner-graph-root-input"
                  label="Root Entity Reference"
                  variant="outlined"
                  size="small"
                  fullWidth
                  value={rootInput}
                  onChange={event => setRootInput(event.target.value)}
                />
                <Button
                  variant="contained"
                  color="primary"
                  onClick={handleApplyRoot}
                >
                  Explore Subgraph
                </Button>

                <FormControl variant="outlined" size="small" fullWidth>
                  <InputLabel id="spanner-page-depth-label">
                    Max Depth
                  </InputLabel>
                  <Select
                    labelId="spanner-page-depth-label"
                    id="spanner-page-depth-select"
                    label="Max Depth"
                    value={maxDepth}
                    onChange={event => setMaxDepth(Number(event.target.value))}
                  >
                    {[1, 2, 3, 4, 5].map(d => (
                      <MenuItem key={d} value={d}>
                        {d} {d === 1 ? 'Hop' : 'Hops'}
                      </MenuItem>
                    ))}
                  </Select>
                </FormControl>

                <FormControl variant="outlined" size="small" fullWidth>
                  <InputLabel id="spanner-page-direction-label">
                    Traversal Direction
                  </InputLabel>
                  <Select
                    labelId="spanner-page-direction-label"
                    id="spanner-page-direction-select"
                    label="Traversal Direction"
                    value={direction}
                    onChange={event =>
                      setDirection(event.target.value as GraphDirection)
                    }
                  >
                    <MenuItem value="both">Both Directions</MenuItem>
                    <MenuItem value="outgoing">
                      Outgoing (Dependencies)
                    </MenuItem>
                    <MenuItem value="incoming">
                      Incoming (Blast Radius)
                    </MenuItem>
                  </Select>
                </FormControl>

                <FormControlLabel
                  control={
                    <Switch
                      color="primary"
                      size="small"
                      checked={mergeRelations}
                      onChange={event =>
                        setMergeRelations(event.target.checked)
                      }
                    />
                  }
                  label="Merge reciprocal relations"
                />

                <Box>
                  <Typography variant="subtitle2">Relation Types</Typography>
                  <Box className={classes.chipGroup}>
                    {AVAILABLE_RELATIONS.map(rel => {
                      const active = selectedRelations.includes(rel);
                      return (
                        <Chip
                          key={rel}
                          size="small"
                          label={rel}
                          clickable
                          color={active ? 'primary' : 'default'}
                          variant={active ? 'default' : 'outlined'}
                          onClick={() => toggleRelation(rel)}
                        />
                      );
                    })}
                  </Box>
                </Box>

                <Box>
                  <Typography variant="subtitle2">Entity Kinds</Typography>
                  <Box className={classes.chipGroup}>
                    {AVAILABLE_KINDS.map(kind => {
                      const active = selectedKinds.includes(kind);
                      return (
                        <Chip
                          key={kind}
                          size="small"
                          label={kind}
                          clickable
                          color={active ? 'primary' : 'default'}
                          variant={active ? 'default' : 'outlined'}
                          onClick={() => toggleKind(kind)}
                        />
                      );
                    })}
                  </Box>
                </Box>
              </Box>
            </InfoCard>
          </Grid>

          <Grid item xs={12} md={8} lg={9}>
            <InfoCard title={`Topology Canvas (${activeRoot})`}>
              <Box className={classes.statsBar}>
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
                <Typography variant="caption" color="textSecondary">
                  Click any node to open its Catalog Entity Page
                </Typography>
              </Box>

              {loading && <Progress />}
              {!loading && error && <ResponseErrorPanel error={error} />}
              {!loading && !error && dependencyNodes.length === 0 && (
                <Typography variant="body1" color="textSecondary">
                  No matching entities found in Spanner Graph for {activeRoot}.
                </Typography>
              )}
              {!loading && !error && dependencyNodes.length > 0 && (
                <Box className={classes.canvasBox}>
                  <DependencyGraph
                    nodes={dependencyNodes}
                    edges={dependencyEdges}
                    direction={DependencyGraphTypes.Direction.LEFT_RIGHT}
                    zoom="enabled"
                    renderNode={({ node }) => {
                      const fillColor = getKindColor(node.kind ?? 'component');
                      const isRoot =
                        node.id.toLocaleLowerCase('en-US') ===
                        activeRoot.toLocaleLowerCase('en-US');
                      return (
                        <g
                          className={classes.nodeCursor}
                          onClick={() => handleNodeClick(node.id)}
                        >
                          <title>
                            {node.title
                              ? `${node.id} — ${node.title}`
                              : node.id}
                          </title>
                          <rect
                            width={172}
                            height={54}
                            rx={8}
                            fill={fillColor}
                            stroke={isRoot ? '#ffd54f' : '#ffffff'}
                            strokeWidth={isRoot ? 3 : 1.5}
                          />
                          <text
                            x={86}
                            y={22}
                            textAnchor="middle"
                            fill="#ffffff"
                            fontSize={10}
                            fontWeight="bold"
                          >
                            {(node.kind ?? 'entity').toLocaleUpperCase('en-US')}
                          </text>
                          <text
                            x={86}
                            y={41}
                            textAnchor="middle"
                            fill="#ffffff"
                            fontSize={12}
                          >
                            {truncateNodeLabel(node.name, 20)}
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
            </InfoCard>

            {children && <Box mt={3}>{children}</Box>}
          </Grid>
        </Grid>
      </Content>
    </Page>
  );
}
