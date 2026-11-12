# DeepSeek Harness 三期技术验证（由 AgentKib 启动 DSH）— 2026-11-12

本文记录三期开工前的技术验证：DSH 未运行时，AgentKib 怎样启动它、继续原会话，有哪些限制，还有哪些规则要先定。本轮只读源码并做沙箱实验，没有改 AgentKib 代码。结论只适用于下列版本。方案见[接入方案](../docs/agents/deepseek-harness.md)的 §4.2、§7 三期与 §9。

## 源码与边界

- DSH：本机安装的 DeepSeek Harness `0.2.2-rc.1`（安装包启动器 `dsh --version` 同为 `0.2.2-rc.1`）。源码按标签 `dsh-v0.2.2-rc.1`（`66491b05`）核对，并与 2026-11-11 的 master（`e8f7b93a34`，rc.2 之后）对照。新版本改了别处，下文结论两边一致。
- 实验：
  - 用 DSH 安装包自带的命令行启动器 `DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh` 启动。它以 Electron 作为 Node 运行，用户不需要另装 `dsh`。
  - 运行环境：独立 HOME 与 `DSH_HOME`，设置 `DSH_TELEMETRY_DISABLED=1`，用 `sandbox-exec` 只允许连接本机。
  - 模型：本机 OpenAI 兼容的合成 provider，经 `--patch` 配置。
  - 插件：经 `--patch` 按绝对路径挂一个探针插件，挂法与 AgentKib 插件相同。它记录各项服务的就绪时间，并提供本机控制接口，用来新建、恢复、发送和读取会话。
  - AgentKib 插件经 `--patch` 加载并连上 Host，已在二期 2a–2d 的验收中反复验证，本轮没有重复。
- 没有读取或修改用户真实的 `~/.dsh`、`~/.agentkib`；DSH 一侧没有真实模型请求。

## 结论

### 1. 只能用 web 配置启动

- 命令行拒绝启动 desktop 配置，提示 `profile "desktop" is managed exclusively by the Electron application`。安装包启动器只放开了 `dsh plugin --profile desktop …`。
- DSH Desktop 自己也是把 desktop 配置交给 web 应用运行：
  - 组合包与 web 相同（`dsh-base` + `dsh-web-app`）。
  - 启动参数为 `--no-open --host 127.0.0.1 --port 0`。
  - 运行时是 Electron 主进程拉起的子进程，退出时由主进程发消息让它正常关闭。
  - AgentKib 可以照这个模式启动 web 配置，用 web 配置也能继续 Desktop 里建的会话。
- 只有 web 配置带插件需要的 `sessionController` 和 Agent 预设，DSH 自带的另外三种运行方式都不行：
  - `headless --session-id <id> "消息"` 是 DSH 里最像 Claude Code `-p --resume` 的用法，但它明确拒绝运行在预设下的会话，报 `session "…" runs under agent preset "standard", which the one-shot runner does not compose`。Desktop 和 web 新建的会话都有预设（实验里默认是 `standard`），所以"每轮起一个进程、跑完就退出"的做法续接不了这些会话。
  - `acp`、`sdk` 两个组合包既没有 Agent 预设，也没有 `sessionController`。
- 配置第一次使用时，由安装包自带的组合包自动创建，不需要联网（实验在禁止外网时完成）。

### 2. 模型、密钥与设置

- API 密钥和 DeepSeek 账号登录都存在 `~/.dsh/.credentials.yaml`，所有配置共用，后台进程可以直接使用。
- 设置界面的修改写进当前配置自己的 `profiles/<name>/cordis.patch.yml`。`~/.dsh/cordis.patch.yml` 虽然对所有配置生效，但设置界面不写它。所以用户在 Desktop 里改的默认模型、自定义 provider 等，web 配置读不到。
- 启动时可以多加一层 `--patch ~/.dsh/profiles/desktop/cordis.patch.yml`，让后台用上 Desktop 的设置：
  - 叠加顺序为：组合包 < 配置自己的 patch < home patch < `--patch` 叠加层。
  - patch 指向不存在的条目时，只记一条警告并跳过。实验里特意加了一个不存在的条目，启动不受影响。
  - DSH 只读取这份文件，用户的文件不会被修改。
- 在后台进程里选模型（`selectModel`）时，DSH 会顺带保存默认模型，写进的是 web 配置，不是 desktop。
- master 给模型请求加了 `dsh-profile/<配置名>` 的 User-Agent 后缀，provider 能看出请求来自哪个配置。

### 3. 启动与资源（沙箱数据）

| 时间（秒，从进程启动算）    | 插件加载 | `appReady` | 会话服务就绪 | 能读历史 |
| --------------------------- | -------- | ---------- | ------------ | -------- |
| 首次（新建 DSH 目录与配置） | 1.50     | 2.02       | 2.10         | —        |
| 再次启动                    | 0.34     | 0.58       | 0.63         | 0.64     |

- 内存：刚启动约 266–269 MB；空闲约 1.5 分钟后约 208 MB。只有一个进程，没有子进程。
- 二期 2c 看到的启动竞态（`dsh-history-unavailable`）没有复现：会话服务一就绪，历史就能读。启动后仍应对历史读取重试几秒。
- 版本：可以用安装包启动器的 `dsh --version` 在启动前对照插件的 `engines.dsh`。版本不符时 DSH 照常启动，只是禁用插件，错误输出为 `dsh: disabling profile plugin row "agentkib-dsh-bridge": …`。
- 插件能用到两个进程级服务：`appReady`（启动完成信号）和 `appExit(code)`（请求 DSH 正常退出）。

