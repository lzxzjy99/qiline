'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('qilineDesktop',{
  flashFrame:()=>ipcRenderer.send('qiline:flash-frame'),
  openOnline:()=>ipcRenderer.send('qiline:open-online'),
  readEngineAsset:name=>ipcRenderer.invoke('qiline:read-engine-asset',name),
  nativeEngine:{
    getInfo:()=>ipcRenderer.invoke('qiline:native-info'),
    search:req=>ipcRenderer.invoke('qiline:native-search',req),
    stop:()=>ipcRenderer.send('qiline:native-stop'),
    onProgress:handler=>{
      if(typeof handler!=='function')return ()=>{};
      const listener=(_ev,msg)=>handler(msg);
      ipcRenderer.on('qiline:native-progress',listener);
      return ()=>ipcRenderer.removeListener('qiline:native-progress',listener);
    },
  },
  onMenuCommand:handler=>{
    if(typeof handler!=='function')return ()=>{};
    const listener=(_ev,cmd)=>handler(cmd);
    ipcRenderer.on('qiline:menu-command',listener);
    return ()=>ipcRenderer.removeListener('qiline:menu-command',listener);
  },
});
