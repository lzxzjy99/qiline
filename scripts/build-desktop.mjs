import {cp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {resolve,join,relative,dirname,isAbsolute} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {checkPE} from './pe-check.mjs';

const root=resolve(import.meta.dirname,'..'),buildRoot=join(root,'build');
const toolsRoot=process.env.QILINE_BUILD_TOOLS_ROOT?resolve(process.env.QILINE_BUILD_TOOLS_ROOT):join(root,'tools/desktop');
const require=createRequire(join(toolsRoot,'package.json'));
const packagerEntry=require.resolve('@electron/packager');
const {packager}=await import(pathToFileURL(packagerEntry));
const {downloadArtifact}=require('@electron/get');
const appManifest=JSON.parse(await readFile(join(root,'apps/desktop/package.json'),'utf8'));
const toolsManifest=JSON.parse(await readFile(join(root,'tools/desktop/package.json'),'utf8'));
const packagerManifest=JSON.parse(await readFile(join(dirname(packagerEntry),'../package.json'),'utf8'));
assert.equal(packagerManifest.version,toolsManifest.devDependencies['@electron/packager'],'desktop packager must match the pinned version');
const version=appManifest.version,electronVersion=toolsManifest.qilineDesktop.electronVersion;
assert.match(version,/^\d+\.\d+\.\d+$/);assert.match(electronVersion,/^\d+\.\d+\.\d+$/);
const built=spawnSync(process.execPath,[join(root,'scripts/build-web.mjs')],{cwd:root,stdio:'inherit'});
if(built.status!==0)process.exit(built.status??1);
const {RULES_VERSION}=await import(pathToFileURL(join(root,'dist/core/src/index.js')));
const archiveName=`electron-v${electronVersion}-win32-x64.zip`;
const archive=process.env.QILINE_ELECTRON_ZIP_DIR?join(resolve(process.env.QILINE_ELECTRON_ZIP_DIR),archiveName)
  :await downloadArtifact({version:electronVersion,artifactName:'electron',platform:'win32',arch:'x64',cacheRoot:join(buildRoot,'electron-cache')});
const archiveBytes=await readFile(archive);
const archiveSHA256=createHash('sha256').update(archiveBytes).digest('hex');
assert.equal(archiveSHA256,toolsManifest.qilineDesktop.electronSHA256,'Electron archive must match the pinned official SHA256');
const appDir=join(buildRoot,'desktop-app'),relativeApp=relative(buildRoot,appDir);
assert.ok(relativeApp&&!relativeApp.startsWith('..')&&!isAbsolute(relativeApp),'staging directory must stay inside build');
await rm(appDir,{recursive:true,force:true});await mkdir(appDir,{recursive:true});
await cp(join(root,'apps/desktop'),appDir,{recursive:true});
await cp(join(root,'dist'),join(appDir,'web'),{recursive:true});
let extractedRuntime;
const options={dir:appDir,name:'QiLine',executableName:'弈合',icon:join(root,'apps/desktop/icon.ico'),platform:'win32',arch:'x64',electronVersion,
  electronZipDir:dirname(archive),out:join(buildRoot,'windows'),overwrite:true,asar:true,prune:false,appVersion:version,buildVersion:version,
  afterExtract:[async({buildPath})=>{extractedRuntime=checkPE(await readFile(join(buildPath,'electron.exe')));}],
  win32metadata:{ProductName:'弈合',FileDescription:'弈合 · 吃子与五连',CompanyName:'QiLine',OriginalFilename:'弈合.exe',InternalName:'QiLine'}};
const paths=await packager(options),extras=[];
for(const directory of paths){
  for(const [source,name]of [['apps/desktop/manual.html','弈合_游玩手册.html'],['docs/Windows真机验收清单.md','Windows真机验收清单.md']]){
    await cp(join(root,source),join(directory,name));extras.push({source,file:name});
  }
  await writeFile(join(directory,'启动说明.txt'),`弈合 v${version} · Windows x64\n\n请保留整个文件夹，双击“弈合.exe”启动。\n支持离线双人与人机练习（简单／标准／困难）。困难 AI 每手最多思考约 8 秒，可随时暂停。\n游玩手册见“弈合_游玩手册.html”。自动保存默认在 %APPDATA%\\QiLine。\n实际运行验证范围见随包验收记录，不能仅凭构建成功认定所有 Windows 环境均通过。\n`,'utf8');
}
const revision=spawnSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'});
const result={version,rulesVersion:RULES_VERSION,electronVersion,packagerVersion:packagerManifest.version,target:'win32-x64',paths,extras,
  electronArchive:{file:archive,bytes:archiveBytes.length,sha256:archiveSHA256,pinnedSHA256Verified:true,source:process.env.QILINE_ELECTRON_ZIP_DIR?'supplied-directory':'official-electron-download',sourceURL:process.env.QILINE_ELECTRON_ARCHIVE_URL??null},extractedRuntime,
  sourceRevision:revision.status===0?revision.stdout.trim():null,builtAt:new Date().toISOString(),runtimeTested:false};
await writeFile(join(buildRoot,'windows-build.json'),JSON.stringify(result,null,2)+'\n');
console.log(JSON.stringify({packaged:paths,version,runtimeTested:false}));
