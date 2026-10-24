/**
 * Build the single-file browser artifact.
 *
 * The DSH client module loader serves exactly one classic script per package
 * (`lib/client.js`), so the artifact must include Mermaid, marked, and DOMPurify
 * in the factory body. `react` stays external because the harness browser
 * module table answers it; a second React copy would break hooks.
 */
import { build } from 'esbuild';
import { stat } from 'node:fs/promises';

const result = await build({
  entryPoints: ['src/client.js'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: ['chrome120', 'safari17'],
  external: ['react', 'react-dom', 'react/jsx-runtime'],
  minify: true,
  legalComments: 'none',
  sourcemap: false,
  logLevel: 'warning',
  define: { 'process.env.NODE_ENV': '"production"' },
  metafile: true,
});

const artifact = await stat('lib/client.js');
const inputs = Object.keys(result.metafile.inputs).length;
console.log(`lib/client.js  ${(artifact.size / 1024 / 1024).toFixed(2)} MiB  (${inputs} bundled inputs)`);
