# Windows 构建与验证

目标：x64；Electron 固定为 44.9.0，构建工具 @electron/packager 20.3.0。规则及会话核心沿用 P2，渲染器沿用 P3。桌面主进程通过标准 `qiline://game` 来源提供包内资源，不加载网站；默认配置关闭 Node 集成，启用隔离、沙盒和网页安全。

## 构建

```sh
npm install --prefix tools/desktop
npm run build:desktop
npm run verify:desktop
```

Node.js 22.12+。正常构建从 Electron 官方来源获取运行库。离线构建可通过环境变量 `QILINE_ELECTRON_ZIP_DIR` 指定包含官方 `electron-v44.9.0-win32-x64.zip` 的目录；`QILINE_BUILD_TOOLS_ROOT` 可指向已安装构建依赖的工具目录。不应使用旧小样重命名构造的运行库作为发行输入。

`build/windows/QiLine-win32-x64` 是完整运行目录，不能只分发 exe。`build/windows-build.json` 记录构建，`build/desktop-verification.json` 记录 PE、版本资源、ASAR 与共享核心核对；输出中的 `runtimeTested` 必须在真实 Windows 验收前保持 `false`。

`npm run build:desktop` 在提取运行库后先检查 x64 PE 区段，发现截断立即失败。`npm run verify:desktop` 检查最终 exe／DLL 和 ASAR 每个文件；仅 package.json 允许 Packager 的格式化与移除 `private` 字段，其他内容逐字节核对。产物中的游戏核心与网页核心逐字节一致。

图标由代码中的棋盘图元绘制，生成脚本为 `scripts/generate-icon.py`，仅重新生成图标时需要 Pillow。已生成的 ICO 随源码提交，正常构建不需要 Python。

## 本轮修复

旧 P1 运行文件实际长度为 173,151,744 字节，而其 PE 区段声明需要至少 247,184,896 字节。本轮停止复用并重新通过 @electron/get 获取官方完整归档，下载归档 SHA256 为 `88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931`。新原始 electron.exe 长度为 247,184,896 字节，区段完整。该发现说明 P1 的“交叉构建有产物”不能作为可运行证据；旧小样不应分发。

桌面提供原生 JSON 保存对话框、保存中断提示、单实例、缩放菜单、退出确认与存储刷新。自动存档留在 `%APPDATA%\QiLine`；网页和桌面通过当前版本 JSON 存档互通，独立保存。

## 验证边界

本轮 Node 检查共 22 项通过（桌面 12，网页宿主 10），加上最终 7 个 PE 文件、40 个应用文件的检查。主进程测试包含文件访问范围、来源、中文路径解析、导出中断和关闭处理；这是模拟接口测试，不是真实系统对话框、触摸或 Windows UI 验收。

本环境没有 Windows 运行器。下一步按 `Windows真机验收清单.md` 补齐 Windows 运行、中文路径、离线、系统缩放、存档与对局实测；实体手机及 Safari 也仍待测。AI 属于 P5，尚未接入。

参考：[官方版本记录](https://releases.electronjs.org/release/v44.9.0)、[自定义协议](https://www.electronjs.org/docs/latest/api/protocol)、[下载保存对话框](https://www.electronjs.org/docs/latest/api/download-item)、[进程隔离](https://www.electronjs.org/docs/latest/tutorial/security)。
