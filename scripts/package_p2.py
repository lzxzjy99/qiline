"""Produce reviewable P2 deliverables from actual completed verification output."""
from pathlib import Path
import hashlib,json,re,zipfile,subprocess

ROOT=Path(__file__).resolve().parent.parent
OUT=ROOT/'docs';OUT.mkdir(exist_ok=True)
matrix=json.loads((ROOT/'reports/configuration-matrix.json').read_text())
cross=json.loads((ROOT/'reports/cross-validation.json').read_text())
geometry=json.loads((ROOT/'reports/geometry.json').read_text())
assert matrix['configurations']==448 and matrix['failed']==0 and cross['failure'] is None
assert cross['statistics']['configurations']==448 and cross['statistics']['games']==896

def tap(path):
    text=(ROOT/path).read_text()
    names=set(re.findall(r'^# Subtest: (.+)$',text,re.M))
    count=int(re.search(r'^# tests (\d+)$',text,re.M).group(1))
    passed=int(re.search(r'^# pass (\d+)$',text,re.M).group(1))
    failed=int(re.search(r'^# fail (\d+)$',text,re.M).group(1))
    assert failed==0 and count==passed==len(names)
    return names,{'file':path,'tests':count,'passed':passed,'failed':failed}

base_names,base=tap('reports/node-test.tap')
session_names,latest_session=tap('reports/session-final.tap')
distinct=len(base_names|session_names)
stats=cross['statistics']
rules_sha=hashlib.sha256((ROOT/'docs/rules-2.1.0-r3.md').read_bytes()).hexdigest()
source_files=sorted((ROOT/'packages').rglob('*.ts'))
for p in source_files:
    source=p.read_text()
    assert not re.search(r'node:|Date\.now|Math\.random|\bfetch\(|\bdocument\b|\bwindow\b|\bprocess\b',source),str(p)
    for module in re.findall(r'(?:from|import)\s*[\'\"]([^\'\"]+)[\'\"]',source):assert module.startswith('.'),(p,module)
verification={'stage':'P2','status':'core-complete','rulesVersion':'2.1.0-r3','rules_sha256':rules_sha,
 'node_groups':[base,latest_session],'distinct_node_tests':distinct,'configuration_matrix':{k:v for k,v in matrix.items() if k!='results'},
 'geometry':geometry,'cross_validation':cross,'runtime':subprocess.check_output(['node','--version'],text=True).strip(),
 'architecture':{'typescript_modules':len(source_files),'platform_or_clock_or_network_dependencies':0},
 'platforms':{'actual_browser':'not tested in P2','actual_windows':'blocked/not tested'},
 'source_sha256':{str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in source_files}}
(ROOT/'reports/verification.json').write_text(json.dumps(verification,ensure_ascii=False,indent=2)+'\n')

