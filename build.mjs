import * as esbuild from 'esbuild'
import pkgJson from './package.json' with { type: 'json' }

await esbuild.build({
  entryPoints: [`${pkgJson.main}`],
  bundle: true,
  minify: false,
  outExtension: { '.js': '.js' },
  outdir: 'dist',
  format: 'esm',
  external: ['@babylonjs/core', '@highlite/plugin-api'],
});
