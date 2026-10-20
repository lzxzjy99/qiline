# P2 公共接口 · 2.1.0-r3

编译输出 `dist/core/src/index.js` 与 `dist/session/src/index.js`；相邻 `.d.ts` 为实际源码生成的类型，不再使用 P1 的固定 81 点声明。核心采用 ESM，浏览器与桌面可导入同一份代码。

## 配置

`RuleConfig` 必须完整包含：`rulesVersion`、`boardSize`、`swap3`、`confirmationDelay`、`superko`、`directions`、`claimMode`。默认值见 `DEFAULT_RULES`，全部组合由 `allRuleConfigurations()` 返回。

| 字段 | 支持值 |
| --- | --- |
| rulesVersion | `2.1.0-r3` |
| boardSize | 9、13、15、19 |
| confirmationDelay | 0、2、4、6、8、10、12 |
| claimMode | `fixed-five` 默认；`color-pressure` 可选 |
| swap3 | true／false |
| superko | `positional`／`off` |
| directions | `diagonal`／`four` |

同一 Match 中配置不可变；设置变化用于新局。棋盘为 row-major 的 `0 | 1 | -1` 数组，白为 -1；坐标字母包含 I，`parsePoint` 完整解析 A10／S19。

## 核心调用

```js
import { DEFAULT_RULES, createMatch, activePlayer, applyAction,
  parsePoint, exportRecord, validateRecord } from './dist/core/src/index.js';

const created = createMatch(DEFAULT_RULES);
if (!created.ok) throw new Error(created.error.code);
let match = created.value;
const point = parsePoint('E5', match.rules.boardSize);
if (point.ok) {
  const next = applyAction(match, {
    kind: 'place', actor: activePlayer(match), point: point.value
  });
  if (next.ok) match = next.value.match;
}
const record = exportRecord(match);
const checked = validateRecord(JSON.parse(JSON.stringify(record)));
```

| 方法 | 行为 |
| --- | --- |
| createMatch | 严格验证规则，从空盘创建带来源标记的不可变 Match |
| applyAction | 原子提交一条玩家命令与全部连带自动停手；失败不改变原 Match |
| activePlayer | 当前操作权；摆局 A、选色 B、正式对局按执色映射；结束返回 null |
| getLegalPlacements | 当前阶段全部合法落点；包含提子、自杀、开局禁提子与 PSK 检查 |
| getLegalActions | 指定玩家的操作，默认当前玩家；正式对局非当前玩家仍可认输；不替玩家制造共同同意动作 |
| inspectGroup | 返回同色正交棋块及去重的气；空点返回 null；只读 |
| undoLastCommand | 数据层撤回一条命令及自动停手；无命令和已终局时拒绝；实时使用须经过会话权限 |
| exportRecord | 返回不可变的、可以 JSON 序列化的完整显式命令记录 |
| validateRecord／replayRecord／parseRecord | 校验结构、版本、全部规则与每条命令，全程重放；不能直接信任最终棋盘或候选 |

成功返回 `{ok:true,value}`，失败返回 `{ok:false,error:{code,messageKey,path?,cause?}}`。规则拒绝不是异常；程序内部不变量出错才抛异常。`exportRecord` 要求核心创建的合法 Match。

动作类型为 `place`、`choose-color`、`pass`、`resign`、`cancel-opening`。前三者受轮次约束；认输允许正式对局任一方发起；开局取消须双方同意。命令同时记录真实玩家 A/B，不能用颜色代替身份。自动停手不是玩家命令，不单独导入或撤销。

`Transition.events` 顺序描述落子、提子、候选建立／取消、停手、阶段和结束。动画消费事件；显示状态只使用完整事务后的稳定 `match.state`。不要把中间被迫停手状态作为玩家可操作局面。

`Claim` 保存 `id`、`color`、五个 `points`、`formedAt` 和 `dueAt`；颜色持续模式的 points 为空。候选按形成时间排序，同一形成时刻按颜色及数值坐标排序；同色多个同时到期仍只有一个胜方。UI 可以显示某色最早到期，但不得丢掉其他候选。

`moveLabels` 只在落子时增加，被提走的位置清零。`lastCaptured` 保留最近一次落子的提子位置，经过停手仍保留；逐步提子动画应消费事件而非重复解释高亮。

## 会话接口

`createSession({matchId,rules?,controllers?,competitive?})` 建立实时会话。控制者绑定 A/B 身份，换色不改变控制者。双方初始均无着法提示权限。

| 方法 | 权限或效果 |
| --- | --- |
| submit(actor, action) | 验证真实入口玩家、控制者和命令 actor；不允许直接提交开局取消来伪造双方同意 |
| requestUndo／requestCancelOpening／requestHints | 双人建立对方同意请求，暂停并使任务失效；人机练习可由人类直接操作 |
| respondToConsent | 只有另一名真实玩家可响应当前请求；错误、重复或过期响应无效 |
| disableHints | 任一方可关闭已同意的着法提示；竞技始终禁用 |
| setPaused | 暂停会让旧任务失效；共同同意请求中不能绕过暂停 |
| beginTask | 绑定 matchId、revision、taskId、kind、actor，返回本会话独有的原始句柄 |
| isTaskCurrent／commitAIResult／completeHint | 核验句柄来源及全部字段；AI 命令仍经核心验证；提示不落子 |
| cancelTask／close | 使结果失效；宿主另行中断实际计算，以释放资源 |
| newGame／loadSave | 新对局标识不能复用；人类双人局须先结束或同意取消开局，练习可替换；任何失败不销毁旧局 |
| exportSave | 保存规则棋谱、控制者和竞技设置；不保存有效任务句柄、共同同意或提示授权 |
| restoreSession | 启动时新建会话并完整重放保存数据，不覆盖任何现有活跃双人局 |

会话 revision 在操作、同意、暂停及任务变更中单调增加，悔棋不会让 revision 随 ply 回退。新局和读档也增加当前会话 revision，并换用新 matchId。

任务句柄不可序列化后重新提交。后台计算可以接收字段副本，宿主必须为每一次请求保留其原始句柄；结果到达后用该原始句柄提交。即使宿主误用了相同标识、修订号和 taskId，另一个会话的旧句柄仍会被拒绝。

此层没有 AI 搜索、浏览器存储、文件 I/O 或 UI 弹窗。P3 接入真实同意与保存；P5 接入后台搜索和中断。读取棋谱只证明落子与规则有效，不认证导入字段所声称的人类身份，也不是联网反作弊系统。

## 与旧契约的区别

固定 9 路改为多尺寸；旧确认枚举改为明确偶数延迟与两种计时方式；新增主动停手和开局取消；和棋、取消与胜方分开；终局后禁止悔棋；人机悔棋按一条显式命令处理。旧棋谱无静默迁移，审查模型的 `2.1.0-r3-audit` 文件也不是产品存档格式。
