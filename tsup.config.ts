import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  dts: { entry: 'src/index.ts' },
  sourcemap: true,
  splitting: false,
  shims: true,
});
