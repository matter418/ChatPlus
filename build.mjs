import * as esbuild from 'esbuild'
import pkgJson from './package.json' with { type: 'json' }

await esbuild.build({
  entryPoints: [`${pkgJson.main}`],
  bundle: true,
  minify: false,
  outExtension: { '.js': '.js' },
  outdir: 'dist',
  format: 'esm',
  // The Idle Alert mp3 is inlined so the single-file plugin needs no asset loader.
  loader: { '.mp3': 'dataurl' },
  external: ['@babylonjs/core', '@highlite/plugin-api'],
});
