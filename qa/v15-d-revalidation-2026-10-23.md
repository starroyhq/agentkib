# v15 D 收尾复验

## 范围与基线

- 基线为合入 #149 后的 main：`f4c3e30a736e8ce8c5224982bfb55935bc21d54e`
- 本机设计文件只读，依据 revision-plan 的 D 收尾补充复验记录及 handoff 对应“复验”四组要求；不复制或提交设计文件
- 仅处理预览无错时误显示 null、长名称来源/菜单、详情使用位置一致性、用量错误提示层级
- 记忆页、双层标签、MCP 安装作用域及长移除菜单属于“以后再设计”的观察项，不扩大范围
- 保留锁、路径、归属、指纹、权限、发送前占用及全部原超时预算；不改跨 Agent 继续、`handoff.*` 或 Codex follower
- 当前工作区的无关改动保留，实施在独立 `codex/v15-d-revalidation` 分支；实施与验证阶段不提交或推送，完成后用户授权提交并创建面向 main 的草稿 PR

## 验收清单（实测前建立）

| 要求 | 自动化回归 | 真实后端与画面 |
| --- | --- | --- |
| 无错预览不产生红色 null 或 alert | 四语 Loading→成功、空文本、仅目录/无文件，以及真实读取错误仍可读 | 项目与个人技能详情中均无 null alert，正文正常显示 |
| 长来源不挤掉路径 | 四语来源限宽、完整 title、查看/导入仍使用原身份 | 超过 100 字符工作区名称，来源最大 240px，路径有可见宽度 |
| 菜单不撑满卡片 | 四语最大 360px、视口上限、完整 title/无障碍名、Escape 焦点与原回调 | 测量稳定态实际宽度、单行省略；正常输入打开正确工作区 |
| 详情与卡片的肯定可见性一致 | 每条观察独立复用既有判断，正常别名/profile/Agent ID、未知与断链、managed 目标保持完整 | `.agents/skills` 的 Hermes/OpenClaw 不列为可见，原始诊断仍可读 |
| 不再显示正常“原生可见性：已检测到” | 四语详情断言保留路径和有效 Agent 列表，异常状态不丢失 | 两种技能详情截图；个人关联项目显示各自工作区名 |
| 用量主提示与原因有层级 | 四语正文色/次要色；窄匹配、详情、重试和概览行为保留 | 缺失合成 stats-cache.json，computed style 验证主提示正文色、原因灰色 |

探索验收包括长菜单关闭后的焦点恢复、多个项目指向同一个人技能时的行标识，以及受限观察不能被另一正常别名反向标成可见

## 实施与验证

### 修复内容

| 项目 | 根因与修改 | 回归覆盖 |
| --- | --- | --- |
| 预览误报 null | React Query 无错时的 `error` 为 `null`，旧判断只排除 `undefined`，最终被转换成字符串；`SkillFileBrowser` 改为排除两种空值 | 四语加载到正文、空文本、只有目录/无文件不产生 alert；真实读取错误仍显示 |
| 长来源与菜单 | 来源默认不收缩，菜单仅有视口上限；`SkillManagerPanels` 对来源加 240px 上限及内部省略，对共享操作菜单加 360px/视口双上限，路径占剩余空间 | 四语完整 title、无障碍名称、原 ID 查看/导入回调、菜单 Escape 焦点恢复与重新打开 |
| 详情使用位置 | 详情直接使用原始 agents，没有复用卡片判断；逐条调用既有 `skillObservationVisibility([item])`，避免正常个人别名把受限项目行重新标为可见；由 `SkillHubPage` 传入已有工作区列表取得名称 | 四语个人/项目名称、禁止/未知 Agent、原始诊断、坏软链和异常状态；独立正常 profile/原生 ID；受管理部署目标保持完整；实际页面接入工作区名称 |
| 用量错误层级 | `AgentUsagePanel` 主提示改为正文色，具体原因继续次要色，不改匹配和重试行为 | 四语颜色类；既有 ENOENT 窄匹配、权限/其他错误、原始详情、重试和概览断言保留 |

