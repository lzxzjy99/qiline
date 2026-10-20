import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {createRequire} from 'node:module';
const {CSP}=createRequire(import.meta.url)('../apps/desktop/policy.cjs');
// A separate preview root keeps development controls out of the shipped game.
const root='build/worker-qa';
await rm(root,{recursive:true,force:true});await mkdir(`${root}/.openai`,{recursive:true});
await cp('dist',`${root}/dist`,{recursive:true});
await cp('.openai/hosting.json',`${root}/.openai/hosting.json`);
await writeFile(`${root}/dist/index.html`,(await readFile('apps/qa/worker.html','utf8')).replace('__CSP__',CSP));
for(const name of ['worker-qa.mjs','hang-worker.js'])await cp(`apps/qa/${name}`,`${root}/dist/${name}`);
console.log(`Worker browser QA preview ready: ${root}`);
