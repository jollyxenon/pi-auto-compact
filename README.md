# pi-auto-compact

面向长程 Pi Agent 会话的分层上下文压缩插件。插件在每次模型请求前检查上下文占用，把已完成的旧回合替换成短摘要块，同时保留 Pi session 中的全部原始 entry，可通过 `context_get` 分页取回。

## 行为

- 在工具调用后的下一次模型请求前自动压缩，不中止正在执行的工具；可在 `/auto-compact-config` 中关闭自动压缩。
- 安装并加载后，通过 `session_before_compact` 取消 Pi 原生压缩，不修改 `settings.json`。唯一例外：上下文已经溢出且插件自身没有任何产出（报错、跳过或状态为空）时，放行原生压缩作为兑底。
- 第一次压缩生成 level 1 块；`/auto-compact` 会在一次原子操作中反复处理当前可见上下文中所有尚未压缩、且位于受保护尾部之前的完整区间。
- `blockMergeThreshold = k` 时，同一连续层级出现第 `k + 1` 个块后，最旧的 `k` 个块提升为一个更高层块。
- 高层块只引用直接子块；低层块和原始 session entry 不删除。
- `maxBlocks` 只约束一次操作完成后的稳定顶层投影；生成、连锁提升和持久化作为一次原子操作。
- 所有自动与手动压缩操作都会在编辑器上方显示实时 token 进度条；操作结束后原位置显示“压缩完成”和最新压缩块 ID、层级。失败时保留失败状态和已完成进度。
- 插件接管 Pi footer 的上下文占用字段，按实际发送给模型的压缩后投影重新计算 `xx%/context_limit`；累计 token、费用、目录、分支和模型信息仍保留。
- 会话的第一条 user entry 作为原始目标保留，不进入压缩块。摘要校验也拒绝 `## Goal`。
- 最近上下文由 `keepRecent` 保护，自动压缩不会触碰当前未完成尾部。
- 恢复已有会话时，`/auto-compact` 会从当前可见上下文的最早可处理位置重新扫描，并模拟沿 context 前进的过程：先压缩最早能放入摘要请求的完整区间，生成的块随后作为参考上下文继续处理后续区间，直到保护尾部之前没有未压缩内容。已经存在的 Pi 原生 `compaction` 只作为当前上下文中的参考摘要，不会再次作为目标范围压缩。

## 安装

从当前目录安装：

```bash
pi install /home/xenon/pi-auto-compact
```

临时试用：

```bash
pi -e /home/xenon/pi-auto-compact
```

修改代码后，在 Pi 中执行 `/reload`。

## 配置

全局配置文件：

```text
~/.pi/agent/auto-compact.json
```

项目配置文件（仅在项目受信任时读取，并覆盖全局值）：

```text
<project>/.pi/auto-compact.json
```

示例：

```json
{
  "enabled": true,
  "trigger": { "mode": "percent", "value": 0.85 },
  "keepRecent": { "mode": "tokens", "value": 20000 },
  "blockTokenCeiling": 2000,
  "blockMergeThreshold": 3,
  "maxBlocks": { "enabled": true, "value": 4 },
  "defaultPageSize": 4000,
  "maxPageSize": 16000,
  "minNetGainTokens": 256,
  "debug": false
}
```

`trigger` 和 `keepRecent` 均支持：

```json
{ "mode": "tokens", "value": 80000 }
```

或：

```json
{ "mode": "percent", "value": 0.8 }
```

配置加载时校验，无效值直接报错：`blockTokenCeiling`、`defaultPageSize`、`maxPageSize`、`minNetGainTokens`、`blockMergeThreshold` 和 `maxBlocks.value` 必须是正整数；`enabled`、`maxBlocks.enabled`、`debug` 必须是布尔值；`trigger` 与 `keepRecent` 单位相同时，`keepRecent.value` 必须小于 `trigger.value`。项目配置里的 `maxBlocks` 按字段合并：只写 `{ "value": 8 }` 不会丢失全局的 `enabled`。

修改配置后执行 `/auto-compact-config`，插件会打开键盘交互设置面板。关闭 `自动压缩` 后，插件不再响应上下文阈值和溢出事件；已有压缩块仍会继续投影，`/auto-compact`、`compact_context` 和 `adjust_context_blocks` 等手动操作仍可用。使用上下键移动；单位、开关等选项用空格或 Tab 切换；数值可以用 Tab 在预设之间切换，也可以直接输入数字；自定义数字不会加入预设，下一次按 Tab 会回到预设值。Enter 或 Ctrl+S 保存全部修改，Ctrl+C 或 Esc 退出且不保存。启用 `debug` 后，插件会把运行时会话切换、上下文投影、压缩进度和结果写入 Pi 的 `~/.pi/agent/pi-debug.log`；关闭时不写入这些日志。

## 输入框命令

