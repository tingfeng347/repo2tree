import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('web/vendor', {recursive: true});
await build({entryPoints:['scripts/highlight-entry.mjs'], outfile:'web/vendor/highlight.js', bundle:true, format:'esm', platform:'browser', target:'es2022', minify:true, legalComments:'inline'});
await copyFile('node_modules/highlight.js/LICENSE', 'web/vendor/highlight.LICENSE');
