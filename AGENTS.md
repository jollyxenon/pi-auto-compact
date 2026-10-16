# Project Instructions

## Scope

本仓库实现 Pi 扩展 `pi-auto-compact`。保持实现围绕分层压缩、原文取回和 Pi 生命周期，不加入与上下文管理无关的功能。

## Commands

```bash
npm test
npm run typecheck
npm pack --dry-run
```

## Invariants

- 自动压缩第一次从当前可见 session context 中第一条参与 LLM context 的**非 system** 消息开始（`role: "system"` 是 Pi 的 prompt state，永不作压缩目标），以后从该分支的保留指针开始；系统提示词、AGENTS.md、工具描述和 Skill 描述由 Pi 单独管理，不属于 session entry。
- 触发与保留窗口沿用 Pi 原生压缩的 token 模型：`reserveTokens` 与 `keepRecentTokens` 都是绝对值。前者按 Pi 的 `shouldCompact (contextTokens > window - reserveTokens)` 判触发，后者用 Pi 的 `estimateTokens` 累计，保留段起点直接用 Pi 的 `findCutPoint`（有效切点、绝不切在 `toolResult`、扫描回退纯元数据 entry）。不再有“窗口百分比”保留预算，也不把 provider 口径的占用和 chars/4 口径的 entry 记账放进同一次比较。
- `CompactBlock` 不可变，只记录 `startEntryId` 与 `endEntryId`，不记录或核验区间内 Entry ID 序列；高层块保留创建时的直接子块引用，低层块不删除。节点身份由其有序 level-1 叶子序列决定；再次形成相同叶子序列时复用旧块，不重新摘要。每个新块在同一次摘要请求中生成单行 `overview` 和详细 `summary`；`overview` 只用于块树检查，不进入模型上下文卡片。
- 当前活动顶层块从首块头到末块尾构成压缩区；块内部和块间后来插入的普通消息一律丢弃，不后移、不进入 `REFERENCE_CONTEXT`，但 `role: "system"` 的 prompt state 始终原样保留在投影中（Pi 用 compaction entry 回放系统提示词，插件没有该机制，只能原样保留）。压缩区外的注入消息照常保留。消息投影按完整 entry 区间定位其中实际存在的消息；首尾 entry 可以不产生模型消息，不得因此漏掉整个块。
- `topLevelBlockIds` 与 `childBlockIdsByParent` 只表示当前稳定树投影；其他分支块不能参与当前分支重平衡。分支前沿索引保存各活动路径的根前沿和内部子前沿选择，不改变块仓库的不可变性。
- `blockMergeThreshold = k` 表示出现第 `k + 1` 个连续同级块后合并最旧 `k` 个。
- 摘要、全部连锁提升和 sidecar 写入成功后才能替换内存状态。
- 摘要通过当前注册提供方的 `streamSimple` 继承 `ctx.thinkingLevel`，认证、请求构造与压缩状态机分离；使用 Pi 的 `retryAssistantCall` 和受信任设置中的重试策略，不另写错误分类或双层重试。请求及重试等待共用操作取消信号，终止摘要与未完成输出不得提交。
- 摘要提示词按原始位置携带真实图片块，只有当前模型不支持图片时才退化为 `[image <mime>, about <大小>KB omitted]` 占位符；`context_get` 文本始终用占位符，base64 不进任何提示词。不产生模型消息的 entry（`custom` 展示记录、`model_change`、`thinking_level_change` 等）不是摘要素材：它们仍留在块的头尾区间内供 `context_get` 取回，但正文 JSON 不进入 `TARGET_RANGE` 或 `REFERENCE_CONTEXT`。`system` 消息同理：只算 prompt state，不计入可压缩对话，也不进入 `TARGET_RANGE` 或 `REFERENCE_CONTEXT`。entry token 记账走 Pi 的消息投影（`sessionEntryToContextMessages` + `estimateTokens`，排除 `system`）。摘要请求预算按实际提示词内容用偏保守的提示词估算（CJK 约每字一 token，其余约每三字符一 token），不沿用 Pi 对拉丁文本的 chars/4 口径，减少窗口校验放行实际超窗请求的机会；该估算仍是启发式近似，不保证与提供方分词器一致。
- 摘要选段预算与实际请求共用 `summaryOutputTokenLimit`；较小的 level-1 卡片预算不能缩小真实输出预留。提供方附加的思考预算必须纳入输出上限，输入预算保留 Pi 适配器余量。调试日志记录模型、有效思考等级、token 估算、尝试次数、耗时和错误，不主动记录提示词、正文或认证信息。
- `REFERENCE_CONTEXT` 与 `TARGET_RANGE` 不重复，二者合起来覆盖摘要所需当前上下文。
- 压缩块禁止 `Goal`，完整卡片不得超过 `blockTokenCeiling`，摘要不得硬截断。
- `context_get` 必须校验当前活动分支并分页；`rawEntryJson` 保留完整 Pi `SessionEntry` 字段。
- 自动扫描使用 Pi 当前可见 entry；原生 `compaction` 与插件展示快照既不作目标，也不进入 `REFERENCE_CONTEXT`。完整 branch 仅用于分支校验和原文取回。无论上下文是否已超窗口，自动扫描都从保留指针开始按摘要请求真实预算逐段推进，没有指针时从最早未压缩内容开始；每个新块都会成为后续段的参考上下文。
- `context` 事件和异步摘要提交必须校验当前会话路径未发生变化；校验用完整路径，不把插件自己的展示追加当成会话切换。
- 原生 `compact` 不做插件失败时的回退：`session_before_compact` 在插件安装期间始终返回 `{ cancel: true }`，包括压缩失败、没有可提交状态和关闭插件自动压缩时；关闭自动压缩只停止插件阈值扫描，不放行原生压缩。压缩进行中 `tree`/`fork`/`clone`/`new`/`resume` 被取消，`/reload` 在输入层被拦截。
- 插件维护单一活动压缩操作；每次操作有独立的插件级 `AbortController`，与 Pi 提供的 `ctx.signal`/`event.signal` 合并，确保 Esc、session_shutdown（quit/reload/new/resume/fork）和会话中断都能取消摘要请求。取消只返回 `skipped`，不提交部分状态。
- 压缩沿一条连续前缀推进。`firstKeptEntryIdByBranch` 与 `topLevelBlockIdsByBranch`、`childBlockIdsByParentByBranch` 使用同一活动路径锚点，一次解析同时得到前沿和保留指针；前缀必须从最早的可压缩 entry 开始连续覆盖到指针之前（前导的 prompt state 与纯元数据 entry 可以留在前缀之外），前部存在未压缩的对话空隙时报告原因并保留原文，不以末块末尾作为前缀终点，也不从旧展示记录之后起步。
- `compact_context` 的 `startId` 必须是保留指针所在的第一条未压缩对话 entry；跳过更早未压缩原文会被拒绝并提示应使用的起点，前导只产生 prompt state 或元数据的 entry 可以显式指定。
- 展示快照用 `pi.appendEntry()` 写入 `custom` entry（`auto-compact-snapshot`），用 `registerEntryRenderer()` 渲染；它不进入模型上下文、摘要目标、参考材料和 token 记账，也不参与状态恢复，不能替代 sidecar。发送的顶层卡片与保留指针都未变化时不重复追加；仅调整块树内部结构而顶层投影不变时，也不重新发一份相同摘要。
- `appendSnapshot()` 只能在最后一次真实会话路径校验之后调用。`context` 路径先确认路径未变并构造好本次请求的新投影，再追加展示 entry 并刷新本地 leaf 缓存，然后返回已构造的消息。不能因为这次自追加把当前请求当成会话切换，也不能删除真实会话变化校验。
- 自动和手动压缩都必须报告 token 进度；完成状态包含最新块信息。footer 的上下文占用按 Pi 的口径估算：优先信任最后一条 assistant usage，只对之后的消息追加 `estimateTokens`；当出现 `context_edit` 或已提交的展示快照（相当于 Pi 的 compaction 失效标记）时该锚点失效，改为对当前投影整体估算。不得再用单调累加的 overhead 去掩盖原生与估算之间的口径差。

## Pi Compatibility

改扩展接口前先查本机 Pi 文档：

```text
/home/xenon/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs
```

核心 Pi 包和 `typebox` 保持在 `peerDependencies`；不要把本机绝对路径放入运行时依赖。
