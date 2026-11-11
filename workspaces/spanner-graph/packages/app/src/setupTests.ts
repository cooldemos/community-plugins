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
import '@testing-library/jest-dom';

// Suppress noisy jsdom @layer CSS parsing warnings emitted by @backstage/ui stylesheets during unit tests.
/* eslint-disable no-console */
const originalConsoleError = console.error;
console.error = (...args: unknown[]) => {
  const isCssParseNoise = args.some(
    arg =>
      String(arg).includes('Could not parse CSS stylesheet') ||
      (Boolean(arg) &&
        typeof arg === 'object' &&
        (arg as { type?: string }).type === 'css parsing'),
  );
  if (isCssParseNoise) {
    return;
  }
  originalConsoleError(...args);
};
/* eslint-enable no-console */
