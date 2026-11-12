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
  CodeSnippet,
  InfoCard,
  Progress,
  ResponseErrorPanel,
} from '@backstage/core-components';
import { useApi } from '@backstage/core-plugin-api';
import {
  Box,
  Button,
  Chip,
  Collapse,
  makeStyles,
  Paper,
  TextField,
  Typography,
} from '@material-ui/core';
import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { NaturalLanguageGraphResponse, spannerGraphApiRef } from '../api/types';

/**
 * Props for {@link SpannerNaturalQueryCard}.
 *
 * @public
 */
export interface SpannerNaturalQueryCardProps {
  title?: string;
  defaultQuery?: string;
  onSelectEntityRef?: (entityRef: string) => void;
}

const AI_SERVICE_CONFIG_SNIPPET = `spannerGraph:
  projectId: your-gcp-project
  instanceId: backstage-graph-instance
  databaseId: backstage-catalog
  llm:
    provider: vertex
    model: gemini-3-flash-preview
    location: global`;

/** Checks whether an error indicates that natural-language LLM translation is not configured on the backend. */
function isUnconfiguredAiServiceError(error: Error): boolean {
  const causeMessage = (error as { cause?: { message?: string } }).cause
    ?.message;
  const details = [error.message, causeMessage].filter(Boolean).join(' ');
  return (
    details.includes('aiServiceUrl') ||
    details.includes('NotImplementedError') ||
    details.includes('501') ||
    details.includes('spannerGraph.llm') ||
    details.includes('spannerGraph.projectId')
  );
}

const useStyles = makeStyles(theme => ({
  queryRow: {
    display: 'flex',
    alignItems: 'center',
    gap: theme.spacing(1.5),
    marginBottom: theme.spacing(2),
  },
  answerPaper: {
    padding: theme.spacing(2),
    marginBottom: theme.spacing(2),
    backgroundColor: theme.palette.background.default,
  },
  chipRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: theme.spacing(1),
    marginTop: theme.spacing(1),
  },
}));

/**
 * Natural-language graph query card displaying synthesized answers, collapsible ISO GQL statements,
 * and clickable matched entity chips.
 *
 * @public
 */
export function SpannerNaturalQueryCard(props: SpannerNaturalQueryCardProps) {
  const {
    title = 'Ask Spanner Graph (Natural Language to ISO GQL)',
    defaultQuery = 'Which production services depend on orders-spanner-db?',
    onSelectEntityRef,
  } = props;

  const classes = useStyles();
  const api = useApi(spannerGraphApiRef);
  const [, setSearchParams] = useSearchParams();

  const [query, setQuery] = useState<string>(defaultQuery);
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<Error | undefined>(undefined);
  const [response, setResponse] = useState<
    NaturalLanguageGraphResponse | undefined
  >(undefined);
  const [showGql, setShowGql] = useState<boolean>(false);

  const handleSelectEntity = (entityRef: string) => {
    if (onSelectEntityRef) {
      onSelectEntityRef(entityRef);
      return;
    }
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      next.set('root', entityRef);
      return next;
    });
  };

  const handleAsk = async () => {
    const trimmed = query.trim();
    if (!trimmed) {
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      const result = await api.askNaturalLanguage(trimmed);
      setResponse(result);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setLoading(false);
    }
  };

  return (
    <InfoCard title={title}>
      <Box className={classes.queryRow}>
        <TextField
          id="spanner-natural-query-input"
          label="Ask a question about catalog dependencies or blast radius"
          variant="outlined"
          size="small"
          fullWidth
          value={query}
          onChange={event => setQuery(event.target.value)}
        />
        <Button
          variant="contained"
          color="primary"
          disabled={loading || !query.trim()}
          onClick={handleAsk}
        >
          Ask Graph
        </Button>
      </Box>

      {loading && <Progress />}
      {!loading && error && isUnconfiguredAiServiceError(error) && (
        <Paper variant="outlined" className={classes.answerPaper}>
          <Typography variant="subtitle2" gutterBottom>
            Natural Language AI Service Not Configured
          </Typography>
          <Typography variant="body2" color="textSecondary" gutterBottom>
            Configure spannerGraph.aiServiceUrl in app-config.yaml to enable
            natural-language-to-ISO-GQL translation:
          </Typography>
          <CodeSnippet
            text={AI_SERVICE_CONFIG_SNIPPET}
            language="yaml"
            showCopyCodeButton
          />
        </Paper>
      )}
      {!loading && error && !isUnconfiguredAiServiceError(error) && (
        <ResponseErrorPanel error={error} />
      )}

      {!loading && response && (
        <Box>
          <Paper variant="outlined" className={classes.answerPaper}>
            <Typography variant="subtitle2" gutterBottom>
              Synthesized Answer
            </Typography>
            <Typography variant="body1">{response.answer}</Typography>

            {response.matchedNodes.length > 0 && (
              <Box mt={2}>
                <Typography variant="caption" color="textSecondary">
                  Matched Entities
                </Typography>
                <Box className={classes.chipRow}>
                  {response.matchedNodes.map(node => (
                    <Chip
                      key={node.id}
                      size="small"
                      color="primary"
                      variant="outlined"
                      label={node.id}
                      clickable
                      onClick={() => handleSelectEntity(node.id)}
                    />
                  ))}
                </Box>
              </Box>
            )}
          </Paper>

          {response.executedGql && (
            <Box>
              <Button
                size="small"
                variant="outlined"
                onClick={() => setShowGql(prev => !prev)}
              >
                {showGql ? 'Hide Executed ISO GQL' : 'Show Executed ISO GQL'}
              </Button>
              <Collapse in={showGql}>
                <Box mt={1}>
                  <CodeSnippet
                    text={response.executedGql}
                    language="sql"
                    showCopyCodeButton
                  />
                </Box>
              </Collapse>
            </Box>
          )}
        </Box>
      )}
    </InfoCard>
  );
}
