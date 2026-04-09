import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    format: ['esm'],
    dts: true,
    sourcemap: true,
    clean: true,
    target: 'node24',
  },
  {
    entry: { bin: 'src/bin.ts' },
    format: ['esm'],
    sourcemap: true,
    clean: false,
    target: 'node24',
    banner: {
      js: '#!/usr/bin/env node',
    },
  },
])
