import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {EventEmitter} from 'node:events';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {checkPE} from '../scripts/pe-check.mjs';
const require=createRequire(import.meta.url);
const {HOME,WEB_PREFERENCES,isGameURL,isHomeURL,resolveAsset,createAssetHandler,configureDownload,installCloseGuard}=require('../apps/desktop/policy.cjs');

test('PE verification catches the truncated-runtime failure before a Windows package is shipped',()=>{
 const bytes=Buffer.alloc(1024);bytes.write('MZ');bytes.writeUInt32LE(128,0x3c);bytes.write('PE\0\0',128);bytes.writeUInt16LE(0x8664,132);bytes.writeUInt16LE(1,134);bytes.writeUInt16LE(240,148);bytes.writeUInt16LE(0x20b,152);bytes.write('.text',392);bytes.writeUInt32LE(512,408);bytes.writeUInt32LE(512,412);
 assert.equal(checkPE(bytes).architecture,'x64');assert.throws(()=>checkPE(bytes.subarray(0,800)),/truncated/);const wrong=Buffer.from(bytes);wrong.writeUInt16LE(0x14c,132);assert.throws(()=>checkPE(wrong),/x64/);assert.throws(()=>checkPE(Buffer.alloc(20)),/DOS/);
});

test('desktop origin accepts only the packaged game and refuses credentials or remote hosts',()=>{
 for(const u of [HOME,'qiline://game/','qiline://game/core/src/index.js'])assert.equal(isGameURL(u),true);
 for(const u of ['https://qiline-rebuild.honeybow16.chatgpt.site','qiline://game.evil/a','qiline://user:pass@game/','qiline://game:99/','file:///a','javascript:alert(1)','invalid'])assert.equal(isGameURL(u),false,u);
 assert.equal(isHomeURL(HOME),true);assert.equal(isHomeURL('qiline://game/'),true);
 for(const u of ['qiline://game/app.mjs','qiline://game/index.html?remote=x','https://game/'])assert.equal(isHomeURL(u),false);
});
test('asset containment works with Chinese and spaces on both POSIX and Windows paths',()=>{
 for(const [api,root] of [[path.posix,'/tmp/中文 空格/应用'],[path.win32,'C:\\用户\\中文 空格\\应用']]){
  assert.equal(resolveAsset(root,'qiline://game/',api),api.join(root,'index.html'));
  assert.equal(resolveAsset(root,'qiline://game/core/src/index.js',api),api.join(root,'core','src','index.js'));
  for(const u of ['qiline://game/%2e%2e%2fsecret.json','qiline://game/%5c..%5csecret.json','qiline://game/C:%5csecret.json','qiline://game/a%00.js','qiline://game/%E0%A4%A'])assert.equal(resolveAsset(root,u,api),null,u);
 }
});
test('offline protocol serves actual UTF-8 assets and MIME without external requests',async()=>{
 const root=await mkdtemp(path.join(tmpdir(),'弈合 离线-'));
 try{
  await writeFile(path.join(root,'index.html'),'<h1>弈合</h1>');await writeFile(path.join(root,'app.mjs'),'export const n=9;');
  const handle=createAssetHandler(root);
  const h=await handle({method:'GET',url:'qiline://game/'});assert.equal(h.status,200);assert.equal(await h.text(),'<h1>弈合</h1>');
  assert.match(h.headers.get('Content-Security-Policy'),/connect-src 'none'/);
  assert.match(h.headers.get('Content-Security-Policy'),/worker-src 'self'/);
  const js=await handle({method:'GET',url:'qiline://game/app.mjs'});assert.match(js.headers.get('Content-Type'),/javascript/);assert.equal(js.headers.get('X-Content-Type-Options'),'nosniff');
  const head=await handle({method:'HEAD',url:HOME});assert.equal(head.status,200);assert.equal(await head.text(),'');
 } finally{await rm(root,{recursive:true,force:true});}
});
test('offline protocol serves the real module Worker, scheduler and browser adapter as local JavaScript',async()=>{
 const handle=createAssetHandler(path.resolve('dist'));
 for(const file of ['ai/src/worker-entry.js','ai/src/worker-controller.js','ui/ai-host.mjs']){
  const response=await handle({method:'GET',url:`qiline://game/${file}`});
  assert.equal(response.status,200);assert.match(response.headers.get('Content-Type'),/javascript/);
  assert.match(response.headers.get('Content-Security-Policy'),/worker-src 'self'/);
  assert.match(await response.text(),/runSearch|createAIWorkerController|class AIWorkerController/);
 }
});
test('missing, malformed, unsupported and failed reads do not expose arbitrary files',async()=>{
 const handle=createAssetHandler('/bundle',async()=>{throw Error('denied');});
 for(const url of [HOME,'https://evil/index.html','qiline://game/%2e%2e%2fprivate.json','qiline://game/LICENSE','qiline://game/private.exe'])assert.equal((await handle({method:'GET',url})).status,404);
 assert.equal((await handle({method:'POST',url:HOME})).status,405);
});
test('renderer keeps sandbox, isolation and web security without Node access',()=>{
 assert.equal(WEB_PREFERENCES.nodeIntegration,false);assert.equal(WEB_PREFERENCES.contextIsolation,true);assert.equal(WEB_PREFERENCES.sandbox,true);assert.equal(WEB_PREFERENCES.webSecurity,true);
 assert.equal(WEB_PREFERENCES.allowRunningInsecureContent,false);assert.equal(WEB_PREFERENCES.webviewTag,false);
});
function downloadFixture(){const contents={},win={webContents:contents,isDestroyed:()=>false},item=new EventEmitter();item.getInitiatorOrigin=()=> 'qiline://game';item.getURL=()=> 'blob:qiline://game/save';item.getFilename=()=> '弈合_第1局.json';item.setSaveDialogOptions=o=>item.options=o;const event={preventDefault(){this.prevented=true;}};const messages=[];return {contents,win,item,event,messages,dialog:{showMessageBox:async(_w,o)=>messages.push(o)}};}
test('trusted JSON export opens the native save dialog with overwrite confirmation',()=>{
 const x=downloadFixture();assert.equal(configureDownload(x.event,x.item,x.contents,x.win,x.dialog),true);assert.equal(x.item.options.defaultPath,'弈合_第1局.json');assert.deepEqual(x.item.options.filters[0].extensions,['json']);assert.ok(x.item.options.properties.includes('showOverwriteConfirmation'));
});
test('exports reject external initiators, non-blob sources, other windows and non-JSON files',()=>{
 for(const change of [x=>x.item.getInitiatorOrigin=()=> 'https://evil',x=>x.item.getURL=()=> 'https://evil/save.json',x=>x.contents={},x=>x.item.getFilename=()=> 'program.exe']){
  const x=downloadFixture();change(x);assert.equal(configureDownload(x.event,x.item,x.contents,x.win,x.dialog),false);assert.equal(x.event.prevented,true);assert.equal(x.item.options,undefined);
 }
});
test('interrupted export reports failure; cancelling or finishing does not raise a false error',async()=>{
 for(const state of ['interrupted','cancelled','completed']){const x=downloadFixture();configureDownload(x.event,x.item,x.contents,x.win,x.dialog);x.item.emit('done',{},state);await Promise.resolve();assert.equal(x.messages.length,state==='interrupted'?1:0);}
});
function closeFixture(){const win=new EventEmitter();win.webContents={session:{flushStorageData(){win.flushed=true;}}};win.isDestroyed=()=>false;win.close=()=>win.emit('close',{preventDefault(){win.secondPrevented=true;}});const prompts=[];const pending=[];const dialog={showMessageBox(_w,options){prompts.push(options);return new Promise((resolve,reject)=>pending.push({resolve,reject}));}};installCloseGuard(win,dialog);return {win,prompts,pending,event:{preventDefault(){this.prevented=true;}}};}
test('closing defaults to continuing the game and prevents duplicate prompts',async()=>{
 const x=closeFixture();x.win.emit('close',x.event);x.win.emit('close',x.event);assert.equal(x.event.prevented,true);assert.equal(x.prompts.length,1);assert.equal(x.prompts[0].defaultId,0);assert.equal(x.prompts[0].cancelId,0);x.pending[0].resolve({response:0});await Promise.resolve();assert.equal(x.win.flushed,undefined);x.win.emit('close',x.event);assert.equal(x.prompts.length,2);
});
test('approved close flushes storage then closes without asking again',async()=>{
 const x=closeFixture();x.win.emit('close',x.event);x.pending[0].resolve({response:1});await Promise.resolve();assert.equal(x.win.flushed,true);assert.equal(x.win.secondPrevented,undefined);assert.equal(x.prompts.length,1);
});
test('failed close dialog leaves the game open and permits retry',async()=>{
 const x=closeFixture();x.win.emit('close',x.event);x.pending[0].reject(Error('dialog failed'));await Promise.resolve();await Promise.resolve();assert.equal(x.win.flushed,undefined);x.win.emit('close',x.event);assert.equal(x.prompts.length,2);
});
