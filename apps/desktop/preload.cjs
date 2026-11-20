'use strict';
const {contextBridge,ipcRenderer}=require('electron');
contextBridge.exposeInMainWorld('qilineDesktop',{
  flashFrame:()=>ipcRenderer.send('qiline:flash-frame'),
  onMenuCommand:handler=>{
    if(typeof handler!=='function')return ()=>{};
    const listener=(_ev,cmd)=>handler(cmd);
    ipcRenderer.on('qiline:menu-command',listener);
    return ()=>ipcRenderer.removeListener('qiline:menu-command',listener);
  },
});
