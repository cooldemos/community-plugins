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

variable "project_id" {
  description = "Google Cloud project ID where Cloud Spanner Graph resources will be created."
  type        = string
}

variable "region" {
  description = "Default Google Cloud region for regional resources."
  type        = string
  default     = "us-central1"
}

variable "spanner_instance_name" {
  description = "Name of the Cloud Spanner instance."
  type        = string
  default     = "backstage-graph-instance"
}

variable "spanner_config" {
  description = "Cloud Spanner instance configuration name (for example, regional-us-central1)."
  type        = string
  default     = "regional-us-central1"
}

variable "spanner_database_name" {
  description = "Name of the Cloud Spanner database storing Backstage catalog graph data."
  type        = string
  default     = "backstage-catalog"
}

variable "processing_units" {
  description = "Spanner compute capacity in processing units (100 to 1000 for dev/production)."
  type        = number
  default     = 100
}

variable "deletion_protection" {
  description = "Whether Terraform is prevented from destroying the Spanner database."
  type        = bool
  default     = true
}

variable "backstage_service_account_id" {
  description = "Account ID for the dedicated Backstage Spanner Graph service account."
  type        = string
  default     = "backstage-spanner-graph"
}
