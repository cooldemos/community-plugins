-- Copyright 2026 The Backstage Authors
--
-- Licensed under the Apache License, Version 2.0 (the "License");
-- you may not use this file except in compliance with the License.
-- You may obtain a copy of the License at
--
--     http://www.apache.org/licenses/LICENSE-2.0
--
-- Unless required by applicable law or agreed to in writing, software
-- distributed under the License is distributed on an "AS IS" BASIS,
-- WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
-- See the License for the specific language governing permissions and
-- limitations under the License.

CREATE TABLE entities (
  entity_ref STRING(MAX) NOT NULL,
  entity_id STRING(MAX) NOT NULL,
  api_version STRING(128) NOT NULL,
  kind STRING(64) NOT NULL,
  namespace STRING(128) NOT NULL,
  name STRING(256) NOT NULL,
  title STRING(MAX),
  description STRING(MAX),
  lifecycle STRING(64),
  owner_ref STRING(MAX),
  system_ref STRING(MAX),
  metadata_json JSON,
  spec_json JSON,
  etag STRING(128),
  description_embedding ARRAY<FLOAT32>(vector_length=>768),
  updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  sync_run_id STRING(64) NOT NULL
) PRIMARY KEY (entity_ref);

CREATE INDEX idx_entities_id ON entities(entity_id);

CREATE INDEX idx_entities_kind_ns ON entities(kind, namespace);

CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name) STORING (kind, namespace, title, lifecycle, owner_ref, system_ref);

CREATE INDEX IF NOT EXISTS idx_entities_owner ON entities(owner_ref, kind, lifecycle) STORING (name, title, system_ref);

CREATE TABLE relations (
  entity_ref STRING(MAX) NOT NULL,
  relation_type STRING(128) NOT NULL,
  target_entity_ref STRING(MAX) NOT NULL,
  originating_entity_id STRING(MAX) NOT NULL,
  source_entity_ref STRING(MAX) NOT NULL,
  updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true),
  sync_run_id STRING(64) NOT NULL
) PRIMARY KEY (entity_ref, relation_type, target_entity_ref, originating_entity_id),
  INTERLEAVE IN PARENT entities ON DELETE CASCADE;

CREATE INDEX relations_by_target ON relations(target_entity_ref, relation_type) STORING (source_entity_ref);

CREATE OR REPLACE PROPERTY GRAPH BackstageCatalogGraph
  NODE TABLES (
    entities
      KEY (entity_ref)
      LABEL Entity
      PROPERTIES (
        entity_id,
        entity_ref,
        kind,
        namespace,
        name,
        title,
        description,
        lifecycle,
        owner_ref,
        system_ref
      )
  )
  EDGE TABLES (
    relations
      KEY (entity_ref, relation_type, target_entity_ref, originating_entity_id)
      SOURCE KEY (entity_ref) REFERENCES entities (entity_ref)
      DESTINATION KEY (target_entity_ref) REFERENCES entities (entity_ref)
      LABEL Relation
      PROPERTIES (
        entity_ref,
        relation_type,
        source_entity_ref,
        target_entity_ref,
        originating_entity_id
      )
  );
