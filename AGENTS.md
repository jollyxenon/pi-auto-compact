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

- 自动压缩从当前可见 session context 中第一条参与 LLM context 的消息开始；系统提示词、AGENTS.md、工具描述和 Skill 描述由 Pi 单独管理，不属于 session entry。
- `CompactBlock` 不可变，只记录 `startEntryId` 与 `endEntryId`，不记录或核验区间内 Entry ID 序列；高层块保留创建时的直接子块引用，低层块不删除。节点身份由其有序 level-1 叶子序列决定；再次形成相同叶子序列时复用旧块，不重新摘要。每个新块在同一次摘要请求中生成单行 `overview` 和详细 `summary`；`overview` 只用于块树检查，不进入模型上下文卡片。
- 当前活动顶层块从首块头到末块尾构成纯净压缩区；块内部和块间后来插入的消息一律丢弃，不后移、不进入 `REFERENCE_CONTEXT`，压缩区外的注入消息保留。消息投影按完整 entry 区间定位其中实际存在的消息；首尾 entry 可以不产生模型消息，不得因此漏掉整个块。
- `topLevelBlockIds` 与 `childBlockIdsByParent` 只表示当前稳定树投影；其他分支块不能参与当前分支重平衡。分支前沿索引保存各活动路径的根前沿和内部子前沿选择，不改变块仓库的不可变性。
- `blockMergeThreshold = k` 表示出现第 `k + 1` 个连续同级块后合并最旧 `k` 个。
- 摘要、全部连锁提升和 sidecar 写入成功后才能替换内存状态。
- 摘要通过当前注册提供方的 `streamSimple` 继承 `ctx.thinkingLevel`，认证、请求构造与压缩状态机分离；使用 Pi 的 `retryAssistantCall` 和受信任设置中的重试策略，不另写错误分类或双层重试。请求及重试等待共用操作取消信号，终止摘要与未完成输出不得提交。
- 摘要选段预算与实际请求共用 `summaryOutputTokenLimit`；较小的 level-1 卡片预算不能缩小真实输出预留。提供方附加的思考预算必须纳入输出上限，输入预算保留 Pi 适配器余量。调试日志记录模型、有效思考等级、token 估算、尝试次数、耗时和错误，不主动记录提示词、正文或认证信息。
- `REFERENCE_CONTEXT` 与 `TARGET_RANGE` 不重复，二者合起来覆盖摘要所需当前上下文。
- 压缩块禁止 `Goal`，完整卡片不得超过 `blockTokenCeiling`，摘要不得硬截断。
- `context_get` 必须校验当前活动分支并分页；`rawEntryJson` 保留完整 Pi `SessionEntry` 字段。
- 自动扫描使用 Pi 当前可见 entry；原生 `compaction` 既不作为目标，也不进入 `REFERENCE_CONTEXT`。完整 branch 仅用于分支校验和原文取回。无论上下文是否已超窗口，自动扫描都从最早未压缩内容开始按摘要请求真实预算逐段推进；每个新块都会成为后续段的参考上下文。
- `context` 事件和异步摘要提交必须校验当前会话路径未发生变化。
- 插件维护单一活动压缩操作；每次操作有独立的插件级 `AbortController`，与 Pi 提供的 `ctx.signal`/`event.signal` 合并，确保 Esc、session_shutdown（quit/reload/new/resume/fork）和会话中断都能取消摘要请求。取消只返回 `skipped`，不提交部分状态。
- 原生 `compact` 不做插件失败时的回退：`session_before_compact` 在插件启用时始终返回 `{ cancel: true }`，即使插件压缩失败或没有可提交状态。压缩进行中 `tree`/`fork`/`clone`/`new`/`resume` 被取消，`/reload` 在输入层被拦截。
- 自动和手动压缩都必须报告 token 进度；完成状态包含最新块信息。footer 的上下文占用必须基于插件实际投影，而不是未压缩 session 原文。

## Pi Compatibility

改扩展接口前先查本机 Pi 文档：

```text
/home/xenon/.local/share/fnm/node-versions/v24.16.0/installation/lib/node_modules/@earendil-works/pi-coding-agent/docs
```

核心 Pi 包和 `typebox` 保持在 `peerDependencies`；不要把本机绝对路径放入运行时依赖。
