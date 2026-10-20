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
for(const [file,expected] of Object.entries(sourceHashes))assert.equal(hash(await readFile(file)),expected,`P2 source changed: ${file}`);
const compiledHashes=JSON.parse(await readFile('reports/p2-compiled-sha256.json','utf8'));
for(const [file,expected] of Object.entries(compiledHashes))assert.equal(hash(await readFile(file)),expected,`P2 compiled changed: ${file}`);
console.log(`${files.length} JavaScript modules parsed; local imports resolve; P2 core/session bytes unchanged.`);
