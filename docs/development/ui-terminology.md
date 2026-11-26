# 界面术语约定

本表用于桌面端与 Web 端的用户界面。按概念选择术语，不按字符串全局替换；API、类型名、存储字段、诊断码、命令和真实文件内容保持原名。局部字典与 `locales/*.json` 均可使用，文案是否完整取决于实际语言分支和调用键是否匹配。

## 状态呈现

1. 300 毫秒内的等待保持静默。
2. 单个控件保存、提交或刷新时原位反馈。可预览的值立即更新，等待超过 300 毫秒后在原图标位置显示进度。
3. 区域首次加载时，用与内容同构的骨架屏。只有超过 3 秒且有明确阶段或进度的长任务才显示进度文字。
4. 触发器只显示即将使用的一个值。历史值、生效时机和其他说明放在悬停提示或展开层。
5. 默认值用中性标签，尚无读数时保留字段名或空值。内部协议状态留给诊断。
6. 模态框打开时先显示稳定的外壳、标题和操作区。能取消的立即可取消，提交等到数据就绪。
7. 结果本身就是确认。复制等没有可见结果的动作，可以在原图标位置短暂显示勾号。
8. 界面文字用于名称和当前值、可恢复的错误、危险操作确认，以及确实阻塞的安全状态。远程界面只呈现远程可执行的操作。

## v15 术语表 v3（2026-10-21）

普通界面按下表说明用户能看到的内容和操作。简体、繁体同步采用新术语；英文和日文仅调整工程用语、含义不清或中英混杂的表达，原有自然用词保留。下表的英文 `Instructions`、`Hooks & Profiles` 和已有的 `No project`，以及日文“プロジェクトなし”“検出済み”，无需为了对齐中文而重译。

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| Agent 使用的指令 | 指令 | 指令 | 指示 | Instructions |
| 钩子与配置档入口 | 钩子与配置档 | 鉤子與設定檔 | フックとプロファイル | Hooks & Profiles |
| Agent 自己的目录中发现的资产 | Agent 目录中的资产 | Agent 目錄中的資產 | Agent フォルダー内のアセット | Assets in Agent folders |
| 共用的资产来源 | 共用资产 | 共用資產 | 共有アセット | Shared assets |
| 会话有可读取的历史 | 有历史内容 | 有歷史內容 | 履歴あり | History available |
| 只有会话信息，没有历史正文 | 无历史内容 | 無歷史內容 | 履歴なし | No history content |
| 没有归属工作区的会话分组 | 未归属工作区 | 未歸屬工作區 | プロジェクトなし | No project |
| 按 Agent 展示诊断结果 | 各 Agent 的检查结果 | 各 Agent 的檢查結果 | Agent ごとの検査結果 | Checks by Agent |
| 解析指令上下文的预览环境 | 预览环境 | 預覽環境 | プレビュー環境 | Preview environment |
| Agent 的 MCP 连接配置 | MCP 连接 | MCP 連線 | MCP 接続 | MCP connection |
| 将已审查的 MCP 连接写入 Agent | 同步到 Agent | 同步至 Agent | Agent に接続 | Connect Agents |
| 工作区诊断入口 | 诊断 | 診斷 | コンテキストの状態 | Diagnostics |
| Agent 的用户级配置 | 全局配置 | 全域設定 | グローバル設定 | Global settings |
| 技能状态已有检测结果 | 已检测到 | 已偵測到 | 検出済み | Detected |
| MCP 官方服务目录 | 官方目录 | 官方目錄 | 公式ディレクトリ | Official directory |
| 远程连接使用的账号 | 账号 | 帳號 | リモートアカウント | Remote account |
| 生成手机访问授权码 | 生成授权码 | 產生授權碼 | 認証コードを生成 | Generate access code |
| 远程访问的完整权限档位 | 完整控制 | 完整控制 | フルコントロール | Full control |
| 暂停手机远程访问 | 暂停远程访问 | 暫停遠端存取 | リモートアクセスを一時停止 | Pause remote access |
| 手机通过局域网直接连接 | 局域网直连 | 區域網路直連 | LAN 直接接続 | LAN direct connection |
| 提供远程连接的服务 | 连接服务 | 連線服務 | 接続サービス | Connection service |
| 发现局域网中的 AgentKib 电脑 | 附近的电脑 | 附近的電腦 | 近くのコンピューター | Nearby computers |
| 发起配对所用的码 | 配对码 | 配對碼 | ペアリングコード | Pairing code |
| 生成终端连接所用的码 | 生成连接码 | 產生連線碼 | 接続コードを生成 | Generate connection code |

MCP 页标题为“MCP 服务”，连接说明置于页头；折叠区使用“高级设置”，旁边始终显示灰字“官方目录、运行实例与网络”。选择 Agent 的菜单保留省略号，对话框标题使用“选择 Agent · {服务名}”。作用域以拉丁字母或数字结尾时，在中文后缀前留空格，例如“项目 northstar-api 里有 1 个服务”。“同步到 Agent”只同步已审查的服务中心连接，不表示安装 Agent、启用上游服务或改变工具分配；这些行为继续分别确认。“有历史内容”和“无历史内容”描述可读历史是否存在，不表示发送权限或运行状态；会话信息与原始文件缺失原因仍可查看。“未分类”保持原称。

“电脑（主机）”指运行 AgentKib 或 Agent 执行服务的电脑。普通界面不用“主机”：桌面本机写“这台电脑”，远端写“其他电脑”“对方电脑”或“已连接的电脑”；Web 操作指引写“电脑上的 AgentKib”，例如“请在电脑上的 AgentKib 里操作”，避免把浏览器设备当成执行端。技术详情中可以保留“主机 / Host”，网络权限中的目标主机、域名与原始协议字段也保留准确含义。普通提示改名不改变设备身份、配对、权限或发送前校验。

远程连接页分为“手机”和“其他电脑”，底部共用“高级设置”。手机首次设置按“登录账号 → 开启远程访问 → 连接手机 → 管理已授权的浏览器”推进；账号实际显示协议提供的用户名，不假定为邮箱。完成设置后显示浏览器列表与“连接新手机”，暂停和撤销需确认。授权码、配对码的位数只在输入格式或占位里体现，说明仍保留各自有效期和授权方式。立即生效的操作使用开关，需要“保存设置”才生效的项使用复选框；连接服务与程序路径需重新登记或重连，单独使用“应用连接设置”并保留风险说明。手机局域网和电脑之间的只读共享共用接口选择，不共用凭据或扩大权限。

## 变更与资产

v15 D 批将原 Agent 页移入“设置 → Agent 与集成”，页内标签为“Agent”和“集成”。首次从设置导航进入时默认打开 Agent；旧集成深链接仍定位到原集成功能。图标栏保留额度和洞察两个独立入口

技能页区分“技能库”“使用位置”“发现技能”：技能库为空且存在使用位置时默认展示使用位置。Agent 自己安装的技能集中说明只读，操作使用“查看”“加入技能库”；导入数量按实际可导入的物理位置统计，不把已管理部署和不可读位置算入。MCP 使用“全部作用域”“全局”“项目 {名称}”，汇总展示不构成新的写入作用域；逐 Agent 启用入口为行末“更多 → 选择 Agent…”