report=f'''# 弈合 · P2 核心引擎验收报告

日期：2026-10-20。工程版本：0.2.0。规则版本：**2.1.0-r3**。

**P2 正式共享核心已完成并通过本轮验收。** 本次是实际 TypeScript 引擎，不再只是接口声明或 Python 审查模型。可以执行完整对局命令并产生确定性的棋局结果；下一步是 P3 网页本地双人界面。

## 已完成

| 模块 | 本轮结果 |
| --- | --- |
| 规则核心 | 实现多棋盘、三手换色、正交棋块与气、同时提子、自杀、PSK、两种五连计时、主动／被迫停手、认输、开局取消、和棋与终局 |
| 五连候选 | 默认每组连续五子独立计时；长连包含多个固定五子组，新增不重置旧组；可选同色换线继承；双方候选独立 |
| 不可变历史 | Match 有运行时来源标记、公开状态与事件冻结；落子及连带自动停手为一个事务；悔棋直接恢复整条命令前的完整状态与历史分支 |
| 棋谱 | 显式版本与全部配置；严格字段校验、完整重放、错误位置与原因；旧格式和最终棋盘注入被拒绝 |
| 会话基础 | 双人同意悔棋／取消／提示、竞技限制、暂停、真实控制者、任务句柄与过期拒绝、保存恢复；不含 UI、实际存储或 AI 搜索 |
| 开发交付 | TypeScript 源码、已编译 ESM 与实际生成的 `.d.ts`、固定依赖、测试与原始报告、可运行演示 |

核心仅使用纯计算，没有 DOM、文件系统、网络、时钟或随机数依赖。两端之后导入同一套核心；界面与 AI 不另写提子或判胜规则。

## 实际验收证据

| 检查 | 结果 |
| --- | --- |
| 严格 TypeScript 编译 | 通过；实际执行 Node {verification['runtime']}、TypeScript 7.0.2 |
| Node 用例 | **{distinct} 个不同用例通过**，分组执行；基础完整运行 {base['tests']} 个，最后会话组 {latest_session['tests']} 个覆盖原会话用例并补充启动恢复与句柄来源测试，重复项不重复计数 |
| 配置矩阵 | **448 种配置，{matrix['checks']:,} 项场景检查：{matrix['passed']:,} 通过、{matrix['notApplicable']} 明确不适用、0 失败**；即时模式的后续拆线、短延迟下不能继续的长连分支单列不适用 |
| 独立提子算法 | 3×3 的 19,683 种赋值中，12,675 种无死块局面、**{geometry['moveProbes']:,}** 次落子判断；实际几何、快速合法性检查与独立全盘算法一致 |
| 跨语言对局 | 正式 TypeScript 与独立 Python 模型，全部 **448** 种配置下 **{stats['games']}** 盘从空盘开始的对局，**{stats['accepted_commands']:,}** 条接受命令，**{stats['state_comparisons']:,}** 次状态比较全部一致 |
| 跨语言历史与合法性 | {stats['undo_checks']:,} 次悔棋、{stats['branch_redo_checks']:,} 次分支重下、{stats['replay_checks']:,} 次回放、{stats['illegal_atomicity_checks']:,} 次非法事务检查、{stats['legal_set_checks']} 次完整合法点集合比较通过 |
| 随机模拟终止情况 | {stats['terminated']} 盘自然结束，{stats['truncated_at_120_commands']} 盘到120条命令后截断；截断未算和棋或负局 |
| 会话控制 | 最新 **{latest_session['tests']}** 项测试通过；包括双方同意、竞技、AI 身份、暂停、悔棋、重开、失败读档、启动恢复、终局竞争、关闭与跨会话旧句柄拒绝 |

状态核对包含棋盘、阶段、执色映射、提子数、行动数、落子数、全部候选及形成／到期时刻、连续停手、结果、棋盘历史摘要与命令数。它不只比较最终胜方。

448 种配置分别覆盖开局、可达边角提子、自杀、非法状态保持、单劫与完整六手三劫循环、撤销分支、确认期限、双方候选、提子反成五、断线重计、换线、长连新旧窗口、双停、从空盘形成的被迫停手和整体悔棋、认输及记录拒绝。

## 本轮发现并修复的最小边界差异

初次交叉核对发现：即时胜利的一步若同时连成六子，字符串式候选编号可能与数值坐标排序选出不同的展示五子组，胜方相同。现已统一按数值坐标排序。

11 手即可从空盘复现：黑 I1、白 A1、黑 H2、白 A3、黑 G3、白 A5、黑 E5、白 A7、黑 D6、白 A9、黑 F4。最后一步形成六连；现在统一选择 I1–E5 的连续五子作为即时胜线。最小棋谱保存在 `fixtures/immediate-six-regression.json`，并覆盖四种棋盘、两种方向和两种颜色。

默认延迟四手的换线案例也由正式核心验证：同组五子模式第 23 手才胜，可选继承模式第 21 手胜。演示命令 `node examples/core-demo.mjs` 可以直接运行并重放两局。

## 会话接入要点

实时界面须经 GameSession 提交玩家操作；纯核心的悔棋函数只负责恢复数据，不代表已经取得同意。外部棋谱的同意字段也不等于实时授权。

后台任务保留原始句柄后再提交结果；宿主另行停止实际后台计算。本层已确保过期结果无法落子，尚未实现真正的 AI 棋力。启动恢复用 restoreSession；活跃双人对局不能通过直接重开或读档绕过结束／取消流程。

## 尚未完成及下一步

- **P3 网页双人界面尚未制作**：棋盘、设置、触摸、真实同意弹窗、自动保存和帮助需要接入本核心。
- Windows 真机运行、离线游戏和发行 .exe 仍在 P4。P1 小样只证明构建路径，不能当作真实 Windows 游戏验收。
- AI 搜索与响应时间在 P5；本轮只测试任务提交机制。
- 胜率平衡在 P6；随机模拟和规则对照不能证明五五开。

本轮没有替换已发布的旧网页版或旧桌面版。对照 Python 模型与正式引擎的规则版本标识、文件格式不同，测试适配器只做显式映射，正式导入不静默接收审查模型文件。

冻结规则副本保留修订 3 当时的阶段描述；当前实现进度以本报告和更新后的工作框架为准。规则正文未改变，基准 SHA-256：`{rules_sha}`。
'''
report_path=OUT/'弈合_P2核心引擎验收报告.md';report_path.write_text(report,encoding='utf-8')

