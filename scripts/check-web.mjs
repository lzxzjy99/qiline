import {readFile,readdir} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const html=await readFile('dist/index.html','utf8');
for(const name of ['app.mjs','style.css','favicon.svg'])assert.ok(html.includes(name));
async function walk(dir){let out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=path.join(dir,e.name);out.push(...(e.isDirectory()?await walk(p):[p]));}return out;}
const files=(await walk('dist')).filter(f=>/\.(mjs|js)$/.test(f));
for(const file of files){
 const r=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});assert.equal(r.status,0,r.stderr);
 const text=await readFile(file,'utf8');
 for(const m of text.matchAll(/(?:from\s*|import\s*)['"](\.[^'"]+)['"]/g))assert.ok(existsSync(path.resolve(path.dirname(file),m[1])),`${file}: ${m[1]}`);
}
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const sourceHashes=JSON.parse(await readFile('reports/verification.json','utf8')).source_sha256;
const extension=JSON.parse(await readFile('reports/session-hard-level-extension.json','utf8'));
for(const file of Object.keys(extension.source))assert.ok(['packages/session/src/types.ts','packages/session/src/session.ts'].includes(file));
for(const [file,expected] of Object.entries(sourceHashes)){
 const updated=extension.source[file];if(updated)assert.equal(updated.baseline,expected);
 assert.equal(hash(await readFile(file)),updated?.sha256??expected,`P2 source changed outside the level extension: ${file}`);
}
const compiledHashes=JSON.parse(await readFile('reports/p2-compiled-sha256.json','utf8'));
for(const file of Object.keys(extension.compiled))assert.ok(file.startsWith('compiled/session/src/'));
for(const [file,expected] of Object.entries(compiledHashes)){
 const updated=extension.compiled[file.replace(/^dist\//,'compiled/')];if(updated)assert.equal(updated.baseline,expected);
 assert.equal(hash(await readFile(file)),updated?.sha256??expected,`P2 compiled changed outside the level extension: ${file}`);
 if(updated)assert.equal(hash(await readFile(file.replace(/^compiled\//,'dist/'))),updated.sha256,`session dist changed: ${file}`);
}
for(const [file,entry]of Object.entries(extension.compiled)){
 assert.equal(hash(await readFile(file)),entry.sha256,`compiled session artifact changed: ${file}`);
 assert.equal(hash(await readFile(file.replace(/^compiled\//,'dist/'))),entry.sha256,`session mirror changed: ${file}`);
}
const aiHashes=JSON.parse(await readFile('reports/ai-contract-sha256.json','utf8'));
for(const [file,expected] of Object.entries(aiHashes.source))assert.equal(hash(await readFile(file)),expected,`AI source changed; run build:ai: ${file}`);
for(const [file,expected] of Object.entries(aiHashes.compiled)){
 assert.equal(hash(await readFile(file)),expected,`AI compiled changed: ${file}`);
 assert.equal(hash(await readFile(file.replace(/^compiled\//,'dist/'))),expected,`AI dist changed: ${file}`);
}
console.log(`${files.length} JavaScript modules parsed; rules core unchanged; session hard-level extension verified; AI source/compiled/dist hashes match.`);
