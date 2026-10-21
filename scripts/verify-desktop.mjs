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
const appManifest=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8'));
const toolsManifest=JSON.parse(await readFile(join(root,'tools/desktop/package.json'),'utf8'));
assert.equal(build.version,appManifest.version);assert.equal(build.electronVersion,toolsManifest.qilineDesktop.electronVersion);
assert.equal(build.packagerVersion,toolsManifest.devDependencies['@electron/packager']);
assert.equal(build.electronArchive.sha256,toolsManifest.qilineDesktop.electronSHA256);assert.equal(build.electronArchive.pinnedSHA256Verified,true);
const directory=build.paths[0],archive=join(directory,'resources/app.asar');
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const pe=[];
for(const name of await readdir(directory))if(/\.(exe|dll)$/i.test(name))pe.push({file:name,...checkPE(await readFile(join(directory,name)))});
const executable=await readFile(join(directory,'弈合.exe'));
const resources=NtExecutableResource.from(NtExecutable.from(executable));
const version=Resource.VersionInfo.fromEntries(resources.entries)[0];
assert.ok(version,'version resource missing');
const language=version.getAllLanguagesForStringValues()[0],strings=version.getStringValues(language);
assert.equal(strings.ProductName,'弈合');assert.equal(strings.ProductVersion,appManifest.version);assert.equal(strings.OriginalFilename,'弈合.exe');
async function walk(dir){const out=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(dir,e.name);if(e.isDirectory())out.push(...await walk(p));else out.push(p);}return out;}
const appRoot=join(root,'build/desktop-app'),files=await walk(appRoot),verified=[];
for(const file of files){const nativeRelative=file.slice(appRoot.length+1),relative=nativeRelative.replaceAll('\\','/'),expected=await readFile(file),actual=extractFile(archive,nativeRelative);if(relative==='package.json'){const normal=JSON.parse(expected);delete normal.private;assert.deepEqual(JSON.parse(actual),normal);}else assert.equal(hash(actual),hash(expected),relative);verified.push({file:relative,sha256:hash(actual),bytes:actual.length});}
const entries=listPackage(archive).map(p=>p.replaceAll('\\','/'));assert.equal(entries.filter(p=>!entries.some(q=>q.startsWith(p+'/'))).length,files.length,'unexpected packaged files');
for(const file of verified.filter(f=>/^web\/(core|session)\/.*\.js$/.test(f.file))){const original=await readFile(join(root,'dist',file.file.slice(4)));assert.equal(file.sha256,hash(original));}
for(const file of verified.filter(f=>f.file.startsWith('web/'))){const original=await readFile(join(root,'dist',file.file.slice(4)));assert.equal(file.sha256,hash(original),`shared web asset: ${file.file}`);}
for(const name of ['web/ai/src/worker-entry.js','web/ai/src/worker-controller.js','web/ui/ai-host.mjs','web/ui/ai-recovery.mjs'])assert.ok(verified.some(f=>f.file===name),`missing AI module: ${name}`);
const extras=[];for(const extra of build.extras??[]){const actual=await readFile(join(directory,extra.file));assert.equal(hash(actual),hash(await readFile(join(root,extra.source))));extras.push({...extra,sha256:hash(actual),bytes:actual.length});}
const result={...build,checks:{peFiles:pe.length,asarFiles:verified.length,versionResource:true,allAssetsMatchSource:true,sharedCoreMatchesWeb:true,sharedWebMatchesSource:true,aiWorkerPackaged:true,externalManualMatchesSource:true},peFiles:pe,asarFiles:verified,externalFiles:extras,asarSHA256:hash(await readFile(archive)),metadata:strings,runtimeTested:false,hostPlatform:process.platform};
await writeFile(join(root,'build/desktop-verification.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({checks:result.checks,runtimeTested:false}));