framework=f'''# 弈合 · 重做工作框架（执行版 v0.2）

更新日期：2026-10-20。当前阶段：**P2 核心引擎已完成；下一步 P3 网页本地双人版。**

## 目标和已确认规则

保留围棋吃子与五子连线获胜，最终交付可直接游玩的网页版、Windows 版和中文手册。本地双人必做，人机可选。规则细节以《弈合_规则2.1与公平性调整表》**修订 3／2.1.0-r3** 为准；旧框架和 P1 的 2.0.0 规则、48种组合不再作为实施依据。

| 设置 | 当前基线 |
| --- | --- |
| 棋盘 | 9、13、15、19 路自选，默认 9 路 |
| 开局 | 三手换色默认开；A 黑白黑三子不能提子，B 选色后白走；可关闭 |
| 提子 | 正交棋块与气；同时提子后检查己气；自杀非法、提子不加走 |
| 连线 | 默认两条对角线，可选四方向；五子以上双方均有效 |
| 计时 | 默认同一组连续五子独立计时、延迟 4 手；可选 0、2、4、6、8、10、12；换线继承默认关闭、可开启 |
| 禁重复 | 默认 PSK，可关闭；停手例外，初始空盘和开局布局入历史 |
| 停手 | 可主动停手；无合法落点自动停手；无候选双停和棋，有候选继续计时，先结算胜利 |
| 悔棋和结束 | 双人休闲双方同意，一条命令及自动动作整体撤回；竞技与终局后禁用；正式对局任一方随时可认输 |
| 对局形式 | 单局为基本单位；多局赛前约定，不强制两局配对，不加入贴目／围地／吃子数胜利 |

规则整局固定，六连按连续五子组分别计时。换线继承为明确互斥选项，不与固定五子计时同时执行。本版不提供旧“无棋可下判负”等未定义混搭；无对应旧引擎时拒绝旧棋谱。

## 阶段与验收

| 阶段 | 状态 | 产物与通过条件 |
| --- | --- | --- |
| P0 框架 | 已完成，随实施维护 | 本文及阶段、模块、验证约定 |
| P1 规则与封装可行性 | 规则已完成；构建有记录，Windows 真机运行仍待补 | 最新规则修订 3、审查与修复资料；P1 Electron 最小小样不等于游戏已在 Windows 验收 |
| P2 核心 | **本轮完成** | TypeScript 共享核心、会话基础、类型声明、配置矩阵、几何独立核对、跨语言回放；本轮 {distinct} 个不同 Node 用例通过，448 配置的 {matrix['passed']:,} 项适用检查通过，{stats['state_comparisons']:,} 次状态比较一致 |
| P3 网页本地双人 | **下一步** | 响应式棋盘、设置、状态、双方同意、查气、保存恢复和规则说明；独立完成开局至终局，刷新恢复与损坏导入不丢当前局 |
| P4 两端交付与实测 | 待实施；Windows 真机验收未完成 | 浏览器与触摸实测、Windows 构建与真实运行、离线、中文路径、缩放和保存；两端同棋谱一致 |
| P5 可选人机 | 待实施 | 复用核心的合法搜索、两档难度、开局与选色、后台可中断；不阻塞双人交付 |
| P6 公平性 | 方案已有，实测待开展 | 分尺寸、延迟、方向、计时方式和角色统计；同策略交换角色；随机对局不作为公平证明 |
| P7 发行整理 | 待实施 | 正式网页、Windows 包、中文手册、源码、构建说明、验证和已知限制 |

P1 中暂缺 Windows 环境不阻断已明确规则的 P2／P3；Windows 完成状态必须保留真实运行门槛。所有阶段按产物与证据推进，不能把能编译、截图或交叉构建视作真实产品验收。

## 模块与依赖

| 位置 | 职责与当前状态 |
| --- | --- |
| packages/core | 已实现；纯规则、阶段、候选、历史和棋谱；不读 DOM、磁盘、时钟、随机数或网络 |
| packages/session | 已实现基础；玩家控制、同意、竞技、暂停、任务失效、保存与恢复数据；平台能力由宿主提供 |
| packages/ui | P3；只展示稳定状态和发送会话命令，不另写判胜或提子 |
| apps/web | P3；浏览器入口与存储，复用核心和会话 |
| apps/desktop | P4；桌面壳与文件适配，复用同一核心与主要界面 |
| packages/ai | P5；合法后继和有限搜索均调用核心，不复制规则 |
| tests／reports／docs | 已建立当前版本的测试、原始结果、接口与阶段资料；后续随改动维护 |

依赖方向为“界面／平台 → 会话 → 核心”，AI 也依赖核心。规则标识、默认值与 448 个配置由同一份定义产生。TypeScript 生成 ESM 与真实 `.d.ts`；P1 的固定81点接口保留为历史材料。

## 事务与记录约定

一条玩家命令及全部连带自动停手构成完整事务，界面不能提交中间状态。顺序为合法性与同时提子、提交动作数、取消无效候选、结算旧到期候选、新建候选／0手判胜、停手和棋与自动轮转。候选按固定五子组或颜色分别保存，不能简化为一个公共倒计时。

Match 只能由核心创建且不可变。棋谱带 schemaVersion、规则版本、完整配置与显式命令，完整重放校验；不从最终棋盘、候选或提子数直接恢复。历史按当前分支恢复，悔棋不能残留旧分支的 PSK 限制。自动停手不单独写成玩家命令。

保存数据与实时会话分开。存档保存规则棋谱、控制者与竞技设置；任务、共同同意和提示授权不从外部字段恢复。导入失败保留当前局和原文件。P3 的自动保存失败须提示并保留导出入口。

## 会话与异步

双人悔棋、开局取消和着法提示须真实对方同意，竞技按禁用约定。开局取消不能由单方看过布局后直接重开；正式对局认输可在对方行动或弹窗期间生效。终局后只读复盘或新局，不能悔棋改判。人机练习按一条显式命令悔棋，不隐式撤回双方一轮。

每次状态或任务变更增加会话 revision；悔棋使 ply 下降也不回退 revision。任务绑定 matchId、revision、taskId、kind、actor 和原始句柄；重开、悔棋、读档、暂停、终局或关闭后旧结果不能提交。宿主还须真正中断后台计算释放资源。

首次恢复用 restoreSession。活跃人类双人局不得通过 newGame／loadSave 绕过结束或同意取消流程；练习可直接重置。新对局标识不复用，控制者绑定真实 A/B 身份，不随选色互换。

## P3 下一步清单与停止点

1. 制作适配桌面与手机的棋盘，支持多尺寸与明确坐标；当前玩家、执色、候选剩余手数、计时方式和方向始终可见。
2. 设置采用推荐预设与明确可选玩法，开局前确认，游戏中更改仅用于新局；不引入旧规则混搭。
3. 接通三手摆局、选色、合法／非法反馈、提子动画、五连候选、主动停手、认输与终局。
4. 通过会话接口接入悔棋、取消和提示同意；查看棋块与气、序号、规则说明是只读辅助，不推进计时。
5. 接入浏览器保存、刷新恢复、导出导入；故障与未知版本不覆盖当前对局。
6. 用 P2 相同棋谱验收 UI 结果，再检查真实浏览器、键盘、点击和触摸；明确记录实际环境。

本轮停在 P2 完成点，未提前制作 P3 界面，未替换旧站或旧桌面发行。P3 完成后再进行 P4 平台验收。

## 公平性与发行原则

保留单局玩法，研究时可以配对交换摆局／选色角色；按棋色、真实玩家、角色、和棋与截断分开记录。不同棋盘、延迟、方向和计时方式不合并宣布平衡；策略、预算与种子可复现。随机策略接近五五开不证明公平，观察上限列截断。

发行必须同时给出网页、Windows 形式、中文手册、源码构建说明、规则版本与实际运行记录。手册包含一页快速开始、提子与五连图例、选项、换色、停手、悔棋和保存；图例来自实际引擎测试。缺失 AI、未验证平台或不足的公平性证据准确标注。

每次后续改动先留下最小复现，再修相应模块并运行受影响检查；规则变化同步更新版本、接口、测试和文案。已经通过且未受影响的检查不无目的重跑。完整 P2 证据见《弈合_P2核心引擎验收报告》和源码包 reports 目录。
'''
framework_path=OUT/'弈合_重做工作框架.md';framework_path.write_text(framework,encoding='utf-8')