- `/auto-compact`：从当前可见上下文的最早可处理位置重新扫描，把目标 entry 之后、受保护尾部之前的所有尚未压缩完整区间逐块处理；已有压缩块会先参与稳定和升层。完整操作成功后才提交状态。
- `/auto-compact-blocks`：以当前活动分支的顶层块为根，交互式展示当前使用的完整压缩块树。每个块显示 ID、层级和生成时保存的一句话概述；使用上下键浏览、左右键折叠或展开、Enter 打开操作、Esc 退出。可拆开任意可见高层块，让它当前选中的子块在原父节点下就地展开；也可把同一父节点下连续、同级的兄弟块合并。level-1 是固定叶子，不在树编辑器中继续拆分。高层节点由它覆盖的有序 level-1 叶子序列识别：只改内部树边不会重做祖先摘要；再次组合出已有叶子序列时直接复用仓库中的旧块，不调用摘要模型。
- `/auto-compact-config`：交互式调整 auto-compact 配置。`自动压缩` 控制是否响应上下文阈值和溢出事件；关闭后仍可使用手动压缩命令和工具。百分比/绝对值与对应数值是分开的设置项；空格或 Tab 切换单位、开关和预设值，直接输入可填写自定义数值，Enter/Ctrl+S 保存，Ctrl+C/Esc 取消。`运行时调试日志` 控制是否写入 Pi 的 `~/.pi/agent/pi-debug.log`。

## 工具

### `compact_context`

在尚未达到自动触发线时，把指定的完整历史区间压成 level 1 块：

```json
{
  "startId": "entry-start",
  "endId": "entry-end",
  "focus": "优先保留失败原因和已修改文件"
}
```

范围不能包含目标 entry、已有顶层块或当前未完成尾部。

### `adjust_context_blocks`

提前把 2 到 `blockMergeThreshold` 个相邻、同级、顶层块合并。若仓库中已有相同有序叶子序列的块，则直接复用已有摘要：

```json
{
  "blockIds": ["ac_000001", "ac_000002"],
  "focus": "合并重复结论"
}
```

### `context_get`

按块读取原始内容：

```json
{
  "blockId": "ac_000004",
  "maxTokens": 4000
}
```

返回 `Truncated: true` 时，用 `Next cursor` 继续：

```json
{
  "cursor": "acur_...",
  "maxTokens": 4000
}
```

默认不展开历史 thinking。需要时设置：

```json
{
  "blockId": "ac_000004",
  "includeThinking": true
}
```

需要完整 Pi `SessionEntry` 字段（包括 thinking、图片、details、usage 和 provider 元数据）时设置：

```json
{
  "blockId": "ac_000004",
  "rawEntryJson": true
}
```

也可以使用 `startId` 与 `endId` 精确读取当前活动分支中的 entry 区间。

## 摘要边界

每次摘要请求分为两个互不重复的区域，二者在请求预算允许时合起来覆盖摘要所需的当前投影：

- `REFERENCE_CONTEXT`：目标范围之外的会话目标、其他历史块、近期原文和其他扩展注入消息，只用于理解术语和因果。对于已经超过模型窗口的会话，插件按完整 entry 或完整块卡片缩小这一部分；原始完整内容仍保留在 session JSONL 中。
- `TARGET_RANGE`：本次唯一允许写入摘要的来源。目标范围本身不会被硬截断；如果最小完整区间仍无法放入摘要请求，整次自动操作失败并保持旧状态。

摘要采用固定输出协议：模型先生成不超过 200 字符的一句话概述，供 `/auto-compact-blocks` 的树视图显示；随后生成 `Constraints & Preferences`、`Progress`、`Key Decisions`、`Next Steps`、`Critical Context` 和文件索引组成的详细 Markdown 摘要。两者在同一次模型请求中生成，概述只写入块元数据，不进入投影给模型的块卡片。完整可见卡片必须不超过 `blockTokenCeiling`；第一次输出不合格时重写一次，仍不合格则整次操作回滚。插件不会硬截断摘要。

## 状态与故障语义

块元数据保存在 session 文件旁的：

```text
<session>.autocompact.json
```

原始消息仍在 Pi 的 append-only session JSONL 中。当前 sidecar schema 为 3；旧 schema 升级后会按无效旧结构隔离为 `.corrupt-<时间戳>`，再从空状态重建。sidecar 使用临时文件加 rename 写入；同时按活动路径保存顶层前沿和每个父节点当前选中的子前沿，切换分支时不会让其他分支参与当前投影或树结构。写入、摘要或任一级提升失败时，当前内存投影保持不变。sidecar 无法解析或结构校验失败（缺少字段、块 ID 重复、子块引用不存在、序号回退）时，原文件重命名为 `<session>.autocompact.json.corrupt-<时间戳>` 留存排查，插件从空状态重建。

插件取消 Pi 原生压缩，但如果上下文已经溢出且插件自身没有产出任何压缩状态（例如摘要失败），会放行 Pi 原生 overflow compaction 作为兑底，避免会话卡死。若配置让受保护尾部本身接近或超过模型窗口，自动压缩将找不到可处理区间；此时应降低 `keepRecent` 或 `trigger`，再执行 `/auto-compact-config`。

## 开发

```bash
npm test
npm run typecheck
npm pack --dry-run
```
