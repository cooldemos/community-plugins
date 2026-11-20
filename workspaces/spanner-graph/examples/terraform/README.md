# Cloud Spanner Graph Terraform Example

This directory provides a standalone Terraform configuration using standard `hashicorp/google` resources to provision a Google Cloud Spanner Graph instance, the `backstage-catalog` database schema, Vertex AI API enablement, and least-privilege IAM bindings for Backstage.

## Provider Configuration (`versions.tf`)

The `google` provider enables `user_project_override = true` and sets `billing_project = var.project_id`. This ensures Application Default Credentials (ADC) attribute Spanner admin and Vertex AI API quota directly to the target project without requiring manual `GOOGLE_CLOUD_QUOTA_PROJECT` overrides.

## Resources Provisioned (`main.tf` and `schema.sql`)

- `google_project_service.spanner`: Enables `spanner.googleapis.com` on the target project (`disable_on_destroy = false`).
- `google_project_service.vertex_ai`: Enables `aiplatform.googleapis.com` on the target project (`disable_on_destroy = false`) for Vertex AI Gemini natural-language queries and optional embedding models.
- `google_spanner_instance.backstage_graph`: Creates an `ENTERPRISE` edition Cloud Spanner instance required for Spanner Graph.
- `google_spanner_database.backstage_catalog`: Creates the `backstage-catalog` database and applies the DDL from `schema.sql`:
  - `entities` root node table (`PRIMARY KEY (entity_ref)`)
  - Secondary indexes `idx_entities_id`, `idx_entities_kind_ns`, `idx_entities_name` (covering `kind`, `namespace`, `title`, `lifecycle`, `owner_ref`, `system_ref`), and `idx_entities_owner` (covering `name`, `title`, `system_ref`)
  - `relations` interleaved child edge table (`INTERLEAVE IN PARENT entities ON DELETE CASCADE`) and `relations_by_target` reverse covering index
  - `BackstageCatalogGraph` property graph mapping `entities` (`Entity`) and `relations` (`Relation`)
- `google_service_account.backstage_spanner`: Creates a dedicated service account for Backstage.
- `google_spanner_database_iam_member.backstage_database_user`: Grants `roles/spanner.databaseUser` on the `backstage-catalog` database to the Backstage service account.
- `google_project_iam_member.backstage_vertex_ai_user`: Grants `roles/aiplatform.user` on the target project to the Backstage service account so `spanner-graph-backend` can invoke Vertex AI Gemini (`gemini-3-flash-preview`) via ADC.

## Usage

```bash
cd workspaces/spanner-graph/examples/terraform
terraform init
terraform apply -var="project_id=my-gcp-project"
```
