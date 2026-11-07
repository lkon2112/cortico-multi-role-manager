import {build} from 'esbuild';
await build({entryPoints:['web/app.ts'],bundle:true,outfile:'public/app.js',format:'esm',platform:'browser',target:'es2022',sourcemap:true});
