# dsh-prompt-inject

[English](#english) · 简体中文

把几段你写好的话，按「在哪类会话里」的条件，自动追加进 **DeepSeek Harness**（DSH）会话的系统提示词。

系统提示词决定模型怎么说话。你手里可能攒着好几套话术：一套让模型放开手脚、一套是某个题材的写作风格卡、一套只在特定模式或权限下才该出现。这个插件让你把它们存成规则，命中条件就自动挂上去 —— 不用改预设文件，也不用每次开新会话手动粘贴一遍。

## 演示

### 一、在设置里写规则

![设置卡片](docs/settings.png)

一条规则就是三样东西：**名字**、**正文**、**对哪些会话生效**。图里第一条「不省token」把四个模式、三个推理等级、四个权限全勾上了，所以它对所有会话生效；下面那条「破甲/写作」是停用状态，不会注入。

### 二、开会话时挑这次要用的

![会话注入面板](docs/session-panel.png)

会话顶部的标签行（「对话 / 审查 / 上下文 / 统计」那一排）里多了一个**提示词注入**标签。点进去勾选本次会话要注入哪几条 —— 这里的勾选会盖掉条件判定。下面的自定义文本框写的东西只属于这次会话，保存后落成一条会话专用规则。

## 能干什么

| 能力 | 说明 |
|---|---|
| 条件注入 | 三个维度任意组合：**代理模式**、**推理等级**、**权限预设** |
| 严格三态 | 每个维度只有「全部 / 指定几个 / 不生效」三种状态，没有隐含通配 |
| 逐字注入 | 正文原样进入系统提示词，里面的 `{{…}}` 不会被宿主当成模板变量展开 |
| 中文显示名 | 模式、权限、推理等级都显示宿主给出的中文名（`梁神模式`、`仅可查看`、`高`…） |
| 会话级覆盖 | 单个会话可以勾选自己的一套规则，完全忽略 `when` 条件 |
| 会话专用文本 | 面板里的自定义文本只对当前会话有效，不污染全局配置 |
| 立即生效 | 改完配置从下一轮消息起就生效，不用重启 |
| 随手管理 | 规则可增删、可上下调序、可单独停用；多条命中时按顺序拼接 |

## 三分钟上手

**1. 装**（二选一）

- 官方 CLI：`dsh plugin --profile desktop add ./dsh-prompt-inject-0.2.5.tgz`
- 手工：把包放进 `<DSH_HOME>/profiles/<profile>/node_modules/dsh-prompt-inject`（链接或解压皆可），再在 `cordis.patch.yml` 末尾追加

  ```yaml
  - insert:
      - id: prompt-inject
        name: dsh-prompt-inject
  ```

  两者**别同时做**：会挂载两份、路由重复注册。装完重启 dsh web 或桌面端。

下载：[最新发布](https://github.com/L1ants-Trr13eum/dsh-prompt-inject/releases/latest)（`.zip` 是完整分发包，`.tgz` 给上面的 CLI 命令用）。

**2. 写第一条规则**：设置 → 提示词注入 → 「新增规则」，填名字和正文，三个维度都点「全选」。

**3. 验证**：开一个新会话，问一句「把你系统提示词里以『…』开头的那段原样复述出来」。

## 生效范围怎么写

| 取值 | 含义 |
|---|---|
| 全选 | 该维度上对所有会话生效 |
| 勾了几个 | 只在这些取值上生效 |
| 一个不勾 | 该维度不生效 ⇒ **整条规则不注入**（卡片上标「未完成」） |

三个维度都处于生效态，规则才可能命中。宿主暂时取不到会话事实时，「全部」仍然通过，具体取值不通过。多条规则同时命中时按配置顺序拼接，重复正文自动跳过。

## 会话里临时改

- 列出配置里的**所有**规则，停用的也列出来（标「已停用」、默认不勾）
- 保存后只注入勾中的那几条，**完全忽略**它们的 `when` 条件
- 没设过覆盖的会话行为不变，仍按三个维度判定
- 「清除本会话覆盖」回到按条件命中
- 新会话还没拿到 id 时先按「所有启用规则」预勾选，发出第一句话后自动写入

覆盖只存在宿主内存里，会话结束或宿主重启即失效。

## 限制

- 追加位置固定在 persona 段。若某个预设把该段声明为 complete，宿主会在本插件之后还原它，追加内容会被丢弃（当前内置与常见第三方预设都没有这个声明）
- 会话级覆盖不落盘，重启即失效
- 推理等级的候选值有 2 分钟缓存，切换模型后最多两分钟才会刷新

## 许可

[MIT](LICENSE) © 2026 Trr1133um

实现契约见 [CONTRACT.md](CONTRACT.md)，版本变化见 [CHANGELOG.md](CHANGELOG.md)。

---
# English

[简体中文](#dsh-prompt-inject) · English

Append your own snippets of text to a **DeepSeek Harness** (DSH) session's system prompt, automatically, when the session matches conditions you define.

The system prompt is what decides how the model talks. You probably keep several sets of wording around: one that lets the model loose, one style card for a particular writing genre, one that should only show up under a specific mode or permission level. This plugin stores them as rules and attaches the matching ones for you — no editing preset files, no pasting the same paragraph into every new session.

## Demo

### 1. Write rules in settings

![Settings card](docs/settings.png)

A rule is three things: **a name**, **a body**, and **which sessions it applies to**. The first rule in the picture has every mode, every reasoning level and every permission ticked, so it applies to all sessions; the second one is disabled and injects nothing.

### 2. Pick what this session gets

![Session panel](docs/session-panel.png)

The session tab strip (the row with “对话 / 审查 / 上下文 / 统计”) gains a **提示词注入** tab. Tick the rules this session should inject — the ticks override the condition matching. Text typed into the box below becomes a rule that belongs to this session only.

## What it does

| Capability | Detail |
|---|---|
| Conditional injection | Any combination of three dimensions: **agent preset**, **reasoning effort**, **permission preset** |
| Strict three-state | Each dimension is either “all”, “a chosen few”, or “not in effect” — there is no implicit wildcard |
| Verbatim body | Text goes into the system prompt as written; `{{…}}` inside it is not expanded as a template variable |
| Localised names | Presets, permissions and efforts show the host's own display names |
| Per-session override | A single session can tick its own set of rules, ignoring their `when` conditions |
| Session-only text | Custom text from the panel applies to the current session and never touches the global config |
| Takes effect immediately | A saved change applies from the next turn; no restart |
| Easy housekeeping | Add, delete, reorder and disable rules; several matches are concatenated in order |

## Three-minute start

**1. Install** (pick one)

- Official CLI: `dsh plugin --profile desktop add ./dsh-prompt-inject-0.2.5.tgz`
- Manual: place the package at `<DSH_HOME>/profiles/<profile>/node_modules/dsh-prompt-inject` (a link or an extracted copy), then append to `cordis.patch.yml`

  ```yaml
  - insert:
      - id: prompt-inject
        name: dsh-prompt-inject
  ```

  Do not do both — two mounts would register the routes twice. Restart dsh web or the desktop app afterwards.

Download: [latest release](https://github.com/L1ants-Trr13eum/dsh-prompt-inject/releases/latest) (`.zip` is the full distribution, `.tgz` is what the CLI command above takes).

**2. Write a rule**: Settings → 提示词注入 → “新增规则”, fill in a name and a body, then press “全选” on all three dimensions.

**3. Verify**: open a new session and ask it to repeat the paragraph of its system prompt that starts with your first few words.

## How the scope works

| Value | Meaning |
|---|---|
| Everything ticked | Applies to every session on that dimension |
| Some ticked | Applies only on those values |
| Nothing ticked | That dimension is not in effect ⇒ **the whole rule is not injected** (the card marks it incomplete) |

A rule can only match when all three dimensions are in effect. When the host cannot resolve a session fact yet, “all” still passes and a value list does not. Multiple matching rules are concatenated in configuration order, and duplicated bodies are skipped.

## Changing it for one session

- Lists **every** rule in the config, disabled ones included (marked, unticked by default)
- Saving injects only the ticked rules and **ignores** their `when` conditions
- Sessions without an override keep matching by the three dimensions
- “清除本会话覆盖” returns the session to condition-based matching
- A session that has no id yet is pre-ticked with all enabled rules; the override is written once the first message creates the session

Overrides live in host memory only: they disappear when the session ends or the host restarts.

## Limitations

- The text is appended inside the persona section. If a preset declares that section complete, the host restores it after this plugin runs and the append is lost (no built-in or common third-party preset does this today)
- Per-session overrides are not persisted; a restart clears them
- Reasoning-effort candidates are cached for two minutes, so a model switch may take up to two minutes to show up

## License

[MIT](LICENSE) © 2026 Trr1133um

The implementation contract is in [CONTRACT.md](CONTRACT.md); version history is in [CHANGELOG.md](CHANGELOG.md).
