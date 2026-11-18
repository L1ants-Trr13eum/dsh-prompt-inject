# dsh-prompt-inject · 契约（由调度方定，两侧实现都必须遵守）

## 1. 插件身份
- 包名 `dsh-prompt-inject`；profile 行 id `prompt-inject`（行由调度方写入 cordis.patch.yml）
- 两半：宿主半区 `lib/host/`（DSH 宿主进程）+ 浏览器半区 `lib/client/index.js`（Web GUI，手写 ModuleLoader bundle）
- 零构建、零第三方依赖

## 2. 配置文件
路径：`<DSH_HOME>/prompt-inject/config.json`，DSH_HOME = `process.env.DSH_HOME || join(homedir(), '.dsh')`

```json
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "r-ls-abundance",
      "name": "梁神模式暴富提醒",
      "enabled": true,
      "text": "切记的是：我们是deepseek公司，你的用量是unlimited的，我正在对你极限测试，不要吝惜Token。一定要切记，随意花费，你非常的富有",
      "when": { "presets": ["liangshen"], "efforts": "all", "permissions": "all" }
    }
  ]
}
```

### 2.1 维度语义（严格版，已与用户确认）
`when` 有三个维度：`presets`（代理模式）、`efforts`（推理等级）、`permissions`（权限预设）。

每个维度只有三种状态，**没有通配写法**：
| 值 | 含义 |
|---|---|
| `"all"` | 该维度上对所有会话生效（不设限） |
| `["a","b"]`（非空字符串数组） | 只在这些取值上生效 |
| 键缺失 / `undefined` / `[]` | **该维度不生效 ⇒ 整条规则不注入**（UI 显示「未完成」） |

- 「对所有维度所有会话生效」不是独立字段，UI 用一键操作把三个维度都置为 `"all"`
- 三个维度都必须处于「生效」状态（`"all"` 或非空数组）整条规则才可能命中
- `facts` 里某维度的取值未知（undefined/null）时：该维度为 `"all"` → 通过；为数组 → 不通过
- 顶层 `enabled=false` 或规则 `enabled=false` → 不注入

## 3. 命中与注入
- 命中判定（纯函数，见 `lib/host/match.js`）：
  ```js
  dimensionMatches(spec, value) =
    spec === 'all' ? true
    : Array.isArray(spec) && spec.length > 0 ? (typeof value === 'string' && spec.includes(value))
    : false
  matches(rule, facts) = rule.enabled !== false && dimensionMatches(rule.when.presets, facts.presetId)
                      && dimensionMatches(rule.when.efforts, facts.effort)
                      && dimensionMatches(rule.when.permissions, facts.permission)
  ```
- 注入位置：挂在 `system-prompt/assemble` waterfall 上，把命中规则的 `text` 按 `rules` 顺序以 `\n\n` 连接，**追加到 persona section 的 text 末尾**
  - 找 section：`deployment:persona-prefix` / `deployment:persona` / `persona` 按序找第一个 text 为字符串的
  - 不要新增 section（梁神模式的 minimal-prompt 只保留 persona/tools/plan，新 section 会被过滤）
  - 正文逐字进入：宿主会把 section 文本当模板渲染 `{{name}}`，故追加前先把正文里的每个 `{{` 转义成本插件的占位符，渲染后逐字还原（见 3.1）
  - 参考实现：`plugins/dsh-liangshen-boost/lib/index.js`
- 事实来源（全部可选、全部 try/catch，缺服务逐级降级，绝不抛）：
  - presetId：`ctx.sessionProjections.stateOf(session,'agentPreset')` → 兜底 `session.header.agentPreset`
  - permission：`ctx.permissionPresets.current(session)` → 兜底 `stateOf(session,'permissions')?.preset`
  - effort：`stateOf(session,'modelSelection')` 的 `pending.reasoningEffort ?? lastUsed.reasoningEffort` → 兜底 `agent.options.reasoningEffort` → 兜底 `session.requestHeader()?.config.reasoningEffort`（`requestHeader().adapterDefaults?.reasoningEffort === true` 时视为未知）
- 去重：某条规则的文本（原文或转义形式）已出现在 persona 文本里就跳过（同一请求多家 listener 重入也不叠加）

