# pi-auto-compact

面向长程 Pi Agent 会话的分层上下文压缩插件。插件在每次模型请求前检查上下文占用，把已完成的旧回合替换成短摘要块，同时保留 Pi session 中的全部原始 entry，可通过 `context_get` 分页取回。

## 行为

- 在工具调用后的下一次模型请求前自动压缩，不中止正在执行的工具；可在 `/auto-compact-config` 中关闭自动压缩。
- 安装并加载后，通过 `session_before_compact` 取消 Pi 原生压缩，不修改 `settings.json`。插件安装期间原生压缩从不运行：手动 `/compact` 直接拒绝，Pi 的阈值请求（`reason: "threshold"`）只取消、不压缩，因为它的阈值读的是 Pi 的 `settings.json`，照它执行就等于让 Pi 的设置决定插件何时压缩；触发完全由插件在 `context` 事件里的检查负责，`overflow` 是真实超窗，仍执行插件压缩。每个会话第一次忽略原生阈值请求时提示一次：Pi 原生压缩已被接管，Pi 的 `compaction` 设置不生效。关闭自动压缩只停止插件的自动扫描，不放行原生压缩。
- 压缩只沿一条连续前缀推进：第一次从当前可见上下文的第一条参与 LLM context 的非 `system` 消息开始，之后从保留指针开始，绝不跳过中间未压缩内容；发现前部存在未压缩对话空隙时报告原因并保留原文，不以最后一个块尾作为前缀终点。前导的 `system` prompt state 与纯元数据 entry 可以留在前缀之外。
- 触发与保留窗口都由 `{ mode: "tokens" | "percent", value }` 表达：`trigger` 是触发点，`keepRecent` 是保留量。`percent` 是窗口占比（0~1），只在每次请求用当时的 `contextWindow` 换算成绝对值；`context` 事件把插件自己的投影估算与 `resolveTokenLimit(cfg.trigger, window)` 直接比较，不再调用 Pi 的 `shouldCompact`（Pi 只认绝对 `reserveTokens`，无法表达“窗口用到 85% 触发”）。保留段起点用同一估算器重放 Pi 的切点策略。两者都用插件的保守提示词口径（`estimateMessageTokens`：CJK 约每字一 token，其余约每三字符一 token），不再沿用 Pi 的 `estimateTokens` / `findCutPoint`：它的 chars/4 在中文和工具输出上低估 2~4 倍，会让“保留 20000 token”实际留下远超配置的原文。provider 返回的 usage 只在可信时直接采用，不和估算混进同一次比较。
- `blockMergeThreshold = k` 时，同一连续层级出现第 `k + 1` 个块后，最旧的 `k` 个块提升为一个更高层块。
- 高层块只引用直接子块；每个块只记录原始范围的首尾 Entry ID，不保存或核验中间 Entry ID 序列；低层块和原始 session entry 不删除。
- 块的首尾可以是不产生模型消息的 `custom` 等 entry。投影按完整 entry 区间定位其中实际存在的消息，不要求首尾 ID 直接对应模型消息；已有块无需重新摘要即可生效。
- sidecar 是唯一有效状态：块仓库、当前分支前沿和保留指针（`firstKeptEntryIdByBranch`）都保存在其中。每次有效状态变化后，插件在对话末尾追加一条仅供展示的 `custom` entry（`auto-compact-snapshot`），记录当次全部顶层块卡片和保留起点；这条记录不进入模型上下文，也不用于恢复块树或覆盖状态。发送的卡片与保留指针都没变时不重复追加，仅调整块树内部结构也不会重新发一份相同摘要。
- 插件只借鉴 Pi 的“摘要 + 指针”思路，不调用 `ctx.compact()`、不生成原生 `CompactionEntry`，也不通过原生钩子发布摘要。已有原生压缩历史不在本次接管范围：未被插件块覆盖的原生摘要会继续保留，不做全局删除。
- 模型每次只收到一份当前顶层块卡片加保留原文，展示快照无论新旧都不会出现在发送内容、摘要目标或参考材料中。
- 当前活动顶层块从第一个块头到最后一个块尾形成压缩区。该区域只投影块卡片；其他扩展后来插入块内部或块间的普通消息会直接丢弃，不后移，也不进入摘要参考。但 `role: "system"` 的 prompt state 始终原样保留在投影里（Pi 用 compaction entry 回放系统提示词，插件只能保留原文）。压缩区之外的注入消息照常保留。
- 恢复已有会话时，`/auto-compact` 会用同一分支的保留指针继续：先压缩最早能放入摘要请求的完整区间，生成的块随后作为参考上下文继续处理后续区间，直到保护尾部之前没有未压缩内容。已经由块表示的旧前缀不会重新摘要，已经追加的展示快照既不作为目标范围也不进入参考区。
- 所有自动与手动压缩操作都会在编辑器上方显示实时 token 进度条；操作结束后原位置显示“压缩完成”和最新压缩块 ID、层级。失败时保留失败状态和已完成进度。
- 插件接管 Pi footer 的上下文占用字段：优先信任最后一条 assistant usage（provider 口径，直接采用），只对之后的消息追加 `estimateMessageTokens`；出现 `context_edit` 或已提交的展示快照时该锚点失效，改为对投影整体用同一保守口径估算。切换模型后，百分比与窗口上限立即按当前模型更新。累计 token、费用、目录、分支和模型信息仍保留：累计量按 Pi 原生 footer 的全部来源汇总（assistant 回复、`usage` entry、`toolResult.usage`、`branch_summary`/`compaction` usage），并加上插件自己记录的摘要用量。摘要请求的 provider usage 会写成 `auto-compact-usage` 的 `custom` entry，所以压缩开销出现在累计值里；Pi 自己的 `/session` 总额看不到这部分，因为 Pi 只给扩展留了 `pi.appendEntry()`，没有写 `usage` entry 的接口。
- `maxBlocks` 只约束一次操作完成后的稳定顶层投影；生成、连锁提升和持久化作为一次原子操作。
- 最近对话由 `keepRecent` 保护（绝对值或窗口占比），自动压缩不会触碰当前未完成尾部；保留段起点沿用 Pi 的切点策略（有效切点、绝不切在 `toolResult`、扫描回退纯元数据 entry），但用插件的保守口径计量，所以保留的原文量按配置生效，而不是按 chars/4 生效。
- 摘要使用当前会话模型和有效思考等级，通过 Pi 已注册提供方的 `streamSimple` 构造请求；不会因省略参数而把主对话的 `high` 等等级变成关闭思考。摘要仍是独立请求，保留 `cacheRetention: "none"`，不调用主对话的请求修改事件。
- 摘要沿用 Pi `settings.json` 的 `retry.enabled`、`retry.maxRetries` 和 `retry.baseDelayMs`，默认对临时连接、限流和服务端错误最多重试 3 次，间隔为 2、4、8 秒；重试前显示通知。使用 Pi 的错误分类，不对笼统的 400、鉴权或额度耗尽错误盲目重试。只在完整请求层重试，底层 SDK 重试次数固定为 0，避免两层重试相乘。
- 自动压缩从当前可见 session context 中的保留指针开始；系统提示词、AGENTS.md、工具描述和 Skill 描述由 Pi 单独管理，不属于 session entry。主会话系统提示词会作为只读参考传给摘要模型。压缩块的 JSON schema 里没有 `Goal` 字段，所以压缩块在结构上不可能携带 Goal。

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
  "keepRecent": { "mode": "percent", "value": 0.25 },
  "blockTokenCeiling": 2000,
  "blockMergeThreshold": 3,
  "maxBlocks": { "enabled": true, "value": 4 },
  "defaultPageSize": 4000,
  "maxPageSize": 16000,
  "minNetGainTokens": 256,
  "debug": false
}
```

`trigger` 和 `keepRecent` 都是 `{ "mode": "tokens" | "percent", "value": 数值 }`：`tokens` 模式是绝对 token 数，`percent` 模式是**窗口占比**（0~1 的小数）。`trigger` 表示“投影上下文达到多少就开始压缩”，`keepRecent` 表示“最近多少内容保持原文”。默认是 `0.85` / `0.25`，即窗口用到 85% 触发、保留最近 25% 窗口的原文。

百分比不能写死在配置里：窗口随当前模型变化，所以 `percent` 只在每次请求时用当时的 `contextWindow` 换算成绝对值，配置文件中永远只存 0~1 的占比。窗口未知（provider 不报告）时百分比无法换算，本次不压缩。两个值都按插件的保守提示词口径（`estimateMessageTokens`）计量，所以“保留 25% 窗口”指的是插件估算口径的 25%，不是 provider 口径。`blockTokenCeiling` 与 `minNetGainTokens` 是卡片预算和最低净收益。默认 `blockTokenCeiling: 2000` 意味着卡片正文的实际提示词量级不超过约 2000 token（旧口径下同一数字实际放行到约 5400 token），所以如果你希望卡片保持原来的长度，应该把它调到 4000~6000。Pi 的 `settings.json` 里的 `compaction` 设置只在插件未接管前有效，插件启用期间不再决定触发时机或保留量。

两个值要一起看：`keepRecent` 换算出的绝对值必须明显小于 `trigger` 换算出的触发点，否则受保护尾部本身就填满了触发线，压缩找不到可处理区间。

配置加载时校验，无效值直接报错：`trigger`、`keepRecent` 的 `mode` 必须是 `"tokens"` 或 `"percent"`，`value` 必须是正数，且 `percent` 模式下 `value` 不得超过 1；`blockTokenCeiling`、`defaultPageSize`、`maxPageSize`、`blockMergeThreshold` 和 `maxBlocks.value` 必须是正整数；`enabled`、`maxBlocks.enabled`、`debug` 必须是布尔值。项目配置里的 `maxBlocks` 按字段合并：只写 `{ "value": 8 }` 不会丢失全局的 `enabled`。

修改配置后执行 `/auto-compact-config`，插件会打开键盘交互设置面板。关闭 `自动压缩` 后，插件不再响应上下文阈值和溢出事件；已有压缩块仍会继续投影，`/auto-compact`、`compact_context` 和 `adjust_context_blocks` 等手动操作仍可用。使用上下键移动；单位、开关等选项用空格或 Tab 切换；数值可以用 Tab 在预设之间切换，也可以直接输入数字；自定义数字不会加入预设，下一次按 Tab 会回到预设值。Enter 或 Ctrl+S 保存全部修改，Ctrl+C 或 Esc 退出且不保存。启用 `debug` 后，插件会把运行时会话切换、上下文投影、压缩进度和结果写入 Pi 的 `~/.pi/agent/pi-debug.log`；关闭时不写入这些日志。

## 输入框命令

- `/auto-compact`：从当前分支的保留指针继续，把受保护尾部之前所有尚未压缩的完整区间逐块处理；已有压缩块会先参与稳定和升层。完整操作成功后才替换内存状态并追加展示快照。
- `/auto-compact-blocks`：以当前活动分支的顶层块为根，交互式展示当前使用的完整压缩块树。每个块显示 ID、层级和生成时保存的一句话概述；使用上下键浏览、左右键折叠或展开、Enter 打开操作、Esc 退出。可拆开任意可见高层块，让它当前选中的子块在原父节点下就地展开；也可把同一父节点下连续、同级的兄弟块合并。level-1 是固定叶子，不在树编辑器中继续拆分。高层节点由它覆盖的有序 level-1 叶子序列识别：只改内部树边不会重做祖先摘要；再次组合出已有叶子序列时直接复用仓库中的旧块，不调用摘要模型。
- `/auto-compact-config`：交互式调整 auto-compact 配置。`自动压缩` 控制是否响应上下文阈值和溢出事件；关闭后仍可使用手动压缩命令和工具。`触发阈值` 和 `保留最近内容` 各由两行组成：单位行在“百分比 / 绝对值”之间切换，数值行填数字。百分比在面板里按 0~100 输入（配置文件里存的是 0~1 的小数），绝对值按 token 数输入。空格或 Tab 切换开关和预设值，Enter/Ctrl+S 保存，Ctrl+C/Esc 取消。`运行时调试日志` 控制是否写入 Pi 的 `~/.pi/agent/pi-debug.log`。

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

`startId` 必须是当前分支保留指针所在的第一条未压缩对话 entry；跳过更早的未压缩原文、包含已有顶层块或触碰当前未完成尾部的范围都会被拒绝，并提示应使用的起点。前导只产生 prompt state 或元数据的 entry 可以显式指定。

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

工具 schema 显式保留 `required: []`：各参数仍为可选，由工具校验上述查询组合；避免网关将缺失的 `required` 转成 `null` 后报 `Invalid schema for function 'context_get'`。

## 摘要边界

每次摘要请求分为两个互不重复的区域，二者在请求预算允许时合起来覆盖摘要所需的当前投影：

- `reference_above`：目标范围之上只读参考，包含主会话系统提示词与历史压缩块卡片，仅用于理解术语和因果。
- `reference_below`：目标范围之外、当前节点之前未压缩的原始内容与块外注入消息，同样只读、不进入摘要。
- `target_compaction_range`：本次唯一允许写入摘要的来源。目标范围本身不会被硬截断；如果最小完整区间仍无法放入摘要请求，整次自动操作失败并保持旧状态。

上述三部分互不重叠，共同覆盖摘要所需当前投影。对于已经超过模型窗口的会话，插件按完整 entry 或完整块卡片缩小参考区；原始完整内容仍保留在 session JSONL 中。

图片在摘要请求里按原始位置以图片块发送，因此按图片计费而不是按 base64 计费；只有当前模型不支持图片输入时才退化为 `[image <mime>, about <大小>KB omitted]` 占位符。`context_get` 的文本形式始终用占位符，原始数据用 `rawEntryJson`。不产生模型消息的 entry（例如其他扩展写入的 `custom` 展示记录、`model_change`、`thinking_level_change`）不是摘要素材：它们仍留在块的头尾区间内，`context_get` 照样能按区间取回，但正文 JSON 不出现在目标区或参考区——这些记录 Pi 在正常对话里也不会发给模型。entry 的 token 记账按 Pi 的消息投影计算（排除不产生模型消息的 entry），计量一律用保守提示词口径（CJK 约每字一 token，其余约每三字符一 token）：`sourceTokens`、卡片预算、净收益门限、进度、受保护尾部和 footer 全部同口径，图片按固定每图估算计费。摘要请求预算同样按实际提示词内容（含工具声明和图片块）用这个口径估算。这是启发式近似，不保证与提供方分词器完全一致，但可以避免 chars/4 在中文/代码内容上把超窗请求当成“放得下”。

范围选择与请求发送共同使用 `max(2 * blockTokenCeiling, 2048)` 作为输出预留；实际请求还受模型输出上限约束。思考与摘要合计不能超过这一上限；范围选择额外预留 Pi 适配器的 4096 token 输入余量和 256 token 重写余量；重写请求本身是本次操作的最后一次请求，只镜像 4096 token 适配器余量，不再叠加 256 token 重写余量，否则第一次请求刚好放下的目标范围会因为重写指令而被判超窗。level-1 因净收益要求而缩小卡片预算时，不会错误地同步缩小请求输出预留。模型达到输出上限而未正常结束时，仍拒绝提交，不硬截断摘要。

摘要采用固定输出协议：模型不写自由文本，而是调用一次 schema 约束的工具 `emit_compaction_block`。参数由 `SUMMARY_SCHEMA` 定义：不超过 50 字符的单行 `overview`（只写入块元数据，供 `/auto-compact-blocks` 的树视图显示），以及 `progress.done`、`progress.doing`、`progress.todo`、`blocked`、`decision`、`critical_content`、`read_files`、`modified_files` 各字段，全部必填。工具带 `constrainedSampling: { type: "json_schema", strict: "prefer" }`：提供方支持严格 JSON-schema 约束采样时，参数合法性由提供方在服务端保证；不支持时退化为普通工具调用，由插件用 `Value.Errors` 按同一 schema 校验。模型完全不调用工具时，插件才退一步从响应文本里提取第一个 `{…}` 再校验。校验通过的字段由 `renderSummaryCard` 渲染成固定顺序的 `<progress>`（含 `<done>`、`<doing>`、`<todo>`）、`<blocked>`、`<decision>`、`<critical_content>`、`<read_files>`、`<modified_files>` 卡片文本存入块，所以卡片形状和标签顺序不再靠正则事后检查。工具声明本身约 468 token，已计入每次摘要请求的输入预算估算。level-1 完整卡片预算同时受 `blockTokenCeiling` 和 `minNetGainTokens` 约束，两者都按保守提示词口径（`estimateMessageTokens`）计量：`blockTokenCeiling: 2000` 意味着卡片正文的实际提示词量级不超过约 2000 token，而不再是被 chars/4 放大后的约 5400 token。确保生成结果达到最低净收益；第一次输出不合格时重写一次，仍不合格则整次操作回滚。插件不会硬截断摘要。

## 状态与故障语义

块元数据保存在 session 文件旁的：

```text
<session>.autocompact.json
```

原始消息仍在 Pi 的 append-only session JSONL 中。当前 sidecar schema 为 4；块只持久化 `startEntryId` 和 `endEntryId`，`context_get` 在当前活动分支上按这两个边界动态读取完整区间。旧 schema 升级后会按无效旧结构隔离为 `.corrupt-<时间戳>`，再从空状态重建。sidecar 使用临时文件加 rename 写入；同时按同一活动路径键保存顶层前沿、每个父节点当前选中的子前沿和保留指针（`firstKeptEntryIdByBranch`），切换分支时不会让其他分支参与当前投影或树结构。写入、摘要或任一级提升失败时，当前内存投影保持不变。sidecar 不存在时正常使用空状态，不报警；权限等其他读取错误会明确报错并中止本次加载，不隔离原文件。sidecar 无法解析或结构校验失败（缺少字段、块 ID 重复、子块引用不存在、序号回退）时，原文件重命名为 `<session>.autocompact.json.corrupt-<时间戳>` 留存排查，插件从空状态重建。保留指针只校验字符串结构，路径与覆盖关系在选块时校验；旧 sidecar 没有该字段时按当前块边界直接推导，不算损坏。

每次有效状态变化还会在会话末尾追加一条 `custom` 展示快照（`auto-compact-snapshot`）。它是派生展示记录，不是有效状态的一部分：丢失、写入失败或不存在都不影响投影和下一次压缩，插件也不会用它恢复块树。展示快照因而不参与模型上下文、摘要目标、参考材料和 token 记账。

每次摘要请求完成时还会追加一条 `auto-compact-usage` 的 `custom` entry，记录 provider 回传的用量（含失败后重写的那次，以及输出后来校验失败的那次——token 已经花掉）。它同样不参与模型上下文和投影，只用于 footer 的累计 token 与费用。没有对应的 entry renderer，Pi 会直接跳过不显示。

插件取消 Pi 原生压缩，并始终接管手动、threshold 和 overflow 压缩；即使插件没有产出可提交状态（例如收益不足、摘要失败或请求预算不足）也取消原生行为，不回退到原生 compact。`threshold` 请求只取消、不压缩：Pi 的阈值读的是 `settings.json` 的 `compaction.reserveTokens`，照它执行就等于让 Pi 的设置决定插件何时压缩、并让 `auto-compact.json` 的 `trigger` 失效。触发完全由插件在 `context` 事件里的检查负责；每个会话第一次忽略原生阈值请求时提示一次。`overflow` 是真实超窗，仍执行插件压缩。关闭自动压缩只停止插件的阈值扫描，不会因此放行原生压缩。插件等待摘要期间会阻止另一轮插件压缩并发启动，避免 session leaf 改变后丢弃结果。压缩进行中，`tree`/`fork`/`clone`/`new`/`resume` 会被取消，`/reload` 会在输入层被拦截；按下 Esc（包括空闲时发起的 `/auto-compact`）或退出（session_shutdown）会中断摘要请求及重试等待，并丢弃未提交的部分结果。若配置让受保护尾部本身接近或超过模型窗口，自动压缩将找不到可处理区间；此时应降低 `keepRecent` 或 `trigger`，再执行 `/auto-compact-config`。

## 摘要请求排查

主对话能成功不代表摘要参数相同。此次在本机 `litellm-gpt/gpt-6-astra` 路由上，以相同小请求验证：旧调用省略思考设置，适配器发送 `reasoning.effort: "none"`，连续两次返回 LiteLLM 包装的 400 `Bad Request / upstream_error`；仅传入有效等级 `high` 后成功。修复后的摘要客户端也已通过真实请求和完整摘要格式检查。这是该路由的实测结果，不代表所有 OpenAI 模型都不支持 `none`。

在 `/auto-compact-config` 开启 `运行时调试日志` 后，`~/.pi/agent/pi-debug.log` 会记录每次摘要请求的提供方、模型、API、思考等级、估算输入 token、输出上限、尝试次数、耗时、返回用量和错误，以及返回的工具调用名和参数是否为合法 JSON（只记形状，不记内容），还有重试等待时间；每次提交还会记录本次摘要用量（输入、输出、缓存读、缓存写、费用）。不主动记录摘要提示词、正文、密钥或请求头；上游错误原文仍可能包含服务端返回的敏感信息，分享日志前应检查。重试与超时设置通过 Pi 的设置读取器加载，项目设置仅在项目受信任时生效。

重试仍失败时，本轮所有结果不提交，原文与之前成功的压缩状态不变；取消请求或重试等待同样不提交部分结果。Pi 的认证解析接口不接收取消信号，若正等待认证命令或 OAuth 刷新，需等解析返回后才能结束操作，但不会再发送摘要请求。持续的 502 仍需要修复上游连通性，客户端有限重试不能保证不可用服务恢复。

## 开发

```bash
npm test
npm run typecheck
npm pack --dry-run
```
