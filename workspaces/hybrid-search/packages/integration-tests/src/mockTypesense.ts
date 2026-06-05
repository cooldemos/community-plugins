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
 * Mock implementation of the Typesense Node SDK Client class.
 * Mapped in Jest via `moduleNameMapper`.
 */

/**
 * Mock Jest spy for Typesense search query execution.
 * Returns mock document hits matching the configured Typesense schema.
 */
export const mockTypesenseSearch = jest.fn().mockResolvedValue({
  hits: [
    {
      document: {
        title: 'Mock Typesense Page',
        text: 'Content from Typesense',
        location: 'typesense-page.html',
      },
    },
  ],
});

/**
 * Mock Jest spy for Typesense collection retrieval.
 */
export const mockRetrieve = jest.fn().mockResolvedValue({
  name: 'mock-collection',
  fields: [],
});

/**
 * Mock Jest spy for Typesense collection creation.
 */
export const mockCreate = jest.fn().mockResolvedValue({
  name: 'mock-collection',
});

const mockDocuments = jest.fn().mockReturnValue({
  search: mockTypesenseSearch,
});

const mockCollections = jest.fn().mockReturnValue({
  retrieve: mockRetrieve,
  documents: mockDocuments,
  create: mockCreate,
});

/**
 * Mock Client class matching the signature expected by the Typesense search engine.
 */
export class Client {
  collections = mockCollections;
}
