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
  createBackendModule,
  coreServices,
} from '@backstage/backend-plugin-api';
import { eventsServiceRef } from '@backstage/plugin-events-node';
import { Storage } from '@google-cloud/storage';
import { DocumentServiceClient } from '@google-cloud/discoveryengine';
import { OAuth2Client } from 'google-auth-library';
import express from 'express';
import crypto from 'crypto';
import { catalogServiceRef } from '@backstage/plugin-catalog-node';

const CE_TYPE_OBJECT_FINALIZED = 'google.cloud.storage.object.v1.finalized';
const authClient = new OAuth2Client();

/**
 * Generates a stable MD5 hash identifier for a search document.
 */
function generateDocId(
  namespace: string,
  kind: string,
  name: string,
  location: string,
): string {
  const cleanLocation = location.startsWith('/') ? location.slice(1) : location;
  const canonicalPath = `/docs/${namespace.toLowerCase()}/${kind.toLowerCase()}/${name.toLowerCase()}/${cleanLocation}`;
  return crypto.createHash('md5').update(canonicalPath).digest('hex');
}

/**
 * A lightweight promise-concurrency pool helper to limit parallel executions.
 */
async function asyncPool<T, R>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Promise<R>[] = [];
  const executing: Promise<any>[] = [];
  for (const item of items) {
    const p = Promise.resolve().then(() => fn(item));
    results.push(p);
    if (concurrency <= items.length) {
      const e: Promise<any> = p.then(() =>
        executing.splice(executing.indexOf(e), 1),
      );
      executing.push(e);
      if (executing.length >= concurrency) {
        await Promise.race(executing);
      }
    }
  }
  return Promise.all(results);
}

/**
 * Express middleware to verify incoming Google OIDC ID tokens for Eventarc webhooks.
 */
function createOidcMiddleware(
  oidcConfig: any,
  logger: any,
): express.RequestHandler {
  return async (req, res, next) => {
    if (!oidcConfig?.getOptionalBoolean('enabled')) {
      next();
      return;
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      logger.warn('Unauthorized Eventarc webhook: Missing Bearer token.');
      res.status(401).send('Unauthorized: Missing Token');
      return;
    }

    const idToken = authHeader.split('Bearer ')[1];
    const audience = oidcConfig.getString('audience');
    const expectedEmail = oidcConfig.getOptionalString('serviceAccountEmail');

    try {
      const ticket = await authClient.verifyIdToken({
        idToken,
        audience,
      });
      const payload = ticket.getPayload();

      if (!payload) {
        logger.warn('Unauthorized Eventarc webhook: Empty token payload.');
        res.status(401).send('Unauthorized: Empty Payload');
        return;
      }

      // Verify issuer is Google
      if (payload.iss !== 'https://accounts.google.com') {
        logger.warn(
          `Unauthorized Eventarc webhook: Invalid issuer ${payload.iss}`,
        );
        res.status(401).send('Unauthorized: Invalid Issuer');
        return;
      }

      // Verify triggering service account email if configured
      if (expectedEmail && payload.email !== expectedEmail) {
        logger.warn(
          `Unauthorized Eventarc webhook: SA email mismatch. Expected ${expectedEmail}, got ${payload.email}`,
        );
        res.status(401).send('Unauthorized: Service Account Mismatch');
        return;
      }

      logger.debug(
        `Eventarc OIDC token verified for trigger SA: ${payload.email}`,
      );
      next();
    } catch (authError) {
      logger.error(
        'Unauthorized Eventarc webhook: ID Token verification failed:',
        authError as Error,
      );
      res.status(401).send('Unauthorized: Token Verification Failed');
    }
  };
}

/**
 * Transforms raw GCS TechDocs search documents into enriched Vertex AI Search JSON payloads.
 */
