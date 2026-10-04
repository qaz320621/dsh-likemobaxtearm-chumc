# DSH SSH 控制台

在 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）的**右侧栏**里做 MobaXterm 式的 SSH：
本机 `ssh` 客户端跑在**真实 PTY** 中，**用户与 AI 共用同一条会话**，双方操作互相可见并全部写入
JSONL 审计日志；AI 通过 9 个工具操作会话，并受**三级权限**约束，危险命令执行前会先告知。

> **English:** An SSH console plugin for the DeepSeek Harness Web UI. The local OpenSSH client runs in a
> real PTY; the operator and the AI share **one** session, every action is visible to both sides and
> appended to a JSONL audit log, and the AI's writes are gated by three permission levels
> (view-only / ask / full) with a cancellable pre-execution warning for dangerous commands.

> 包名：`dsh-likemobaxtearm-chumc` · 版本：**1.0.0** · 许可：MIT · 自检：**九套**（`npm test`，其中五套零依赖，跑完会打印项数）

---

## 目录

- [特性](#特性)
- [平台支持](#平台支持)
- [快速开始：从构建到跑起来](#快速开始从构建到跑起来)
- [使用](#使用)
- [配置](#配置)
- [测试](#测试)
- [数据与隐私](#数据与隐私)
- [分发](#分发)
- [架构与实现要点](#架构与实现要点)
- [已知限制](#已知限制)
- [版本与变更](#版本与变更)
- [发布清单](#发布清单)
- [许可](#许可)

---

## 特性

- **一个宿主标签 + 自建二级标签条**：宿主标签条里只有「SSH 控制台」一项，所有会话都在这个页面**自己的**标签条上
  （滚轮横滚 / `◀` `▶` / `▾` 看全部 / 每项 `✕` 关闭）；每个会话一台主机、一个真实终端（xterm.js，全屏程序可用）
- **AI 可操作**：9 个工具 `ssh_list_hosts` / `ssh_list_sessions` / `ssh_connect` / `ssh_exec` /
  `ssh_send` / `ssh_read` / `ssh_status` / `ssh_log` / `ssh_disconnect`
- **三级 AI 权限**（每个会话独立，你随时切换）
  - `仅可看`：AI 只能读，写入一律被拒绝
  - `问答`（默认）：AI 每条命令都要你点「允许」
  - `完全`：AI 直接执行；**危险命令先弹出可取消的告知窗口**
- **输入权互斥**：同一时刻只有一个写者；AI 持锁时你可以一键「收回控制」——**真的发送 Ctrl+C**
- **双向可见**：AI 的命令在终端里标注出现；你的操作 AI 可用 `ssh_log` / `ssh_read` 主动拉取
- **用户留言给 AI**：提问 / 报错（自动附最近终端输出）/ **仅记录**（只写日志，不消耗 AI token）
- **断线重连**：Harness 重启后标签仍在，按 `r`（或点按钮）**在原标签内**重连；连接信息记在浏览器
- **Windows/ConPTY 适配**：`\r\033[K` 式整屏重绘不再灌满日志与分页；空闲重绘帧去重；哨兵支持 posix / cmd / PowerShell 三方言
- **审计日志**：`<workspace>/.dsh-ssh/logs/*.jsonl` —— 命令原文**全量**、输出超阈值截断并标注
  `truncated/fullBytes/lines`、口令提示后的输入记 `[redacted]`

## 平台支持

| 环节 | Linux | macOS | Windows |
|---|---|---|---|
| 浏览器 UI（xterm 渲染、权限/日志/留言面板） | ✅ | ✅ | ✅ |
| 插件宿主半边（起 ssh、日志、AI 工具） | ✅ **已实测** | 理论可用（**未实测**） | 理论可用（**未实测**） |
| 需要的本机 ssh | PATH 上的 `ssh` | 系统自带 `/usr/bin/ssh` | OpenSSH 客户端（Win10 1809+ 自带 `C:\Windows\System32\OpenSSH\ssh.exe`，需在 PATH） |
| 默认 `sshBinary` | `ssh`（经 `ctx.subprocess.resolveExecutable` 解析成真实路径并记入日志） | 同左 | 同左；不在 PATH 时用配置项指绝对路径 |
| 交互式操作（你打字 / `ssh_send`） | ✅ | ✅ | ✅ 远端任意 shell |
| **`ssh_exec`（AI 执行 + 退出码）** | ✅ | ✅ | ✅ 三方言（自动探测 posix / cmd / PowerShell，可用 `remoteShell` 指定） |
| 远端是 cmd / PowerShell | ✅ 走 `call echo …%ERRORLEVEL%` / `Write-Output $LASTEXITCODE` 哨兵 | 同左 | 同左 |
| 密码 / 2FA 提示 | ✅ 终端内输入 | ✅ | ✅ 使用 OpenSSH 时（plink/PuTTY 不是 `ssh`，不支持） |
| `~/.ssh/config`、密钥、ssh-agent、ProxyJump | ✅ | ✅ | ✅（OpenSSH 语义） |

实现上没有 Linux 专属代码：PTY 来自宿主 `ctx.subprocess.spawnTerminal`（它自身覆盖 Linux/macOS/Windows），
日志与路径全部走 `node:path`，ssh 可执行文件走 PATH 解析。

## 环境要求

- **DSH 0.2.0-rc.2 / Web profile**（开发与测试版本）。插件依赖这些宿主契约：
  `ctx.subprocess.spawnTerminal`、`ctx.connection.fetch`、`ctx.tools`、`ctx.systemPrompt`、`ctx.agents`，
  以及客户端的 `sidebarRightTabs` / `slots` API。契约若变动，`npm test` 里的**真 Cordis 激活测试**会先报出来。
- 本机有 OpenSSH 客户端（默认从 PATH 找 `ssh`）。
- **不需要**在远端安装任何东西：走的是你本机的 `ssh`，复用 `~/.ssh/config`、密钥、agent。
- 插件**不保存任何口令**；交互式密码/2FA 由你在终端里输入，日志里会打码。

## 快速开始：从构建到跑起来

### 1. 获取源码

```bash
git clone <你的仓库地址> dsh-ssh
cd dsh-ssh
```

> 仓库里**已经附带构建产物** `client.xterm.js`，所以第 2 步是可选的；改了 `chunk/terminal.js` 才必须重建。

### 2. 构建客户端终端 chunk（可选）

`client.xterm.js` 是把 xterm.js 打进懒加载 chunk 的产物，源码是 `chunk/terminal.js`：

```bash
# 本插件的运行时**零依赖**；这两个只是构建期依赖，--no-save 保持 package.json 干净
npm install --no-save esbuild @xterm/xterm @xterm/addon-fit

node build.mjs        # → 生成/覆盖 client.xterm.js
```

（也可以装成 devDependencies：`npm i -D esbuild @xterm/xterm @xterm/addon-fit`。要求 Node ≥ 18。）

### 3. 安装到 DSH profile

插件是一个 **DSH bundle**（`package.json` 里声明 `dsh.bundle.patch` + `dsh.client`）。

**方式 A：让 AI 装（推荐）** —— 在 DSH 会话里说：

> 用 `plugin_manager` 的 `install_bundle`，target 是 `<这个目录的绝对路径>`

**方式 B：自己在 Web UI 装** —— 侧边栏 **Plugins** 页 → 安装 → 填入该目录的绝对路径（或 npm 包名）。

`install_bundle` 会调用 profile 的包管理器完成安装与选择。**安装动作需要 `danger-full-access` 或审批**，
因为插件 Host 代码会在 Harness 进程内、工作区沙箱之外执行。

### 4. 重启 Harness 一次，然后刷新页面

- **Host 半边**：DSH 按 URL 缓存已加载的 JS 模块代，所以**必须重启**才会加载新代码。
- **Client 半边**：`client.js` / `client.xterm.js` 是每次从磁盘读取的，**刷新页面**即可。

重启后如果插件没激活，启动日志会给出具体原因（例如某个服务没注入）。

### 5. 第一次连接

右侧栏 → 加号 → Guide 里的 **「SSH 会话管理器」** → 填 target（`host` / `user@host` / `~/.ssh/config` 别名）
→ 连接。密码/2FA 提示会出现在终端里，由你输入。

## 使用

### 你（操作者）

- **终端**：直接打字；`Ctrl+C`、全屏程序（vim/top）都正常。
- **工具栏**：
  - 权限三档：`仅可看` / `问答` / `完全`（对 AI 生效）
  - **收回控制**：AI 正在跑命令时，一键打断它（真 Ctrl+C）并拿回输入权
  - **重命名**：改标签名
- **底部四个抽屉**：
  - **日志**：当前会话的日志，按 `user` / `ai` / `system` / `remote` 过滤，可刷新
  - **历史**：全部日志文件（含 `archive/` 里的归档），点「查看」只读打开（默认末尾 300 行）
  - **留言**：给 AI 留言，三种类型 —— `提问`、`报错`（自动附最近 20 行终端输出）、`仅记录`（只写日志，**不消耗 AI token**）
  - **待确认**：AI 请求执行的命令；危险命令的告知窗口也在这里（可取消）
- **断线重连**：Harness 重启后标签会显示"会话已断开"，按 **`r`** 或点「重新连接」——**在原标签内**重连，不会多开标签。
  连接信息（target/user/port/name）存在浏览器里，所以重启后不用重打。
- **最近连接**：管理器里列出连过的目标，一键连接；新标签页里也会给出这个列表。
- **会话切换由插件自己管**：宿主标签条是 `overflow: hidden` 且不可改，所以会话不放在那里 ——
  页面顶部的二级标签条是插件自己渲染的，**能滚动**：
  - 第一项 **「控制台」是常驻页**：主机管理、新建连接、日志目录都在这里，永远在、不可关闭；会话排在它后面；
  - 鼠标滚轮 → 横向滚动；`◀` `▶` → 左右微调；`▾` → 列出全部页面（滚动条之外也能直达）；
  - `▾` 下拉点一下展开，**点面板外部或按 `Esc` 自动收起**（再点 `▾` 也能收起）；
  - 每项 `✕` → 关闭该会话；`Ctrl+Alt+←` / `Ctrl+Alt+→` → 依次切换；
  - 圆点配色：🟢 就绪、🟠 连接中 / 已退出、⚪ 已关闭或未知；**红色只用于危险命令与危险操作按钮**
    （常驻的「控制台」页不带圆点 —— 它没有会话状态，不该显示任何告警色）；
  - 关掉「SSH 控制台」这个宿主标签**不会**杀掉会话（AI 仍可继续操作），重新打开就能看到它们；
  - 旧版本留下的每会话标签：打开时会自动把会话并入控制台并**自行关闭**（没关掉就手动 `✕`）。

### AI（模型侧）

| 工具 | 作用 |
|---|---|
| `ssh_list_hosts` | 列出保存的主机（不含口令） |
| `ssh_list_sessions` | 当前 DSH 会话里的 SSH 会话（状态/权限/输入权/日志路径） |
| `ssh_connect` | 新建会话；会自动在右侧栏开一个可见标签 |
| `ssh_exec` | 执行一条命令并等结束，返回输出 + 退出码（受三级权限约束） |
| `ssh_send` | 写入原始文本（可选回车），用于交互式程序、发 `\u0003` |
| `ssh_read` | 按行分页读取终端输出（去控制序列） |
| `ssh_status` | 单个会话的状态快照 + 最近输出 |
| `ssh_log` | 读取 JSONL 审计日志（按 actor/kind 过滤） |
| `ssh_disconnect` | 关闭会话并回收进程树 |

权限语义：

- `仅可看` → 写入类工具直接拒绝（`SSH_PERMISSION_VIEW_ONLY`），并要求 AI 请你切换权限，**不会反复重试**
- `问答` → 命令进入待确认队列，你点「允许」才执行；超时未确认返回 `SSH_APPROVAL_TIMEOUT`
- `完全` → 直接执行；命中危险规则时**先**给出可取消的告知窗口（`dangerGraceMs`，默认 5s）

其它约定：你按键收回输入权时，AI 的调用以 `waitReason=revoked` 结束（这是正常打断，不是错误）；
远端在等凭据时 AI 的写入被拒绝（`SSH_AUTH_REQUIRED`，**AI 不得代填口令**）。

`ssh_exec` 的退出码用哨兵标记解析，属于**启发式**：命令自己后台化、或把 shell 换掉时可能拿不到真实退出码；
且哨兵依赖 POSIX `printf`，所以**远端**需要是 POSIX shell（远端是 cmd/PowerShell 时请用 `ssh_send` + `ssh_read`）。

### 日志字段

`ai.command` / `user.input` 的 `command` **全量保留**；`output` / `ai.result` 的 `text` 超过
`outputLogTruncateChars`（默认 200）会被截断，并带 `truncated` / `fullBytes` / `lines`。
口令提示后输入的行记 `text:"[redacted]"` + `sensitive:true`。

日志按**一次交互**合并，规则是"**看换行，不只看时间**"：终端每敲一个键就重画整行，纯按时间合并会把
`ls` 和 ` -a` 切成两条，所以 ——

- 缓冲区**已有换行**（命令提交了 / 输出成行了）→ 安静 `outputFlushQuietMs`（默认 400ms）就落一条；
- 缓冲区**还没有换行**且**你最近按过键**（正在编辑这一行，方向键、翻历史、补全都算）→ **完全不落盘**，
  直到你回车。纯时间窗口治不了这件事：你停 10 秒也只是一次停顿，不代表"这行打完了"；
- 既没有换行、也没人在打字（裸提示符、进度条之类）→ 等 `outputIdleFlushMs`（默认 5000ms）再落；
- 回车时先把这一行的回显落成一条，命令结果另成一条（结果因此有独立的 200 字符额度）；
- 还有：超过 `outputFlushMaxBytes` 立即落一条，会话结束/关闭时也会冲刷。

实时流不受影响：浏览器始终逐字节收到输出，被合并的只有落盘。

### 日志的生命周期

- **一个 SSH 会话一个文件**：`logs/<会话 id>-<主机>_<YYYYMMDD-HHMMSS>.jsonl`，会话结束即定稿
  （所以同一台主机的多次连接是多个文件，重连会产生新文件）；
- **自动归档**：超过 `logArchiveAfterDays`（默认 7 天）的日志被 gzip 成同目录
  `archive/<同名>.jsonl.gz` —— 内容一字不差，体积约 1/10；**正在写日志的活跃会话永不被移动**；
- **阈值可以精确到小时**：`logArchiveAfterDays: 0.5`（小数天 = 12 小时）或直接写时长
  `logArchiveAfterDays: '12h'` / `'90m'` / `'30s'`。归档扫描在启动后 5 秒、每次打开会话、
  以及**每 10 分钟**各跑一次，所以小时级阈值不需要有人操作也会生效；
- **`0` 是"关闭"而不是"立即"**：`logArchiveAfterDays: 0` 表示不归档（写错成 `0` 不会把日志一次性全压掉）；
  想激进归档就写一个真实时长（如 `'30s'`）；
- **保留期**：只有把 `logRetentionDays` 设为大于 0（默认 **0 = 永久保留**），超过该时长的**归档**才会被删除；
  当前日志永远不会被自动删除；
- **界面里能看历史**：控制台页底部的「历史日志」列出全部文件（含归档，标注日期/会话/主机/大小/是否归档），
  点「查看」只读打开，默认取末尾 300 行；解压后超过读取上限的归档会明确拒绝并报出实际大小，而不是卡死；
- 文件名经过校验（`../` 之类直接拒绝），插件只读自己的日志目录。

## 配置

配置写在 **profile 的 patch 文件**里：`~/.dsh/profiles/<profile>/cordis.patch.yml`（Harness 的插件配置统一在这里，
宿主没有图形化的插件配置页）。按行 id 覆盖，**只写你要改的键即可**，其余键取默认值：

```yaml
# ~/.dsh/profiles/web/cordis.patch.yml（安装插件时这一行已经存在，补上 config 即可）
- id: dsh-ssh
  disabled: false
  config:
    logArchiveAfterDays: '12h'   # 归档阈值：数字=天（可小数），或 12h / 90m / 30s；0 = 不归档
    logRetentionDays: 0          # 归档保留：同样写法；0 = 永久保留
```

改完**即时生效**（profile patch 层是 live 的）。⚠️ 但配置变更会让这一行**重新挂载**，而插件卸载的清理动作会
**关闭当前所有 SSH 会话**（标签显示"已断开"，按 `r` 即可重连）——所以最好在会话不重要时改，或干脆改完重启一次。
生效后可以在控制台页「历史日志」表头看到当前策略（如"归档阈值 12 小时，归档保留 永久"）。

| 字段 | 默认 | 含义 |
|---|---|---|
| `logDir` | `.dsh-ssh/logs` | 相对 workspace 的日志目录 |
| `logEnabled` | `true` | 关闭则只保留内存日志 |
| `outputLogTruncateChars` | `200` | 日志中输出截断阈值（0 = 不截断） |
| `outputFlushQuietMs` | `400` | 输出合并窗口：缓冲区**已有换行**时，安静这么久落一条 |
| `outputIdleFlushMs` | `5000` | 还在输入中的行（缓冲区尚无换行）等这么久才落一条，避免把半行切开 |
| `outputFlushMaxBytes` | `8192` | 超过此量立即落一条 |
| `maxConsecutiveBlankLines` | `1` | 投射时最多保留几个连续空行（0 = 全删）；ConPTY 重绘曾把空行放大到 90% |
| `repaintDedupe` | `true` | 丢弃空闲期的整屏重绘帧（判定规则见「Windows / ConPTY 适配」） |
| `repaintIdleMs` | `2000` | 多久没有输入才算空闲，用于重绘判定 |
| `repaintResizeMs` | `3000` | resize 之后这么久内，重复出现过的整屏内容按重绘丢弃（**命令执行中也生效**，见下） |
| `remoteShell` | `auto` | `ssh_exec` 哨兵方言：`auto` / `posix` / `cmd` / `powershell` |
| `markerMode` | `auto` | 哨兵写法：`auto`（Windows 上 `plain`，其它平台 `hidden`）/ `plain` / `hidden` |
| `markerFailThreshold` | `2` | 连续几次哨兵超时后该会话降级（不再等满超时） |
| `degradedTimeoutMs` | `15000` | 降级后单条命令的等待上限 |
| `maxLogBytesPerSession` | `8388608` | 单会话日志上限，超出后停止追加 |
| `logArchiveAfterDays` | `7` | 归档阈值：数字=**天**（可用小数，`0.5` = 12 小时），或时长字符串 `12h` / `90m` / `30s`；**`0` = 关闭归档** |
| `logRetentionDays` | `0` | 归档保留期：同样的天/时长写法；**`0` = 永久保留** |
| `maxReadBytes` | `262144` | `ssh_read` 单次上限 |
| `maxToolOutputBytes` | `16384` | 返回给 AI 的输出上限 |
| `defaultPermission` | `ask` | 新会话默认权限 |
| `commandTimeoutMs` | `120000` | 单条命令等待上限 |
| `approvalTimeoutMs` | `120000` | `问答` 权限下等待确认的超时 |
| `dangerGraceMs` | `5000` | `完全` 权限下危险命令的可取消窗口 |
| `noteContextLines` | `20` | 「报错」留言附带的终端输出行数 |
| `defaultRows` / `defaultCols` | `24` / `80` | 初始终端尺寸 |
| `sshBinary` | `ssh` | ssh 可执行文件（PATH 名或绝对路径） |
| `extraSshArgs` | `[]` | 追加到 ssh 命令行的参数 |
| `dangerPatterns` | 内置表 | 危险命令规则（`{id, pattern, note}`），非空则**替换**内置表 |
| `dangerDisabledIds` | `[]` | 从生效规则里禁用某些 id |
| `workspaceRoot` | `''` | 强制日志/hosts 的根目录；留空则用会话 workspace |

例：

```yaml
- id: dsh-ssh
  name: 'dsh-likemobaxtearm-chumc'
  config:
    defaultPermission: ask
    dangerGraceMs: 8000
    outputLogTruncateChars: 400
    logArchiveAfterDays: 0.5   # 等价于 '12h'：半天前的日志自动 gzip 归档
    logRetentionDays: 0        # 归档永久保留（>0 才按天/小时清理）
```

## 测试

```bash
npm test            # 九套自检，全部通过后打印总项数（当前 253 项）
```

**绝大多数测试不需要正在运行的 Harness** —— 它们自己搭环境：

| 套件 | 覆盖 | 依赖 |
|---|---|---|
| `test/inject-audit.mjs` | 静态审计两半代码里每个 `ctx.<服务>` 都已在 `inject` 声明；禁止再出现消费者不可用的 `rpc.handle` / `ctx.webServer`；默认 `sshBinary` 可移植 | 无 |
| `test/connection-contract.mjs` | 对**已安装** connection 源码的事实断言（为什么用 fetch 路由而不是 `rpc.handle`）+ 真 Cordis 下 fetch 路由可用 | DSH 安装 |
| `test/cordis-activation.mjs` | **用真 Cordis 加载真 `index.js`**：9 工具 + 提示段 + 两条路由注册成功，且不碰 webServer、不调 rpc.handle | DSH 安装 |
| `test/host-smoke.mjs` | 真 PTY + 真 ssh + 真 sshd：连接、哨兵退出码、回显剥离（含折行）、日志截断、日志合并、三级权限、危险告知、关闭回收 | 一个可 ssh 的靶机 |
| `test/host-rpc.mjs` | 真 `index.js` 装配：RPC/流、9 工具、**用宿主自带校验器**裁决工具 schema 与返回值、留言三类、会话隔离、工作区根解析 | DSH 安装 + 靶机 |
| `test/client-wiring.mjs` | 真 `client.js` 的注册与数据通路：tab 类型/插槽座位、hello→补水、AI 建会话开标签、**选中会话不新开宿主标签**、常驻首页、二级标签条数据、最近连接与绑定记忆 | 无 |
| `test/log-retention.mjs` | 日志生命周期（临时目录，不碰真实日志）：按天/小时归档、活跃会话保护、保留期、清单、读取尾部、`../` 拒绝、超大归档拒绝、`0` = 关闭 | 无 |
| `test/windows-conpty.mjs` | 把三份 Windows 实机报告的字节级证据变成回归测试：`\r` 重写、空行折叠、重绘判定矩阵、三方言哨兵、**两种方言的命令/哨兵块顺序**、折行 token、降级与 `revokedSource` | 无 |
| `test/identity.mjs` | **名字与版本一致性**：包名在 patch 行/宿主导出/客户端注册/chunk 注册/README 元数据里必须一致；版本号在 README 与客户端构建标记里必须一致；tab kind 与存储键**不**随包名变 | 无 |

两个环境变量：

- `DSH_NODE_MODULES=<node_modules 目录>` —— 自动定位不到 DSH 安装位置时显式指定（测试只借它拿 `node-pty` / `cordis` / `dsh-tools`）。
- `DSH_SSH_TEST_TARGET=<host>` —— 需要一个可 ssh 的靶机时用（默认 `localhost`，即本机 sshd）。

只跑不依赖 Harness 的五套（含一致性自检与 ConPTY 用例）：

```bash
npm run test:offline
```

### 量日志指标（和报告同一把尺子）

仓库自带一个度量脚本，口径与几份 Windows 验证报告一致（bytes/line、重复帧、横幅/提示符次数、记账字段、事件分布），
并按验收阈值给出 PASS/FAIL：

```bash
node tools/log-metrics.mjs <workspace>/.dsh-ssh/logs/<session>.jsonl
npm run metrics -- <同上>
```

## 数据与隐私

插件**不把任何数据写进包目录**。运行时只写到使用者自己的环境：

| 位置 | 内容 |
|---|---|
| `<workspace>/.dsh-ssh/logs/*.jsonl` | 会话活动日志（命令全量、输出截断、口令打码） |
| `<workspace>/.dsh-ssh/logs/archive/*.jsonl.gz` | 归档日志（超过 `logArchiveAfterDays` 天自动压缩，保留策略见 `logRetentionDays`） |
| `<workspace>/.dsh-ssh/hosts.json` | 保存的主机（target/user/port/name/备注，**无口令**） |
| `<workspace>/.dsh-ssh/client-errors.log` | 界面崩溃堆栈（仅出错时产生） |
| 浏览器 `localStorage` | `dsh-ssh.recents.v1`、`dsh-ssh.binding.v1.*`（最近连接 / 标签绑定） |

⚠️ 日志会包含你在远端执行过的命令及其输出，分享日志前请自行检查。
口令打码是**启发式**（识别 `password/passphrase/密码/口令/验证码/token` 等提示行），**不是安全边界**。
不想要落盘日志就设 `logEnabled: false`。仓库自带的 `dist.mjs` 会在打包时**拒绝**包含日志/hosts/绝对家目录路径的副本。

## 分发

```bash
node dist.mjs                    # 组装干净副本 → dist/<包名>
node dist.mjs --name dsh-ssh     # 改名（会一致改写 package.json / patch 行 / 宿主导出 / client 与 chunk 注册 id）
```

`dist.mjs` 只带运行时 + README + 可移植测试，排除 `SPEC.md`、`USER-CHECK.md`、`dist/`、`node_modules`，
并在输出前**自检**：没有日志、没有 hosts、没有绝对家目录路径 —— 发现问题会直接拒绝生成。

## 架构与实现要点

```
index.js            宿主装配：配置、会话管理器、两条 fetch 路由、9 个工具、提示段
src/session.js      一个会话 = 一个真实 PTY 跑本机 ssh；输出环、哨兵执行、输入权、日志
src/manager.js      会话注册表、审批队列、危险告知、主机配置存储、工作区根解析
src/rpc.js          /api/dsh-ssh/invoke（一元）+ /api/dsh-ssh/stream（NDJSON 帧流）
src/tools.js        9 个模型工具 + 系统提示段
src/log.js          JSONL 日志（截断、打码、上限）
src/ring.js         有界输出环（分页读取、纯文本投影）
src/exec.js         哨兵协议（折行回显剥离、口令提示识别）
src/danger.js       危险命令规则表
client.js           单个「SSH 控制台」宿主标签 + 插件自建的可滚动二级标签条、终端/管理器 UI、浏览器端连接记忆
chunk/terminal.js   xterm 渲染组件（由 build.mjs 打成 client.xterm.js）
```

几个关键决定（都是被实践逼出来的）：

- **本机 `ssh` 跑在真 PTY**，而不是用 `ssh2` 库直连：白拿 `~/.ssh/config`、密钥、agent、ProxyJump、
  密码/2FA 交互，而且 **AI 操作的就是你眼前那条 shell** —— 这是"双向可见"的前提。
- **共享单通道**：用户与 AI 共用一个 PTY，输入权用 token 互斥，避免"两个通道各说各话"。
- **传输用 `ctx.connection.fetch` 的精确路由，而不是 `connection.rpc.handle`**：后者把注册作用域绑在
  **提供者**的 ctx 上并访问 `owner.webServer`，消费者侧无法满足，会在启动时抛错并拖垮整个插件。
- **chunk 懒加载**：xterm 体积大，用 `require.async('./client.xterm.js')` 按需加载；React 由 `client.js`
  注入 chunk，保证页面只有一份 React。
- **诊断可观测**：客户端组件崩溃会回传宿主写进 `client-errors.log`；管理器与断开面板显示客户端版本号，
  一眼判断"页面是不是旧代码"。

## Windows / ConPTY 适配

Windows 桌面版的本地 PTY 是 **ConPTY**，它会按自己的节奏**整屏重绘**（`\r\033[K` + 重写当前行）。
一位 Windows 用户的实测报告指出：一次「接受 host key + 输口令 + 一条 echo」的会话，PTY 实际送来
7,964 字节 / 530 行，人工可见文本只有约 600 字节（**平均 15 字节/行**，而真实文本是 40–90），
`ssh_read` 翻页拿到的几乎全是空行。0.1.1 针对这条链路做了四件事：

| 报告中的问题 | 处理 |
|---|---|
| 整屏重绘灌入输出环与日志 | 投射层把 `\r` 当作**重写当前行**（而不是换行），连续空行折叠到 `maxConsecutiveBlankLines`；日志新增 `rawBytes` / `collapsedBytes` / `blankLines` / `rewrites` 记账，噪声水平可直接从日志量出来 |
| 空闲期也在刷帧 | **空闲重绘去重**：会话空闲 `repaintIdleMs` 且没有命令在执行时，与上一帧可见文本完全相同、且 ≥128 字节 / ≥4 行的帧不再进环、不再落日志；被丢弃的帧数记在会话状态与下一条日志的 `repaintsSkipped` / `repaintOf` 上 |
| 重绘插进回显中间导致 `stripEcho` 失效 | 回显剥离只做**块级删除**（不按边界截断）：删掉「提示符+命令回显（含折行续行）」「哨兵脚本回显（含折行续行）」「取值行」「尾部提示符」四块，中间剩下的就是真输出。**两种方言的块顺序不同**：posix 命令与哨兵同一行回显，cmd/PowerShell 哨兵另起一行（于是输出夹在命令回显与哨兵回显之间）—— 按固定顺序截断会把输出删掉，这正是 0.1.3 在 cmd 上正文恒空的原因 |
| `ssh_read` 分页被空行淹没 | `readLines()` 改为在**投射后**的可见行上分页 |
| Windows 远端（cmd/PowerShell）没有可用哨兵 | `remoteShell` 三方言：POSIX 用 `printf … $?`；**cmd 的哨兵必须单独一行**（`cmd /c exit 5` 之后换行再 `call echo …%ERRORLEVEL%`）—— 实测证明写成同一行 `… & call echo …%ERRORLEVEL%` 拿到的永远是旧值：cmd 在**整行解析期**就展开了 `%ERRORLEVEL%`，`call` 只是把已替换完的字符串再跑一遍；PowerShell 用 `Write-Output …$LASTEXITCODE`。`auto` 从提示符形状（`PS C:\>` / `C:\>` / `$`·`#`）自动判定，结果见 `ssh_status` 的 `detectedShell` |
| 无法区分"客户端重发尺寸"和"ConPTY 自发重绘" | 新增 `session.resize` 日志事件（`cols` / `rows` / `source` / `duplicates`），`ssh_status` 增加 `visibleBytes` / `repaintsSkipped` / `repaintBytesSaved` / `resizeDuplicates` |

**0.1.2 追加修复（来自 0.1.1 的实机验证报告）**：

- **陈旧哨兵值**：实测 `cmd /c exit 5 & call echo TOKEN%ERRORLEVEL%` 报 0 —— 改为哨兵独立行；
  解析时也只认**本次 token 自己的回显之后**的第一个取值行（重放的旧屏里出现的是旧 token 或旧取值，天然被排除）；
- **重放污染抓取窗口**：审批条出现/消失会把终端行数 16↔14 来回挤，每次 resize 都让 ConPTY 整屏重绘并把**上一轮的哨兵行**重放进流里 ——
  而旧版的重绘去重正好在"命令执行中"被关掉了，于是旧内容进了本次抓取。现在：resize 后 `repaintResizeMs` 内
  **历史指纹**命中的整屏内容一律按重放丢弃（命令执行中也生效）、审批条改为**覆盖层**（不再改变终端尺寸）、
  客户端的 resize 发送加 250ms 去抖（一次布局变化只发一次 PTY 尺寸）。

**0.1.3 追加修复（来自 0.1.1/0.1.2 的实机验证报告）**：

- **ConPTY 会吃掉「打印后立刻擦掉」的行**：报告用 A/B/C/D 对照实验证明，元凶是 `\033[K`（擦到行尾），
  与 SGR 8 隐藏无关 —— 同一渲染帧内被擦掉的内容**一个字节都不会进输出流**，于是 POSIX 哨兵在 Windows 上永远等不到。
  现在 `markerMode: auto` 在 Windows 上改用**明文哨兵** `printf '\n<token>%d\n' $?`（不隐藏、不擦行）；
  `hidden` 仍然可用（Linux/macOS 默认）。
- **折行会把 token 劈开**：ConPTY 在 63 列处插入 `\b` + `\n`，`__DSH_SSH_DONE_f2\b\n85f4__`。
  现在 token 匹配对 `\b`/`\r`/`\n` 容忍（`splitTolerant`），解析与剥离都不再因此失效 ——
  这同时修掉了 0.1.2 的一个回归：折行时哨兵脚本回显会残留在给模型的结果里。
- **回显剥离改为按哨兵回显一刀切**（单行命令）：提示符 + 命令回显 + 哨兵脚本回显是一个整块，
  在哨兵回显行结束处切开，不再逐行猜。验收：`ver` 的结果**恰好 1 行**、`cmd /c exit 5` 的结果**为空**。
- **降级快速失败**：连续 `markerFailThreshold` 次哨兵超时后，该会话不再等满 `commandTimeoutMs`，
  而是按 `degradedTimeoutMs` 收尾并在结果里标 `markerUnavailable: true`，提示改用 `ssh_send` + `ssh_read`。
- **`revoked` 的来源可读**：`ai.result.revokedSource` 记 `user keystroke`（直接按键）/ `user revoke`（点「收回控制」）/ `teardown`；
  配合 `input.owner` 事件的 `reason` 可以区分「用户打断」与「结算」。
- 用法建议：**连接后等提示符稳定再发第一条命令**（登录横幅/升级提示还在刷时抢跑会让第一条命令的哨兵难对齐）。

**去重的安全边界（重要）**：只在**空闲**时生效 —— 刚写过输入（用户按键或 AI 命令）的窗口内一律不去重，
所以 `echo hi; echo hi`、`tail -f` 的重复行都不会被吃掉；单行帧、小于 128 字节的帧也永不去重。
不想要这个行为就设 `repaintDedupe: false`。这条规则由 `test/windows-conpty.mjs` 逐条钉住。

## 已知限制

- `ssh_exec` 的退出码是启发式（哨兵）：命令后台化或替换掉 shell 时拿不到真实退出码；
  PowerShell 若执行的是纯 cmdlet（不设置 `$LASTEXITCODE`）会表现为超时，而不是错误码。
- macOS / Windows **未实机验证**（代码无平台分支，PTY 由宿主提供）。
- 口令打码是启发式，不是安全边界。
- 尚未实现（原计划的 M2/M3）：SFTP / 文件浏览器、端口转发、跳板机可视化、空闲会话回收、`ssh2` 结构化执行通道。
- 会话是**进程内**的：Harness 重启后进程结束（标签可一键重连，但不恢复远端会话状态）。
- 远端全屏程序的**回放**只有有界缓冲，不是完整录像。
- 宿主标签条溢出时不可滚动（上游 `sidebar-right` 是 `overflow: hidden`，且插件不允许改宿主 DOM/样式），
  所以**会话不占用宿主标签**：插件在单个宿主标签内自建二级标签条并自己实现滚动。
  代价是宿主的分屏/浮动不再能"按会话"使用（要做分屏得我们在二级层自己实现）。

## 版本与变更

当前版本 **1.0.0**（首个正式版本）。完整历史见 [CHANGELOG.md](./CHANGELOG.md)。名字与版本的一致性由 `test/identity.mjs` 自动把关：
`package.json` / bundle patch 行 / 宿主导出 / 客户端与 chunk 的注册 id / README 元数据必须全部相同，
版本号必须同时出现在 README 与客户端构建标记（管理器底部那行 `客户端版本：…`）里。

1.0.0 由三份 Windows 实机验证报告驱动完成 ConPTY 适配（见「Windows / ConPTY 适配」与 CHANGELOG）：

- 0.1.1 `\r` 重写语义 / 空行折叠 / 重绘去重
- 0.1.2 cmd 哨兵独立行 + 取值锚定 + resize 重放去重 + 审批覆盖层
- 0.1.3 Windows 明文哨兵（擦行会被 ConPTY 吃掉）+ 折行容忍 + 降级快速失败
- 0.1.4 块级回显删除（修掉 0.1.3 在 cmd 上正文恒空的回归）

**验证状态**：

| 环境 | 状态 |
|---|---|
| Linux（作者本机，真 sshd + 真 Cordis） | ✅ 九套 **253 项**全绿 |
| Windows 10 22H2 + DSH 桌面版 0.2.0-rc.2（第三方实测） | ✅ 0.1.3 起 POSIX 哨兵打通、cmd 退出码正确；**1.0.0 的块级删除修复尚未在 Windows 复测** |
| macOS | ⚠️ 未实测（代码无平台分支，PTY 由宿主提供） |

## 发布清单

```bash
npm test                      # 九套自检（当前 253 项）
npm run test:offline          # 零依赖的五套（CI 跑这个 + 语法检查）
node dist.mjs                 # 组装干净副本（自检：无日志 / 无 hosts / 无绝对家目录）
node dist.mjs --name <包名>   # 改名：package.json / patch 行 / 宿主导出 / 客户端与 chunk 注册 / README 一起改
```

发布前必须成立（`test/identity.mjs` 与 `dist.mjs` 会强制）：

1. 包名在 `package.json`、bundle patch 行、`index.js` 导出、`client.js` 与 `client.xterm.js` 的注册 id、README 元数据里**完全一致**；
2. 版本号同时出现在 `package.json`、README 元数据、客户端构建标记里；
3. 分发包内**没有** `.dsh-ssh/`、`*.jsonl`、`hosts.json` 或绝对家目录路径；
4. tab 的 `kind`（`ssh-console` / `ssh`）与浏览器存储键**不随包名变** —— 改名/升级不丢标签布局与最近连接；
5. CI（`.github/workflows/ci.yml`）在 Ubuntu 上跑语法检查 + 五套零依赖自检，全部依赖-free。

## 许可

[MIT](./LICENSE) © 2026 dsh-ssh contributors —— 可自由使用、修改、分发（保留版权与许可声明）。
如需换成别的许可（例如 Apache-2.0、MPL-2.0），替换 `LICENSE` 并同步 `package.json` 的 `license` 字段即可。