使用位置卡片只展示一个来源：“个人”或“项目 {名称}”，个人技能关联的工作区保留在“更多 → 打开工作区”。正常“已检测到”状态省略，异常状态与 Agent 标签分行；浅色 Agent 标签前写“可见于”，ⓘ 解释文件及配置可见性不等于运行中的 Agent 已加载。列表上方集中说明“这些技能由 Agent 自己安装，AgentKib 只读；导入技能库后可以统一管理”，只有存在已撤销部署时显示对应筛选

原生卡片的“可见于”不包含已确认禁止、尚待确认或无法核实加载的 Agent；限制原因分别使用“不会加载”“加载前需要确认”“无法确定是否加载”，原始诊断放在详情。独立正常别名、profile 或原生 Agent ID 的可见性保留，安装归属和只读说明不等于加载限制；坏软链不因所有权或恢复状态覆盖而变为可见。更多菜单的工作区名称保持单行，长名称视觉省略但完整名称可访问。资源库记忆计数正常为灰字，有待审记录时保留注意色

技能详情的原生使用位置沿用卡片的肯定可见性判断，省略正常“原生可见性：已检测到”后缀，保留异常状态和原始诊断；个人技能关联项目使用“项目 {名称}”，不重复显示无法区分的“项目”行。长来源徽标最大 240px，操作菜单最大 360px 并受视口限制；完整名称保持可访问

Agent 概览仅在有实际用量时展示用量卡片；不可用原因置于“用量”标签，主提示使用“暂时读不到 {Agent} 的用量”，不使用“数据源”或“Provider”。Claude Code 的本机 stats-cache.json 缺失时补充“未找到 Claude Code 的本机用量统计文件”，保留具体原因优先、原始详情和重试；不把权限或其他文件错误描述为文件缺失。能力已支持时只显示能力名称；控制标为“控制 · 实验性”或“控制 · 不支持”。用户级资产卡使用“全局配置”

用量错误的主提示使用正文色，具体原因使用次要文字色；原始错误继续放在可展开详情中，不把主提示和原因都弱化为灰字

路径仅在可信的本机主目录边界内缩写为 `~/…`，长路径可省略中段，悬停显示原路径。读取显示上下文失败时保留原路径，不猜测用户名或用户主目录；显示缩写不得作为打开文件、导入、同步或权限检查的输入。新增和修改的四语界面文案不加段尾句号，保留段内标点、命令和文件内容

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 尚未写入文件的一份完整计划，名词 | 变更计划 | 變更計畫 | 変更プラン | Change plan |
| 打开差异并检查计划，动作 | 审查变更 | 審查變更 | 変更を確認 | Review changes |
| 有计划等待用户处理，状态或入口 | 待审变更 | 待審變更 | 確認待ちの変更 | Pending changes |
| 将已审查的计划写入目标文件，动作 | 应用变更 | 套用變更 | 変更を適用 | Apply changes |
| 跨类型资产的全局入口 | 资源库 | 資源庫 | ライブラリ | Library |
| 资源库内保存技能的集合 | 技能库 | 技能庫 | スキルライブラリ | Skill library |
| MCP 服务与获准工具的统一连接入口 | MCP 服务中心 | MCP 服務中心 | MCP ハブ | MCP Hub |
| 单项能力 | 技能 | 技能 | スキル | Skill |
| 导入、预览、部署时处理的完整文件集合 | 技能包 | 技能套件 | スキルパッケージ | Skill package |
| 资产与配置的管理流程 | 资产管理 | 資產管理 | アセット管理 | Asset management |
| 有明确管理记录的资产或副本 | AgentKib 管理的… | AgentKib 管理的… | AgentKib が管理する… | … managed by AgentKib |
| 未取得上述管理关系的资产或副本 | 未由 AgentKib 管理 | 未由 AgentKib 管理 | AgentKib の管理対象外 | Not managed by AgentKib |

`ChangeSet` 是实现中的类型与数据对象；界面以“变更计划”称呼该对象，标题与按钮再分别使用名词、状态或动作。不能把“审查变更”用于表示已应用成功，也不能把“待审变更”用于表示未生成计划的编辑草稿。

“资源库”与“技能库”按所在层级区分；技能页面中的保存、版本、回收区与来源说明应明确指向技能库。“技能”与“技能包”按对象区分，不能把一次批量导入多个技能描述为一个技能包。`SKILL.md`、GitHub 仓库名和用户定义的技能名保留原文。

### E2：工作区诊断与变更计划（2026-10-23，10-24 收尾）

诊断页依次显示汇总、问题列表和默认折叠的“各 Agent 的检查结果”。汇总保留警告、错误、可自动修复数量及检查时间；刚完成的检查使用“检查于 刚刚”，英文统一为“1 warning · 0 errors · 0 auto-fixable · checked just now”，数量按单复数变化。读取失败时使用“未诊断”，包括仍保留上次缓存报告的情况，不能把旧报告或尚未取得的结果显示成当前零问题。工作区页头继续沿用错误、警告和待审记忆的统一状态口径，不把信息级说明计为问题

问题标题先说明实际文件及问题，保留磁盘上的文件名大小写；共享文件完全重复时使用“CLAUDE.md 与 AGENTS.md 内容完全相同”。影响句写出实际受影响的 Agent，例如“Grok Build 会读到两份相同的指令”，同一组文件影响几个 Agent 时一起列出。建议和按钮点名实际目的页：简体使用“查看指令上下文”，繁体对应既有侧栏“指令內容”，英文和日文也与各自侧栏标题一致；打开时直接选择问题对应的 Agent；原始证据、Agent 归属和校验依据放在“详情”中。“只支持诊断”等信息级条目默认折叠；“各 Agent 的检查结果”折叠行里的“需处理”数量使用注意色，展开后只有异常格着色，正常和不适用格保持浅色“正常”，不适用的原始状态仍可核对

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 重新读取工作区的诊断结果 | 重新诊断 | 重新診斷 | 再診断 | Run diagnostics again |
| 查看问题对应 Agent 实际读取的指令 | 查看指令上下文 | 查看指令內容 | 指示コンテキストを確認 | View instruction context |
| 刚完成的诊断时间 | 刚刚 | 剛剛 | たった今 | just now |
| 计划中将写入的目标列表 | 将写入的文件 | 將寫入的檔案 | 書き込み対象のファイル | Files to write |
| 面向各 Agent 的项目指令正文 | 共享项目指令 | 共用專案指令 | 共通のプロジェクト指示 | Shared project instructions |
| 由同一计划生成的 Agent 文件 | 各 Agent 配置同步 | 各 Agent 設定同步 | 各 Agent の設定同期 | Agent configuration sync |
| AgentKib 自己管理的索引和配置记录 | AgentKib 记录 | AgentKib 記錄 | AgentKib の記録 | AgentKib records |
| 将用户级文件纳入当前计划 | 包含全局配置 | 包含全域設定 | グローバル設定を含める | Include global configuration |
| 打开诊断证据文件所在的工作区内目录 | 打开所在文件夹 | 開啟所在資料夾 | ファイルのあるフォルダーを開く | Open containing folder |
| 真实磁盘修改与编辑草稿冲突的标题 | 磁盘上的配置被修改了 | 磁碟上的設定已被修改 | ディスク上の設定が変更されました | Configuration changed on disk |
| 明确放弃草稿并采用磁盘内容 | 放弃草稿，载入磁盘版本 | 放棄草稿，載入磁碟版本 | 下書きを破棄してディスクの内容を読み込む | Discard draft and load disk version |
| 保留当前编辑内容 | 保留草稿 | 保留草稿 | 下書きを保持 | Keep draft |

