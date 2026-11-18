# dsh-prompt-inject 0.2.6 — 安装说明

把若干段提示词按条件（代理模式 / 推理等级 / 权限预设）追加进 DSH 会话的系统提示词，并在「设置 → 提示词注入」里用一个卡片管理。

## 包里有什么

| 路径 | 说明 |
|---|---|
| `package/` | 插件本体（host 半区 `lib/host/`、浏览器半区 `lib/client/`、`cordis.patch.yml`） |
| `dsh-prompt-inject-0.2.6.tgz` | 同一份本体的官方打包格式，走 CLI 安装时用它 |
| `install.sh` / `install.ps1` | 手工安装：复制到 profile 的 node_modules 并写入挂载行 |
| `uninstall.sh` / `uninstall.ps1` | 反向操作（只删自己写入的行，配置数据保留） |

## 要求

- DSH 桌面版或 `dsh web`，profile 目录已存在（默认 `~/.dsh/profiles/desktop`）
- Node ≥ 22（只在自检时用到；插件本身零依赖、零构建）

## 装法 A：官方 CLI（推荐）

```bash
dsh plugin --profile desktop add ./dsh-prompt-inject-0.2.6.tgz
```

CLI 会把包加入 `dsh.profile.bundles` 并合并包内的 `cordis.patch.yml`。

## 装法 B：脚本（A 不可用时）

```bash
# Linux / macOS / Git-Bash
DSH_HOME=~/.dsh DSH_PROFILE=desktop ./install.sh

# Windows PowerShell
powershell -ExecutionPolicy Bypass -File .\install.ps1
```

脚本做两件事：把 `package/` 复制成 `<profile>/node_modules/dsh-prompt-inject`；在 `cordis.patch.yml` 末尾追加一条 `- insert:`（已存在则跳过，**A/B 只能选一**）。

## 装完

1. **完整退出并重启 dsh web**
2. `设置 → 提示词注入` 出现卡片；首次没有配置文件时卡片显示空列表
3. 新建的会话才生效（每轮装配时实时求值，改配置不用再重启）

## 配置

数据在 `<DSH_HOME>/prompt-inject/config.json`：

```json
{
  "version": 1,
  "enabled": true,
  "rules": [
    {
      "id": "r-example",
      "name": "示例规则",
      "enabled": true,
      "text": "要追加到系统提示词里的正文",
      "when": { "presets": "all", "efforts": ["max"], "permissions": ["danger-full-access"] }
    }
  ]
}
```

每个维度只有三态：`"all"`（该维度不设限）/ 非空字符串数组（只在这些值上生效）/ **键缺失或空数组（该维度不生效 ⇒ 整条规则不注入）**。三个维度都必须生效，规则才可能命中。

## 自检（装完怎么确认活着）

1. 重启后打开 `设置`，左侧出现「提示词注入」分组
2. 新建一条规则、`text` 填一句可辨认的话（例如 `PIN-TEST-OK`），三个维度都设为「全部」
3. 新建一个会话，在系统提示词里搜 `PIN-TEST-OK`；搜到即链路通

宿主半区的完整单测（86 例）与客户端 bundle 检查（61 项）只在本仓库里随 `test/` 提供，分发压缩包不含测试目录。

## 卸载

```bash
./uninstall.sh           # 或 powershell -File .\uninstall.ps1
```

或删掉 `cordis.patch.yml` 里那条 `# dsh-prompt-inject (installed by …)` 起的 4 行。配置数据保留在 `<DSH_HOME>/prompt-inject/config.json`。

## 已知边界

- 若某个 preset 把 persona 段声明为 `complete`，`dsh-system-prompt` 会在装配 waterfall 之后还原该段，追加会被丢弃（内置 preset 均无此声明）
- 卡片的「未保存拦截关闭」依赖官方关闭按钮类名以 `_close` 结尾的启发式；官方改名会退化为「不提示但不报错」