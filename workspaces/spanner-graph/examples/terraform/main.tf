# Copyright 2026 The Backstage Authors
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

resource "google_project_service" "spanner" {
  project            = var.project_id
  service            = "spanner.googleapis.com"
  disable_on_destroy = false
}

resource "google_spanner_instance" "backstage_graph" {
  project          = var.project_id
  name             = var.spanner_instance_name
  config           = var.spanner_config
  display_name     = "Backstage Catalog Graph"
  processing_units = var.processing_units
  edition          = "ENTERPRISE"

  labels = {
    app       = "backstage"
    component = "spanner-graph"
  }

  depends_on = [google_project_service.spanner]
}

resource "google_spanner_database" "backstage_catalog" {
  project                  = var.project_id
  instance                 = google_spanner_instance.backstage_graph.name
  name                     = var.spanner_database_name
  version_retention_period = "7d"
  deletion_protection      = var.deletion_protection

  ddl = [
    "CREATE TABLE entities (entity_id STRING(MAX) NOT NULL, entity_ref STRING(MAX) NOT NULL, api_version STRING(128) NOT NULL, kind STRING(64) NOT NULL, namespace STRING(128) NOT NULL, name STRING(256) NOT NULL, title STRING(MAX), description STRING(MAX), lifecycle STRING(64), owner_ref STRING(MAX), system_ref STRING(MAX), metadata_json JSON, spec_json JSON, etag STRING(128), description_embedding ARRAY<FLOAT32>(vector_length=>768), updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true), sync_run_id STRING(64) NOT NULL) PRIMARY KEY(entity_id)",
    "CREATE INDEX idx_entities_ref ON entities(entity_ref)",
    "CREATE INDEX idx_entities_kind_ns ON entities(kind, namespace)",
    "CREATE TABLE relations (entity_id STRING(MAX) NOT NULL, target_entity_ref STRING(MAX) NOT NULL, relation_type STRING(128) NOT NULL, source_entity_ref STRING(MAX) NOT NULL, updated_at TIMESTAMP NOT NULL OPTIONS (allow_commit_timestamp=true), sync_run_id STRING(64) NOT NULL) PRIMARY KEY(entity_id, relation_type, target_entity_ref), INTERLEAVE IN PARENT entities ON DELETE CASCADE",
    "CREATE INDEX relations_by_target ON relations(target_entity_ref, relation_type) STORING (source_entity_ref)",
    "CREATE OR REPLACE PROPERTY GRAPH BackstageCatalogGraph NODE TABLES (entities KEY (entity_id) LABEL Entity PROPERTIES (entity_id, entity_ref, kind, namespace, name, title, description, lifecycle, owner_ref, system_ref)) EDGE TABLES (relations KEY (entity_id, relation_type, target_entity_ref) SOURCE KEY (entity_id) REFERENCES entities (entity_id) DESTINATION KEY (target_entity_ref) REFERENCES entities (entity_ref) LABEL Relation PROPERTIES (relation_type, source_entity_ref, target_entity_ref))",
  ]
}

resource "google_service_account" "backstage_spanner" {
  project      = var.project_id
  account_id   = var.backstage_service_account_id
  display_name = "Backstage Cloud Spanner Graph Service Account"
}

resource "google_spanner_database_iam_member" "backstage_database_user" {
  project  = var.project_id
  instance = google_spanner_instance.backstage_graph.name
  database = google_spanner_database.backstage_catalog.name
  role     = "roles/spanner.databaseUser"
  member   = "serviceAccount:${google_service_account.backstage_spanner.email}"
}
