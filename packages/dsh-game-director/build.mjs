import { build } from 'esbuild';

// Shared chunks keep the root plugin and preset tools on the same state and activation handles.
await build({
  entryPoints: { index: 'src/index.ts', agent: 'src/agent.ts' },
  outdir: 'lib',
  splitting: true,
  chunkNames: 'chunks/[name]-[hash]',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  sourcemap: true,
});