function mapSearchDocuments(
  docs: Array<{ title: string; text: string; location: string }>,
  namespace: string,
  kind: string,
  name: string,
  entity?: any,
): Array<{ id: string; jsonData: string }> {
  return docs
    .filter(doc => doc.title && doc.text && doc.location)
    .map(doc => {
      const docId = generateDocId(namespace, kind, name, doc.location);
      const docPayload = {
        id: docId,
        title: doc.title,
        name,
        namespace,
        kind,
        location: doc.location,
        text: doc.text,
        path: doc.location,
        owner: entity?.spec?.owner || 'unknown',
        lifecycle: entity?.spec?.lifecycle || 'unknown',
        componentType: entity?.spec?.type || '',
        annotations: entity?.metadata?.annotations || {},
        authorization: {
          resourceRef: `${kind.toLowerCase()}:${namespace.toLowerCase()}/${name.toLowerCase()}`,
        },
      };

      return {
        id: docId,
        jsonData: JSON.stringify(docPayload),
      };
    });
}

/**
 * Compares current and historical documents to identify stale page IDs that should be purged.
 */
function computeIdsToDelete(
  currentDocIds: Set<string>,
  previousDocs: Array<{ title?: string; text?: string; location?: string }>,
  namespace: string,
  kind: string,
  name: string,
): string[] {
  const idsToDelete: string[] = [];
  for (const prevDoc of previousDocs) {
    if (prevDoc.title && prevDoc.text && prevDoc.location) {
      const prevId = generateDocId(namespace, kind, name, prevDoc.location);
      if (!currentDocIds.has(prevId)) {
        idsToDelete.push(prevId);
      }
    }
  }
  return idsToDelete;
}

/**
 * Backend module extending the events plugin with GCS Eventarc webhook support.
 *
 * @public
 */
