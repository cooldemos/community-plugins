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

output "spanner_instance_id" {
  description = "Cloud Spanner instance name."
  value       = google_spanner_instance.backstage_graph.name
}

output "spanner_database_id" {
  description = "Cloud Spanner database name."
  value       = google_spanner_database.backstage_catalog.name
}

output "backstage_service_account_email" {
  description = "Service account email granted Spanner databaseUser access."
  value       = google_service_account.backstage_spanner.email
}
