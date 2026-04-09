import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node22',
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    sourcemap: true,
    clean: false,
    target: 'node22',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
])
