# GCS Eventarc TechDocs Ingress Backend Module for Backstage (`@backstage-community/plugin-events-backend-module-gcs-eventarc`)

`@backstage-community/plugin-events-backend-module-gcs-eventarc` mounts an event-driven webhook at `/api/events/gcs` that listens for Google Cloud Storage (GCS) `google.cloud.storage.object.v1.finalized` notifications delivered by Google Eventarc. Whenever a CI/CD pipeline publishes a new `search_index.json` for a TechDocs site, the module enriches the pages with Backstage Software Catalog metadata, imports them into Google Cloud Vertex AI Search, and purges removed pages by comparing against the previous GCS object generation.

---

## Ingestion Architecture & Sequence

```text
┌───────────────────────────────────────────────────────────────────────────────────────────┐
│                           Decoupled Eventarc Ingestion Sequence                           │
├───────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                           │
│  CI/CD Pipeline ──► Upload search_index.json ──► GCS TechDocs Bucket                      │
│                                                        │                                  │
│                                                        ▼                                  │
│                                     Google Eventarc Trigger                               │
│                                  (object.v1.finalized event)                              │
│                                                        │                                  │
│                                                        ▼                                  │
│                                 Private GKE / Cloud Run Webhook                           │
│                                   (HTTP POST /api/events/gcs)                             │
│                                                        │                                  │
│                                                        ▼ (Verify OIDC & Return 200 OK)    │
│                                   Internal Backstage Event Bus                            │
│                                                        │                                  │
│                                                        ▼ (Async 'gcs-notifications' Sub)  │
│                                  1. Download search_index.json (Gen N)                    │
│                                  2. Enrich via CatalogService (canonical entity.kind)     │
│                                  3. Compute Deterministic MD5 Document IDs                │
│                                  4. Import Batches & Verify metadata.failureCount == 0    │
│                                  5. Diff vs Gen N-1 & Delete Removed Page IDs             │
│                                                                                           │
└───────────────────────────────────────────────────────────────────────────────────────────┘
```

### Synchronization Guarantees

1. **Non-Blocking Webhook Ingress**: `/api/events/gcs` validates incoming headers (and Google OIDC ID tokens when enabled), publishes `gcs-notifications` onto Backstage's internal `EventsService`, and immediately responds `200 OK` so user traffic is not blocked.
2. **Canonical Catalog Enrichment**: For each `namespace/kind/name/search_index.json` object, the subscriber looks up the parent entity via `CatalogService` and enriches every page with `owner`, `lifecycle`, `componentType`, `annotations`, canonical `kind` (`entity?.kind || kind`, such as `'Component'` or `'API'` so case-sensitive Discovery Engine filters match), and lowercase `authorization.resourceRef` (`<kind>:<namespace>/<name>`).
3. **Deterministic Document IDs**: Page IDs are derived from `md5("/docs/<namespace>/<kind>/<name>/<cleanLocation>")` (lowercased entity coordinates), ensuring in-place upserts across rebuilds without changing existing document IDs.
4. **Partial Failure Guard Before Delta Deletions**: Inline `importDocuments` batches (`<= 100` docs, bounded by `maxConcurrency`) are awaited via `operation.promise()` and checked for `Number(metadata?.failureCount ?? 0) > 0`. If any document fails to import, the module logs `response.errorSamples` and aborts **before** running GCS generation delta deletions so failed imports never cause valid pages to be deleted.
5. **GCS Generation Delta Cleanup**: When GCS Object Versioning is enabled on the TechDocs bucket, the subscriber fetches the immediately preceding object generation, computes removed page IDs, and deletes only obsolete pages from Vertex AI Search.

---

## Authentication & GKE Routing Constraints

`/api/events/gcs` supports two security postures depending on how Eventarc delivers events:

- **Cloud Run / Public HTTPS Destinations (`oidc.enabled: true`)**: Eventarc attaches a signed `Authorization: Bearer <ID_TOKEN>` header. The middleware verifies the Google signature, `https://accounts.google.com` issuer, expected `oidc.audience`, and optional `oidc.serviceAccountEmail`.
- **Private GKE Service Destinations (`oidc.enabled: false`)**: Eventarc deploys a managed `gke-forwarder` pod inside an `eventarc-<trigger-name>-<hash>` namespace that pulls from Pub/Sub and posts directly over cluster-internal HTTP without generating OIDC tokens. Set `oidc.enabled: false` and block external ingress to `/api/events/gcs` at the network/edge layer.

