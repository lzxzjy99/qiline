'use strict';
const {app,BrowserWindow,protocol,session,dialog,Menu,ipcMain,shell,screen} = require('electron');
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
  app.whenReady().then(async()=>{
    protocol.handle('qiline',createAssetHandler(path.join(app.getAppPath(),'web')));
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isGameURL(details.url)&&!details.url.startsWith('blob:qiline://game/')}));
    ipcMain.on('qiline:flash-frame',()=>{if(win&&!win.isDestroyed()&&!win.isFocused())win.flashFrame(true);});
    ipcMain.on('qiline:open-online',()=>{shell.openExternal('https://qiline-online.pages.dev/online.html').catch(()=>{});});
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
        {label:'关于弈合',click:()=>dialog.showMessageBox(win,{type:'info',title:'弈合',message:`弈合 · 离线版 v${version}`,detail:'规则 2.1.0-r3\n支持同设备双人、离线人机练习与棋谱复盘续下。\nAI 提供简单／标准／困难三档（默认9路困难档启用 Gen-3 NNUE + 多核 SMP）。\n完整玩法见界面角落“玩法手册”。',buttons:['知道了']})}
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
  app.on('window-all-closed',()=>app.quit());
}
