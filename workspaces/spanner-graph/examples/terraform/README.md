# Cloud Spanner Graph Terraform Example

This directory provides a standalone Terraform configuration using standard `hashicorp/google` resources to provision a Google Cloud Spanner Graph instance, database schema (`entities`, interleaved `relations`, indexes, and `BackstageCatalogGraph` property graph), and least-privilege IAM bindings for Backstage.

## Resources Provisioned

- `google_project_service.spanner`: Enables `spanner.googleapis.com` on the target project.
- `google_spanner_instance.backstage_graph`: Creates an `ENTERPRISE` edition Cloud Spanner instance required for Spanner Graph.
- `google_spanner_database.backstage_catalog`: Creates the `backstage-catalog` database and applies the `entities`, `relations`, `relations_by_target`, and `BackstageCatalogGraph` DDL statements.
- `google_service_account.backstage_spanner`: Creates a dedicated service account for Backstage.
- `google_spanner_database_iam_member.backstage_database_user`: Grants `roles/spanner.databaseUser` on the database to the Backstage service account.

## Usage

```bash
cd workspaces/spanner-graph/examples/terraform
terraform init
terraform apply -var="project_id=my-gcp-project"
```
