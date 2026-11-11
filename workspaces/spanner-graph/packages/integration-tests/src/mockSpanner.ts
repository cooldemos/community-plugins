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
  SpannerEntityRow,
  SpannerRelationRow,
} from '@backstage-community/plugin-catalog-backend-module-spanner-sync';

interface MockJsonRow {
  toJSON: () => Record<string, unknown>;
}

/** Wraps a plain object in a Spanner-compatible row with `.toJSON()`. */
function wrapRow(data: Record<string, unknown>): MockJsonRow {
  return {
    toJSON: () => data,
  };
}

/**
 * In-memory Cloud Spanner Graph database simulator supporting DDL schema tracking,
 * interleaved `entities` / `relations` mutations, stale entity reconciliation, and
 * multi-hop ISO GQL `MATCH TRAIL` path queries for hermetic integration testing.
 */
export class InMemorySpannerDatabase {
  public readonly ddlHistory: string[] = [];
  public readonly entities = new Map<
    string,
    SpannerEntityRow & { description_embedding?: number[] }
  >();
  public readonly relations = new Map<string, SpannerRelationRow>();

  async updateSchema(
    statements: readonly string[],
  ): Promise<Array<{ promise: () => Promise<void> }>> {
    this.ddlHistory.push(...statements);
    return [{ promise: async () => undefined }];
  }

  table(tableName: string) {
    if (tableName === 'entities') {
      return {
        upsert: async (rows: unknown[]) => {
          for (const raw of rows as SpannerEntityRow[]) {
            this.entities.set(raw.entity_ref, { ...raw });
          }
        },
      };
    }
    if (tableName === 'relations') {
      return {
        upsert: async (rows: unknown[]) => {
          for (const raw of rows as SpannerRelationRow[]) {
            const key = `${raw.entity_ref}::${raw.relation_type}::${raw.target_entity_ref}::${raw.originating_entity_id}`;
            this.relations.set(key, { ...raw });
          }
        },
      };
    }
    throw new Error(
      `Unsupported table "${tableName}" in InMemorySpannerDatabase`,
    );
  }

  async runTransactionAsync<T>(
    callback: (transaction: {
      runUpdate: (query: {
        sql: string;
        params?: Record<string, unknown>;
      }) => Promise<[number]>;
      update: (tableName: string, rows: unknown[]) => void;
      commit: () => Promise<void>;
    }) => Promise<T>,
  ): Promise<T> {
    const transaction = {
      runUpdate: async ({
        sql,
        params,
      }: {
        sql: string;
        params?: Record<string, unknown>;
      }): Promise<[number]> => {
        const activeSyncRunId = String(params?.syncRunId ?? '');
        if (/DELETE\s+FROM\s+relations/i.test(sql)) {
          let deleted = 0;
          for (const [key, rel] of this.relations.entries()) {
            if (rel.sync_run_id !== activeSyncRunId) {
              this.relations.delete(key);
              deleted += 1;
            }
          }
          return [deleted];
        }

        if (/DELETE\s+FROM\s+entities/i.test(sql)) {
          let deleted = 0;
          for (const [entityRef, entity] of this.entities.entries()) {
            if (entity.sync_run_id !== activeSyncRunId) {
              this.entities.delete(entityRef);
              deleted += 1;
              // Simulate INTERLEAVE IN PARENT entities ON DELETE CASCADE.
              for (const [relKey, rel] of this.relations.entries()) {
                if (rel.entity_ref === entityRef) {
                  this.relations.delete(relKey);
                }
              }
            }
          }
          return [deleted];
        }

        return [0];
      },
      update: (tableName: string, rows: unknown[]) => {
        if (tableName === 'entities') {
          for (const updateRow of rows as Array<{
            entity_ref?: string;
            entity_id?: string;
            description_embedding?: number[];
          }>) {
            const key = updateRow.entity_ref ?? updateRow.entity_id ?? '';
            const existing = this.entities.get(key);
            if (existing) {
              existing.description_embedding = updateRow.description_embedding;
            }
          }
        }
      },
      commit: async () => undefined,
    };

    return callback(transaction);
  }

