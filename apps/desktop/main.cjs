'use strict';
const {app,BrowserWindow,protocol,session,dialog,Menu,ipcMain,shell,screen} = require('electron');
const {spawn} = require('node:child_process');
const readline = require('node:readline');
const path = require('node:path');
const fs = require('node:fs');
const {version} = require('./package.json');
const {HOME,WEB_PREFERENCES,isGameURL,isDesktopPageURL,createAssetHandler,configureDownload,installCloseGuard} = require('./policy.cjs');

protocol.registerSchemesAsPrivileged([{scheme:'qiline',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setName('QiLine');
app.setAppUserModelId('org.qiline.game');
const profileOverride=process.env.QILINE_PROFILE_DIR;
if(profileOverride&&!path.isAbsolute(profileOverride))throw new Error('QILINE_PROFILE_DIR must be an absolute path');
const profile=profileOverride?path.resolve(profileOverride):path.join(app.getPath('appData'),'QiLine');
fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
const windowStateFile=path.join(profile,'window-state.json');

// ---- Native AVX2 Multi-Thread Engine Sidecar (qiline-engine.exe) ----
const ALLOWED_ENGINE_ASSETS=new Set(['qiline-gpufast-v3.qgpu','qiline_v26_mcts.wasm']);
let nativeProc=null;
let nativeInfo=null;
let nativeBootPromise=null;
let nativePending=new Map();
let nativeSeq=0;

function resolveSidecarPaths(){
  const candidates=[
    path.join(process.resourcesPath||'', 'engine'),
    path.join(path.dirname(app.getPath('exe')), 'resources', 'engine'),
    path.resolve(app.getAppPath(), '..', 'native-bin'),
  ];
  for(const dir of candidates){
    const exe=path.join(dir,'qiline-engine.exe');
    const model=path.join(dir,'nnue-gen7-192x2.bin');
    if(fs.existsSync(exe)&&fs.existsSync(model))return {exe,model};
  }
  return null;
}

function shutdownNativeSidecar(){
  if(!nativeProc)return;
  const p=nativeProc;
  nativeProc=null;
  nativeBootPromise=null;
  for(const [,entry] of nativePending){
    try{entry.resolve({ok:false,cancelled:true});}catch{}
  }
  nativePending.clear();
  try{p.stdin.write('{"cmd":"quit"}\n');}catch{}
  setTimeout(()=>{try{if(!p.killed)p.kill();}catch{}},250);
}

function ensureNativeSidecar(winRef){
  if(nativeInfo&&nativeProc&&!nativeProc.killed)return Promise.resolve(nativeInfo);
  if(nativeBootPromise)return nativeBootPromise;
  nativeBootPromise=new Promise(resolve=>{
    const paths=resolveSidecarPaths();
    if(!paths){nativeInfo={available:false,reason:'missing'};resolve(nativeInfo);return;}
    try{
      const proc=spawn(paths.exe,[],{stdio:['pipe','pipe','ignore'],windowsHide:true});
      nativeProc=proc;
      let readyMsg=null;
      let settled=false;
      const done=info=>{if(!settled){settled=true;nativeInfo=info;resolve(info);}};
      const bootTimer=setTimeout(()=>{shutdownNativeSidecar();done({available:false,reason:'timeout'});},4000);

      const rl=readline.createInterface({input:proc.stdout});
      rl.on('line',line=>{
        let msg;try{msg=JSON.parse(line);}catch{return;}
        if(msg.type==='ready'){
          readyMsg=msg;
          try{proc.stdin.write(JSON.stringify({cmd:'load',modelPath:paths.model.replaceAll('\\','/')})+'\n');}catch{}
        }else if(msg.type==='loaded'){
          clearTimeout(bootTimer);
          if(msg.ok){
            done({
              available:true,
              version:readyMsg?.version||'v26-native',
              isa:readyMsg?.isa||'avx2',
              logicalCores:readyMsg?.logicalCores||4,
              physicalCores:readyMsg?.physicalCores||4,
              perfCores:readyMsg?.perfCores||4,
              effCores:readyMsg?.effCores||0,
            });
          }else{
            shutdownNativeSidecar();
            done({available:false,reason:'model-load-failed'});
          }
        }else if(msg.type==='progress'){
          const target=winRef&&!winRef.isDestroyed()?winRef:null;
          if(target)target.webContents.send('qiline:native-progress',msg);
        }else if(msg.type==='result'||msg.type==='error'){
          const entry=nativePending.get(msg.id);
          if(entry){
            nativePending.delete(msg.id);
            entry.resolve(msg.type==='result'?{ok:true,...msg}:{ok:false,error:msg.error||'search-error'});
          }
        }
      });
      proc.on('error',()=>{clearTimeout(bootTimer);if(nativeProc===proc)nativeProc=null;done({available:false,reason:'spawn-error'});});
      proc.on('exit',()=>{
        clearTimeout(bootTimer);
        if(nativeProc===proc)nativeProc=null;
        nativeBootPromise=null;
        for(const [,entry] of nativePending){try{entry.resolve({ok:false,error:'exited'});}catch{}}
        nativePending.clear();
        done({available:false,reason:'exited'});
      });
    }catch{
      done({available:false,reason:'exception'});
    }
  });
  return nativeBootPromise;
}

function readWindowState(){
  const fallback={width:1240,height:900,maximized:false};
  try{
    const raw=JSON.parse(fs.readFileSync(windowStateFile,'utf8'));
    if(!raw||typeof raw!=='object')return fallback;
    const width=Number.isFinite(raw.width)?Math.max(700,Math.min(3840,raw.width)):fallback.width;
    const height=Number.isFinite(raw.height)?Math.max(620,Math.min(2160,raw.height)):fallback.height;
    const maximized=raw.maximized===true;
    if(Number.isFinite(raw.x)&&Number.isFinite(raw.y)){
      const visible=screen.getAllDisplays().some(d=>raw.x>=d.workArea.x-80&&raw.x<=d.workArea.x+d.workArea.width-120&&raw.y>=d.workArea.y-40&&raw.y<=d.workArea.y+d.workArea.height-120);
      if(visible)return {width,height,x:raw.x,y:raw.y,maximized};
    }
    return {width,height,maximized};
  }catch{return fallback;}
}
function saveWindowState(win){
  if(!win||win.isDestroyed())return;
  try{
    const maximized=win.isMaximized();
    const bounds=maximized?win.getNormalBounds():win.getBounds();
    fs.writeFileSync(windowStateFile,JSON.stringify({width:bounds.width,height:bounds.height,x:bounds.x,y:bounds.y,maximized}));
  }catch{}
}

let win;
const isSmoke=process.env.QILINE_SMOKE_EXIT==='1';
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.on('before-quit',()=>{shutdownNativeSidecar();});
  app.whenReady().then(async()=>{
    protocol.handle('qiline',createAssetHandler(path.join(app.getAppPath(),'web')));
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isGameURL(details.url)&&!details.url.startsWith('blob:qiline://game/')}));
    ipcMain.on('qiline:flash-frame',()=>{if(win&&!win.isDestroyed()&&!win.isFocused())win.flashFrame(true);});
    ipcMain.on('qiline:open-online',()=>{shell.openExternal('https://qiline-online.pages.dev/online.html').catch(()=>{});});
    ipcMain.handle('qiline:read-engine-asset',async(_ev,name)=>{
      if(typeof name!=='string'||!ALLOWED_ENGINE_ASSETS.has(name))throw new Error('Asset not allowed');
      const full=path.join(app.getAppPath(),'web','assets',name);
      return await fs.promises.readFile(full);
    });
    ipcMain.handle('qiline:native-info',async()=>{
      if(isSmoke)return {available:false,reason:'smoke'};
      return await ensureNativeSidecar(win);
    });
    ipcMain.handle('qiline:native-search',async(_ev,req)=>{
      const info=await ensureNativeSidecar(win);
      if(!info.available||!nativeProc||nativeProc.killed)return {ok:false,error:'unavailable'};
      const id=++nativeSeq;
      const payload={
        cmd:'search',
        id,
        swap3:req?.swap3!==false,
        moves:Array.isArray(req?.moves)?req.moves.map(n=>Number(n)|0):[],
        timeMs:Math.max(50,Math.min(120000,Number(req?.timeMs)||1500)),
        nodeBudget:Math.max(1000,Math.min(200000000,Number(req?.nodeBudget)||50000000)),
        maxDepth:Math.max(1,Math.min(24,Number(req?.maxDepth)||20)),
        threads:Math.max(1,Math.min(32,Number(req?.threads)||info.physicalCores||4)),
        ttMb:Math.max(16,Math.min(512,Number(req?.ttMb)||256)),
        seed:(Number(req?.seed)>>>0)||1,
        randomize:req?.randomize===true,
        clearTt:req?.clearTt===true,
      };
      return await new Promise(resolve=>{
        nativePending.set(id,{resolve});
        try{nativeProc.stdin.write(JSON.stringify(payload)+'\n');}
        catch{nativePending.delete(id);resolve({ok:false,error:'write-failed'});}
      });
    });
    ipcMain.on('qiline:native-stop',()=>{
      if(nativeProc&&!nativeProc.killed){
        try{nativeProc.stdin.write('{"cmd":"stop"}\n');}catch{}
      }
    });
    const ws=readWindowState();
    win=new BrowserWindow({
      title:'弈合 · 吃子与五连',icon:path.join(app.getAppPath(),'icon.ico'),
      width:ws.width,height:ws.height,...(ws.x!==undefined?{x:ws.x,y:ws.y}:{}),
      minWidth:700,minHeight:620,backgroundColor:'#f5f4ee',show:false,autoHideMenuBar:false,
      webPreferences:{...WEB_PREFERENCES,preload:path.join(__dirname,'preload.cjs')},
    });
    win.on('resize',()=>saveWindowState(win));
    win.on('move',()=>saveWindowState(win));
    win.on('close',()=>saveWindowState(win));
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(!isDesktopPageURL(url))event.preventDefault();});
    win.webContents.on('will-redirect',event=>event.preventDefault());
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.session.on('will-download',(event,item,contents)=>configureDownload(event,item,contents,win,dialog));
    win.webContents.on('render-process-gone',()=>{if(!win.isDestroyed())dialog.showMessageBox(win,{type:'error',title:'界面已停止',message:'请关闭后重新打开弈合。',detail:'程序会尝试恢复最近一次自动保存的对局。',buttons:['知道了']}).catch(()=>{});});
    if(!isSmoke)installCloseGuard(win,dialog);
    const sendCmd=cmd=>win&&!win.isDestroyed()&&win.webContents.send('qiline:menu-command',cmd);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'文件',submenu:[
        {label:'新对局',accelerator:'CmdOrCtrl+N',click:()=>sendCmd('new-game')},
        {label:'保存到棋谱库',accelerator:'CmdOrCtrl+S',click:()=>sendCmd('save-library')},
        {type:'separator'},
        {label:'导出 JSON 存档',click:()=>sendCmd('export-save')},
        {label:'导入 JSON 存档',click:()=>sendCmd('import-save')},
        {label:'打开自动存档目录',click:()=>shell.openPath(profile)},
        {type:'separator'},
        {label:'退出',accelerator:'Alt+F4',click:()=>app.quit()},
      ]},
      {label:'页面与显示',submenu:[
        {label:'本地与人机对局',click:()=>win.loadURL(HOME)},
        {label:'棋谱库与复盘',click:()=>win.loadURL('qiline://game/test-records.html')},
        {label:'在线对战（网页版）',click:()=>shell.openExternal('https://qiline-online.pages.dev/online.html').catch(()=>{})},
        {type:'separator'},
        {label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{label:'恢复原始大小',role:'resetZoom'},
        {type:'separator'},{label:'全屏',role:'togglefullscreen'},
      ]},
      {label:'帮助',submenu:[
        {label:'玩法手册与功能说明',accelerator:'F1',click:()=>sendCmd('open-manual')},
        {label:'关于弈合',click:()=>dialog.showMessageBox(win,{type:'info',title:'弈合',message:`弈合 · 离线版 v${version}`,detail:'规则 2.1.0-r3\n支持同设备双人、离线人机练习与棋谱复盘续下。\n默认9路困难 AI 搭载 Gen-7 v26 引擎：自动识别并榨干硬件性能（WebGPU GPU 神经网络 MCTS、原生 AVX2 多核引擎、WASM 多核/单核 NNUE v5）。\n完整玩法见界面角落“玩法手册”。',buttons:['知道了']})}
      ]}
    ]));
    if(isSmoke){
      win.webContents.once('did-finish-load',()=>setTimeout(()=>app.exit(0),120));
      win.webContents.once('did-fail-load',()=>app.exit(1));
    }else{
      win.once('ready-to-show',()=>{if(ws.maximized)win.maximize();win.show();});
    }
    await win.loadURL(HOME);
  }).catch(error=>{dialog.showErrorBox('弈合启动失败','请确认已完整解压整个文件夹，并检查当前账户是否有保存权限。\n'+String(error.message));app.exit(1);});
  app.on('window-all-closed',()=>{shutdownNativeSidecar();app.quit();});
}