修改测试文件为 `SkillFileBrowser.test.tsx`、`SkillUsageList.v15.test.tsx`、`SkillManagerPanels.test.tsx`、`SkillHubPage.v15.test.tsx`、`AgentsPage.test.tsx`；同步更新 `docs/SKILLS.md` 与 `docs/UI-TERMINOLOGY.md`

没有增加用户文案或 locale 键；个人/项目、未知项目和异常状态均复用现有四语翻译，未改 `handoff.*`。Web 没有技能管理详情或 Agent 用量设置页，本轮不新增 Web 管理入口；协议、后端与镜像源码均未修改，Web 通过类型、构建与全量回归验证

### 自动化验证

使用临时 userconfig 设置 `manage-package-manager-versions=false`，隔离 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、应用数据及用户目录；测试组合使用各自全新 TMPDIR。未更改依赖、锁文件或任何测试超时

- 有效红测：五个修改过的测试文件，33 失败、192 通过，覆盖原始四组缺陷
- 修复后相同组合：`pnpm --filter @agentkib/desktop exec vitest run src/features/skills/SkillFileBrowser.test.tsx src/features/skills/SkillUsageList.v15.test.tsx src/features/skills/SkillManagerPanels.test.tsx src/features/skills/SkillHubPage.v15.test.tsx src/features/agents/AgentsPage.test.tsx --maxWorkers=1`，5 文件、225 项通过，8.71 秒
- `pnpm typecheck`：通过（backend、desktop、Web）
- `pnpm lint`：通过，0 error，275 条现有 warning
- `pnpm format:check`：通过，1026 文件
- 对五个修改的桌面测试文件运行 `oxfmt --check`：通过
- `node --check qa/probes/v15-d-finalize-sandbox.mjs`：通过
- `pnpm --filter @agentkib/desktop build:web`、`pnpm --filter @agentkib/web build`：通过
- `pnpm --filter @agentkib/desktop electron:build`、`pnpm --filter @agentkib/desktop cursor:stage`：通过；全量测试后再次恢复插件构建目录
- `pnpm test:web`：69 文件、1492 项通过，35.59 秒
- `pnpm --filter @agentkib/desktop test --maxWorkers=2`：短 TMPDIR 下完整重跑通过，407 文件通过、1 文件既有跳过，8264 项通过、3 项既有跳过，376.09 秒；包含原有 mcp-latency 阶段
- 完整重跑后 `electron:build`、`cursor:stage` 再次通过，插件构建目录恢复完成；仅匹配本次沙盒 desktop 路径的进程核对为空

新工作树开始曾尝试复用其他工作树的依赖，触发 pnpm 拒绝链接及重复 React 的测试环境错误；删除的仅为本工作树新建依赖目录，改为 `pnpm install --frozen-lockfile` 后独立安装，锁文件无变化。这些环境错误不计入产品红测证据。首次绿测中的菜单重开断言改用已有异步查询等待菜单挂载，没有加休眠、延长预算或弱化断言

第一次桌面全量为 406 文件通过、1 文件失败、1 文件既有跳过，8260 项通过、4 项失败、3 项既有跳过。四项均在 `cursor-native-recovery.test.ts` 的真实 macOS socket 测试，错误都是 `Cursor bridge socket path is too long`，由未修改的 `cursor-bridge.ts:276` 保护抛出：验证脚本误用系统默认长临时目录后，拼接出的 socket 路径为 108 字节，超过 104 字节限制。改为新建 `/tmp/adr-*` 隔离目录后路径为 70 字节，同一测试文件 18 项通过，784ms；没有修改生产路径保护、测试源码或断言。随后用短 TMPDIR 重新跑整个桌面组合全部通过，未只依赖局部重跑

### 真实 Electron 复验

扩展既有 `qa/probes/v15-d-finalize-sandbox.mjs` 的可选 `--scenario d-revalidation`，默认场景保持原样。增加一个 112 字符工作区及其 `.claude/skills/project-rules`；基本工作区含 `.agents/skills/api-checks`，个人目录含 `code-style`。探针经正式 plan → inspect → add 登记工作区，真实后端读取合成文件，未替换 IPC 返回值或放宽安全检查