> [!IMPORTANT]
>
> **GKE Port 80 Requirement**: Eventarc's GKE destination block always delivers HTTP requests to Service port `80`. Expose port `80` on your Backstage Kubernetes `Service` mapped to container port `7007`.

### Kubernetes Service & Network Hardening (GKE)

#### 1. Backstage `Service` Mapping Port 80 -> 7007

```yaml
apiVersion: v1
kind: Service
metadata:
  name: backstage
  namespace: backstage
spec:
  type: ClusterIP
  ports:
    - port: 7007
      targetPort: 7007
      protocol: TCP
      name: http
    - port: 80
      targetPort: 7007
      protocol: TCP
      name: eventarc
  selector:
    app: backstage
```

#### 2. Edge Blocking (`HTTPRoute`, Cloud Armor, or NGINX Ingress)

Block public requests to `/api/events/gcs` at your external load balancer or ingress controller:

```yaml
# Option A: GKE Gateway API HTTPRoute rewrite
apiVersion: gateway.networking.k8s.io/v1
kind: HTTPRoute
metadata:
  name: backstage-external-route
  namespace: backstage
spec:
  parentRefs:
    - group: gateway.networking.k8s.io
      kind: Gateway
      name: external-http-gateway
  rules:
    - matches:
        - path:
            type: PathPrefix
            value: /api/events/gcs
      filters:
        - type: URLRewrite
          urlRewrite:
            path:
              type: ReplaceFullPath
              replaceFullPath: /blocked-internal-route
      backendRefs:
        - name: backstage
          port: 7007
    - matches:
        - path:
            type: PathPrefix
            value: /
      backendRefs:
        - name: backstage
          port: 7007
```

```bash
# Option B: Google Cloud Armor edge deny rule
gcloud compute security-policies create backstage-armor-policy
gcloud compute security-policies rules create 1000 \
  --security-policy=backstage-armor-policy \
  --expression="request.path.matches('/api/events/gcs')" \
  --action="deny-403"
```

```yaml
# Option C: NGINX Ingress path block
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: backstage-ingress
  namespace: backstage
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      location /api/events/gcs {
        deny all;
        return 403;
      }
spec: {}
```

#### 3. Kubernetes `NetworkPolicy` (Cluster-Internal Port 80 Isolation)

Restrict port `80` ingress exclusively to the managed Eventarc forwarder namespace (named `eventarc-<trigger-name>-<hash>` in GKE; verify the exact namespace via `kubectl get ns | grep '^eventarc-'`):

```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: isolate-eventarc-port-80
  namespace: backstage
spec:
  podSelector:
    matchLabels:
      app: backstage
  policyTypes:
    - Ingress
  ingress:
    - from:
        - namespaceSelector:
            matchExpressions:
              - key: kubernetes.io/metadata.name
                operator: In
                values: ['eventarc-gcs-techdocs-trigger'] # Match your GKE eventarc-<trigger>-<hash> namespace
      ports:
        - protocol: TCP
          port: 80
    - ports:
        - protocol: TCP
          port: 7007
```

---

## Installation

Install the module in `packages/backend`:

```bash
yarn --cwd packages/backend add @backstage-community/plugin-events-backend-module-gcs-eventarc
```

Register the events backend plugin and the webhook module in `packages/backend/src/index.ts`:

```typescript
// packages/backend/src/index.ts
import { createBackend } from '@backstage/backend-defaults';

const backend = createBackend();

backend.add(import('@backstage/plugin-events-backend'));
backend.add(
  import('@backstage-community/plugin-events-backend-module-gcs-eventarc'),
);

backend.start();
```

---

## Configuration

> [!IMPORTANT]
>
> **Mutual Exclusion with Direct TechDocs Indexing**:
> `eventsModuleGcsEventarcWebhook` throws an error at startup if TechDocs direct collator indexing is enabled (`search.engines.vertexai.types.techdocs.indexing.enabled: true` or inherited from `search.engines.vertexai.indexing.enabled: true`). Keep `techdocs.indexing.enabled: false` when using this module.

```yaml
events:
  modules:
    gcsEventarcWebhook:
      oidc:
        enabled: true # Set false for GKE internal destinations; true for Cloud Run / HTTPS
        audience: ${BACKEND_BASE_URL}/api/events/gcs
        serviceAccountEmail: ${EVENTARC_TRIGGER_SA_EMAIL}
      maxConcurrency: 5
      payloadSizeLimit: '100kb'
      batchSize: 100

search:
  engines:
    vertexai:
      types:
        techdocs:
          indexing:
            enabled: false
          datastore:
            projectId: ${GCP_PROJECT_ID}
            datastoreId: ${VERTEX_TECHDOCS_DATASTORE_ID}
            location: europe-west4
```

