import {spawnSync} from 'node:child_process';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {resolve,dirname} from 'node:path';
export const PREDECESSOR_COMMIT='bf1fb00355295ae6b8d1cb8fd200c17148508e83';
export const predecessorRoot=resolve('build/predecessor-059');
export async function preparePredecessor(){
 const git=(args)=>{const r=spawnSync('git',['-c',`safe.directory=${process.cwd().replaceAll('\\','/')}`,...args],{encoding:null,maxBuffer:16000000});
  if(r.status!==0)throw Error(`Cannot read immutable predecessor from Git: ${r.stderr}`);return r.stdout;};
 const paths=git(['ls-tree','-r','--name-only',PREDECESSOR_COMMIT,'compiled']).toString('utf8').trim().split('\n');
 const hashes={};
 for(const file of paths){
  const bytes=git(['show',`${PREDECESSOR_COMMIT}:${file}`]),target=resolve(predecessorRoot,file.slice('compiled/'.length));
  await mkdir(dirname(target),{recursive:true});
  let current;try{current=await readFile(target);}catch{}
  if(!current?.equals(bytes))await writeFile(target,bytes);
  hashes[file]=createHash('sha256').update(bytes).digest('hex');
 }
 const manifest={version:'0.5.9',commit:PREDECESSOR_COMMIT,hashes};
 await writeFile(resolve(predecessorRoot,'baseline.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===resolve(import.meta.filename)){
 const manifest=await preparePredecessor();console.log(JSON.stringify({commit:manifest.commit,files:Object.keys(manifest.hashes).length}));
}