  async run({
    sql,
    params = {},
  }: {
    sql: string;
    params?: Record<string, unknown>;
  }): Promise<[MockJsonRow[]]> {
    if (/ML\.PREDICT/i.test(sql)) {
      const predicted: MockJsonRow[] = [];
      for (const entity of this.entities.values()) {
        if (!entity.description_embedding) {
          predicted.push(
            wrapRow({
              entity_ref: entity.entity_ref,
              embedding: [0.25, 0.5, 0.75],
            }),
          );
        }
      }
      return [predicted];
    }

    if (/FROM\s+entities\s+WHERE\s+entity_ref\s*=\s*@rootRef/i.test(sql)) {
      const rootRef = String(params.rootRef ?? '');
      const found = Array.from(this.entities.values()).find(
        e => e.entity_ref === rootRef,
      );
      return [found ? [wrapRow({ ...found })] : []];
    }

    if (/MATCH\s+(?:p\s*=\s*)?TRAIL/i.test(sql)) {
      return [this.evaluateGqlMatchTrail(sql, params)];
    }

    return [[]];
  }

  /** Evaluates a parameterized ISO GQL MATCH TRAIL query against the in-memory entities and relations. */
  private evaluateGqlMatchTrail(
    sql: string,
    params: Record<string, unknown>,
  ): MockJsonRow[] {
    const rootRef = String(params.rootRef ?? '');
    const maxPaths = Number(params.maxPaths ?? 500);
    const relationFilter = Array.isArray(params.relationTypes)
      ? new Set(params.relationTypes as string[])
      : undefined;
    const kindFilter = Array.isArray(params.entityKinds)
      ? new Set(
          (params.entityKinds as string[]).map(k =>
            k.toLocaleLowerCase('en-US'),
          ),
        )
      : undefined;

    const depthMatch = /\{1,(\d+)\}/.exec(sql);
    const maxDepth = depthMatch ? Number.parseInt(depthMatch[1], 10) : 2;

    let direction: 'outgoing' | 'incoming' | 'both' = 'both';
    if (/\]->\)\{1,/.test(sql) || sql.includes('-[e:Relation]->')) {
      direction = 'outgoing';
    } else if (
      /\(<-\[e:Relation/.test(sql) ||
      sql.includes('<-[e:Relation]-')
    ) {
      direction = 'incoming';
    }

    const entitiesByRef = new Map<string, SpannerEntityRow>();
    for (const entity of this.entities.values()) {
      entitiesByRef.set(entity.entity_ref, entity);
    }

    const startNode = entitiesByRef.get(rootRef);
    if (!startNode) {
      return [];
    }

    const allEdges = Array.from(this.relations.values());
    const results: MockJsonRow[] = [];

    interface QueueItem {
      currentRef: string;
      depth: number;
      usedEdgeKeys: Set<string>;
      elements: Array<Record<string, unknown>>;
    }

    const queue: QueueItem[] = [
      {
        currentRef: rootRef,
        depth: 0,
        usedEdgeKeys: new Set<string>(),
        elements: [
          {
            kind: 'node',
            properties: { ...startNode },
          },
        ],
      },
    ];

    while (queue.length > 0 && results.length < maxPaths) {
      const current = queue.shift()!;
      if (current.depth >= maxDepth) {
        continue;
      }

      for (const edge of allEdges) {
        if (relationFilter && !relationFilter.has(edge.relation_type)) {
          continue;
        }

        const edgeKey = `${edge.source_entity_ref}::${edge.relation_type}::${edge.target_entity_ref}`;
        if (current.usedEdgeKeys.has(edgeKey)) {
          continue;
        }

        let nextRef: string | undefined;
        if (
          (direction === 'outgoing' || direction === 'both') &&
          edge.source_entity_ref === current.currentRef
        ) {
          nextRef = edge.target_entity_ref;
        } else if (
          (direction === 'incoming' || direction === 'both') &&
          edge.target_entity_ref === current.currentRef
        ) {
          nextRef = edge.source_entity_ref;
        }

        if (!nextRef) {
          continue;
        }

        const nextNode = entitiesByRef.get(nextRef);
        if (!nextNode) {
          continue;
        }

        const nextElements = [
          ...current.elements,
          {
            kind: 'edge',
            properties: { ...edge },
          },
          {
            kind: 'node',
            properties: { ...nextNode },
          },
        ];

        const nextUsedEdges = new Set(current.usedEdgeKeys);
        nextUsedEdges.add(edgeKey);

        if (
          !kindFilter ||
          kindFilter.has(nextNode.kind.toLocaleLowerCase('en-US'))
        ) {
          results.push(wrapRow({ path: nextElements }));
          if (results.length >= maxPaths) {
            break;
          }
        }

        queue.push({
          currentRef: nextRef,
          depth: current.depth + 1,
          usedEdgeKeys: nextUsedEdges,
          elements: nextElements,
        });
      }
    }

    return results;
  }
}