“你改了”只描述生成该计划时草稿的实际修改，不根据当前可能更新的编辑器内容推测，也不把自动生成的哈希变化称作用户编辑。单行预览去掉 Markdown 列表符号，中文使用全角括号，例如“你改了：共享项目指令新增 1 行（发布前更新 CHANGELOG）”；这只改变摘要显示，不改写用户指令。英文写入说明使用“9 files will be written when you apply”。诊断生成的修复计划说明待修复文件，不假定用户手动修改过共享指令

第一次接管时，已核实是导入共享指令的原有正文移进 AgentKib 托管区块，不在区块外再留一份；与共享正文完全相同的 CLAUDE.md 正文换成引用，独有正文仍保留在区块外一次。计划说明“原有内容会移进 AgentKib 托管的区块”，差异只把实际新增的托管标记和用户新加内容标为新增。只有部分重合、不能确认可移入的正文保留原样，并提前说明“这段会和共享指令重复”；应用后的诊断继续报告重复，不能仅因文件不再完全相同就称为解决。已经存在的区块外重复也需诊断并提供核对后手动处理的建议，不能未经确认删除用户内容

文件名使用工作区内相对路径，例如“.codex/config.toml”和“.grok/config.toml”，完整路径放在悬停提示；工作区内文件省略重复的第二行路径，外部文件仍保留可区分的路径信息。文件按用途分组不改变原风险级别；“中”说明会改写 Agent 读取的文件，“低”依实际目标说明是 AgentKib 记录还是 Agent 使用的文件，原有高风险和全局配置授权继续保留

“正在生成变更计划”“计划已失效”“与磁盘冲突”和“已应用”是互斥状态。失效表示草稿比计划新，需要重新生成；计划应用时的磁盘冲突继续提供“使用磁盘版本”和“保留我的草稿”，两者不能绕过应用前的文件指纹检查。刷新或重新进入工作区时，仅在磁盘内容真的改变且与草稿冲突时确认，标题和选项使用上表的明确表述；没有 manifest 时重新准备产生的临时身份变化不算磁盘修改。磁盘未变时直接保留草稿，选择“保留草稿”后未保存分区数也不应增加。草稿的原始比较基线与已确认过的磁盘快照分开保留，同一磁盘版本再次进入不重复确认，新的外部修改仍需确认

“已应用”只代表文件已经写入，重新诊断进行中、失败、有未解决项或出现新问题都需如实说明，不能因为写入成功就声称诊断正常。没有解决项且没有新问题时写“重新诊断：没有新问题”，不写“解决 0 项”；原有问题仍存在时写“仍有 N 项需关注”并提供“去诊断”。“查看本次变更”只读展示本次结果，侧栏待审变更数量为 0 时不显示数字

自动生成的校验信息可以折叠，但不能隐藏用户指令或无法可靠识别的内容。DeepSeek Harness 已独立、完整读取同目录 AGENTS.md 时，CLAUDE.md 中的独立 `@AGENTS.md` 只是未展开的文字，不表示共享指令丢失，只作为说明，不进问题列表或“需关注”计数；此时计划不显示兼容性警告。共享正文没有被该 Agent 完整读取，或暂时无法确认完整读取时，继续保留警告和计划中的提前说明；计划判断保留实际读取结果、全局内容占用的 64 KiB 预算、过滤和读取失败等限制，不能仅凭计划中有 AGENTS.md 就认定安全

路径缩写仅用于展示，诊断定位使用“打开所在文件夹”，只复用受控的工作区内目录操作；全局路径仍保留完整详情和指令上下文入口，不扩大文件访问权限

## 部署与双向同步

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 选择位置并建立部署 | 部署到… | 部署至… | 配置先を選択… | Deploy to… |
| 将技能库版本写入已有部署位置 | 更新部署 | 更新部署 | 配置を更新 | Update deployment |
| 将部署位置的修改保存到所属技能库 | 保存到技能库 | 儲存至技能庫 | スキルライブラリに保存 | Save to skill library |
| 已写入位置的一份技能包 | 已部署副本 | 已部署副本 | 配置済みコピー | Deployed copy |
| 移除 AgentKib 在该位置管理的副本 | 撤销部署 | 撤銷部署 | 配置を撤回 | Withdraw deployment |
| 恢复该部署的上一版本 | 回滚部署 | 復原部署 | 配置をロールバック | Roll back deployment |

“部署”和原文案中的“分发”指向相关的文件写入流程，但新建与更新不是同一个动作：

- `prepareSkillDeployment({ operation: "deploy", library_id, target_ids })` 选择位置、生成部署预览；其他部署操作以 `deployment_id` 标识已有位置。
- `prepareSkillSync({ operation: "push", deployment_id })` 将技能库版本同步到已有部署；`pull` 反向更新技能库。它们保留各自的预览、冲突选择、基线与确认规则。

因此，界面统一使用“部署”描述副本及其更新状态，以“部署到…”和“更新部署”区分动作；不再另用“分发”表示同一部署关系。“更新部署”的说明可写为“将技能库版本写入已部署位置”。保存到技能库不会暗示其他位置已经更新，部署成功也不代表运行中的 Agent 已重新加载技能。

行为依据见 `apps/desktop/src/features/skills/SkillManagerPanels.tsx`、`packages/backend/src/skill-manager.ts` 的 `prepareDeployment`、`packages/backend/src/skill-sync.ts` 的 `prepare`。界面文字调整不合并这些操作或改变授权。

## 会话与续接