### Parameter Reference Matrix

| Parameter                                                          | Type / Required                     | Default   | Description                                                                                                        |
| :----------------------------------------------------------------- | :---------------------------------- | :-------- | :----------------------------------------------------------------------------------------------------------------- |
| **`events.modules.gcsEventarcWebhook.oidc.enabled`**               | `boolean` (Optional)                | `false`   | Enables Google OIDC Bearer token validation on `POST /api/events/gcs`.                                             |
| **`events.modules.gcsEventarcWebhook.oidc.audience`**              | `string` (Required if OIDC enabled) | –         | Expected OIDC audience URL (typically `${baseUrl}/api/events/gcs`).                                                |
| **`events.modules.gcsEventarcWebhook.oidc.serviceAccountEmail`**   | `string` (Optional)                 | –         | Expected Eventarc trigger service account email on the ID token.                                                   |
| **`events.modules.gcsEventarcWebhook.maxConcurrency`**             | `number` (Optional)                 | `5`       | Maximum parallel `importDocuments` or `deleteDocument` operations per event.                                       |
| **`events.modules.gcsEventarcWebhook.batchSize`**                  | `number` (Optional)                 | `100`     | Documents per inline `importDocuments` batch (clamped to `1..100`).                                                |
| **`events.modules.gcsEventarcWebhook.payloadSizeLimit`**           | `string` (Optional)                 | `'100kb'` | Express JSON body limit on `/api/events/gcs`.                                                                      |
| **`search.engines.vertexai.types.techdocs.indexing.enabled`**      | `boolean` (Optional)                | `false`   | Must be `false` (or omitted when global `indexing.enabled` is `false`) so collators do not conflict with Eventarc. |
| **`search.engines.vertexai.types.techdocs.datastore.projectId`**   | `string` (Required)                 | –         | GCP Project ID hosting the TechDocs Vertex AI Search Data Store.                                                   |
| **`search.engines.vertexai.types.techdocs.datastore.datastoreId`** | `string` (Required)                 | –         | Target Discovery Engine Data Store ID for TechDocs pages.                                                          |
| **`search.engines.vertexai.types.techdocs.datastore.location`**    | `string` (Required)                 | –         | Region/location of the TechDocs Data Store (e.g., `'global'`, `'europe-west4'`).                                   |

---

## Infrastructure Provisioning (Terraform)

Enable `eventarc.googleapis.com`, `eventarcpublishing.googleapis.com`, `pubsub.googleapis.com`, `cloudresourcemanager.googleapis.com`, and either `container.googleapis.com` (GKE) or `run.googleapis.com` (Cloud Run). Enable **Object Versioning** on your TechDocs GCS bucket so delta deletions can read previous `search_index.json` generations.

### Eventarc Trigger & IAM

```hcl
resource "google_service_account" "eventarc_trigger_sa" {
  account_id   = "backstage-eventarc-sa"
  display_name = "Backstage Eventarc Trigger Service Account"
}

resource "google_project_iam_member" "eventarc_receiver" {
  project = var.project_id
  role    = "roles/eventarc.eventReceiver"
  member  = "serviceAccount:${google_service_account.eventarc_trigger_sa.email}"
}

resource "google_project_iam_member" "gcs_pubsub_publisher" {
  project = var.project_id
  role    = "roles/pubsub.publisher"
  member  = "serviceAccount:service-${data.google_project.project.number}@gs-project-accounts.iam.gserviceaccount.com"
}

# Option A: GKE Service Destination (Private VPC Routing)
resource "google_eventarc_trigger" "gcs_techdocs_gke" {
  name     = "gcs-techdocs-trigger"
  location = var.region
  project  = var.project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }

  matching_criteria {
    attribute = "bucket"
    value     = var.techdocs_bucket_name
  }

  destination {
    gke {
      cluster   = var.gke_cluster_name
      location  = var.gke_cluster_location
      namespace = "backstage"
      service   = "backstage"
      path      = "/api/events/gcs"
    }
  }

  service_account = google_service_account.eventarc_trigger_sa.email
}

# Option B: Cloud Run Destination (Enable oidc.enabled: true in app-config.yaml)
resource "google_eventarc_trigger" "gcs_techdocs_run" {
  name     = "gcs-techdocs-run-trigger"
  location = var.region
  project  = var.project_id

  matching_criteria {
    attribute = "type"
    value     = "google.cloud.storage.object.v1.finalized"
  }

  matching_criteria {
    attribute = "bucket"
    value     = var.techdocs_bucket_name
  }

  destination {
    cloud_run_service {
      service = "backstage"
      region  = var.region
      path    = "/api/events/gcs"
    }
  }

  service_account = google_service_account.eventarc_trigger_sa.email
}
```