本轮没有合成待审记忆，因为该项已在 #149 验收，不属于这四组剩余问题

| 检查 | zh-CN | zh-TW | en-US | ja-JP |
| --- | --- | --- | --- | --- |
| 来源徽标实际宽度 | 240px | 240px | 240px | 240px |
| 路径保留宽度 | 708px | 708px | 708px | 708px |
| 稳定态菜单宽度 / 项目高度 | 360px / 28px | 360px / 28px | 360px / 28px | 360px / 28px |
| 完整 title 与无障碍名称 | 保留 | 保留 | 保留 | 保留 |
| 菜单 Escape 焦点恢复 | 通过 | 通过 | 通过 | 通过 |
| 项目与个人预览 alert 数量 | 0 / 0 | 0 / 0 | 0 / 0 | 0 / 0 |
| 详情项目行具名、正常后缀省略 | 通过 | 通过 | 通过 | 通过 |
| 用量原始详情先收起、展开可读 | 通过 | 通过 | 通过 | 通过 |

默认原生窗口为 1360 × 860 CSS px，VTRON 浅色，未使用 Playwright 视口模拟冒充原生窗口。简中实际点选长名称“打开工作区”，到达对应工作区并核对完整标题；四语自动化另验证原始回调身份。来源内容的 scrollWidth 为 685/685/701/732px，实际可用 222px，computed `text-overflow: ellipsis`；菜单位于 x=959 至 1319，未越出 1360px 窗口

四语项目详情均仅列 Codex、Cursor、OpenCode、Grok Build、Antigravity、DeepSeek Harness，Hermes/OpenClaw 仅保留原始限制诊断。个人详情均显示个人行及两个具名项目行，个人路径保持完整。未显示正常“原生可见性：已检测到”，预览正文正常，页面没有独立 null 文本

四语用量主提示均为 `rgb(14, 20, 43)`，原因均为 `rgb(98, 106, 126)`，文字透明度均为 1。错误源为合成 HOME 中不存在的 Claude stats-cache.json，详情展开后保留真实 ENOENT。没有改动主题色值或错误语义

每语五种状态，共 20 张截图；简中五张及日文长菜单见 [截图索引](../docs/screenshots/v15-d-revalidation/README.md)，其他三语完整截图在本地忽略目录 `qa/screenshots/v15-d-revalidation/`。DOM 实测保存为 [computed-style.json](../docs/screenshots/v15-d-revalidation/computed-style.json)。捕获前核对所有内容为合成数据；页面无用户名、账号、密钥或真实用户路径，renderer pageerror 为 0

复用既有 Seatbelt 探针：环境五目录隔离、仅回环网络、拒绝探针枚举的真实用户目录与系统凭据访问，未登录或连接外部服务；不将其描述成拒绝所有 HOME 路径或 Chromium 渲染器沙盒。结束后仅清理自建 Electron PID，退出码 0，未结束其他应用或用户进程

### 独立复核与差异

- 独立源码复核：no finding，检查四组实现、调用方、回归、原生可见性隔离、受管理目标语义和探针安全边界
- 独立视觉复核：实际查看四语全部 20 张及日文原尺寸详情/菜单，no finding；截图只能证明视觉结果，焦点和完整名称由交互/DOM 检查与自动化另证
- 与本批设计无实质差异：采用建议的 240px/360px，个人项目关联选择逐行具名，保留路径和全部原始诊断
- 本轮只覆盖 macOS 默认窗口与 VTRON 浅色；没有重测 Windows、其他主题、窄窗口或真实 CLI。相关修改仅为桌面展示，未改变 CLI 行为或状态读取的新鲜度
- “以后再设计”四类观察继续保留；不改 designs、跨 Agent 继续、Codex follower、发送与任何内部安全保护
- 验证完成后用户授权提交、推送并创建面向 main 的草稿 PR，保持未合并；原有工作区无关文件未改动
