import {readFile,writeFile,readdir,cp,mkdir} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..'),hash=b=>createHash('sha256').update(b).digest('hex');
const baseline=JSON.parse(await readFile(path.join(root,'reports/verification.json'),'utf8')).source_sha256;
const compiledBaseline=JSON.parse(await readFile(path.join(root,'reports/p2-compiled-sha256.json'),'utf8'));
const source={};
for(const [file,before,after]of [
 ['packages/session/src/types.ts','"easy"|"standard"','"easy"|"standard"|"hard"'],
 ['packages/session/src/session.ts','c.level==="easy"||c.level==="standard"','c.level==="easy"||c.level==="standard"||c.level==="hard"'],
]){
 const bytes=await readFile(path.join(root,file)),text=bytes.toString('utf8');
 if(text.split(after).length!==2||hash(Buffer.from(text.replace(after,before)))!==baseline[file])throw Error(`Only the reviewed hard-level enum extension is allowed: ${file}`);
 source[file]={baseline:baseline[file],sha256:hash(bytes)};
}
const compilerRoot=process.env.QILINE_TYPESCRIPT_ROOT??path.join(root,'tools/ai/node_modules/typescript');
if(JSON.parse(await readFile(path.join(compilerRoot,'package.json'),'utf8')).version!=='7.0.2')throw Error('Pinned compiler required');
const result=spawnSync(process.execPath,[path.join(compilerRoot,'bin/tsc'),'--project',path.join(root,'tsconfig.session-levels.json')],{cwd:root,stdio:'inherit'});
if(result.status!==0)process.exit(result.status??1);
const compiled={};
for(const name of await readdir(path.join(root,'build/session-levels/session/src'))){
 const file=`compiled/session/src/${name}`,generated=path.join(root,'build/session-levels/session/src',name);
 let bytes=await readFile(generated);
 if(name.endsWith('.map')){
   const map=JSON.parse(bytes.toString('utf8'));
   map.sources=map.sources.map(source=>path.relative(path.dirname(path.join(root,file)),path.resolve(path.dirname(generated),source)).replaceAll('\\','/'));
   bytes=Buffer.from(JSON.stringify(map));await writeFile(generated,bytes);
 }
 compiled[file]={baseline:compiledBaseline[file.replace(/^compiled\//,'dist/')],sha256:hash(bytes)};
}
await mkdir(path.join(root,'compiled/session'),{recursive:true});
await cp(path.join(root,'build/session-levels/session'),path.join(root,'compiled/session'),{recursive:true});
await writeFile(path.join(root,'reports/session-hard-level-extension.json'),JSON.stringify({scope:'Only Controller level enum and its validator add hard; no session authority or game-rule change',source,compiled},null,2)+'\n');
console.log('Session hard-level extension verified against the frozen source and compiled.');
