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
import { Entity } from '@backstage/catalog-model';
import { SpannerEntityRow, SpannerRelationRow } from '../types';

/**
 * Normalizes a Backstage entity reference string into canonical `kind:namespace/name` form,
 * lowercasing `kind` and `namespace` while preserving entity `name` casing.
 *
 * @public
 */
export function normalizeEntityRef(
  rawRef: string,
  defaultKind: string = 'component',
): string {
  const trimmed = rawRef.trim();
  if (!trimmed) {
    throw new Error('Entity reference cannot be empty');
  }

  const normalizedDefaultKind =
    defaultKind.trim().toLocaleLowerCase('en-US') || 'component';
  let kind = normalizedDefaultKind;
  let remainder = trimmed;

  const colonIdx = trimmed.indexOf(':');
  if (colonIdx !== -1) {
    kind =
      trimmed.slice(0, colonIdx).trim().toLocaleLowerCase('en-US') ||
      normalizedDefaultKind;
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
    throw new Error(
      `Invalid entity reference "${rawRef}": missing entity name`,
    );
  }

  return `${kind}:${namespace}/${name}`;
}

/**
 * Transforms a Backstage catalog Entity into a Spanner `entities` table node row.
 *
 * @public
 */
export function transformEntityToSpannerNode(
  entity: Entity,
  syncRunId: string,
  nowIso: string = new Date().toISOString(),
): SpannerEntityRow {
  const kind = entity.kind.toLocaleLowerCase('en-US');
  const namespace = (entity.metadata.namespace ?? 'default').toLocaleLowerCase(
    'en-US',
  );
  const name = entity.metadata.name;
  const entityRef = `${kind}:${namespace}/${name}`;
  const entityId = entity.metadata.uid ?? entityRef;

  const spec = (entity.spec ?? {}) as Record<string, unknown>;
  const lifecycle = typeof spec.lifecycle === 'string' ? spec.lifecycle : null;
  const ownerRef =
    typeof spec.owner === 'string' && spec.owner.trim()
      ? normalizeEntityRef(spec.owner, 'group')
      : null;
  const systemRef =
    typeof spec.system === 'string' && spec.system.trim()
      ? normalizeEntityRef(spec.system, 'system')
      : null;

  return {
    entity_id: entityId,
    entity_ref: entityRef,
    api_version: entity.apiVersion,
    kind,
    namespace,
    name,
    title:
      typeof entity.metadata.title === 'string' ? entity.metadata.title : null,
    description:
      typeof entity.metadata.description === 'string'
        ? entity.metadata.description
        : null,
    lifecycle,
    owner_ref: ownerRef,
    system_ref: systemRef,
    metadata_json: entity.metadata as Record<string, unknown>,
    spec_json: spec,
    etag:
      typeof entity.metadata.etag === 'string' ? entity.metadata.etag : null,
    updated_at: nowIso,
    sync_run_id: syncRunId,
  };
}

/**
 * Transforms a Backstage catalog Entity's outgoing relations into deduplicated Spanner `relations` table edge rows.
 *
 * @public
 */
export function transformEntityRelationsToSpannerEdges(
  entity: Entity,
  syncRunId: string,
  nowIso: string = new Date().toISOString(),
): SpannerRelationRow[] {
  const relations = entity.relations;
  if (!relations || relations.length === 0) {
    return [];
  }

  const kind = entity.kind.toLocaleLowerCase('en-US');
  const namespace = (entity.metadata.namespace ?? 'default').toLocaleLowerCase(
    'en-US',
  );
  const sourceEntityRef = `${kind}:${namespace}/${entity.metadata.name}`;
  const originatingEntityId = entity.metadata.uid ?? sourceEntityRef;

  const seenCompositeKeys = new Set<string>();
  const edges: SpannerRelationRow[] = [];

  for (const relation of relations) {
    if (!relation?.type || !relation?.targetRef) {
      continue;
    }

    const targetEntityRef = normalizeEntityRef(relation.targetRef);
    const relationType = relation.type.trim();
    // Deduplicate by the Spanner `relations` composite primary key (entity_ref, relation_type, target_entity_ref, originating_entity_id).
    const compositeKey = `${sourceEntityRef}::${relationType}::${targetEntityRef}::${originatingEntityId}`;
    if (seenCompositeKeys.has(compositeKey)) {
      continue;
    }
    seenCompositeKeys.add(compositeKey);

    edges.push({
      entity_ref: sourceEntityRef,
      relation_type: relationType,
      target_entity_ref: targetEntityRef,
      originating_entity_id: originatingEntityId,
      source_entity_ref: sourceEntityRef,
      updated_at: nowIso,
      sync_run_id: syncRunId,
    });
  }

  return edges;
}