export const eventsModuleGcsEventarcWebhook = createBackendModule({
  pluginId: 'events',
  moduleId: 'gcs-eventarc-webhook',
  register(env) {
    env.registerInit({
      deps: {
        httpRouter: coreServices.httpRouter,
        events: eventsServiceRef,
        logger: coreServices.logger,
        config: coreServices.rootConfig,
        catalog: catalogServiceRef,
        auth: coreServices.auth,
      },
      async init({ httpRouter, events, logger, config, catalog, auth }) {
        const router = express.Router();

        // Exempt /gcs endpoint from Backstage's default backend auth policy
        httpRouter.addAuthPolicy({
          path: '/gcs',
          allow: 'unauthenticated',
        });

        // 1. CONFIGURATION LOADING & VALIDATION
        const oidcConfig = config.getOptionalConfig(
          'events.modules.gcsEventarcWebhook.oidc',
        );
        const oidcEnabled = oidcConfig?.getOptionalBoolean('enabled') ?? false;

        const webhookConfig = config.getOptionalConfig(
          'events.modules.gcsEventarcWebhook',
        );
        const maxConcurrency =
          webhookConfig?.getOptionalNumber('maxConcurrency') ?? 5;
        const payloadSizeLimit =
          webhookConfig?.getOptionalString('payloadSizeLimit') ?? '100kb';
        const configBatchSize =
          webhookConfig?.getOptionalNumber('batchSize') ?? 100;
        const batchSize = Math.min(Math.max(configBatchSize, 1), 100);

        if (!oidcEnabled) {
          logger.warn(
            'GCS Eventarc Webhook: OIDC token verification is disabled. ' +
              'The /api/events/gcs endpoint is currently unauthenticated. ' +
              'To prevent search index spoofing, secure this endpoint using network constraints.',
          );
        }

        const storage = new Storage();

        // Initialize reusable Discovery Engine client singleton once at boot (fail-fast)
        const techdocsConfig = config.getOptionalConfig(
          'search.engines.vertexai.types.techdocs',
        );
        let docClient: DocumentServiceClient | undefined = undefined;
        let parent: string | undefined = undefined;
        let dataStoreId: string | undefined = undefined;

        if (techdocsConfig) {
          const globalIndexingEnabled =
            config.getOptionalBoolean(
              'search.engines.vertexai.indexing.enabled',
            ) ?? false;
          const techdocsIndexingEnabled =
            techdocsConfig.getOptionalBoolean('indexing.enabled') ??
            globalIndexingEnabled;

          if (techdocsIndexingEnabled) {
            throw new Error(
              'GCS Eventarc Webhook conflict: techdocs indexing is enabled in search configuration. ' +
                'You cannot use GCS Eventarc webhook synchronization concurrently with local techdocs indexing. ' +
                'Please disable local techdocs indexing (set search.engines.vertexai.types.techdocs.indexing.enabled to false) ' +
                'or remove the eventsModuleGcsEventarcWebhook module from your backend.',
            );
          }

          dataStoreId = techdocsConfig.getString('datastore.datastoreId');
          const location = techdocsConfig.getString('datastore.location');
          const projectId = techdocsConfig.getString('datastore.projectId');

          const apiEndpoint =
            location !== 'global'
              ? `${location}-discoveryengine.googleapis.com`
              : undefined;

          docClient = new DocumentServiceClient({ apiEndpoint });
          parent = docClient.projectLocationCollectionDataStoreBranchPath(
            projectId,
            location,
            'default_collection',
            dataStoreId,
            'default_branch',
          );
        } else {
          logger.warn(
            'GCS Eventarc Webhook: No TechDocs search configuration resolved under "search.engines.vertexai.types.techdocs". TechDocs synchronization will be disabled.',
          );
        }

        // 2. HELPER GCS DOWNLOAD LOGIC
        async function getDocs(
          bucketName: string,
          blobName: string,
          generation: number,
        ): Promise<Array<{ title: string; text: string; location: string }>> {
          try {
            const bucket = storage.bucket(bucketName);
            const file = bucket.file(blobName, {
              generation: generation.toString(),
            });
            const [fileContent] = await file.download();
            const searchIndex = JSON.parse(fileContent.toString('utf-8')) as {
              docs: Array<{ title: string; text: string; location: string }>;
            };
            return searchIndex.docs || [];
          } catch (error) {
            logger.error(
              `Failed to fetch or parse index file from GCS:`,
              error as Error,
            );
            return [];
          }
        }

        async function getPreviousGeneration(
          bucketName: string,
          blobName: string,
        ): Promise<number | null> {
          try {
            const [files] = await storage.bucket(bucketName).getFiles({
              prefix: blobName,
              versions: true,
            });
            const generations = files
              .filter(f => f.name === blobName && f.generation)
              .map(f => Number(f.generation))
              .sort((a, b) => b - a);

            if (generations.length < 2) {
              return null;
            }
            return generations[1]; // Immediately previous version
          } catch (error) {
            logger.warn(
              `Failed to retrieve previous GCS generation for blob ${blobName}:`,
              error as Error,
            );
            return null;
          }
        }

        // 3. MOUNT WEBHOOK INGRESS (Secured via OIDC)
        router.post(
          '/gcs',
          express.json({ limit: payloadSizeLimit }),
          createOidcMiddleware(oidcConfig, logger),
          async (req, res) => {
            const eventType = req.headers['ce-type'] as string;
            const gcsData = req.body as {
              bucket: string;
              name: string;
              generation: number;
            };

            logger.info(
              `Received Eventarc webhook: "${eventType}" for file: "${gcsData.name}"`,
            );

            if (eventType === CE_TYPE_OBJECT_FINALIZED) {
              await events.publish({
                topic: 'gcs-notifications',
                eventPayload: gcsData,
              });
            }

            res.status(200).send('Event processed successfully');
          },
        );

        httpRouter.use(router as any);

        // 4. SUBSCRIBE & PROCESS INDEX SYNCHRONIZATION
        events.subscribe({
          id: 'gcs-eventarc-webhook',
          topics: ['gcs-notifications'],
          onEvent: async (event: any) => {
            const gcsData = event.eventPayload as {
              bucket: string;
              name: string;
              generation: number;
            };

            // Only process TechDocs index files
            if (gcsData.name.endsWith('/search_index.json')) {
              logger.info(
                `Starting search-index synchronization for: ${gcsData.name}`,
              );

              const pathParts = gcsData.name.split('/');
              if (pathParts.length < 3) {
                logger.error(`Unexpected GCS path format: ${gcsData.name}`);
                return;
              }
              const namespace = pathParts[0];
              const kind = pathParts[1];
              const name = pathParts[2];

              // Fetch catalog metadata
              let entity: any = undefined;
              try {
                const credentials = await auth.getOwnServiceCredentials();
                entity = await catalog.getEntityByRef(
                  { kind, namespace, name },
                  { credentials },
                );
              } catch (catalogError) {
                logger.warn(
                  `GCS Eventarc Webhook: Could not retrieve Catalog Entity for "${kind}:${namespace}/${name}". Ingesting without enrichment.`,
                  catalogError as Error,
                );
              }

              try {
                // A. Download and Parse new index
                const docs = await getDocs(
                  gcsData.bucket,
                  gcsData.name,
                  gcsData.generation,
                );
                if (docs.length === 0) {
                  logger.info(`No documents to process for: ${gcsData.name}`);
                  return;
                }

                if (!docClient || !parent || !dataStoreId) {
                  logger.error(
                    'GCS Eventarc Webhook: Cannot synchronize. TechDocs search datastore is not configured in app-config.yaml.',
                  );
                  return;
                }

                // B. Map documents with catalog metadata
                const documents = mapSearchDocuments(
                  docs,
                  namespace,
                  kind,
                  name,
                  entity,
                );

                // C. Spawn inline import LROs concurrently (throttled by maxConcurrency to protect local socket pool)
                const chunks: any[][] = [];
                for (let i = 0; i < documents.length; i += batchSize) {
                  chunks.push(documents.slice(i, i + batchSize));
                }

                logger.info(
                  `Ingesting ${documents.length} documents into dataStore: ${dataStoreId} by spawning ${chunks.length} import operations (concurrency limit: ${maxConcurrency})...`,
                );

                const operations = await asyncPool(
                  maxConcurrency,
                  chunks,
                  async chunk => {
                    const [operation] = await docClient!.importDocuments({
                      parent,
                      inlineSource: {
                        documents: chunk as any,
                      },
                      reconciliationMode: 'INCREMENTAL',
                    } as any);
                    return operation;
                  },
                );

                // D. Await all LROs concurrently (Google Cloud indexes them in parallel on their distributed servers!)
                logger.info(
                  `Waiting for all ${operations.length} import operations to complete in parallel...`,
                );
                await Promise.all(operations.map(op => (op as any).promise()));
                logger.info(`Bulk document ingestion completed.`);

                // E. Delta-reconciliation: compare with previous generation and delete stale documents
                const previousGeneration = await getPreviousGeneration(
                  gcsData.bucket,
                  gcsData.name,
                );
                const idsToDelete: string[] = [];

                if (previousGeneration) {
                  logger.info(
                    `Comparing changes with previous GCS generation: ${previousGeneration}`,
                  );
                  const previousDocs = await getDocs(
                    gcsData.bucket,
                    gcsData.name,
                    previousGeneration,
                  );
                  const currentDocIds = new Set(documents.map(d => d.id));
                  idsToDelete.push(
                    ...computeIdsToDelete(
                      currentDocIds,
                      previousDocs,
                      namespace,
                      kind,
                      name,
                    ),
                  );
                }

                // F. Purge stale documents with concurrency throttling
                if (idsToDelete.length > 0) {
                  logger.info(
                    `Purging ${idsToDelete.length} stale documents from index with concurrency limit ${maxConcurrency}...`,
                  );
                  await asyncPool(maxConcurrency, idsToDelete, async docId => {
                    const docPath = `${parent}/documents/${docId}`;
                    try {
                      await docClient!.deleteDocument({ name: docPath });
                      logger.debug(`Deleted stale search document: ${docId}`);
                    } catch (delError) {
                      logger.error(
                        `Failed to delete search document ${docId}:`,
                        delError as Error,
                      );
                    }
                  });
                  logger.info(`Delta cleanup finished.`);
                }

                logger.info(
                  `Successfully synchronized search index for ${kind}:${namespace}/${name}`,
                );
              } catch (error) {
                logger.error(
                  `Failed to synchronize search documents for ${name}`,
                  error as Error,
                );
              }
            }
          },
        });
      },
    });
  },
});

export default eventsModuleGcsEventarcWebhook;
