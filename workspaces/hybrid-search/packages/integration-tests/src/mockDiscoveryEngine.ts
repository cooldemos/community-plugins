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

/**
 * @fileoverview
 * Mock implementation of the Google Cloud Vertex AI Search (Discovery Engine) SDK client classes.
 * Mapped in Jest via `moduleNameMapper`.
 *
 * Note: The `protos` namespace is only used for type positions in the plugin and is elided
 * by the TypeScript compiler at runtime. Therefore, this mock does not need to export it.
 */

/**
 * Mock Jest spy for the SearchServiceClient.search method.
 * Returns a standard Google GAX client tuple: `[apiResultsArray, nextPageToken, rawResponse]`.
 */
export const mockSearch = jest.fn().mockResolvedValue([
  // Index 0: apiResults (the array of SearchResult objects)
  [
    {
      document: {
        name: 'projects/my-project/locations/eu/collections/default_collection/dataStores/techdocs-ds/branches/default_branch/documents/123',
        structData: {
          title: 'Mock Page',
          location: 'page.html',
        },
        derivedStructData: {
          snippets: [{ snippet: 'Content' }],
        },
      },
    },
  ],
  // Index 1: nextPageToken (undefined since we return a single mocked page)
  undefined,
  // Index 2: rawResponse
  {
    results: [
      {
        document: {
          name: 'projects/my-project/locations/eu/collections/default_collection/dataStores/techdocs-ds/branches/default_branch/documents/123',
        },
      },
    ],
  },
]);

/**
 * Mock Jest spy for the DocumentServiceClient.importDocuments method.
 * Returns a mock operation containing a promise that resolves when the import completes.
 */
export const mockImportDocuments = jest.fn().mockResolvedValue([
  {
    promise: jest.fn().mockResolvedValue({}),
  },
]);

/**
 * Mock Jest spy for the DocumentServiceClient.projectLocationCollectionDataStoreBranchPath helper.
 * Generates a mock resource path string.
 */
export const mockProjectLocationCollectionDataStoreBranchPath = jest
  .fn()
  .mockReturnValue('mock-parent-path');

/**
 * Mock SearchServiceClient class matching the signature expected by the Vertex AI Search engine.
 */
export class SearchServiceClient {
  search = mockSearch;
}

/**
 * Mock DocumentServiceClient class matching the signature expected by the Vertex AI Search indexer stream.
 */
export const mockDeleteDocument = jest.fn().mockResolvedValue({});

export class DocumentServiceClient {
  projectLocationCollectionDataStoreBranchPath =
    mockProjectLocationCollectionDataStoreBranchPath;
  importDocuments = mockImportDocuments;
  deleteDocument = mockDeleteDocument;
}
