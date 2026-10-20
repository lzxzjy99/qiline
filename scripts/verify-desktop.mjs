import {readFile,readdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import assert from 'node:assert/strict';
import {checkPE} from './pe-check.mjs';
const root=resolve(import.meta.dirname,'..');
const require=createRequire(join(process.env.QILINE_BUILD_TOOLS_ROOT?resolve(process.env.QILINE_BUILD_TOOLS_ROOT):join(root,'tools/desktop'),'package.json'));
const {extractFile,listPackage}=require('@electron/asar');
const {NtExecutable,NtExecutableResource,Resource}=require('resedit');
const build=JSON.parse(await readFile(join(root,'build/windows-build.json'),'utf8'));
const directory=build.paths[0],archive=join(directory,'resources/app.asar');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pe=[];
for(const name of await readdir(directory))if(/\.(exe|dll)$/i.test(name))pe.push({file:name,...checkPE(await readFile(join(directory,name)))});
const executable=await readFile(join(directory,'弈合.exe'));
const resources=NtExecutableResource.from(NtExecutable.from(executable));
const version=Resource.VersionInfo.fromEntries(resources.entries)[0];
assert.ok(version,'version resource missing');
const language=version.getAllLanguagesForStringValues()[0],strings=version.getStringValues(language);
assert.equal(strings.ProductName,'弈合');assert.equal(strings.ProductVersion,'0.4.0');assert.equal(strings.OriginalFilename,'弈合.exe');
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
const appRoot=join(root,'build/desktop-app'),files=await walk(appRoot),verified=[];
for(const file of files){const relative=file.slice(appRoot.length+1).replaceAll('\\','/'),expected=await readFile(file),actual=extractFile(archive,relative);if(relative==='package.json'){const normal=JSON.parse(expected);delete normal.private;assert.deepEqual(JSON.parse(actual),normal);}else assert.equal(hash(actual),hash(expected),relative);verified.push({file:relative,sha256:hash(actual),bytes:actual.length});}
const entries=listPackage(archive);assert.equal(entries.filter(p=>!entries.some(q=>q.startsWith(p+'/'))).length,files.length,'unexpected packaged files');
for(const file of verified.filter(f=>/^web\/(core|session)\/.*\.js$/.test(f.file))){const original=await readFile(join(root,'dist',file.file.slice(4)));assert.equal(file.sha256,hash(original));}
const result={...build,checks:{peFiles:pe.length,asarFiles:verified.length,versionResource:true,allAssetsMatchSource:true,sharedCoreMatchesWeb:true},peFiles:pe,asarFiles:verified,asarSHA256:hash(await readFile(archive)),metadata:strings,runtimeTested:false,hostPlatform:process.platform};
await writeFile(join(root,'build/desktop-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checks:result.checks,runtimeTested:false}));
