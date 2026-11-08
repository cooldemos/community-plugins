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
 * Mock implementation of the Google Cloud Storage (GCS) SDK Client classes.
 * Mapped in Jest via `moduleNameMapper`.
 */

/**
 * Mock Jest spy for GCS file download.
 * Returns a tuple containing a Buffer with a mocked TechDocs search_index.json.
 */
export const mockDownload = jest.fn().mockResolvedValue([
  Buffer.from(
    JSON.stringify({
      docs: [
        {
          title: 'Intro',
          text: 'Welcome to Backstage',
          location: 'index.html',
        },
      ],
    }),
    'utf-8',
  ),
]);

/**
 * Mock Jest spy for GCS bucket file listing.
 * Returns a mock file metadata array, matching GCS Eventarc notification payloads.
 */
export const mockGetFiles = jest.fn().mockResolvedValue([
  [
    {
      name: 'default/Component/my-comp/search_index.json',
      generation: '987654',
    },
  ],
]);

/**
 * Mock Jest spy for GCS bucket.file helper.
 */
export const mockFile = jest.fn().mockReturnValue({
  download: mockDownload,
});

/**
 * Mock Jest spy for GCS storage.bucket helper.
 */
export const mockDeleteFiles = jest.fn().mockResolvedValue({});

export const mockBucket = jest.fn().mockReturnValue({
  file: mockFile,
  getFiles: mockGetFiles,
  deleteFiles: mockDeleteFiles,
});

/**
 * Mock Storage class matching the signature expected by the GCS plugins.
 */
export class Storage {
  bucket = mockBucket;
}
