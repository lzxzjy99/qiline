'use strict';
const path = require('node:path');
const fs = require('node:fs/promises');
const SCHEME = 'qiline';
const HOST = 'game';
const HOME = 'qiline://game/index.html';
const MIME = Object.freeze({'.html':'text/html; charset=utf-8','.js':'text/javascript; charset=utf-8','.mjs':'text/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.svg':'image/svg+xml','.json':'application/json; charset=utf-8','.png':'image/png','.ico':'image/x-icon'});
const CSP = "default-src 'self'; script-src 'self'; worker-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
const WEB_PREFERENCES = Object.freeze({nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true,allowRunningInsecureContent:false,webviewTag:false,spellcheck:false});
function isGameURL(raw) {
  try {const u=new URL(raw);return u.protocol===SCHEME+':' && u.hostname===HOST && !u.port && !u.username && !u.password;}
  catch {return false;}
}
function isHomeURL(raw) {
  if (!isGameURL(raw)) return false;
  const u=new URL(raw);return (u.pathname==='/' || u.pathname==='/index.html') && !u.search;
}
function resolveAsset(root, raw, pathAPI=path) {
  if(!isGameURL(raw)) return null;
  let decoded;try {decoded=decodeURIComponent(new URL(raw).pathname);}catch{return null;}
  if(decoded.includes('\\') || decoded.includes('\0'))return null;
  const parts=decoded.split('/').filter(Boolean);
  if(parts.some(p=>p==='.'||p==='..'||p.includes(':')))return null;
  if(!parts.length)parts.push('index.html');
  const target=pathAPI.resolve(root,...parts),rel=pathAPI.relative(root,target);
  if(!rel || rel==='..' || rel.startsWith('..'+pathAPI.sep) || pathAPI.isAbsolute(rel))return null;
  return target;
}
function createAssetHandler(root, readFile=fs.readFile) {
  return async request=>{
    const headers={
      'Content-Security-Policy':CSP,
      'X-Content-Type-Options':'nosniff',
      'Cross-Origin-Opener-Policy':'same-origin',
      'Cross-Origin-Embedder-Policy':'require-corp',
      'Cross-Origin-Resource-Policy':'same-origin',
    };
    if(!['GET','HEAD'].includes(request.method))return new Response('Method not allowed',{status:405,headers});
    const file=resolveAsset(root,request.url);
    if(!file)return new Response('Not found',{status:404,headers});
    const mime=MIME[path.extname(file).toLowerCase()];
    if(!mime)return new Response('Not found',{status:404,headers});
    try {const bytes=await readFile(file);return new Response(request.method==='HEAD'?null:bytes,{headers:{...headers,'Content-Type':mime}});}
    catch {return new Response('Not found',{status:404,headers});}
  };
}
function configureDownload(event,item,contents,win,dialog) {
  const origin=item.getInitiatorOrigin();
  if(contents!==win.webContents || !['qiline://game','qiline://game/'].includes(origin) || !item.getURL().startsWith('blob:qiline://game/') || !item.getFilename().endsWith('.json')) {
    event.preventDefault();return false;
  }
  item.setSaveDialogOptions({title:'导出弈合存档',defaultPath:path.basename(item.getFilename()),buttonLabel:'保存存档',filters:[{name:'弈合 JSON 存档',extensions:['json']}],properties:['showOverwriteConfirmation']});
  item.once('done',(_event,state)=>{if(state==='interrupted'&&!win.isDestroyed())dialog.showMessageBox(win,{type:'error',title:'存档未导出',message:'文件保存中断，请重新导出。',detail:'当前对局仍保留在游戏中。',buttons:['知道了']}).catch(()=>{});});
  return true;
}
function installCloseGuard(win,dialog) {
  let approved=false,pending=false;
  win.on('close',event=>{
    if(approved)return;
    event.preventDefault();if(pending)return;pending=true;
    dialog.showMessageBox(win,{type:'question',title:'关闭弈合',message:'关闭游戏？',detail:'如果页面提示自动保存失败，请先导出存档。未完成的双方同意请求，下次启动需重新发起。',buttons:['继续游戏','关闭'],defaultId:0,cancelId:0,noLink:true})
      .then(({response})=>{pending=false;if(response===1&&!win.isDestroyed()){win.webContents.session.flushStorageData();approved=true;win.close();}})
      .catch(()=>{pending=false;});
  });
}
module.exports={SCHEME,HOST,HOME,CSP,WEB_PREFERENCES,isGameURL,isHomeURL,resolveAsset,createAssetHandler,configureDownload,installCloseGuard};
