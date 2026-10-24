# E2 收尾沙盒验收清单

此清单在运行界面前建立，实际结果由本批 QA 汇总；待执行不代表通过

## 隔离和边界

- 复用已入库的 E2 离线夹具，另建 `agentkib-v15-e2-finalize-*` 自有临时根目录
- HOME、CODEX_HOME、CLAUDE_CONFIG_DIR、AGENTKIB_BENCHMARK_DATA_DIR、AGENTKIB_BENCHMARK_USER_DATA 五目录独立，另隔离 XDG、AgentKib 共用资产和 Electron profile
- Seatbelt 禁止真实个人数据、凭据和非回环网络；Electron 禁外部导航、Keychain 和外部应用，故不点“打开所在文件夹”
- 不登录，不启动真实 CLI，不调用模型；合成历史由真实后端读取，不替换生产 IPC、诊断、计划或应用结果
- 只在当前工作树完成本轮 renderer/backend/main 构建后取证
- 截图前核对可见文本不含真实用户名、本机路径或局域网地址；导出的证据将自有 HOME 显示为 `~`
- 通过 `v15-e2-finalize-ui.cjs` 额外记录实际自有 Electron 进程树，退出后核对包含后端在内的子进程，不将“发起退出”当作“已经清理”

## 本批功能与视觉覆盖

| 要求或用户控制       | 正常输入与可观察结果                                                      | 证据                                            |
| -------------------- | ------------------------------------------------------------------------- | ----------------------------------------------- |
| 相同指令首次接管     | 无 manifest 的 northstar-api，编辑共用项目指令新增一行，经审查和应用      | plan、applied、应用前后真实文件及诊断 JSON      |
| 导入移动而非复制     | 原正文在 AGENTS 托管块内仅一次，CLAUDE 只剩引用；差异原正文为未改动       | AGENTS 和 CLAUDE diff 截图与文件断言            |
| 部分重叠与历史重复   | 部分重叠保留并提前说明，既有块外重复保留真实诊断和处理办法                | 单元/集成测试；可构造时另拍截图                 |
| DeepSeek 真实来源    | Agent 自己读取 AGENTS 时引用是信息，不计问题；初始重复解决后正常          | doctor 信息展开、真实诊断 JSON                  |
| 无 manifest 草稿切换 | 编辑后切到其他工作区再回来，无确认、文本及未保存分区数不变                | 返回资产截图及文本断言                          |
| 真实外部磁盘修改     | 只外部写合成 manifest，再切换回来出现有明确后果的对话框                   | 磁盘冲突截图；保留草稿和载入磁盘的两条路径      |
| 相对路径文件列表     | 英文下 .codex/config.toml 与 .grok/config.toml 同时可辨，悬停保留完整路径 | en-US plan 首屏                                 |
| 诊断影响和导航       | 影响点名实际 Agent；查看指令上下文打开并选中该 Agent                      | doctor/context 截图与选中状态                   |
| 检查时间和矩阵       | 四语自然时间、英文统一计数；异常折叠计数使用 warning 色                   | 四语 doctor 截图、computed style                |
| 计划摘要             | 中文全角括号、去掉列表符号；英文文件数句自然；首次接管说明可见            | 四语 plan 截图                                  |
| 已应用反馈           | 无新问题、仍有问题、新问题和已解决计数分别准确，0 待审无徽标              | 四语 applied、相关状态回归                      |
| 概览诊断标题         | 与诊断页标题一致                                                          | overview 截图与文本断言                         |
| 会话索引来源状态     | 未在该工作区使用的失败来源为灰色；当前记录或旧成功计数时仍注意            | 实际未使用来源截图、四语 DOM 回归及持久计数回归 |
| 页面对齐和首屏       | 1360×860 首屏按钮完整，无非预期横向溢出，四语不漏原始英文                 | 全部截图及矩形/viewport JSON                    |

## 额外探索和现有能力

- 冲突后选择保留草稿，再次切换，确认分区数不涨、编辑仍可见、旧计划不能应用
- 应用完成后查看本次变更、关闭提示、切走，确认只读结果和提示生命周期
- 保留生成中、计划失效、磁盘冲突、已应用的互斥行为；真实速度看不到的暂态以已有延迟探针明确标注，不改结果
- 检查已有全局配置包含和 Home 审批入口，不通过界面验收触发真实主目录写入

## 已完成的真实取证

