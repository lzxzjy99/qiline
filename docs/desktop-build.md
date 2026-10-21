# Windows 构建与验证

当前候选版 v0.5.7，目标 Windows x64；Electron 固定为 44.9.0，构建工具 @electron/packager 20.3.0。规则及会话核心沿用已验证的 P2，渲染器与当前网页共用，包含双人、人机练习、AI Worker、有限恢复和存档恢复。P5.7 加入棋力优化，版本运行范围见 [Windows 0.5.7 验收记录](Windows0.5.7验收记录.md)。桌面主进程通过标准 `qiline://game` 来源提供包内资源，不加载网站；默认配置关闭 Node 集成，启用隔离、沙盒和网页安全。

## 构建

```sh
npm install --prefix tools/desktop
npm run build:desktop
npm run verify:desktop
```

Node.js 22.12+。正常构建从 Electron 官方来源获取运行库。离线构建可通过环境变量 `QILINE_ELECTRON_ZIP_DIR` 指定包含 `electron-v44.9.0-win32-x64.zip` 的目录；`QILINE_BUILD_TOOLS_ROOT` 可指向已安装构建依赖的工具目录。构建始终核对固定的官方归档 SHA256，镜像或本地输入也须一致，不应使用旧小样重命名构造的运行库作为发行输入。本轮归档由镜像提供，来源 URL 与校验结果记录在 `build/windows-build.json`。

`build/windows/QiLine-win32-x64` 是完整运行目录，不能只分发 exe。保留整个目录，双击“弈合.exe”启动。`build/windows-build.json` 记录构建，`build/desktop-verification.json` 记录 PE、版本资源、ASAR、网页／AI Worker 和外部手册核对。两份构建报告的 `runtimeTested:false` 表示这些工具只做结构与内容检查；实际运行项目单列于 [P5.6 验收报告](P5.6验收报告.md) 和 [Windows 清单](Windows真机验收清单.md)。

`npm run build:desktop` 在提取运行库后先检查固定归档 SHA256 和 x64 PE 区段，发现不符或截断立即失败。`npm run verify:desktop` 检查最终 exe／DLL 和 ASAR 每个文件；仅 package.json 允许 Packager 的格式化与移除 `private` 字段，其他内容逐字节核对。产物中的网页资产与 `dist/` 一致，必须包含 Worker 入口、调度器和人机恢复模块；随包外部手册与清单也按来源核对。修改这些来源后须重新同步产物并核对，不能沿用旧检查结论。

图标由代码中的棋盘图元绘制，生成脚本为 `scripts/generate-icon.py`，仅重新生成图标时需要 Pillow。已生成的 ICO 随源码提交，正常构建不需要 Python。

## 运行库与存档

P4 曾发现旧 P1 运行文件实际长度为 173,151,744 字节，而其 PE 区段声明需要至少 247,184,896 字节，因此停止复用。当前固定归档 SHA256 为 `88e08039d0ef359bab9f674e8051fa103bd8628ea7c5a5e1daaa610a8a0c6931`，原始 electron.exe 长度为 247,184,896 字节，区段完整。该历史发现说明有构建文件不能作为可运行证据；旧小样不应分发。

桌面提供原生 JSON 保存对话框、保存中断提示、单实例、缩放菜单、退出确认与存储刷新。自动存档默认留在 `%APPDATA%\QiLine`；网页和桌面通过当前版本 JSON 存档互通，独立保存。测试时可用绝对路径环境变量 `QILINE_PROFILE_DIR` 指定独立存档目录，避免覆盖正常游玩进度；相对路径会拒绝启动。

## 验证边界

P5.7 全量 Node 检查 9,659 项通过，失败、跳过和取消均为零，记录见 `reports/p5-7-tests.tap`；其中包含桌面策略、产品矩阵、搜索、恢复、界面和新增棋力专项。v0.5.7 包结构检查验证 7 个 PE 文件和 70 个 ASAR 文件，网页与 AI Worker 已打入包中，来源一致。构建时 HEAD 仅表示基线提交，本轮有未提交差异；包内容以逐文件和 ASAR 哈希为准，详见 `reports/desktop-p5-7-verification.json`。

v0.5.6 完整包已在 Windows NT 10.0.26200.0 x64 的中文空格路径启动两次，退出码均为 0。9 路标准 AI=A 的摆局与应手、两条命令悔棋、暂停锁盘可导出、原生 JSON 保存／打开、确认导入、同隔离目录重启恢复并明确继续，以及退出保护的继续／关闭分支均已实际操作。结果与截图见 `reports/windows-p5-6-runtime.json`，限于该文件的 `runtimeScope`。

物理断网、系统缩放 150%／200%、单实例第二次启动、窗口／多屏组合、其他架构、实体手机和 Safari 尚未验收。主进程的文件访问、来源、导出中断等自动检查使用模拟接口，不能将其扩大为全部原生操作通过。构建报告继续保留 `runtimeTested:false`，不通过改动总布尔值来宣称全部 Windows 配置通过。

参考：[官方版本记录](https://releases.electronjs.org/release/v44.9.0)、[自定义协议](https://www.electronjs.org/docs/latest/api/protocol)、[下载保存对话框](https://www.electronjs.org/docs/latest/api/download-item)、[进程隔离](https://www.electronjs.org/docs/latest/tutorial/security)。