D10、D11 的同 Agent 续接以“能否继续、在哪里运行”为准。用户直接输入，后台完成占用、锁、指纹、版本和平台检查；这些检查及未知结果的核对要求保留，不再要求用户手动交接执行权。

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 可选择、读取历史或控制的实体 | 会话 | 對話 | 会話 | Session |
| 操作入口 | 会话操作 | 對話操作 | 会話の操作 | Session actions |
| 重命名、归档等管理 | 会话管理 | 對話管理 | 会話の管理 | Session management |
| 空闲时的输入框占位 | 继续这条会话… | 繼續這段對話… | この会話を続ける… | Continue this session… |
| 发送后后台启动中的过渡状态 | 正在启动… | 正在啟動… | 起動中… | Starting… |
| AgentKib 后台进程正在运行 | 在 AgentKib 中运行 | 在 AgentKib 中執行 | AgentKib で実行中 | Running in AgentKib |
| Claude Code 终端已连接 | 在终端中运行 · 已连接 | 在終端中執行 · 已連線 | ターミナルで実行中 · 接続済み | Running in terminal · Connected |
| 跟随 Codex 桌面端 | 在 Codex 中运行 · 已连接 | 在 Codex 中執行 · 已連線 | Codex で実行中 · 接続済み | Running in Codex · Connected |
| 桌面端占着会话但没有窗口在用（发送时请它接上） | 在 Codex 中打开 · 发送时连接 | 在 Codex 中開啟 · 傳送時連線 | Codex で開いています · 送信時に接続 | Open in Codex · Connects when you send |
| 已连接的 DeepSeek Harness 会话空闲 | DeepSeek Harness 已连接 | DeepSeek Harness 已連線 | DeepSeek Harness に接続済み | Connected to DeepSeek Harness |
| 已连接的 DeepSeek Harness 正在执行当前轮次 | 在 DeepSeek Harness 中运行 | 在 DeepSeek Harness 中執行 | DeepSeek Harness で実行中 | Running in DeepSeek Harness |
| DeepSeek Harness 桥接未连接，无法确认原会话状态 | 实时状态未知 | 即時狀態未知 | リアルタイムの状態は不明 | Live status unknown |
| 已连接终端的列表徽标 | 终端 | 終端 | ターミナル | Terminal |
| 列表里有审批或提问在等 | 等待你 | 等待你 | 対応待ち | Needs you |
| 连接的终端正在跑一轮 | 在终端中运行 | 在終端中執行 | ターミナルで実行中 | Running in terminal |
| Codex 应用等其他客户端正在跑一轮 | 在 {agent} 中运行 | 在 {agent} 中執行 | {agent} で実行中 | Running in {agent} |
| 分组标题里正在运行的数量 | {n} 个运行中 | {n} 個執行中 | 実行中 {n} | {n} running |
| 分组标题里在等的数量 | {n} 个在等你 | {n} 個在等你 | 対応待ち {n} | {n} need you |
| 已连接终端的审批与提问提示 | 审批和提问在终端中处理 | 核准和提問在終端中處理 | 承認と質問はターミナルで対応してください | Handle approvals and questions in the terminal |
| 正在别处使用且无法连接 | 正在 {agent} 中使用 | 正在 {agent} 中使用 | {agent} で使用中 | In use in {agent} |
| 外部占用时的主要操作 | 分支会话并继续 | 分支對話並繼續 | 会話を分岐して続ける | Fork and continue |
| 外部占用时返回该 Agent | 回 {agent} 继续 | 回 {agent} 繼續 | {agent} で続ける | Continue in {agent} |
| 平台、Agent 或版本不支持继续 | 仅可查看 | 僅可查看 | 閲覧のみ | View only |
| 使用已有客户端继续 | 在原客户端继续 | 在原客戶端繼續 | 元のクライアントで続ける | Continue in the original client |
| 复制执行电脑上的续接命令 | 复制续接命令 | 複製續接命令 | 再開コマンドをコピー | Copy resume command |
| Claude Code 连接设置向导 | 连接终端 | 連接終端 | ターミナルに接続 | Connect terminal |
| Claude 工具权限尚未取得原生确认 | 工具权限待确认 | 工具權限待確認 | ツール権限は未確認 | Tool permissions unconfirmed |
| 外部占用时打开插件安装指引（终端能接收从这里发的消息后才显示） | 安装连接插件，以后自动连接 | 安裝連線外掛，以後自動連線 | 接続プラグインをインストールすると、次回から自動で接続されます | Install the connection plugin to connect automatically |
| Codex 下一轮待发消息 | 待发队列 | 待發佇列 | 送信待ちキュー | Queued messages |

“会话”指实体，正文可称消息、内容或历史；用户输入、引用原文与文件正文不做术语替换。繁体界面使用“對話”，日文沿用“会話”，按地区自然表达保持各语言内部一致。英文实体统一为 `Session`，协议名与第三方产品的正式名称保持原样。

空闲时不显示额外状态徽标。等待你用琥珀色；启动中、运行中、已连接终端、跟随 Codex 桌面端、外部占用、仅可查看使用中性色或主色；首页、侧栏和详情沿用同一概念。首页和侧栏只显示主机已经报告、不必检查其他客户端的状态，和手机一致：等待你（琥珀色圆点）；一轮正在运行（转动的圆环，悬停写出在 AgentKib、终端还是 Codex 应用里运行）；终端（连接终端里空闲的 Claude Code）；仅可查看。AgentKib 的后台进程空闲驻留、只在别处打开、结果待核对和已归档的会话不显示；“正在 {agent} 中使用”在打开会话后显示。分组标题在会话数前标出在等和运行中的数量，收起时仍显示。侧栏用圆点时，悬停及无障碍标签写出对应状态；仅可查看不增加运行圆点。同一个原因在一屏只说明一次。客户端版本、会话 ID、来源文件放在“会话操作 → 会话详情”，输入区不堆放这些技术信息。

外部占用且暂时无法连接时，保留普通输入框及草稿，显示一行占用说明。`{agent}` 使用实际产品名（Claude Code、Codex）。桌面端可跟随时，页头显示已连接状态，并按当前执行能力开放发送。占用解除后自动恢复发送，分支仍可从会话操作菜单发起。只读时给出具体原因；校验中、未知操作结果、连接异常、缺少权限分别解释，不能统一当作平台或版本不支持，也不能承诺自动重发。