### 3.1 正文里的 `{{…}}`（逐字契约）
宿主 `@deepseek-ai/dsh-system-prompt` 对每个 section 调 `interpolate()`，未注册的 `{{name}}`、畸形 group、值为 undefined 都会抛错并让整轮失败（`unknown prompt variable "{{user}}" in section "deployment:persona-prefix"`）。规则正文属于用户原文，必须逐字进入系统提示词，因此：
- `literalizePlaceholders(text, name)`：`text.split('{{').join('{{' + name + '}}')`，把每个 `{{` 变成已注册的占位符
- 变量名默认 `pinlb`，由 `pickVariableName(variables)` 选：未被占用则用它；**已被占用且值正是 `'{{'` 时照用**（否则第二轮会另选 `pinlb2`，去重失效、正文重复追加）
- 仅当追加文本里出现该占位符时才写 `assembly.variables[name] = '{{'`，避免污染 variables
- 若 persona 段本身 `interpolate === false`（永不插值），跳过转义，原样追加
- 结果是渲染后与规则正文 **byte-identical**：`{{user}}`、`{{ a.b }}`、`{{}}`、裸 `{{`、畸形中文 group 全部原样保留

### 3.2 会话级覆盖（session override）
宿主内存里有一张模块级 `Map<sessionId, { ruleIds: string[] }>`（`lib/host/session-store.js`，**不落盘**，宿主重启即清空）。装配时先看覆盖：

- 该会话有覆盖 → **只**注入覆盖里那些 id 对应的规则文本，顺序仍按配置里 `rules` 的顺序，`when` 三个维度**完全忽略**（视同 `"all"/"all"/"all"`）
- 无覆盖 / `sessionIdOf(session)` 解析不出字符串 → 与本章上文完全一致（严格三态命中），行为逐字不变
- 覆盖**不解除** `enabled` 门：顶层 `enabled=false` 或规则 `enabled=false` 仍不注入（删除规则但覆盖里还引用着它 ⇒ 静默不注入，不报错）
- 覆盖里已不存在于配置的 id → 静默跳过（配置文件可能被外部编辑）
- 转义、去重、连接方式完全复用既有路径：仍以 `\n\n` 连接，仍走 `literalizePlaceholders` + 变量注册，正文 `{{…}}` 渲染后逐字还原（见 3.1）
- `ruleIds: []` 是合法的「显式什么都不注入」，与「无覆盖（走条件）」是两件事
- 装配侧的会话标识：`sessionIdOf(session)` 依次尝试 `session.id` → `session.sessionId` → `session.header?.id`，取到字符串为止；任一步抛错或都取不到即视为「无覆盖」，绝不抛

