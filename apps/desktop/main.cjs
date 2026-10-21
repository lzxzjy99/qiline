'use strict';
const {app,BrowserWindow,protocol,session,dialog,Menu} = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const {version} = require('./package.json');
const {HOME,WEB_PREFERENCES,isGameURL,isHomeURL,createAssetHandler,configureDownload,installCloseGuard} = require('./policy.cjs');

// A stable, standard origin keeps modules and local saves independent of install path.
protocol.registerSchemesAsPrivileged([{scheme:'qiline',privileges:{standard:true,secure:true,supportFetchAPI:true,corsEnabled:true}}]);
app.setName('QiLine');
app.setAppUserModelId('org.qiline.game');
const profileOverride=process.env.QILINE_PROFILE_DIR;
if(profileOverride&&!path.isAbsolute(profileOverride))throw new Error('QILINE_PROFILE_DIR must be an absolute path');
const profile=profileOverride?path.resolve(profileOverride):path.join(app.getPath('appData'),'QiLine');
fs.mkdirSync(profile,{recursive:true});app.setPath('userData',profile);
let win;
if(!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance',()=>{if(win){if(win.isMinimized())win.restore();win.show();win.focus();}});
  app.whenReady().then(async()=>{
    protocol.handle('qiline',createAssetHandler(path.join(app.getAppPath(),'web')));
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    // The game is fully offline. Blob export remains inside the trusted game origin.
    session.defaultSession.webRequest.onBeforeRequest((details,callback)=>callback({cancel:!isGameURL(details.url)&&!details.url.startsWith('blob:qiline://game/')}));
    win=new BrowserWindow({title:'弈合 · 吃子与五连',icon:path.join(app.getAppPath(),'icon.ico'),width:1180,height:900,minWidth:700,minHeight:620,backgroundColor:'#f5f4ee',show:false,autoHideMenuBar:false,webPreferences:{...WEB_PREFERENCES}});
    win.webContents.setWindowOpenHandler(()=>({action:'deny'}));
    win.webContents.on('will-navigate',(event,url)=>{if(!isHomeURL(url))event.preventDefault();});
    win.webContents.on('will-redirect',event=>event.preventDefault());
    win.webContents.on('will-attach-webview',event=>event.preventDefault());
    win.webContents.session.on('will-download',(event,item,contents)=>configureDownload(event,item,contents,win,dialog));
    win.webContents.on('render-process-gone',()=>{if(!win.isDestroyed())dialog.showMessageBox(win,{type:'error',title:'界面已停止',message:'请关闭后重新打开弈合。',detail:'程序会尝试恢复最近一次自动保存的对局。',buttons:['知道了']}).catch(()=>{});});
    installCloseGuard(win,dialog);
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      {label:'文件',submenu:[{label:'退出',accelerator:'Alt+F4',click:()=>app.quit()}]},
      {label:'显示',submenu:[{label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{label:'恢复原始大小',role:'resetZoom'},{type:'separator'},{label:'全屏',role:'togglefullscreen'}]},
      {label:'帮助',submenu:[{label:'关于弈合',click:()=>dialog.showMessageBox(win,{type:'info',title:'弈合',message:`弈合 · 离线版 v${version}`,detail:'规则 2.1.0-r3\n支持同设备双人与人机练习，AI 提供简单／标准／困难三档。\n完整玩法见游戏右上角“玩法手册”。\nWindows x64 候选版，实际验收范围见随包记录。',buttons:['知道了']})}]}
    ]));
    win.once('ready-to-show',()=>win.show());
    await win.loadURL(HOME);
  }).catch(error=>{dialog.showErrorBox('弈合启动失败','请确认已完整解压整个文件夹，并检查当前账户是否有保存权限。\n'+String(error.message));app.exit(1);});
  app.on('window-all-closed',()=>app.quit());
}
