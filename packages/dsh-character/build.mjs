import { build } from 'esbuild';
await build({
  entryPoints: { index: 'src/index.ts', agent: 'src/agent.ts' }, outdir: 'lib',
  splitting: true, chunkNames: 'chunks/[name]-[hash]', bundle: true,
  platform: 'node', format: 'esm', target: 'node22', sourcemap: true,
});
