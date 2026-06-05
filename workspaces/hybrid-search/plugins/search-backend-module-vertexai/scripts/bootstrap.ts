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

import { Storage, File } from '@google-cloud/storage';
import { DocumentServiceClient } from '@google-cloud/discoveryengine';
import crypto from 'crypto';

const MAX_FILES_TO_IMPORT = 100;
const CONCURRENCY_LIMIT = 10;

/**
 * Generates an MD5 hash ID for a given string.
 */
function generateId(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex');
}

/**
 * A lightweight promise-concurrency pool helper to limit parallel executions.
 */
export async function asyncPool<T, R>(
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
 * Download and parse a search_index.json from GCS.
 */
async function getEntityDocuments(
  blob: File,
): Promise<Array<{ title: string; text: string; location: string }>> {
  try {
    const [content] = await blob.download();
    const contentJson = JSON.parse(content.toString('utf-8'));
    return contentJson.docs || [];
  } catch (error) {
    console.error(`Error loading/parsing GCS blob ${blob.name}:`, error);
    throw error;
  }
}

/**
 * Helper to query the Backstage Catalog REST API over HTTP to enrich documents.
 */
export async function fetchCatalogEntity(
  backstageUrl: string,
  kind: string,
  namespace: string,
  name: string,
): Promise<any | null> {
  const url = `${backstageUrl}/api/catalog/entities/by-name/${kind.toLowerCase()}/${namespace.toLowerCase()}/${name.toLowerCase()}`;
  try {
    const res = await fetch(url);
    if (res.ok) {
      return await res.json();
    }
    console.warn(
      `Warning: Could not fetch catalog entity from ${url}. Status: ${res.status}. Ingesting without catalog metadata enrichment.`,
    );
  } catch (error) {
    console.warn(
      `Warning: Failed to contact Catalog API at ${url}. Ingesting without catalog metadata enrichment.`,
    );
  }
  return null;
}

/**
 * Process a single search_index.json blob: map schema, create NDJSON, and upload to staging.
 */
export async function processEntity(
  blob: File,
  destBucket: any,
  backstageUrl: string,
): Promise<void> {
  const pathParts = blob.name.split('/');
  if (pathParts.length < 3) {
    console.warn(`Skipping invalid path structure: ${blob.name}`);
    return;
  }
  const namespace = pathParts[0];
  const kind = pathParts[1];
  const name = pathParts[2];

  // Fetch parent Catalog Entity dynamically to enrich search documents with metadata
  const entity = await fetchCatalogEntity(backstageUrl, kind, namespace, name);

  const docs = await getEntityDocuments(blob);
  console.log(
    `Processing ${docs.length} documents for entity: ${namespace}/${kind}/${name}`,
  );

  const jsonlEntries: string[] = [];

  for (const doc of docs) {
    const title = doc.title;
    const text = doc.text;
    const location = doc.location;

    if (!title || !text || !location || location.endsWith('/')) {
      continue;
    }

    const structuredEntry = {
      id: generateId(`${namespace}_${kind}_${name}_${location}`),
      jsonData: JSON.stringify({
        id: generateId(`${namespace}_${kind}_${name}_${location}`),
        title,
        name,
        namespace,
        kind,
        location,
        text,
        path: location,
        owner: entity?.spec?.owner || 'unknown',
        lifecycle: entity?.spec?.lifecycle || 'unknown',
        componentType: entity?.spec?.type || '',
        annotations: entity?.metadata?.annotations || {},
        authorization: {
          resourceRef: `${kind.toLowerCase()}:${namespace.toLowerCase()}/${name.toLowerCase()}`,
        },
      }),
    };
    jsonlEntries.push(JSON.stringify(structuredEntry));
  }

  if (jsonlEntries.length > 0) {
    const destFilename = `${namespace}-${kind}-${name}.ndjson`;
    const destBlob = destBucket.file(destFilename);

    console.log(`Uploading staging file ${destFilename}...`);
    try {
      await destBlob.save(jsonlEntries.join('\n'), {
        contentType: 'application/x-ndjson',
      });
    } catch (error) {
      console.error(`Failed to upload staging file ${destFilename}:`, error);
      throw error;
    }
  }
}

/**
 * Command: prepare-docs
 * Scans GCS source bucket for search_index.json and uploads NDJSON to staging bucket.
 */
export async function prepareDocs(options: {
  techdocsBucket: string;
  stagingBucket: string;
  backstageUrl: string;
}): Promise<void> {
  console.log(
    `Scanning source bucket: "${options.techdocsBucket}" for search_index.json files...`,
  );
  const storage = new Storage();

  const sourceBucketObj = storage.bucket(options.techdocsBucket);
  const stagingBucketObj = storage.bucket(options.stagingBucket);

  const [blobs] = await sourceBucketObj.getFiles({
    // Simulates the match_glob="**/search_index.json"
  });

  const targetBlobs = blobs.filter(b => b.name.endsWith('/search_index.json'));
  const totalCount = targetBlobs.length;

  console.log(`Found ${totalCount} entities to process.`);

  let failureCount = 0;

  await asyncPool(CONCURRENCY_LIMIT, targetBlobs, async blob => {
    try {
      await processEntity(blob, stagingBucketObj, options.backstageUrl);
    } catch (err) {
      failureCount++;
    }
  });

  console.log(
    `\nProcessing complete: ${totalCount} entities processed. ${failureCount} errors encountered.`,
  );
}

/**
 * Triggers document import operation in Vertex AI Search for a chunk of GCS files.
 */
async function importDocsFromGcs(
  client: DocumentServiceClient,
  parent: string,
  inputUris: string[],
): Promise<void> {
  console.log(
    `Importing chunk of ${inputUris.length} files into Vertex AI Search...`,
  );
  try {
    const [operation] = await client.importDocuments({
      parent,
      inlineSource: undefined,
      gcsSource: {
        inputUris,
      },
      reconciliationMode: 'INCREMENTAL',
    } as any);

    console.log(`Spawned import operation: ${operation.name}. Waiting...`);
    const [response] = await (operation as any).promise();
    console.log(`Operation ${operation.name} completed successfully.`);
    console.log(JSON.stringify(response, null, 2));
  } catch (error) {
    console.error(`Error importing chunk of documents:`, error);
    throw error;
  }
}

/**
 * Command: import-docs
 * Batches and imports NDJSON files from staging bucket into Vertex AI Search datastore.
 */
export async function importDocs(options: {
  projectId: string;
  location: string;
  datastoreId: string;
  stagingBucket: string;
}): Promise<void> {
  const storage = new Storage();
  const bucketObj = storage.bucket(options.stagingBucket);

  const [files] = await bucketObj.getFiles();
  const ndjsonFiles = files.filter(f => f.name.endsWith('.ndjson'));

  console.log(
    `Found ${ndjsonFiles.length} staging ndjson files in gs://${options.stagingBucket}`,
  );

  const apiEndpoint =
    options.location !== 'global'
      ? `${options.location}-discoveryengine.googleapis.com`
      : undefined;

  const client = new DocumentServiceClient({ apiEndpoint });
  const parent = client.projectLocationCollectionDataStoreBranchPath(
    options.projectId,
    options.location,
    'default_collection',
    options.datastoreId,
    'default_branch',
  );

  // Chunk the GCS URIs in groups of MAX_FILES_TO_IMPORT (100)
  const chunks: string[][] = [];
  for (let i = 0; i < ndjsonFiles.length; i += MAX_FILES_TO_IMPORT) {
    const slice = ndjsonFiles.slice(i, i + MAX_FILES_TO_IMPORT);
    chunks.push(slice.map(f => `gs://${options.stagingBucket}/${f.name}`));
  }

  const totalCount = chunks.length;
  console.log(`Split ingestion into ${totalCount} batch import operations.`);

  let failureCount = 0;

  await asyncPool(CONCURRENCY_LIMIT, chunks, async chunk => {
    try {
      await importDocsFromGcs(client, parent, chunk);
    } catch (err) {
      failureCount++;
    }
  });

  console.log(
    `\nImport complete: ${totalCount} operations executed. ${failureCount} errors encountered.`,
  );
}

/**
 * Main CLI entry point.
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  const parsedFlags: Record<string, string> = {};
  for (let i = 1; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].substring(2);
      const val = args[i + 1];
      if (val && !val.startsWith('--')) {
        parsedFlags[key] = val;
        i++;
      }
    }
  }

  if (command === 'prepare-docs') {
    const techdocsBucket = parsedFlags.techdocsBucket;
    const stagingBucket = parsedFlags.stagingBucket;
    const backstageUrl = parsedFlags.backstageUrl || 'http://127.0.0.1:7007';

    if (!techdocsBucket || !stagingBucket) {
      console.error(
        'Usage: bootstrap prepare-docs --techdocsBucket <bucket> --stagingBucket <bucket> [--backstageUrl <url>]',
      );
      process.exit(1);
    }

    await prepareDocs({ techdocsBucket, stagingBucket, backstageUrl });
  } else if (command === 'import-docs') {
    const projectId = parsedFlags.projectId;
    const location = parsedFlags.location;
    const datastoreId = parsedFlags.datastoreId;
    const stagingBucket = parsedFlags.stagingBucket;

    if (!projectId || !location || !datastoreId || !stagingBucket) {
      console.error(
        'Usage: bootstrap import-docs --projectId <project> --location <location> --datastoreId <datastore> --stagingBucket <bucket>',
      );
      process.exit(1);
    }

    await importDocs({ projectId, location, datastoreId, stagingBucket });
  } else {
    console.error('Unknown command. Use "prepare-docs" or "import-docs".');
    console.error('\nUsage Examples:');
    console.error(
      '  yarn bootstrap prepare-docs --techdocsBucket <bucket> --stagingBucket <bucket>',
    );
    console.error(
      '  yarn bootstrap import-docs --projectId <project> --location <location> --datastoreId <datastore> --stagingBucket <bucket>',
    );
    process.exit(1);
  }
}

if (typeof require !== 'undefined' && require.main === module) {
  main().catch(err => {
    console.error('Fatal execution error:', err);
    process.exit(1);
  });
}
