# E2 沙盒交互验收清单

此文件是截图探针的覆盖清单，最终结果由本批 QA 记录统一汇总

## 隔离与准备

- 只使用新建的 `/private/tmp/agentkib-v15-e2-*` 所有权目录
- 独立设置 HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、AGENTKIB_BENCHMARK_DATA_DIR、AGENTKIB_BENCHMARK_USER_DATA，同时隔离 XDG 和 AgentKib 共用资产目录
- 原生会话、工作区、指令和应用偏好全部为合成输入；不提供真实 CLI 或账户
- Seatbelt 禁止非回环网络、真实个人数据目录和密钥目录读取；Electron 额外禁止外部导航、外部应用和 Keychain 操作
- `prepare` 只准备文件；当前构建完成后才能运行 `discover`、`ready` 和界面
- `discover` 经真实后端读取合成 Claude 历史并登记四个工作区；Antigravity 只配置合成目录、不提供 ACP，从真实后端产生来源不可读结果
- `ready` 经真实后端准备 manifest 并保存为合成磁盘输入；界面主流程继续调用原生产 IPC
- `locale` 仅在应用关闭后切换合成偏好；`disk-conflict` 外部修改合成 manifest，验证真实冲突检查
- 不替换生产 IPC handler 或结果；生成中等暂态若需暂停，仅使用独立测试探针，结果另行标明

## 功能与截图对应

| 用户行为或状态         | 功能检查                                                       | 视觉证据                          |
| ---------------------- | -------------------------------------------------------------- | --------------------------------- |
| 打开重复指令工作区诊断 | 真实 CLAUDE.md 与 AGENTS.md 相同，问题标题、影响、建议已本地化 | zh-CN 默认折叠                    |
| 展开检查结果和详情     | 正常格浅色、异常格突出，不出现数值比；英文原文只在详情里       | zh-CN 展开                        |
| 编辑共享项目指令并审查 | 草稿保留，计划默认选首个改动文件，按用途分组，风险说明可见     | zh-CN 1360×860 首屏，底栏完全可见 |
| 正在生成计划           | 仅一个状态，资产编辑只读，应用不可用                           | generating                        |
| 计划生成后再次编辑     | 仅失效状态，重新生成前应用不可用                               | stale                             |
| 外部修改磁盘 manifest  | 两个冲突处理入口，保留草稿或磁盘版本都有明确结果               | conflict                          |
| 应用变更               | 原文件备份、真实磁盘更新、重新诊断，新生成文件不制造警告       | applied                           |
| 全局会话目录           | 多工作区只在顶部出现一条完整来源失败，重试为蓝色且禁重复点击   | catalog source notice             |
| 工作区会话页           | 来源失败保持一条，未使用来源保持中性                           | workspace source notice           |
| 英文、日文概览         | 共用资产折行无行首分隔点                                       | en-US、ja-JP overview             |
| 其他三语诊断与计划     | 不溢出，无英文原句泄漏，底栏可用                               | zh-TW、en-US、ja-JP doctor、plan  |

## 额外边界

- 生成后修改草稿并重新生成，确认新计划覆盖旧计划且选择文件仍合理
- 冲突时先保留草稿，确认需重新生成；使用磁盘版本后不继续写入旧草稿
- 应用后关闭提示、生成新计划、离开工作区，确认提示生命周期
- 展开长路径或切换窄内容区后，不产生横向页面溢出

## 截图前隐私检查

检查可见文本与截图：不得出现真实用户名、本机仓库路径、原生真实会话、账户、凭据或局域网地址
所有项目路径应显示为 `~/projects/…`；截图原始文件先保存在任务拥有的输出目录，核对后再放入 QA 证据目录

## 本轮实际取证说明

- 窗口真实初始尺寸为 1360×860，普通计划 Apply 矩形为 x=1210.30、y=728、w=108.70、h=36，首屏完整可见
- 干净流程：应用前 1 项重复指令警告；应用 9 个文件、备份 3 个原有文件；重新诊断解决 1 项，出现已在计划提前说明的 DeepSeek 引用兼容警告
- 冲突流程：外部修改合成 manifest、保留草稿后，应用前实际有 10 项警告（重复指令 1 项 + 9 个 Agent 的 expected-content-missing）；应用后解决 10 项，保留预告的兼容警告。不能把注入引发的额外警告当成干净流程结果
- 生成中截图仅对真实 changes.plan 的原始响应加 3500ms 延迟；只读交互另用 5000ms 延迟，编辑标签因祖先 fieldset 禁用而不能操作。没有替换请求、结果或生产 IPC handler
- 统一目录与工作区会话页均只出现 1 条 Antigravity 来源提示，统一目录完整换行；真实重试后仍 1 条。computed color 为 rgb(40, 90, 224)，与 --primary-text #285ae0 一致
- 四语截图均使用合成文件和会话，用户输入内容不作为界面文案翻译。CJK 诊断未泄漏英文原句，原始英文证据只在“详情”中
- 所有应用进程只按各探针 root 的实际 PID 清理；截图 helper 正常请求退出后复核，不将键盘退出动作本身当作清理成功
- 英文单数语法已用最终 renderer 重拍，实际为 added 1 shared instruction line，分号后为小写 write；英文 Apply 矩形为 x=1190.96、y=728、w=128.04、h=36

## 已核验的交付截图与证据

截图保存于 `qa/screenshots/v15-e2-2026-10-23/`，共 19 张，均为 1360×860 的合成数据实拍

- `en-US-doctor.png`
- `en-US-overview.png`
- `en-US-plan.png`
- `ja-JP-doctor.png`
- `ja-JP-overview.png`
- `ja-JP-plan.png`
- `zh-CN-catalog-source-notice.png`
- `zh-CN-doctor-collapsed.png`
- `zh-CN-doctor-expanded.png`
- `zh-CN-plan-applied-clean.png`
- `zh-CN-plan-applied-conflict.png`
- `zh-CN-plan-applied.png`
- `zh-CN-plan-conflict.png`
- `zh-CN-plan-first-screen.png`
- `zh-CN-plan-generating.png`
- `zh-CN-plan-stale.png`
- `zh-CN-workspace-source-notice.png`
- `zh-TW-doctor.png`
- `zh-TW-plan.png`

JSON 证据：

- `clean-after-apply.json`
- `clean-before-apply.json`
- `clean-initial-diagnosis.json`
- `cleanup-evidence.json`
- `conflict-after-apply.json`
- `conflict-after-diagnosis.json`
- `conflict-before-apply.json`
- `conflict-pre-injection-diagnosis.json`
- `en-US-overview-wrap.json`
- `ja-JP-overview-wrap.json`
- `ui-validation.json`

`cleanup-evidence.json` 核对 5 个自有 fixture root，remaining_owned_pids 为空；本轮未创建 tmux。截图目录不包含私有 fixture 配置或启动参数
