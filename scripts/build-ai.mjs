import {cp,mkdir,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('../',import.meta.url));
const compilerRoot=process.env.QILINE_TYPESCRIPT_ROOT??path.join(root,'tools/ai/node_modules/typescript');
const compiler=JSON.parse(await readFile(path.join(compilerRoot,'package.json'),'utf8'));
if(compiler.version!=='7.0.2')throw Error('Use the pinned TypeScript 7.0.2 build tool.');
const output=path.join(root,'build/ai-typescript');
await rm(output,{recursive:true,force:true});
const result=spawnSync(process.execPath,[path.join(compilerRoot,'bin/tsc'),'--project',path.join(root,'tsconfig.ai.json')],{cwd:root,stdio:'inherit'});
if(result.error)throw result.error;
if(result.status!==0)process.exit(result.status??1);
// Dependencies are typechecked but only the new package is copied. Frozen P2 artifacts are never overwritten.
await mkdir(path.join(root,'compiled'),{recursive:true});
await rm(path.join(root,'compiled/ai'),{recursive:true,force:true});
await cp(path.join(output,'ai'),path.join(root,'compiled/ai'),{recursive:true});
async function filesIn(dir){
 const out=[];
 for(const entry of await readdir(path.join(root,dir),{withFileTypes:true})){
  const file=path.posix.join(dir,entry.name);
  out.push(...(entry.isDirectory()?await filesIn(file):[file]));
 }
 return out.sort();
}
async function hashes(files){
 return Object.fromEntries(await Promise.all(files.map(async file=>[
  file,createHash('sha256').update(await readFile(path.join(root,file))).digest('hex'),
 ])));
}
const source=await hashes([...(await filesIn('packages/ai')),'tsconfig.json','tsconfig.ai.json','tools/ai/package.json','scripts/build-ai.mjs']);
const compiled=await hashes(await filesIn('compiled/ai'));
await mkdir(path.join(root,'reports'),{recursive:true});
await writeFile(path.join(root,'reports/ai-contract-sha256.json'),JSON.stringify({source,compiled},null,2)+'\n');
console.log('AI contract typecheck and compilation passed; core/session artifacts are not overwritten by this build.');