### 4. 写入锁：两个进程共用会话数据

- 锁是内核 `flock`，加在会话目录的 `session.lock` 上，持有写入句柄期间一直有效，不会过期；进程退出时（包括崩溃）由内核释放。
- DSH 不会自动释放空闲的会话。会话一旦在某个进程里恢复（发过消息，或经 `resolveAgent` 取用），这个进程就一直持有它，直到退出；源码里没有空闲回收。
- 实验结果：
  - A 跑完一轮、处于空闲时，B 恢复同一会话，返回 `session/writer-held`（`already owned by an active write handle`）。B 读这个会话的历史正常，19 条事件都读到了，读取不需要锁。
  - A 收到 SIGTERM 后 0.1 秒内退出，B 随即恢复成功。
  - B 被 SIGKILL（相当于崩溃）后，另一个进程立刻恢复成功。
  - A 新建的会话，已经在运行的 B 马上就能列出，不用重启。
- DSH Desktop 遇到被占用的会话，点发送时提示：“当前会话已被占用，可能是其他正在运行的 DSH 导致的（如其他 dsh web、桌面端），请退出其他正在运行的 DSH 后重试。”
- 反过来也一样：Desktop 里发过消息的会话，Desktop 会一直占着，直到 Desktop 退出。Desktop 没装 AgentKib 插件时，AgentKib 启动的进程拿不到这些会话。

### 5. 停止

- SIGTERM：DSH 正常关闭，最多等 5 秒，退出码 0；再收到一次信号就强制退出。SIGINT 的退出码为 130。
- 正在跑的一轮会被中断，不会等它跑完：
  - 模型请求随即断开。
  - 已经生成的部分回复保留下来，这一轮记为 `turn/end {"reason": {"kind": "aborted", "reason": {"kind": "disposed"}}}`。
  - 之后在另一个进程里续接这个会话、再发消息，一切正常。
- 标准输入关闭后，web 运行时不会退出（10 秒后仍在运行）。所以 AgentKib 崩溃时，它启动的 DSH 会留在后台，继续占着会话，需要插件自己兜底。

## 建议做法

- **启动**：
  - 什么时候启动：只在没有可控制的 DSH 时（§5.1 的规则不变）。
  - 命令：主进程用安装包启动器运行 `dsh --profile web --patch <AgentKib 叠加层> [--patch <desktop 配置的 patch>] --no-open --port 0 --host 127.0.0.1`，标准输入接管道。
  - 叠加层：按绝对路径插入随 AgentKib 发布的插件，并标明"由 AgentKib 托管"。
  - 找不到启动器时：先退回 PATH 上的 `dsh`，再找不到就提示需要安装 DeepSeek Harness。
- **插件托管模式**（只在 AgentKib 启动的进程里生效）：
  - 空闲退出：没有正在跑的轮次、没有待答的审批和问题、也没人在看，持续 N 分钟后调用 `appExit(0)`，把会话放出来。
  - 发现用户自己的 DSH（装了插件的 Desktop 注册上来，或 AgentKib 看到 DSH Desktop 的进程）、并且后台空闲时，立即退出，把会话让给 Desktop。
  - 兜底：标准输入关闭，或与 AgentKib 的连接断开超过约 30 秒时，自己退出。
- **就绪与版本**：启动前做版本检查；启动后等插件注册（约 1–2 秒），历史读取失败时重试几秒。
- **退出 AgentKib**：后台还有轮次在跑时，并入现有的退出确认。
- **DSH 没开时打开 DSH 会话**：按需启动 DSH 后读历史，不新增依赖。
- **界面**：
  - 输入框里"DSH 没有运行"的提示，改为说明会自动启动。
  - 连接面板显示后台进程的状态。
  - 在 DSH Desktop 里安装插件改为可选但推荐。装了以后，Desktop 开着时也能从 AgentKib 控制它正在用的会话，AgentKib 也能及时把会话让给它。

## 待定规则

1. 空闲多久停。建议 3 分钟：后台进程约 200 MB，而且它占着会话时 Desktop 没法继续。
2. 退出 AgentKib 时后台还有轮次在跑：现在就停（这一轮记为中断），还是让它跑完再自己退出（跑完前遇到审批就停）。
3. 后台是否叠加 Desktop 的设置。建议叠加。
4. “需要时自动启动 DeepSeek Harness”开关的默认值。建议默认开启。
5. DSH 没开时打开 DSH 会话，是否自动启动。建议自动启动。

## 剩余风险

- 实验在空白沙箱里做，用户真实的配置（会话和插件更多）启动可能更慢。需要在真实环境里量一次；那会占用真实的 `~/.dsh`，要单独征得同意。
- DSH 仍是预览版，命令行参数、配置组合、写入锁和 `appExit` 等以后都可能变化，靠版本检查和插件上报的服务兜底。
- 两个 DSH 同时运行时的交接，只在两个命令行进程之间验证过，没有用 DSH Desktop 本身验证，以免影响用户正在用的 Desktop。
