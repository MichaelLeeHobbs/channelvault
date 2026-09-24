import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Explode/implode tests do real file I/O; on Windows (with on-access AV
    // scanning) a parallel run pushes them past the 5 s default.
    testTimeout: 20_000,
  },
});
