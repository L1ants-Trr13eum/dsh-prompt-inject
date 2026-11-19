# Changelog

## 0.2.7 — 2026-11-19

- 入口回到会话顶部标签行（0.2.6 的改动作废）：重新注册 `conversation.view`（id `prompt-inject`、order 900、label「提示词注入」、`inject: sessionInject`），把 `InjectView` 与 `.pinin-view` 那组样式一起恢复（含半透明主题下的卡片底色与描边）；`conversation.composer.dock` 的注册再次删除
- 标签视图与覆盖层 Modal 仍共用 `useSessionPanel` 那一份 body/footer，交互、接口、三态语义一律未动；新会话空白态（标签行整行不渲染）仍走开场区 `hero.options` 按钮 + Modal
- 测试：浏览器半区 61 → 60 项（断言 `conversation.view` 的 id/order/label/inject 面与标签视图渲染，并断言 `conversation.composer.dock` 不再注册）

## 0.2.6 — 2026-11-18

- 入口改回输入框下方（本机实测该 slot 落在状态条右侧）：删除 0.2.5 的顶部标签视图（`conversation.view`）与它的 `.pinin-view` 样式、`InjectView` 组件；重新注册 `conversation.composer.dock`（id `prompt-inject-composer`、order 900、`inject: sessionInject`），与开场区 `hero.options` 共用同一颗 `InjectButton`
- 面板仍是那一个 Modal（`shell.overlay`），交互、接口、三态语义一律未动
- 测试：浏览器半区 60 → 61 项（dock 注册与 id/order/inject 面、点击后面板只拉一次 /session、面板保存走 POST、无 sessionId 时按钮照旧渲染；并断言 `conversation.view` 不再注册）

## 0.2.5 — 2026-11-18

- 入口从输入框上方搬到会话顶部标签行：「系统提示词注入」现在是 `conversation.view` 上的真标签（id `prompt-inject`、`order:900`、`label:'提示词注入'`），与「对话 / 审查 / 上下文 / 统计」并列；`conversation.composer.dock` 的注册已删除
- 面板内容抽成 `useSessionPanel({ sessionId, open, onClose })`，标签视图（`.pinin-view`，`max-width:720px`、无弹窗遮罩、无关闭按钮）与覆盖层 Modal 共用同一份 body/footer，不再有两套逻辑
- 标签视图的 `sessionId` 取自 slot 的 `inject` 混入的 props，不读模块级 bridge；空白态（标签行整行不渲染）仍走开场区按钮 + Modal
- 测试：浏览器半区 57 → 60 项（四个 slot 注册齐全且 `conversation.composer.dock` 已移除、标签注册的 id/order/label/inject 面、标签视图在 `{sessionId}` 下渲染勾选列表并直接按 props 的 sessionId 保存、无 sessionId 时渲染不崩）

## 0.2.4 — 2026-11-17

- `/options` 的推理等级改为读取真实数据：`ctx.get('llm')` → `listProviders()` → `await listModels()` → `await resolveModelInfo()` → `reasoning.efforts`；中文表 `off=关闭 / low=低 / medium=中 / high=高 / max=最高`，单个 provider/model 失败只跳过，整体 8 秒上限、结果缓存 120 秒，拿不到才退回静态 `低/中/高`
- 客户端加保底候选：`/options` 失败或返回空时，三个维度仍有可勾的 chip，删掉「宿主没有提供候选值」空态
- 删掉叙述性小字（卡片副标题、保存行提示、会话面板说明、弹窗 description）；顶部开关小字改为 `启用` / `不启用`
- 仓库整理：新增 `LICENSE`（MIT）、`.gitignore`、GitHub Actions CI、`scripts/build-dist.mjs`；打包产物不再入库

## 0.2.3 — 2026-11-17

- 维度控件从「不设 / 全部 / 指定」三段改为铺开的可勾选 chip，右上角一个「全选 / 全不选」；勾满存 `"all"`，部分存数组，一个不勾就是该维度不生效（`[]` 原样保存）

## 0.2.2 — 2026-11-17

- 设置卡片按官方设置分区重做版式：折叠行 + 一行人话摘要，去掉整段原理说明；「指定」态改为下拉多选
- `/options` 统一返回 `{ id, label }`：预设走 `await ctx.agentPresets.list()` 的 `name`，权限走 `catalog().options`，都补内置中文表
- 修正根因：此前同步读取异步服务导致候选值恒为空

## 0.2.1 — 2026-11-17

- 修复：重做版式后会话面板的勾选框丢了样式（`pin-check` → `pinin-check`），并补两条断言防回潮

## 0.2.0 — 2026-11-17

- 会话级注入：输入框上方与开场区（hero）各挂一个「系统提示词注入」按钮，面板可逐会话勾选规则
- 覆盖语义：有覆盖只注入覆盖内的规则、忽略 `when`；无覆盖保持按条件命中
- 自定义文本保存时落成会话专用规则（`when:{}`）；新增三条 `/api/prompt-inject/session` 接口；覆盖只存内存

## 0.1.1 — 2026-11

- 修复：正文里的 `{{…}}` 会让宿主当成模板变量而整轮报错，改为转义成 `{{pinlb}}` 再还原
- 新增分发包脚本（`install.sh` / `install.ps1` / 卸载脚本、zip 打包）

## 0.1.0 — 2026-11

- 首个版本：规则按「模式 / 推理等级 / 权限」三维度严格三态命中，追加进 persona 段；设置卡片；配置读写接口
