import {cp,mkdir,writeFile} from 'node:fs/promises';
import {build} from 'esbuild';

await mkdir('dist-pages',{recursive:true});
await cp('compiled','dist-pages',{recursive:true});
await cp('apps/web','dist-pages',{recursive:true});
await cp('packages/ui','dist-pages/ui',{recursive:true});
await build({entryPoints:['server/pages.mjs'],outfile:'dist-pages/_worker.js',tsconfigRaw:{},bundle:true,format:'esm',platform:'browser',target:'es2022'});
await writeFile('dist-pages/_routes.json',JSON.stringify({version:1,include:['/api/rooms','/api/rooms/*'],exclude:[]})+'\n');
await writeFile('dist-pages/_headers','/*\n  Cross-Origin-Opener-Policy: same-origin\n  Cross-Origin-Embedder-Policy: require-corp\n  Cross-Origin-Resource-Policy: same-origin\n');
console.log('Cloudflare Pages ready: static website, cross-origin isolated SMP AI, and same-origin D1 online rooms.');
