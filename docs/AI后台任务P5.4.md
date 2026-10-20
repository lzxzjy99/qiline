# AI 后台任务 · P5.4

2026-10-20 完成。规则仍为 `2.1.0-r3`，P2 规则与会话源码和产物均未改动。本阶段实现后台运行和任务生命周期；P5.5 再加入可直接游玩的人机入口。

## 运行方式

每条 AI 显式命令创建一个新的模块 Worker。Worker 安装监听器后发送严格的 `{protocolVersion:1,kind:"ready"}`，主线程才发送完整请求。Worker 重放棋谱并调用 P5.3 的 `runSearch`，仅回传协议 reply，不发送内部搜索诊断。主线程保留原始任务令牌，重验身份、版本与动作后提交。

结果提交、暂停、任务作废、故障或超时后，调度器移除监听器、清空所有调度定时器并调用 `terminate()`。线程同时在发送结果后自行关闭。旧回调、重复结果和关联字段属于旧任务的消息不能落子。A 连摆三子、B 选白后继续下白，都通过下一次宏任务创建新 Worker，不递归连续操作。

## 生命周期约定

| 操作或情况 | 行为 |
| --- | --- |
| `start()`／`sync()` | 根据真实玩家和 Session 状态调度；重复调用不会重复建任务 |
| `change(() => session.command(...))` | 使用既有 Session 命令；成功后立即处理过期线程，失败则保留原任务 |
| `pause()` | Session 暂停，任务失效，立即终止正在启动或搜索的线程 |
| `resume()` | 清除等待／错误，创建新身份的任务 |
| `retry()` | 仅失败状态可用，显式重新尝试；不会自动反复重试 |
| 悔棋到 AI 回合 | 暂停，`hold: "undo"`，等待手动继续；包括不增加手数的选色悔棋 |
| 悔棋到人类回合 | 允许玩家继续操作 |
| 成功重开／读档 | 终止旧任务，按新 matchId 重新调度；旧结果无效 |
| 认输或终局 | 终止工作，不再自动建立任务 |
| `close()` | 幂等关闭调度器与 Session，终止线程、清空计时器 |
| 构造／消息／结果错误 | 暂停并报告失败，棋局不因错误增加动作 |
| 线程终止抛出异常 | 阻止继续建线程，避免累积无法确认停止的任务；需销毁宿主排查 |

P5.5 的 UI 变更须统一走 `change()`，页面销毁须调用 `close()`。若其他代码直接改变活跃 Session，任务监视器每 50 ms 检查一次，收到消息时也立即检查；主线程有机会执行时会终止过期线程。直接取消当前任务会进入等待，避免刚取消又自动重建。没有活跃任务时，外部直接变更后须显式 `sync()`。

## 两层超时

| 设置 | 默认值 |
| --- | ---: |
| 启动等待，含开始任务与准备请求 | 3,000 ms |
| 简单档搜索预算 | 300 ms |
| 标准档搜索预算 | 1,200 ms |
| 搜索消息与调度宽限 | 250 ms |

启动成功后，用主线程单调时钟设置“搜索预算 + 宽限”的截止时间；默认两档分别为 550／1,450 ms。重复 ready 不延长时间。启动与计算阶段均有独立守护，忽略两阶段间可提前完成的时间时，默认总等待上界为 3,550／4,450 ms。消息即使比延迟触发的守护计时器先被处理，也会检查截止时间，过期后不提交。

P5.3 自身预算耗尽但带合法候选的 `timeout` 可在宿主截止前正常提交；宿主硬超时无可信结果时必须暂停，不能自动停手或认输。启动失败使用 `AI_WORKER_FAILED`，无结果计算超时使用 `AI_NO_RESULT`。

这些是主线程可运行时的调度界限。系统挂起、后台标签页计时器节流、主线程长任务可能推迟实际终止；消息截止检查仍会拒绝过期结果。主要搜索和重放已移到 Worker，但请求导出／结构化复制、最终核心合法性复核和提交仍在主线程，极长棋谱不保证零卡顿。

## 宿主接入

```js
import {createBrowserAI} from './ui/ai-host.mjs';

const created = createBrowserAI(session, state => renderStatus(state));
if (!created.ok) throw Error(created.error.code);
const ai = created.value;
ai.start();

// 示例：玩家操作必须使用已有 Session 权限与规则接口。
ai.change(() => session.submit(humanActor, action));
ai.pause();
ai.resume();
// 宿主销毁时 ai.close()；失败后由用户选择 ai.retry()。
```

`createBrowserAI` 使用 `new Worker(new URL(..., import.meta.url), {type:"module"})`；网页和 Electron 共用模块路径，无网络或模型服务。桌面 CSP 明确允许 `worker-src 'self'`，仍禁止外部连接。Windows 自定义协议的实际 Worker 启动，须在 P5.5 整合并打包后真机验收。

底层 `createAIWorkerController(session, host, limits?)` 可注入 Worker 工厂、单调时钟、计时器及状态观察器，用于测试。观察器异常不改变游戏权限；创建任务与观察器回调的重入也会检查已取消线程，防止遗漏终止。

## 验证与复现

本轮共 3,739 项 Node 自动检查通过，无失败或跳过：

| 检查 | 数量 | 含义 |
| --- | ---: | --- |
| Worker 生命周期矩阵 | 1,792 | 448 种规则 × 两种 AI 身份 × 两档；模拟消息与时钟，采用指定合法动作 |
| 调度与竞态专项 | 29 | 超时、实际终止调用、重复／过期结果、悔棋、读档、故障和回调重入 |
| 真实线程专项 | 3 | 同一 Worker 入口实际搜索；CPU 无限循环与启动阻塞的物理终止；主事件循环保持响应 |
| 接口、战术、搜索、Session、网页和桌面回归 | 1,915 | 含 13 项桌面策略与本地资产检查 |

另在云端 Chromium 中完成 4 项实际模块 Worker 检查：E5 防守与只提交一次、暂停／继续、悔棋等待，以及无限循环线程硬超时后手动重试。无限循环期间主线程产生 28 次 20 ms 心跳；两次 Worker 均终止一次，剩余调度定时器 0。结果截图见 [浏览器验收](../reports/ai-p5-4-browser.jpg)。控制台没有本应用错误；存在浏览器扩展自身的 metadata 通信错误。

```sh
npm run test:worker
node --test tests/ai.test.mjs tests/ai-matrix.test.mjs tests/ai-tactics.test.mjs \
  tests/ai-tree.test.mjs tests/ai-search.test.mjs tests/session.test.mjs \
  tests/restore-session.test.mjs tests/web.test.mjs tests/desktop.test.mjs
npm run check
```

开发浏览器验收先 `npm run build`、`node scripts/build-worker-qa.mjs`，再使用 Sites 管理的预览指向 `build/worker-qa`。独立验收根目录只存在于忽略的 build 目录；`apps/qa` 不复制到产品 dist 或对外游戏入口。

本轮没有重跑 P5.2 完整选点矩阵和 P5.3 预算矩阵，历史结果保留。生命周期矩阵不是 1,792 局真实搜索对战，也不证明棋力或公平性。真实 Windows、实体手机和 Safari 尚待验收；当前产品入口仍为同设备双人，未生成新的 AI Windows 包。下一步为 P5.5 人机练习入口、难度、摆局角色及保存恢复。