paths=[ROOT/'package.json',ROOT/'package-lock.json',ROOT/'tsconfig.json',ROOT/'README.md']
for directory in ['packages','dist','tests','fixtures','scripts','docs','reports','examples']:
    paths.extend(p for p in (ROOT/directory).rglob('*') if p.is_file() and '__pycache__' not in p.parts
                 and p.suffix not in ('.pyc',) and p.name not in ('manifest.json',))
paths=sorted(set(paths))
manifest={str(p.relative_to(ROOT)):hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}
(ROOT/'reports/manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
paths.append(ROOT/'reports/manifest.json')
archive=ROOT.parent/'弈合_P2核心引擎与测试包.zip'
with zipfile.ZipFile(archive,'w',zipfile.ZIP_DEFLATED) as z:
    for p in paths:z.write(p,'qiline-rebuild/'+str(p.relative_to(ROOT)))
with zipfile.ZipFile(archive) as z:
    assert z.testzip() is None
    for name,sha in manifest.items():assert hashlib.sha256(z.read('qiline-rebuild/'+name)).hexdigest()==sha
print(json.dumps({'report':str(report_path),'framework':str(framework_path),'archive':str(archive),
 'archive_bytes':archive.stat().st_size,'files':len(paths),'distinct_tests':distinct,'cross_states':stats['state_comparisons']},ensure_ascii=False))