> [!NOTE]
>
> **Additional IAM Roles by Target**:
>
> - **Cloud Run destinations**: Grant `roles/run.invoker` on the Cloud Run service to `google_service_account.eventarc_trigger_sa.email`.
> - **GKE destinations**: Grant `roles/compute.viewer`, `roles/container.developer`, and `roles/iam.serviceAccountAdmin` (on the trigger SA) to the Eventarc Service Agent (`service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com`).

### Optional: Customer-Managed Encryption Keys (CMEK)

When organizational policies require KMS encryption on Eventarc channels, pass the full channel config resource path in `name`:

```hcl
resource "google_eventarc_google_channel_config" "default" {
  provider        = google-beta
  project         = var.project_id
  location        = var.region
  name            = "projects/${var.project_id}/locations/${var.region}/googleChannelConfig"
  crypto_key_name = var.kms_key_id
}

resource "google_kms_crypto_key_iam_member" "eventarc_kms" {
  crypto_key_id = var.kms_key_id
  role          = "roles/cloudkms.cryptoKeyEncrypterDecrypter"
  member        = "serviceAccount:service-${data.google_project.project.number}@gcp-sa-eventarc.iam.gserviceaccount.com"
}
```

### Optional: Pub/Sub Dead-Letter Topic (DLQ)

Attach a dead-letter topic to the Eventarc-managed Pub/Sub subscription so notifications are retained if Backstage is temporarily unreachable:

```bash
gcloud pubsub topics create gcs-eventarc-dlq

SUBSCRIPTION=$(gcloud eventarc triggers describe gcs-techdocs-trigger \
  --location="${REGION}" \
  --format="value(transport.pubsub.subscription)")

gcloud pubsub subscriptions update "${SUBSCRIPTION}" \
  --dead-letter-topic=gcs-eventarc-dlq \
  --max-delivery-attempts=5
```

---

## Local Development Testing

1. Authenticate Application Default Credentials:
   ```bash
   gcloud auth application-default login
   ```
2. Set `events.modules.gcsEventarcWebhook.oidc.enabled: false` in `app-config.local.yaml`.
3. Send a simulated CloudEvent to your local backend:
   ```bash
   curl -X POST http://localhost:7007/api/events/gcs \
     -H "Content-Type: application/json" \
     -H "ce-type: google.cloud.storage.object.v1.finalized" \
     -d '{
       "bucket": "your-techdocs-bucket",
       "name": "default/component/your-service/search_index.json",
       "generation": 100001
     }'
   ```

---

## Troubleshooting

| Scenario                                        | Symptom                                                                                 | Root Cause                                                                                                                    | Resolution                                                                                  |
| :---------------------------------------------- | :-------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------ |
| **Conflicting Indexing Error**                  | Startup fails with `GCS Eventarc Webhook conflict: techdocs indexing is enabled`.       | `search.engines.vertexai.indexing.enabled` or `types.techdocs.indexing.enabled` is `true`.                                    | Set `search.engines.vertexai.types.techdocs.indexing.enabled: false`.                       |
| **GKE Forwarder `401 Unauthorized`**            | Eventarc deliveries fail with HTTP `401` inside GKE.                                    | `oidc.enabled: true` is set, while GKE `gke-forwarder` pods do not attach Google OIDC tokens.                                 | Set `oidc.enabled: false` and isolate `/api/events/gcs` via edge rules and `NetworkPolicy`. |
| **Partial Import Failure (`failureCount > 0`)** | Logs show `importDocuments reported X failed document(s)` and delta cleanup is skipped. | Discovery Engine rejected one or more documents due to schema mismatch (delta deletion is skipped to protect existing pages). | Inspect the logged `errorSamples`, update the Data Store schema, and re-trigger the event.  |
| **Removed TechDocs Pages Not Deleted**          | Updated sites still show deleted pages in search results.                               | GCS Object Versioning is disabled on the TechDocs bucket, so `getPreviousGeneration` returns `null`.                          | Enable Object Versioning on the TechDocs GCS bucket.                                        |