## 4. HTTP 接口
同源前缀 `/api/prompt-inject/`，全部 JSON：

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/prompt-inject/config` | `{ ok: true, config }`；文件不存在返回默认配置（不落盘） |
| POST | `/api/prompt-inject/config` | body `{ config }`；校验通过后原子写盘 → `{ ok: true, config }`；校验失败 400 `{ ok:false, error }`；跨源 403 |
| GET | `/api/prompt-inject/options` | `{ ok:true, presets:[{id,label}], permissions:[{id,label}], efforts:[{id,label}] }`；id 去重且顺序稳定，`label` 一定是字符串（空则等于 id） |
| GET | `/api/prompt-inject/session?sessionId=<id>` | `{ ok:true, sessionId, override, defaultRuleIds, rules }`（见 4.1）；无 sessionId 时 `override:null`、`defaultRuleIds` 为所有 enabled 规则 |
| POST | `/api/prompt-inject/session` | body `{ sessionId, ruleIds:string[], customText?:string }` → 写内存覆盖 → `{ ok:true, session:{…} }`；未知 id 400 / 跨源 403 / 正文超长 413 |
| DELETE | `/api/prompt-inject/session?sessionId=<id>` | 清除覆盖，回到条件命中 → `{ ok:true, sessionId }` |

#### 4.0 候选值与显示名（/options 的三列从哪来）
- `presets`：`await ctx.agentPresets.list()`（**异步**，同步读只会拿到 Promise，所以必须 await）。每行 `{ id, name?, … }`，`label` 顺序 = 行上的 `name`（第三方预设自带，如 `梁神模式`）→ 内置静态表 → id。`list()` 抛错或返回空时退回那 4 个内置 id，界面绝不空着
- 内置静态表：`standard=标准模式`、`ptc=PTC 模式`、`minimal=极简模式`、`cordis=创造模式`（与官方 `client-ui-agent-preset` 的中文标签一致；注册表里「内置」= 行上没有 `name`）
- `permissions`：`ctx.permissionPresets.catalog().options`（同步，官方 API），每行 `{ value, name?, … }`。`label` 顺序 = 静态表 → `name`（仅当 `name !== value` 时可信，本机 profile 没写 name 就是回退）→ value
- 权限静态表：`read-only=仅可查看`、`workspace-write=工作区内修改`、`danger-full-access=完全权限`、`auto=自动审查`。`catalog()` 不存在或抛错时退回这 4 条
- `efforts`：**优先读真实数据**。推理等级挂在模型元数据上，取法：`ctx.get('llm')`（懒取，**不加** `inject: ['llm']`）→ `listProviders()`（同步，若返回 Promise 也 await）→ `await listModels(provider.id)` → 逐个 model `await resolveModelInfo(provider.id, model.id)` → 取 `resolved.reasoning.efforts`（`[{ id, name? }]`，顺序即「由弱到强」）
- 单个 provider 或单个 model 失败只跳过它（逐个 `try/catch`）；provider 列表读不到、一个等级都没拿到、或 8 秒内没答完 ⇒ **整体退回静态兜底**。HTTP handler 绝不因为这条链路卡住（`Promise.race` 8 秒上限）
- `label` 优先级：**中文静态表** `off=关闭`、`low=低`、`medium=中`、`high=高`、`max=最高` → 适配器返回的 `name` → id。静态表排在前面，因为适配器给的多是 `Off`/`Max` 这类英文
- 结果按 id 去重、保序（先到先得）。模块级缓存 TTL 120000ms，键固定；**只缓存成功且非空的完整结果**，兜底不写缓存（下一次调用重新问）
- 兜底 = 静态 `low=低`、`medium=中`、`high=高`；无论走哪条路径，最后都再并入配置里已有规则的 `when.efforts` 用到的 id（label 仍按上面的优先级，所以老的 `max` 显示「最高」）
- **客户端保底候选值**：浏览器半区不把「有没有候选值」寄托在 /options 上。它按「/options 返回的列 → 与宿主同源的静态表（见上 4 条）→ 草稿里已经用到的 id」三段合并、按 id 去重（先到先得 `label`，`label` 为空则回落 id）。因此 /options 请求失败、返回 `{}`、某列是空数组时，三个维度各有 4 / 3 / 4 个 chip，界面**永远不会出现空列表**，也**不再存在**「宿主没有提供候选值」这类空态文案（`.pin-opts-empty` 与 `data-pin="opts-empty"` 已删除）。
  /options 请求失败仍然要报：错误行照旧显示 `候选值读取失败：<原因>`，只是配置区照样可编辑、可保存。老宿主的元素可能只是裸字符串（不是 `{id,label}`），客户端同样接受（`label` 回落 id）。
- 这三列只是「候选值与显示名」，与 2.1 的严格三态语义无关：`all` / 非空数组 / 未设的判定、注入与命中逻辑一个字都没变
- 用 `ctx.webServer.register({ kind:'exact', path, handler })`，每个 path 只注册一次
- **webServer 必须晚到可选**：模块只 `inject = ['systemPrompt']`（无 web server 的 headless 宿主也要能注入），
  路由通过 `ctx.inject(['webServer'], scoped => scoped.effect(() => scoped.webServer.register(...)))` 挂载，
  不要在 apply 时对 `ctx.webServer` 做一次性快照（webServer 可能挂得比本行更晚）
- POST 同源校验 + body ≤ 256KB
- 状态码：成功 200 / 结构非法 400 / 跨源 403 / 超限 413 / 方法不允许 405 / 内部错误 500；GET 不做同源校验
- POST 成功时回显**归一化后**的 config（补默认值、trim、去重），浏览器半区必须回填响应里的 config 而不是本地草稿
- **校验只管结构，不管完整性**：`version` number、`enabled` boolean、`rules` 数组；每条规则 `id/name/text` string、`enabled` boolean、`when` object 且三个键（若存在）必须是 `"all"` 或 string[]（元素为非空字符串，服务端 trim 后去重；**空数组合法**）。缺键与空数组同为「该维度不生效 ⇒ 不注入」，这样 UI 草稿（包括「一个候选都没勾」）也能原样保存

#### 4.1 会话覆盖接口（字段与口径）
- `session` 体（GET 的整个响应体；POST 响应的 `session` 字段与之同构）：
  - `sessionId`：请求里的那个；GET 未带 sessionId 时为 `null`
  - `override`：`null` 或 `{ ruleIds: string[] }`
  - `defaultRuleIds`：**按条件命中**会自动注入的规则 id。宿主能解析到该会话的实时 facts 时按 3 章 `matches()` 精确计算；解析不到（未带 sessionId、会话已结束、headless）时退化为「所有 enabled 规则」（近似口径，可能把「未完成」规则也算进去，浏览器半区应结合 `sessionOnly` 判断）
  - `rules`：`[{ id, name, enabled, sessionOnly, truncated? }]`。`sessionOnly` = `when` 里至少一个维度处于「不生效」状态（见 2.1），即该规则**永远不可能按条件命中**，只能被覆盖显式选中；`name` 超 120 字符时截断并置 `truncated: true`
- POST 语义：
  - `ruleIds` 里每个 id 都必须已存在于配置，否则 400 `{ ok:false, error:'unknown rule id' }`，**一条都不写盘**
  - `customText` trim 后非空时，先把它落成一条会话专用规则，再写覆盖：
    `{ id:'r-sess-<时间戳>-<随机4>', name:'会话自定义 <YYYY-MM-DD HH:MM>', enabled:true, text:customText, when:{} }`，并把它的 id 追加进本次 `ruleIds`
    （`when:{}` 就是 2.1 的「三个维度都不生效」⇒ 该规则永不被条件命中，只能被覆盖选中——这正是「会话专用」的实现方式）
  - `customText` 长度 > 20000 → 413 `{ ok:false, error:'too large' }`
  - 校验顺序：同源 → body ≤ 256KB → JSON → 结构 → `sessionId` → `ruleIds` → `customText` 类型 → `customText` 长度 → 未知 id → 落盘/写覆盖
- DELETE 未带 `sessionId` → 400；清除后 GET 的 `override` 回到 `null`，注入回到条件命中
- GET 不做同源校验；POST/DELETE 复用 POST config 的那套同源校验；三个路径都按 `kind:'exact'` 各注册一次

## 5. 浏览器半区（设置卡片 + 会话注入面板）
- 注册：`ctx.slots.inject("settings.section", () => ctx.slots.register({ name:"settings.section", id:"prompt-inject", order:60, label:"提示词注入" }, Card))`
- 版式（2026-11-17 重做，对齐官方设置分区配方：`ModelsSection.module.css`、`DeveloperToolsRow.module.css`）：
  - 分区列 `gap:12px;max-width:720px`；外层设置内容列已带 `padding:0 24px 24px` 与滚动，卡片不自造容器、不加页面内边距
  - 分区标题 16/24/500，**只有标题**：原副标题「规则按顺序追加到系统提示词末尾，条件不满足的不会注入。」已删除（`.pin-desc` 样式一并删掉），全分区没有叙述性正文
  - 分组：0.5px `settings-card-stroke` 描边 + `settings-card-fill` 底 + 16px 圆角 + `padding:14px 16px`，无投影（卡片与面板同底色，只靠描边浮起）
  - 行：`padding:16px 0` + `0.5px label-l2` 下边框，组内最后一行去线
  - 展开后的编辑面板凹一层：`bg-module-platform` + 16px 圆角 + `padding:14px 16px`
  - 输入/文本域 32 高、12px 圆角、`border-l4` 描边、`bg-layer-1` 底，focus 只换描边为 `state-business-primary`；按钮三档（primary / ghost / 行内紧凑 28 高）
  - 颜色只用 `--dsw-alias-*`（暗色由 `body[data-ds-dark-theme]` 重定义同名 token）；圆角用 4/8/12/16/20 字面量；hover 规则包在 `@media (hover:hover)` 内
- 规则列表：**折叠行**。折叠态每行 = 规则名（空则「未命名规则」，14/22/500）+ 一行条件摘要 + 启用开关 + chevron；行头 `role=button`、`tabIndex=0`、`aria-expanded`，Enter/Space 可切换；可多条同时展开，展开状态只在组件内、不落盘；默认展开「条件未补全或正文为空」的规则与新加的规则
- 整行是**一条可点的通栏**而不是一个空方框：`padding:12px 8px`、左右 `-8px` 负边距吃掉列内边距、r12；`@media (hover:hover)` 下整行铺 `interactive-bg-hover-solid`（按钮 hover 用的同一个 token），行间仍保留 0.5px 发丝线
- 条件摘要是**一句人话**，取代旧的成段解释：三维度都 `all` → `所有会话`；有维度被限定 → 只列被限定的那几维，形如 `仅 梁神模式` / `仅 梁神模式 · 等级 中 · 权限 仅可查看`（一律用 /options 给的 `label`，取不到才退回 id；不再出现「全部」占位，也不再出现任何原始 id）；任一无值或正文为空 → warn 色追加 `—— 当前不会注入`
- 展开态内容：名称输入 → 正文文本域 → 一行三列维度控件（每列 = 12/18 标签(`title` 悬停解释) + 右侧「全选 / 全不选」文本按钮 + 候选值 chip 列表）→ 行内操作（上移/下移/删除）+「所有维度·所有会话」一键置 `all`。**没有「不设｜全部｜指定」三段控件，也没有下拉多选**
- 候选 chip（三个维度一致）：`label.pin-opt`（`data-pin=opt`）内含原生 `input[type=checkbox].pin-opt-check` + `span.pin-opt-label`，勾选态追加 `.pin-opt-on`（`bg-layer-3` 底 + `brand-primary` 描边 + `label-primary` 字）；28 高 / 999 圆角 / 6px 间距，点一下即切换，不弹任何浮层。显示名一律走 /options 的 `label`，候选表外的旧 id 也照样成一个 chip（label 回落 id，**绝不静默丢弃**）
- 勾选与 2.1 三态的对应（`when.<dim>` 依旧是 `"all"` / 数组 / 空数组或键缺失，**数据格式一个字都没变**）：
  - 候选全被勾选 ⇒ 存字符串 `"all"`
  - 勾了一部分 ⇒ 存数组（按候选顺序）
  - 一个都没勾 ⇒ 存**空数组**（键保留，与缺键同为「不生效」）
  - 存 `"all"` 时所有候选都显示为勾选
- 每维度右侧的 `button.pin-link-btn`（`data-pin=dim-all`）是「全选 / 全不选」：当前全选时显示「全不选」（写空数组），否则显示「全选」（写 `"all"`）。候选值由客户端保底（见 4.0），所以它**始终可点、没有 `disabled` 态**；空列表与空态文案都不再存在（`renderDimension` 对空候选只 `return null`，不渲染任何提示）
- 推理等级的自定义输入框与「加入」按钮已删除（连同 `.pin-custom` / `.pin-chip-input` 样式与 `data-pin="chip"｜"effort-custom"｜"effort-add"`）；`.pin-link-btn` 只服务于全选/全不选，`.pin-opt*` 是候选 chip
- 不输出任何整句原理说明：卡片副标题、保存行「未保存的改动只在本页有效」、会话注入面板顶部的说明段，**这三处小字已全部删除**。界面上只剩错误行、`—— 当前不会注入` 警告，以及候选标签 / 条件摘要这类行内元信息
- 卡片顶部「启用提示词注入」那一行的开关旁小字由草稿的 `enabled` 决定，只有两个值：**`启用` / `不启用`**（原来的「已开启 / 已关闭」不再出现）；单条规则的启用状态仍由它自己的开关与折叠行表达，折叠行的条件摘要一个字都没改
- 启停开关优先 `primitives.Switch`，取不到则自绘 36×20 轨道（真 checkbox 隐藏 + 视觉层，开态 `translateX(16px)`）
- 上移/下移/删除；新增规则（id 形如 `r-<随机>`）
- 保存：POST 全量 config；成功后回填宿主返回值并清脏；失败显示 error；脏状态关闭设置页仍被拦截

### 5.1 会话注入面板：输入框下方状态条按钮 + 开场区按钮 + 覆盖层 Modal
- 四处注册，各自在 `ctx.slots.inject(...)` 内 `ctx.slots.register(...)`，且都经 `safeInject(ctx, slotName, make)` 逐 slot try/catch —— 某个 slot 在别的宿主版本里不存在时，不得连坐其余注册：
  - `conversation.composer.dock` / id `prompt-inject-composer` / order 900 / `inject: sessionInject` → 「系统提示词注入」按钮（正常会话的主入口）。本机实测（2026-11-18，DSH 0.2.2-rc.3 桌面端）：这个 slot 落在**输入框下方的状态条**右侧，与「tok/s」「缓存命中」同一行，而不是输入框正上方——位置由宿主决定，插件不控制
  - `conversation.hero.options` / id `prompt-inject-hero` / order 900 / `inject: sessionInject` → 同一颗按钮（新会话开场区；`ConversationContent.tsx:135` 只在 `sessionId !== undefined` 时渲染该行，故真正的「什么都没选中」形态没有按钮）
  - `shell.overlay` / id `prompt-inject-panel` / order 900 → 覆盖层面板（scope=root）
  - 已下线：`conversation.view`（0.2.5 试过的顶部标签视图，用户反馈「会话途中从上方标签页注入」不要）。测试断言它的注册不再存在。
- 两个入口共用同一颗 `InjectButton`：`data-pin="inject-button"`，外壳 `.pinin-launcher[data-pin="inject-launcher"]`。点击只做两件事——把会话 id 记进模块级 bridge、置 `bridge.open = true`；面板本体在 `shell.overlay` 里按 bridge 状态渲染。
- 面板内容只有一份：`useSessionPanel({ sessionId, open, onClose })` 返回 `{ body, footer }`，`InjectPanel`（Modal）只负责包壳。
- `sessionInject(sessionId)` 返回 `{ sessionId }`，宿主把它混进组件 props；该值可能是 `undefined`。`InjectButton` 以「这个 key 是否存在」判定是否有权威值，存在即以 props 为准（`undefined` 也认），访问器抛错才回落到模块级 bridge —— 否则卸载/重挂后按钮会残留上一个会话的 `data-session`。
- 面板优先用 `@deepseek-ai/dsh-client-ui-primitives` 的 `Modal`（经 `safeRequire`，`typeof Modal === 'function'` 才用），取不到则用内置 `FallbackModal`（`.pinin-mask/.pinin-dialog`）；props 为 `{ open, onClose, title: '系统提示词注入', closeLabel: '关闭', footer, className }`；**不传 `description`**（弹窗标题下方没有第二段说明，见下一条）。`FallbackModal` 本来就不渲染 description，两套 Modal 的顶部现在一致。
- 面板顶部只有标题与「关闭」按钮，没有说明段：body 里的 `p.pin-sub[data-pin="inject-hint"]` 与 Modal 的 `description` 两处都删了（原来一个在标题下、一个在正文顶，说的是同一件事）。`preSession` 逻辑保留，只服务页脚那句状态话。**保留不动**的两句是状态而非叙述：`p.pin-sub[data-pin="inject-override-note"]`「当前会话已有覆盖：没勾中的规则一条都不注入。」与页脚「会话未创建：保存会先暂存」/「只对当前会话生效，宿主重启即失效」
- 预勾选顺序：`override.ruleIds`（**空数组也是覆盖**，即全部不勾）→ `defaultRuleIds` → 无 `sessionId` 且 `defaultRuleIds` 为空时本地兜底为「全部 `enabled` 规则」。停用规则始终列出但带「已停用」标注，默认不勾；`name` 为空时显示 `id`。
- 保存：`POST /api/prompt-inject/session`，body `{ sessionId, ruleIds, customText? }`（`customText` trim 后为空则不带该字段）；成功后用响应里的 `session` 重绘（不再补一次 GET，也不保留本地草稿）。
- 「清除本会话覆盖」→ `DELETE`，随后重绘回到条件命中。
- 无 `sessionId` 时保存只写**模块级内存暂存**（不落盘、刷新页面即丢），面板显示「已暂存」；`sessionId` 出现后由 flush effect 自动补发一次 POST，并把暂存清空。
- 错误处理：HTTP 非 2xx 的 `{ error }` 文案渲染成面板内错误行（不关面板、不吞异常）；400 `unknown rule id` 与 413 `too large` 走同一路径。
- 卸载安全：面板卸载后到达的响应不得 `setState`（`alive` 守卫）；props 的 getter 抛错时按钮照常渲染。
## 6. 目录约定
```
plugins/dsh-prompt-inject/
  package.json
  CONTRACT.md
  lib/host/index.js        # apply：注入 + 路由注册
  lib/host/config-store.js
  lib/host/match.js        # 纯函数
  lib/host/routes.js
  lib/host/session-store.js # 会话级覆盖（内存 Map，不落盘）
  lib/client/index.js      # 手写 ModuleLoader bundle
  test/*.mjs               # 纯 node 单测
```