- 四语各使用独立的无 manifest 合成工作区，经真实编辑、审查和应用，均为应用前 1 项重复警告、应用 9 个文件、应用后 0 错误和 0 警告，已应用提示解决 1 项，没有新问题
- 原规则在 AGENTS 托管块内各出现一次，CLAUDE 中不再保留共享正文，仅通过 `@AGENTS.md` 引入；保留既有托管标记和生成说明句，不把“只剩引用”误写为物理文件只剩一行
- 英文两个 config 行均显示完整的工作区相对路径，其 CSS 位置分别为 y=477.75 与 y=513.75，高 36，完整路径保留在提示中
- 各语言实际窗口均为 CSS 1360×860，首屏应用按钮完整可用、无页面横向溢出；Retina PNG 为 2720×1720，不将两种像素尺寸混称
- 中文计划中原正文为未改动行，只新增托管标记和实际添加的规则；中文摘要使用全角括号，英文文件数句为 `9 files will be written when you apply`
- 无 manifest 草稿往返无确认、文本和 1 分区计数保留；外改后的首次检查发现同一版本重复确认，修复后使用全新夹具复验：单击一次保留即可退出，同一版本再次往返不弹，新外改仍会再要求确认，明确放弃按钮加载磁盘并清除草稿
- 概览标题与诊断标题一致，刚检查时显示“检查于 刚刚”；各 Agent 折叠计数使用 warning，查看指令上下文实际选中 Grok Build
- 四个工作区的未使用 Antigravity 来源均为灰色，computed color 为 `rgb(98, 106, 126)`；已使用来源的注意色由四语实际 DOM 及持久计数回归覆盖，不声称完成了真实 ACP 历史故障验收
- 真实零问题工作区再次编辑并应用 2 个文件，反馈为“重新诊断：没有新问题”，没有“解决 0 项”；查看本次变更只读、无应用按钮、Escape 返回正常
- 额外在自有夹具注入旧版块外重复：诊断 15 项警告（7 项托管漂移、8 项块外重复），从诊断问题卡审查并应用 1 个 manifest 修复后只解决 7 项漂移，仍如实显示“仍有 8 项需关注”。此故障注入场景与干净流程分开记录
- Seatbelt 对文档保留地址 `203.0.113.1:443` 的非回环连接实测为 EPERM；没有登录、模型请求、真实 CLI 或外部应用打开
- 部分重叠的真实边界另在 Atlas 合成工作区验收：CLAUDE 原有正文含共享规则和一条独立规则，计划提前写“這段會和共用指令重複 · CLAUDE.md”；应用后保留块外原文，独立规则只出现一次，真实诊断报告 3 项块外重复，未写成“解决”。该边界本来就要求手动处理，不和干净流程混称
- 最终导航 guard 构建后重新执行中文快速切换、单击保留、稳定返回、新外改再确认及放弃载入磁盘，均通过；繁体按钮和建议已与目的页“指令內容”一致，实际选中 Grok Build；日文诊断及概览均为“最終確認：たった今”
- 最后视检发现上下文页可编辑 input 不在 body.innerText 内，已补强截图 guard：同时本地检查可见非 password input 与 textarea 值，不输出原值，拒绝个人路径、裸露夹具路径和私网地址。中繁两张上下文图通过正常 UI 输入合法相对目录 `.` 并真实解析后重拍，不替换预览结果
- 已查看最终四语诊断、计划、已应用、来源状态及补录图，未发现新增布局错位、主操作裁切或个人路径；7 套自有夹具共启动 11 次应用，记录核对 57 个进程身份，全部正常退出，强制终止 0、剩余自有子进程 0、页面错误 0，未创建 tmux

## 最终证据

证据保存在 `qa/screenshots/v15-e2-finalize-2026-10-24/`，共 30 张 PNG，`ui-validation.json` 含 24 个通过的检查，`cleanup-evidence.json` 单列清理证据，`network-evidence.json` 单列非回环连接拒绝证据

- 导航与磁盘确认：`zh-CN-draft-round-trip.png`、`zh-CN-real-disk-conflict.png`、`zh-CN-kept-draft.png`、`zh-CN-disk-version-loaded.png`
- 最终目的页与时间文案：`zh-CN-context-agent.png`、`zh-TW-doctor.png`、`zh-TW-context-agent.png`、`ja-JP-doctor.png`、`ja-JP-overview.png`
- 部分正文边界：`zh-TW-partial-overlap-plan.png`、`zh-TW-partial-overlap-applied.png`、`zh-TW-partial-overlap-doctor.png`、`partial-before-apply.json`、`partial-after-apply.json`、`partial-after-files.json`
- 旧重复及零解决反馈：`zh-CN-existing-duplicate-doctor.png`、`zh-CN-existing-duplicate-plan.png`、`zh-CN-applied-remaining.png`、`zh-CN-applied-no-new-issues.png`

没有启动真实 CLI、真实账户或模型请求；没有点击会打开 Finder 的动作，没有覆盖 Windows/Linux 原生窗口。本轮没有为 Web 新增工作区管理页