| 提示用途 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 外部占用选择 | 这条会话正在 {agent} 中使用。为避免两边同时写入，请选择： | 這段對話正在 {agent} 中使用。為避免兩邊同時寫入，請選擇： | この会話は {agent} で使用中です。同時に書き込まれないよう、操作を選んでください： | This session is in use in {agent}. To avoid both sides writing at once, choose: |
| 分支说明 | 原会话不受影响，新会话会标“分支自 {title}” | 原對話不受影響，新對話會標「分支自 {title}」 | 元の会話には影響しません。新しい会話には「{title} から分岐」と表示されます。 | The original session stays as is. The new one is marked "Forked from {title}". |
| 返回该 Agent 之后 | 这条会话在 AgentKib 中只读，{agent} 那边关闭后会自动恢复 | 這段對話在 AgentKib 中為唯讀，{agent} 那邊關閉後會自動恢復 | この会話は AgentKib では閲覧のみです。{agent} 側で閉じると、ここで続けられるようになります。 | This session is view only in AgentKib. You can continue here once it's closed in {agent}. |
| 已连接终端但不能从这里发送 | 在终端中继续这条会话，这里会同步显示 | 在終端中繼續這段對話，這裡會同步顯示 | この会話はターミナルで続けてください。ここにも同期して表示されます。 | Continue this session in the terminal. It stays in sync here. |
| 跟随时只能在 Codex 处理的请求 | 这项请求请在 Codex 中处理 | 這項請求請在 Codex 中處理 | このリクエストは Codex で対応してください | Handle this request in Codex |
| 只能在 DeepSeek Harness 作答的请求 | 这项请求请在 DeepSeek Harness 中处理。 | 這項請求請在 DeepSeek Harness 中處理。 | このリクエストは DeepSeek Harness で対応してください。 | Handle this request in DeepSeek Harness. |
| DeepSeek Harness 先答后的卡片 | 这项请求已经在 DeepSeek Harness 中处理过了。 | 這項請求已經在 DeepSeek Harness 中處理過了。 | このリクエストはすでに DeepSeek Harness で対応済みです。 | This request was already handled in DeepSeek Harness. |
| 跟随时不开放的操作 | 这项操作请在 Codex 中完成。 | 這項操作請在 Codex 中完成。 | この操作は Codex で行ってください。 | Use Codex for this action. |
| Codex 完全退出说明 | 只关掉 Codex 的窗口可能不够，完全退出应用后才能在这里继续 | 只關閉 Codex 的視窗可能不夠，完全結束應用程式後才能在這裡繼續 | Codex のウィンドウを閉じるだけでは不十分な場合があります。ここで続けるには、アプリを完全に終了してください。 | Closing the Codex window may not be enough. Quit the app completely to continue here. |
| Claude Code 后台自动结束 | 后台进程已结束，下次发送时会自动继续 | 背景程序已結束，下次傳送訊息時會自動繼續 | バックグラウンドプロセスを終了しました。次のメッセージ送信時に自動で続行します。 | The background process ended. It will resume automatically when you send your next message. |
| Claude Code 后台任务运行中（一项，有描述） | 后台运行中：{description} | 背景執行中：{description} | バックグラウンドで実行中：{description} | Running in the background: {description} |
| Claude Code 后台任务运行中（多项；会话列表） | {n} 个后台任务运行中 | {n} 個背景工作執行中 | バックグラウンドタスク {n} 件を実行中 | {n} background tasks running（一项时为 1 background task running） |
| 后台任务结束后 Claude Code 自己开始的一轮 | 后台任务有了结果，Claude Code 正在继续 | 背景工作有了結果，Claude Code 正在繼續 | バックグラウンドタスクの結果を受けて、Claude Code が続けています | A background task finished. Claude Code is continuing. |
| Claude Code 连续自动轮次超过上限 | Claude Code 连续自动运行了太多轮，AgentKib 已停止它和后台任务。发送消息即可继续。 | Claude Code 連續自動執行了太多輪，AgentKib 已停止它和背景工作。傳送訊息即可繼續。 | Claude Code が自動で何度も続けて実行したため、AgentKib がバックグラウンドタスクごと停止しました。メッセージを送ると続けられます。 | Claude Code kept starting turns on its own, so AgentKib stopped it and its background tasks. Send a message to continue. |
| 账户达到使用上限（输入框上方，随上限名称和重置时间） | 你已达到使用上限 / 已达到 5 小时使用上限，15:30 重置，重置后自动继续。 | 你已達到使用上限 / 已達到 5 小時使用上限，15:30 重置，重置後自動繼續。 | 利用制限に達しました / 5 時間の利用制限に達しました。15:30にリセットされます。リセット後に自動で続行します。 | You've hit your usage limit / You've hit your 5-hour limit · resets 3:30 PM · continues automatically after the reset. |
| 关掉重置后的自动继续 | 不自动继续 | 不自動繼續 | 自動で続行しない | Don't continue automatically |
| 这一次重置后自动继续（提示上的按钮） | 重置后自动继续 | 重置後自動繼續 | リセット後に自動で続行 | Continue automatically after the reset |
| 设置：达到使用上限后的默认做法 | 达到使用上限时，重置后自动继续 | 達到使用上限時，重置後自動繼續 | 利用制限に達したら、リセット後に自動で続行 | Continue automatically when a usage limit resets |
| DSH 额度用尽（随 DSH） | 当前请求的额度已用尽。 | 目前請求的額度已用盡。 | リクエストのクォータを使い切りました。 | Request quota exhausted. |
| 项目 Agent 等待使用上限重置（委派暂停原因） | 项目 Agent 达到使用上限，汇报会在它重置后继续送达。 | 專案 Agent 達到使用上限，回報會在重置後繼續送達。 | プロジェクト Agent が利用制限に達しました。報告はリセット後に届けられます。 | The Project Agent hit its usage limit. Reports go on once it resets. |
| Codex 执行策略（随 Codex 桌面端，按策略 ID 本地化） | 请求批准 / 帮我批准 / 完全访问权限 | 要求核准 / 代我核准 / 完整存取權 | 承認を求める / 代わりに承認 / フルアクセス | Ask for approval / Approve for me / Full access |
| DSH 权限预设（随 DSH，按预设 ID 本地化） | 仅可查看 / 工作区内修改 / 完全权限 / 自动审查 | 僅可檢視 / 工作區內修改 / 完整權限 / 自動審查 | 読み取り専用 / ワークスペース書き込み / フルアクセス / 自動認可レビュー | Read Only / Workspace Write / Full access / Auto review |
| Devin 权限模式（新建与会话设置，按模式 ID 本地化：auto / accept-edits / smart / dangerous） | 只读自动 / 自动接受编辑 / 智能批准 / 全部批准 | 唯讀自動 / 自動接受編輯 / 智慧核准 / 全部核准 | 読み取りのみ自動 / 編集を自動承認 / スマート承認 / すべて承認 | Read-only auto / Accept edits / Smart / Approve all |
| Devin 权限选择的标题 | 这一轮的权限（Devin 运行中不能询问你） | 這一輪的權限（Devin 執行中無法詢問你） | このターンの権限（Devin は実行中に確認できません） | Permissions for this turn (Devin cannot ask while it runs) |
| Devin 未登录（`devin-login-required`） | Devin CLI 还没有登录（Devin Desktop 的登录不能给 CLI 用）。在终端运行一次 devin auth login，再发送。 | Devin CLI 尚未登入（Devin Desktop 的登入無法給 CLI 使用）。在終端機執行一次 devin auth login，再傳送。 | Devin CLI にログインしていません（Devin Desktop のログインは CLI と共有されません）。ターミナルで devin auth login を一度実行してから、もう一度送信してください。 | Devin CLI is not logged in (Devin Desktop's login is not shared with the CLI). Run devin auth login once in a terminal, then send again. |
| Devin 工作区未信任（`devin-workspace-untrusted`） | Devin 还没有信任这个工作区。在终端进入这个目录运行一次 devin 并选择信任，再发送。 | Devin 尚未信任這個工作區。在終端機進入這個目錄執行一次 devin 並選擇信任，再傳送。 | Devin はまだこのワークスペースを信頼していません。ターミナルでこのフォルダーに移動して devin を一度実行し、信頼を選んでから送信してください。 | Devin does not trust this workspace yet. Run devin once in this folder in a terminal and choose to trust it, then send again. |
| 找不到 Devin CLI（`devin-cli-unavailable`） | 没有找到 Devin CLI。安装 Devin CLI 或 Devin Desktop 后可以继续。 | 找不到 Devin CLI。安裝 Devin CLI 或 Devin Desktop 後即可繼續。 | Devin CLI が見つかりません。Devin CLI または Devin Desktop をインストールすると続行できます。 | Devin CLI was not found. Install Devin CLI or Devin Desktop to continue. |
| Devin 会话在别处打开（`session-open-elsewhere`） | 这条会话正在 Devin Desktop 或终端里打开，关掉那边后再从这里发送。 | 這個對話正在 Devin Desktop 或終端機中開啟，關閉那邊後再從這裡傳送。 | このセッションは Devin Desktop またはターミナルで開かれています。そちらを閉じてから、ここから送信してください。 | This session is open in Devin Desktop or a terminal. Close it there, then send from here. |
| Devin 不收附件（`attachments-unsupported`） | Devin 只能从这里接收文字，不能带图片或文件。 | Devin 只能從這裡接收文字，無法附帶圖片或檔案。 | Devin はここからテキストのみを受け取れます。画像やファイルは添付できません。 | Devin takes only text from here, without images or files. |
| Devin 这一轮失败（`devin-run-failed`） | Devin 没能完成这一轮。可以稍后重试，或在终端运行 devin 查看原因。 | Devin 沒能完成這一輪。可以稍後重試，或在終端機執行 devin 查看原因。 | Devin はこのターンを完了できませんでした。後でもう一度試すか、ターミナルで devin を実行して原因を確認してください。 | Devin could not finish this turn. Try again later, or run devin in a terminal to see why. |
| Devin 的进程在没人停止时被结束（`devin-run-stopped`） | Devin CLI 的进程在这一轮完成前被结束了。可以再发送一次。 | Devin CLI 的程序在這一輪完成前被結束了。可以再傳送一次。 | このターンが終わる前に Devin CLI のプロセスが終了しました。もう一度送信できます。 | The Devin CLI process was ended before this turn finished. You can send again. |
| Devin 结束后找不到会话（`devin-session-not-found`） | Devin 结束了这一轮，但没有找到它保存的会话。 | Devin 結束了這一輪，但找不到它儲存的對話。 | Devin はターンを終えましたが、保存したセッションが見つかりません。 | Devin finished the turn, but the session it saved was not found. |
| Devin 打开终端的按钮（仅桌面，未登录或未信任时） | 在终端登录 Devin CLI / 在终端信任这个工作区 | 在終端機登入 Devin CLI / 在終端機信任這個工作區 | ターミナルで Devin CLI にログイン / ターミナルでこのワークスペースを信頼 | Log in to Devin CLI in a terminal / Trust this workspace in a terminal |
| Devin 终端已打开 | 已在 {terminal} 中打开，完成后回到这里再发送。 | 已在 {terminal} 中開啟，完成後回到這裡再傳送。 | {terminal} で開きました。終わったらここに戻って送信し直してください。 | Opened in {terminal}. When you are done, come back and send again. |
| Devin 达到使用上限（还没有或读不出重置时间；读出后同 Claude Code、Codex 的上限提示） | 已达到每周使用上限。请稍后再试。/ 你已达到使用上限。请稍后再试。 | 已達到每週使用上限。請稍後再試。/ 你已達到使用上限。請稍後再試。 | 週間の利用制限に達しました。後でもう一度お試しください。/ 利用制限に達しました。後でもう一度お試しください。 | You've hit your weekly limit. Try again later. / You've hit your usage limit. Try again later. |
| 后台任务开关（本机 Claude Code 会话的“更多操作”） | 允许 Claude Code 在后台运行任务 | 允許 Claude Code 在背景執行工作 | Claude Code にバックグラウンドでの実行を許可 | Let Claude Code run tasks in the background |
| 后台任务开关说明 | 命令、子代理和 /loop 这类定时任务可以在后台运行，结束或到点后 Claude Code 会自己接着处理；退出 AgentKib 会停止它们。改动在 Claude Code 下次启动时生效。 | 命令、子代理和 /loop 這類排程工作可以在背景執行，結束或到時間後 Claude Code 會自己接著處理；結束 AgentKib 會停止它們。變更在 Claude Code 下次啟動時生效。 | コマンドやサブエージェント、/loop などの定期実行をバックグラウンドで実行し、終わったり時間になったりすると Claude Code が自動で続けます。AgentKib を終了すると停止します。変更は Claude Code の次回起動時に反映されます。 | Commands, subagents and scheduled prompts such as /loop can run in the background, and Claude Code picks them up by itself when they finish or come due. Quitting AgentKib stops them. Changes apply the next time Claude Code starts. |
| 后台任务开关不可用：CLI 版本过低 | 需要 Claude Code {minimum} 或更新版本（当前 {version}）。 | 需要 Claude Code {minimum} 或更新版本（目前 {version}）。 | Claude Code {minimum} 以降が必要です（現在 {version}）。 | Requires Claude Code {minimum} or later (this computer has {version}). |
| Claude Code 中途外部打开 | 你在 Claude Code 里打开了这条会话，AgentKib 已停止，避免两边同时写入 | 你在 Claude Code 裡開啟了這段對話，AgentKib 已停止，避免兩邊同時寫入 | Claude Code でこの会話が開かれたため、同時に書き込まれないよう AgentKib を停止しました。 | You opened this session in Claude Code. AgentKib stopped to avoid both sides writing at once. |
| Windows Claude Code 原因 | Windows 上暂不支持在这里继续 Claude Code 会话 | Windows 上暫不支援在這裡繼續 Claude Code 對話 | Windows では、ここで Claude Code の会話を続ける機能はまだ使えません | Continuing Claude Code sessions here isn't supported on Windows yet |
| Codex 版本过低原因 | Codex 版本过低，升级后可以在这里继续 | Codex 版本過舊，升級後可以在這裡繼續 | Codex のバージョンが古いため、更新するとここで続けられます。 | Your Codex version is too old. Update it to continue here. |

Devin 一轮没有运行或没有完成的原因用 Devin 自己的说法写在输入框上方，桌面和 Web 一致；打开终端的按钮只在桌面端、只对未登录和未信任出现，AgentKib 只启动命令，Web 和手机只显示说明。达到使用上限的一轮不算失败，只显示使用上限的提示，不同时显示原因。碰到上限时先说“请稍后再试”；AgentKib 从 Devin 的 `/usage` 读出重置时间后，提示写出时间，和 Codex 一样有“不自动继续”“重置后自动继续”。

Claude Code 自动结束仅在用户停留期间真实回收进程时显示一次浅色提示，重新进入不重播。后台任务运行中、Claude Code 自己开始的一轮和连续自动轮次超过上限三种状态用同一位置（输入区上方）的浅色一行；超过上限的提示重新进入仍显示，直到下次发送。会话列表只在没有轮次运行时显示后台任务标记（圆点，不转动）；中途冲突显示信息提示；Codex 自动释放不显示结束提示。连接终端设置只在 macOS 桌面提供，入口为所选 Claude Code 会话的“更多操作 → 连接终端…”，不再在“会话操作”中重复提供。指引依次为“安装插件（只需一次）”“生成连接码”“在终端粘贴并回车”，安装与连接命令使用短按钮“复制”，无障碍标签区分具体命令。当前生产插件还不能接收从 AgentKib 发出的消息：已连接时输入区换成“在终端中继续这条会话，这里会同步显示”，发送与停止都在终端处理，跟随态不提供“停止”按钮；选择条在此之前不显示插件链接。AgentKib 后台执行的停止入口保留。Web 沿用现有能力提供复制续接命令与电脑上的 AgentKib 操作说明，不增加跨 Agent 功能。

连接终端对话框尚未连接时使用“未连接”，不将其描述为会话“仅可查看”。连接后徽标用“已连接”，正文用“已连接终端”；已连接、等待终端重新连接、连接码已过期及现有错误互斥显示，不与生成指引并列。未撤销绑定在终端退出或应用重启后继续保留，用中性图标及“等待终端重新连接”说明正常离线；已安装步骤折叠，提供“复制继续命令”“重新生成连接码”和“清除连接…”，不要求重用已消费的连接命令。明确清除成功后回到首次未连接指引，随后恢复终端不会自动连接。检查连接保留尚未到期的连接命令。已有绑定但初次检查尚未完成，或暂时无法检查时，提示“暂时无法核实终端连接状态”，不直接宣告断开；繁忙或控制暂不可用也不将已确认在线的连接改称断开。在线连接提供需确认的“断开”；已离线但仍有可撤销绑定时，保留需确认的“清除连接…”，确认说明写清用户可见结果：“清除后，这条会话在终端继续时不会再自动连接；以后要连接，需要新的连接码。”底层仍撤销该终端连接的凭据与未使用连接码，终端照常运行，AgentKib 停止同步。桌面指引不再要求用户回到当前对话框；Web 提示仍明确在“电脑上的 AgentKib”打开连接指引。平台版本提示使用代码要求的最低版本：“仅 macOS · 需要 Claude Code {最低版本} 或更高版本”。通过能力检查但尚未验证的版本以中性灰字说明“Claude Code {版本} 还没有验证过，同步显示可能不完整”，不使用警告色，不覆盖权限、缺口或结果未知提示。旧 CLI、旧插件、必需能力缺失分别说明下一步，不兼容时不显示连接命令；更高版本不自动开放发送或停止。输入区的权限模式风险采用可展开的简短说明，保留完整原生模式解释及“上次观察”区别，不更改审批或发送权限。移动端主要操作的触控高度至少为 44px。

同 Agent 续接的可见入口不再使用“交给 AgentKib”“交还原客户端”“待交接”“执行管理”“由 AgentKib 执行”“已连接原会话”“仅查看历史”“恢复执行”，连接指引不再称“原终端”，队列不再称“原客户端待发队列”。这些规则不要求改名 API、类型、诊断码或旧操作回执，也不改变资产管理中的“由 AgentKib 管理”概念。

跨 Agent 的“在其他 Agent 中继续”“交接文件”是独立功能，保留现有继续流程。v15 E 将会话页“更多操作”中的“在工作区续接”改为“在其他 Agent 中继续”，直接打开原有跨 Agent 继续对话框；内部 `handoff.*`、`sessions.*Handoff` 键和协议保持不变。工作区侧栏“继续工作”改为“会话”，首页、概览及工作区列表中的“打开会话”均进入同一个可输入的会话页面。保留“在原客户端继续”和 Codex follower。

工作区状态统一为“正常 / 需关注 N 项 / 未诊断”。N 为该工作区诊断的错误、警告和待审记忆总数，不计信息项；首页待处理总数以同一批配置问题加全部待审记忆计算，记忆单列，避免重复计数。尚未取得诊断或诊断读取失败时使用中性的“未诊断”；已知有待审记忆时仍显示其需关注数。未安装的 Agent 是中性状态，不算发现或会话来源异常。读不到已安装 Agent 的会话时点名来源，用中性文字与重试；只有同工作区、同 Agent 曾读到会话而这次失败时才用 warning。概览最近会话已有记录时不显示来源状态。待处理与待审批计数使用主题的 warning 色（复用现有 amber 值）。

### 会话操作对话框（2026-11-14）

“会话操作”和设置页用同一套版式：每一部分是一个带标题的分组，分组里的各行放在同一个带边框的卡片里，行内左边写名称和说明，右边放开关或按钮。桌面用应用的标准按钮尺寸；Web 在触屏上保留 44 px 的点按高度，用鼠标时与桌面一致。目录、命令这类长文本显示为一行，放不下时截断，悬停看全文，行尾是复制按钮，复制后短暂显示对勾。不常用的内容收在可展开的一行里，如 DeepSeek Harness 的“安装 AgentKib 插件”和“诊断”。委派暂停的原因用琥珀色，和“需要你处理”里的一致。往这个对话框里加新内容时沿用这些组件（`operation-layout.tsx`），不单独写一套间距和按钮。

### 工具详情（2026-10-27）

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 一轮中 Agent 改过的文件汇总 | 已修改 N 个文件 | 已修改 N 個檔案 | N 件のファイルを編集 | Edited N files |
| 展开或收起单个文件的差异预览 | 查看差异 / 收起差异 | 查看差異 / 收起差異 | 差分を表示 / 差分を閉じる | Show diff / Hide diff |
| 展开或收起一条工具记录 | 展开详情 / 收起详情 | 展開詳情 / 收起詳情 | 詳細を表示 / 詳細を閉じる | Show details / Hide details |
| 一轮的耗时，用于过程标题 | 用时 {时长} | 用時 {時長} | 所要時間 {時間} | Worked {duration} |
| 命令的非零退出码 | 退出码 {code} | 結束代碼 {code} | 終了コード {code} | exit {code} |
| 用户拒绝执行的工具调用 | 已拒绝 | 已拒絕 | 拒否済み | Declined |
| 输出预览只保留了末尾 | 输出已截断，只显示末尾部分 | 輸出已截斷，只顯示結尾部分 | 出力は切り詰められています（末尾のみ表示） | Output truncated; showing the end |
| 记录没有可显示的详情 | 这条记录没有可显示的详情。 | 此記錄沒有可顯示的詳情。 | この記録には表示できる詳細がありません。 | This record has no details to show. |
| 工具行的类型标签 | 运行、读取、修改、新建、删除、移动、搜索、网页、计划、切换模式、工具、MCP、子代理 | 執行、讀取、修改、新建、刪除、移動、搜尋、網頁、計畫、切換模式、工具、MCP、子代理 | 実行、読み取り、編集、作成、削除、移動、検索、Web、計画、モード切替、ツール、MCP、サブエージェント | Run, Read, Edit, Create, Delete, Move, Search, Web, Plan, Mode, Tool, MCP, Agent |

文件汇总和差异预览不用“变更”：“变更”专指变更计划（ChangeSet）。“已修改 N 个文件”只说明 Agent 在这一轮改过这些文件，不表示已经审查，也不提供撤销；“查看差异”只打开有界预览，不能写成“审查变更”。时长按语言格式化为“2 分 7 秒”“2m 7s”“2分7秒”，超过一小时只显示小时和分钟。增删行数显示为 `+a -b`，读屏读作“新增 a 行”“删除 b 行”，不只靠颜色区分。命令的退出码已在工具行显示时，展开内容不再重复；工具对话框单独显示内容时仍会写出退出码。工具对话框标题沿用“工具摘要”。

### 工作树与程序启动的会话（2026-10-29）

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 从仓库分出来的 git worktree | 工作树 | 工作樹 | ワークツリー | Worktree |
| 目录组头的工作树数量 | · N 个工作树 | · N 個工作樹 | · N 個のワークツリー | · N worktrees |
| 会话页的工作树标签 | 工作树 {名称} · {分支} | 工作樹 {名稱} · {分支} | ワークツリー {名前} · {ブランチ} | Worktree {name} · {branch} |
| 工作树文件夹已删除 | 工作树 {名称} · 已删除 | 工作樹 {名稱} · 已刪除 | ワークツリー {名前} · 削除済み | Worktree {name} · deleted |
| 无法检查工作树 | 工作树 {名称} · 状态未知 | 工作樹 {名稱} · 狀態未知 | ワークツリー {名前} · 状態不明 | Worktree {name} · status unknown |
| 工作区列表中工作树的说明 | {主检出} 的 git 工作树 {名称} | {主檢出} 的 git 工作樹 {名稱} | {メイン} の git ワークツリー {名前} | Git worktree {name} of {main checkout} |
| 由 SDK、`-p`、`exec`、后台任务或 `/loop` 启动的会话 | 程序启动的会话 | 程式啟動的對話 | プログラムが起動したセッション | Started by a program |
| 目录选项中的显示开关 | 显示程序启动的会话 | 顯示程式啟動的對話 | プログラムが起動したセッションを表示 | Show program-started sessions |

“工作树”与 Codex 中文界面的叫法一致，普通界面不写 worktree。工作树会话行和侧栏只放 lucide `Split` 图标，不加文字徽标；悬停和读屏写出名称、分支、路径和状态。已删除与状态未知用文字说明，图标变淡只作辅助，不只靠颜色或透明度区分。`GitBranch` 图标继续专指用户创建的分叉，两者不混用。主检出没有登记成工作区时，组名取主检出的文件夹名；连主检出都找不到时，组名旁加 `Split` 图标，悬停写“这是 git 工作树”。“程序启动的会话”指不是由人在客户端里开始的会话，不称“自动化”或“SDK 会话”；行上用 `Bot` 图标，开关默认关闭且不保存。

## 项目 Agent（2026-11-13）

| 概念 | 简体中文 | 繁體中文 | 日本語 | English |
| --- | --- | --- | --- | --- |
| 指挥其他会话的 Claude Code、Codex 或 DeepSeek Harness 会话 | 项目 Agent | 專案 Agent | プロジェクト Agent | Project Agent |
| 由项目 Agent 开出、派任务的 Codex 或 DeepSeek Harness 会话 | Worker | Worker | ワーカー | Worker |
| 项目 Agent 交给 Worker 的工作 | 任务 | 任務 | タスク | Task |
| Worker 的结果送回项目 Agent | 汇报 | 回報 | 報告 | Report |
| 开 Worker、派任务这件事（暂停和恢复的对象） | 委派 | 委派 | 委任 | Delegation |
| 设定入口 | 设为项目 Agent… | 設為專案 Agent… | プロジェクト Agent にする… | Make Project Agent… |
| 以后指挥项目 Agent 的个人助理（尚未提供） | 个人 Agent | 個人 Agent | パーソナル Agent | Personal Agent |
| Worker 的来源（列表与会话页） | Worker api · 委派自 〈项目 Agent〉 | Worker api · 委派自 〈專案 Agent〉 | ワーカー api · 委任元 〈プロジェクト Agent〉 | Worker api · Delegated by 〈Project Agent〉 |
| 需要用户处理的委派暂停（“需要你”里的一项） | 委派已暂停 | 委派已暫停 | 委任を一時停止中 | Delegation paused |
| 自动恢复委派期间 | 正在恢复委派 | 正在恢復委派 | 委任を再開中 | Resuming delegation… |
| 允许项目 Agent 替用户处理的事 | 项目 Agent 可以替你决定 | 專案 Agent 可以替你決定 | プロジェクト Agent に任せること | The Project Agent may decide |
| 让一个 Worker 不再归这个项目 Agent（会话保留） | 移出 | 移出 | 外す | Remove |
| 改动已设定的项目 Agent | 修改设定… | 修改設定… | 設定を変更… | Change settings… |

“Agent”仍指 Claude Code、Codex 这类产品；项目 Agent 是一个会话担任的角色，三级依次是个人 Agent、项目 Agent、Worker。Worker 与 Agent 一样在中文界面保留英文，日文写“ワーカー”。Worker 是会话列表里能看到的独立 Codex 或 DeepSeek Harness 会话，不能叫“子代理”，子代理在一个会话内部。简体中文写“汇报”，不写“回报”，避免读成收益；繁体中文写“回報”。给 Claude Code 看的工具名（`worker_*`）和汇报开头（`[AgentKib report]`）固定用英文。

## 保留与解释的技术概念

| 概念 | 用户界面的处理 |
| --- | --- |
| MCP、MCP Hub、Streamable HTTP | MCP 服务中心的技术别名为 MCP Hub；繁体、日文与英文名称见上表。页面常驻说明：通过同一连接向 Agent 提供已启用的服务和获准工具。保留 MCP、Hub 和 Streamable HTTP 的协议或技术名称，不将 Hub 归入资源库概念。传输类型、服务地址及配置键保持准确。 |
| 原生 / Native | 仅用于区分 Agent 自身提供的配置、队列、审批或续接能力与 AgentKib 提供的能力。首次相关说明应指出由哪个 Agent 提供，不将其改写成不受条件限制的“可用”。 |
| 电脑（主机） / Computer (Host) | 指运行 AgentKib 或 Agent 执行服务的电脑，与浏览器、手机等访问设备区分。普通界面按上文使用“这台电脑”“其他电脑”或“电脑上的 AgentKib”；“主机 / Host”仅用于技术详情及网络目标等精确概念。需要用户在电脑上操作时给出实际页面路径，不能提供浏览器中不存在的设置入口。 |
| 回执 / Receipt、指纹 / Fingerprint、UUID、哈希 / Hash | 在诊断详情、确认依据及恢复流程中保留精确含义；普通反馈优先说明是否完成、是否需要确认及下一步。标识值和诊断码保持原文。 |
| 核对 / Verify、Reconcile | 用于事实或结果尚未确认的操作。“结果待核对”不能改成“失败”或“成功”，核对结果不能表达成自动重发。 |
| Agent、Claude Code、Codex、GitHub、CLI、API、JSON、TOML | 产品名、协议名、工具名和文件格式按正式名称保留。普通技能项目不因代码中使用 `Skill` 类型而保留英文。 |

## 本轮应用范围与验证边界

UX-30 的范围为变更审查流程、资源库与技能管理的主要入口、以及桌面和 Web 会话局部文案中的上述概念。沿用现有键和类型，必要时为首次说明增加翻译键；不迁移字典架构，不改协议、持久化字段、权限或执行语义。

UX-31 当时补齐了旧工作区 Claude 面板及文件面板的四语文案、`managedText` 调用键与四语词条的匹配，以及远程 Web 设置简体文案中的繁体混字。工作区 Claude 入口现已迁移到通用会话页。检查语言分支是否落到简体、动态字符串键是否无法匹配而显示原文。已有完整四语分支的 `native-scope`、`question-form`、`native-decisions` 等组件不计为缺译。

验收以实际组件的 `zh-Hant`、`ja-JP` 渲染和关键操作文案为准，并回归 `zh-CN`、`en-US`；四语言键数量一致只能作为辅助检查。本轮不据此声称全仓所有文案或所有实机状态均已审计，也不恢复“约 170 处缺翻译”的旧统计。

D10、D11 会话无感续接（2026-10-19）更新本表“会话与续接”部分，取代早期 UX-30 中的手动执行交接术语。核对范围为桌面会话页、工作区 Claude 面板、Web 会话页，以及首页、目录、连接向导和会话详情；四语词条和实际渲染均需验证。真实 CLI、Windows 与真手机验收单独记录，不能由字典比对或合成测试替代。第 4 阶段记录见 `qa/session-continue-stage-4-validation-2026-10-19.md`。
