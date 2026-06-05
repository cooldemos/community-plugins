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
  SearchEngine,
  QueryTranslator,
} from '@backstage/plugin-search-backend-node';
import {
  IndexableResultSet,
  SearchQuery,
  IndexableDocument,
} from '@backstage/plugin-search-common';
import { SearchServiceClient } from '@google-cloud/discoveryengine';
import { Writable } from 'node:stream';
import { LoggerService } from '@backstage/backend-plugin-api';

interface ExtendedIndexableDocument extends IndexableDocument {
  kind?: string;
  namespace?: string;
  name?: string;
}

const unpackProtobuf = (val: any): any => {
  if (val === null || typeof val !== 'object') return val;

  if ('stringValue' in val) return val.stringValue;
  if ('numberValue' in val) return val.numberValue;
  if ('boolValue' in val) return val.boolValue;
  if ('nullValue' in val) return null;
  if ('structValue' in val) return unpackProtobuf(val.structValue);
  if ('listValue' in val)
    return (val.listValue?.values || []).map(unpackProtobuf);

  const target = val.fields || val;
  const result: Record<string, any> = {};
  for (const [k, v] of Object.entries(target)) {
    result[k] = unpackProtobuf(v);
  }
  return result;
};

/**
 * SearchEngine implementation for Google Cloud Vertex AI Search.
 *
 * @public
 */
export class VertexAISearchEngine implements SearchEngine {
  private client: SearchServiceClient;
  private projectId: string;
  private location: string;
  private dataStoreId: string;
  private engineId?: string;
  private searchOptions?: Record<string, any>;
  private logger?: LoggerService;

  constructor(options: {
    projectId: string;
    location: string;
    dataStoreId: string;
    engineId?: string;
    searchOptions?: Record<string, any>;
    logger?: LoggerService;
  }) {
    if (!options.projectId) {
      throw new Error(
        'projectId is strictly required for VertexAISearchEngine',
      );
    }
    if (!options.location) {
      throw new Error('location is strictly required for VertexAISearchEngine');
    }
    if (!options.dataStoreId) {
      throw new Error(
        'dataStoreId is strictly required for VertexAISearchEngine',
      );
    }

    this.projectId = options.projectId;
    this.location = options.location;
    this.dataStoreId = options.dataStoreId;
    this.engineId = options.engineId;
    this.searchOptions = options.searchOptions;
    this.logger = options.logger;

    this.logger?.info(
      `Initializing VertexAISearchEngine for project ${
        this.projectId
      }, location ${this.location}, dataStore ${this.dataStoreId}${
        this.engineId ? `, engineId ${this.engineId}` : ''
      }`,
    );

    // Initialize the Google Cloud Discovery Engine client
    // Ensure the environment has GOOGLE_APPLICATION_CREDENTIALS set or runs on GCP with identity
    this.client = new SearchServiceClient({
      apiEndpoint:
        this.location !== 'global'
          ? `${this.location}-discoveryengine.googleapis.com`
          : undefined,
    });
  }

  setTranslator(_translator: QueryTranslator): void {
    // No-op: interface requires implementation
  }

  async getIndexer(_type: string): Promise<Writable> {
    throw new Error(
      'Indexing is not supported directly through VertexAISearchEngine',
    );
  }

  async query(query: SearchQuery): Promise<IndexableResultSet> {
    const parent = this.engineId
      ? `projects/${this.projectId}/locations/${this.location}/collections/default_collection/engines/${this.engineId}/servingConfigs/default_search`
      : `projects/${this.projectId}/locations/${this.location}/dataStores/${this.dataStoreId}/servingConfigs/default_search`;

    this.logger?.info(`Using parent serving config: "${parent}"`);
    this.logger?.info(`Querying Vertex AI Search with term: "${query.term}"`);

    try {
      const [apiResults] = await this.client.search({
        servingConfig: parent,
        query: query.term,
        ...this.searchOptions,
        relevanceScoreSpec: {
          returnRelevanceScore: true,
          ...this.searchOptions?.relevanceScoreSpec,
        },
      });

      const resultsCount = apiResults?.length || 0;
      this.logger?.info(`Vertex AI Search returned ${resultsCount} results`);

      const results = (apiResults || []).map((result: any) => {
        const structData = unpackProtobuf(result.document.structData) || {};
        const derivedStructData =
          unpackProtobuf(result.document.derivedStructData) || {};

        const kind = structData.kind || 'other';
        const namespace = structData.namespace || 'default';
        const name = structData.name || '';
        const fileLocation = structData.location || '';

        let displayText = '';
        let source = 'fallback_text';

        const extractiveAnswers = derivedStructData.extractive_answers || [];
        const extractiveSegments = derivedStructData.extractive_segments || [];
        const snippets = derivedStructData.snippets || [];

        if (extractiveAnswers.length > 0) {
          displayText = extractiveAnswers
            .map((a: any) => a.content || '')
            .filter((c: string) => c.length > 0)
            .join(' ');
          source = 'extractive_answer';
        } else if (extractiveSegments.length > 0) {
          displayText = extractiveSegments
            .map((s: any) => s.content || '')
            .filter((c: string) => c.length > 0)
            .join('\n...\n');
          source = 'extractive_segment';
        } else if (snippets.length > 0) {
          displayText = snippets
            .map((sn: any) => sn.snippet || '')
            .filter((c: string) => c.length > 0)
            .join(' ');
          source = 'snippet';
        } else {
          displayText = structData.text || '';
        }

        this.logger?.info(
          `Mapped search result text for "${
            structData.title || result.document.name
          }" using source: ${source}`,
        );

        const doc: ExtendedIndexableDocument = {
          title: structData.title || result.document.name,
          text: displayText,
          location: `/docs/${namespace}/${kind}/${name}/${fileLocation}`,
          kind,
          namespace,
          name,
        };

        // Extract relevance score from rankSignals if populated
        const relevanceScore = result.rankSignals?.relevanceScore;

        this.logger?.debug(
          `Mapped document: ${doc.title} with semantic score: ${relevanceScore}`,
        );

        return {
          type: 'techdocs',
          document: doc,
          score:
            typeof relevanceScore === 'number' ? relevanceScore : undefined,
        };
      });

      return { results } as IndexableResultSet;
    } catch (error) {
      this.logger?.error(`Vertex AI Search failed`, error as Error);
      throw error;
    }
  }
}
