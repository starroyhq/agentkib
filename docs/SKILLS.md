# Skill management

Skill Hub separates the local library from the places where agents discover skills. Adding or updating a library package changes only the library by default. Explicitly authorized locations can follow accepted library versions automatically.

## Library and existing installations

**My Skills** contains library packages. **Usage locations** also shows personal and project installations discovered outside AgentKib. **Discover** retains the OpenAI catalog and public GitHub import.

An existing CC Switch installation or linked skill can be inspected and copied into the library. The original files, links and manager metadata remain untouched. An external installation is never adopted merely because its name or content matches a library package. Different sources may have the same display name; a collision at a native destination blocks deployment.

An external link that points to an AgentKib deployment remains visible under its own entry path and Agent filters. Details show the related locations without transferring ownership of the link.

For local Skills whose frontmatter contains a description but omits `name`, copy import uses the original directory name and preserves the original `SKILL.md` bytes. That name remains stable in library details, deployment and removal/restore, including when another package already uses the same display name. GitHub imports retain their existing metadata validation.

Local display names retain the existing 64 UTF-8-byte metadata limit. A separate safe library ID handles noncanonical directory names and collisions; it does not replace the displayed name or rewrite the source. An explicit invalid `name` is rejected rather than replaced by a directory fallback.

Package details include the entrypoint and supporting files, including custom resource directories, licenses, binary files and executable permissions. Text previews are bounded; binary resources show metadata. Previews do not execute package code or automatically load remote resources. Unsafe paths, internal links and private resources are reported rather than silently omitted from an import.

Complete copies also preserve empty directories used by package scripts. Empty-directory changes participate in content validation; existing packages without empty directories retain their previous content hashes.

Directory entries end in `/` in the package tree and change preview. Additions and removals of empty directories are included even when no file content changes. A binary version does not hide the readable text of the other version; each side retains its own content or metadata display.

Private resource checks cover every directory component as well as the filename. For example, `secrets/config.json` is excluded from both package previews and MCP asset reads.

Local filenames must have an unambiguous package-relative representation. For example, a literal backslash in a Unix filename is rejected so the preview cannot refer to a different file from the copied package.

## Batch import from local agents

In **My Skills**, use **Import from local agents** to select existing personal, project and external installations. Filter by agent, scope or name, and select or deselect all readable packages in the filtered list. The initial selection includes readable external packages. The dialog shows native restrictions, trust requirements and unverified visibility separately from whether the files can be copied; importing does not change those native settings.

Several entry paths that resolve to the same physical package are one import item, with all entry paths and related agents shown. An existing library snapshot with the same resolved source and content is skipped. Changed content at the same source becomes a new snapshot, and different sources remain separate even when their names or content match. The preview shows the allocated library ID; a new collision before application fails that item rather than replacing a package.

A damaged or unreadable old library snapshot is not a deduplication match. A healthy source can be copied under a new library ID, with the ignored snapshot's diagnostic shown in the preview. The old snapshot and source record stay untouched. Unsafe library-parent or destination paths still block the operation.

Skipped items are checked again against the reviewed library content and source record when applying. If a matching library snapshot was removed or changed after preview, that item fails and needs a new preview; other imports can still succeed.

Review the full batch before applying it. Each item shows its files, final library ID and ready, skipped or failed status. Batch previews expire after 15 minutes and retain their own snapshots, including when more than four packages are selected. Cancelling or expiring a preview clears its temporary files.

Concurrent preparations share preview retention checks. Single-package previews retain at most four snapshots, while batches keep their own items; both share the 1 GiB retained snapshot limit. Failed preparation releases its reservation so later previews can proceed.

Application reports each item's result independently. A failed item does not undo successful imports; use **Retry failed** to prepare a new preview for the failures. Repeating the same batch request during the current app run returns its existing result. After restarting, scan and prepare again; source and content matching prevents duplicate imports. If file installation succeeds but refreshing the catalog fails, the import remains successful and the refresh issue is reported separately.

Copying a CC Switch installation never changes its original directory, link or manager metadata. Imported packages remain in the library until deployed explicitly. Local copy imports retain their local source; AgentKib does not infer a GitHub repository from a package name or grant remote update access to the copied package.

## GitHub versions

GitHub installation downloads a complete package snapshot through GitHub's API and file endpoints. It does not create a local Git clone or run package code. Both during installation and for an existing GitHub library package, **Choose version** offers paginated tag and branch lists, or a 7–40 character commit SHA. The dialog shows the selected reference, and the preview resolves it to a full commit SHA and displays the commit identifier. A failure to read a version list is reported; it does not select the default branch instead.

Choosing another tag, branch or commit can upgrade, downgrade or switch the package's tracking branch while preserving its library ID, repository and package path. The selected version must still contain a valid Skill at that path. Each preview freezes the resolved commit and downloaded files, so later changes to a remote branch cannot change the content being reviewed. Tags belong to the repository; a new tag does not necessarily change every Skill in it.

If another request installs the same repository and package path during preparation or before application, the stale installation fails and needs a new preview. It does not create a second library ID or change the installed reference. Preparing the same source again updates the existing package; selecting another reference requires **Choose version**.

A failed package download stops scheduling new files and waits for in-flight downloads and file writes before clearing its temporary snapshot. The original error is reported after cleanup; remaining workers cannot recreate a discarded snapshot. An existing library package and its source record stay unchanged, and a fresh preview can retry the operation.

**Check updates** and ordinary **Update** continue to use the package's recorded reference. A branch checks its latest package content; a tag or commit stays on that selected reference and does not advance to a different tag automatically. Use **Choose version** to change the selection explicitly. Existing records without a reference type retain their previous resolution behavior; reading them does not migrate the record.

**Rollback** restores the previous package contents and source selection together, including the previous tracking branch or tag. The rollback action retains one previous version. Immutable package snapshots separately preserve accepted versions and synchronization baselines. A manual library rollback pauses upstream auto-update; a deployment rollback pins that location. Version changes reach only explicitly authorized, conflict-free following locations. Locally copied packages have no inferred remote versions and remain local snapshots.

A damaged current package can still be rolled back to a valid backup, including when local files exceed the package limits or `SKILL.md` is missing. Its directory is preserved as the previous backup without reading or following internal links. The current directory, its parents and the backup must still pass path safety checks, and the backup must pass complete package validation.

After recovery, updates and version changes can replace that damaged old backup. The current and candidate packages are still verified in full. The old backup must be a regular directory within safe parent paths. An existing accepted snapshot is reused without reading the obsolete contents; healthy history missing a snapshot, including legacy v1 records, is archived under the existing package limits before replacement. A missing entry point or known structural damage does not require admitting the directory as a valid Skill snapshot: physical transaction moves preserve it for compensation, without following internal links. I/O failures or changes during archival are reported. A failed commit restores the old backup; a successful commit retains the healthy former current package as the only previous version.

## Deploy, update and withdraw

Use **Deploy to…** to choose personal or project locations. The preview shows exact paths, file changes, shared visibility and conflicts. Personal writes require the existing separate Agent Home confirmation. Deployments use complete copies; they do not depend on a symlink back to the library.

Codex, Claude Code, Cursor, OpenCode, OpenClaw, Hermes, Grok Build and Antigravity CLI have native target adapters. Environment overrides and profiles are resolved on the host. OpenClaw project targets must be configured native workspaces. Hermes project skills may require native project trust; AgentKib does not grant trust automatically. Antigravity IDE skills can be inspected and imported, but the writable Antigravity target is the CLI.

For OpenClaw, an explicit workspace configuration takes precedence over `OPENCLAW_WORKSPACE_DIR`. Workspace configuration strings support native environment-variable substitution; unresolved variables block deployment rather than selecting a fallback directory.

OpenClaw workspace variables can come from the process environment, the active state directory's `.env`, or the configuration's `env.vars`, in that order. These files are read without executing a shell. The `default` profile uses the normal `.openclaw` directory, including when the profile name uses different capitalization.

OpenClaw project discovery reads the current `agents.entries` mapping and supports the legacy `agents.list` format. When both are present, `entries` takes precedence. OpenCode Skill permissions follow native key ordering and wildcard matching, with the last matching rule taking effect.

Native restrictions also include OpenClaw's per-agent Skill allowlists and OpenCode's local configuration layers and explicit environment overrides. An empty OpenClaw allowlist disables all Skills for that agent. Hermes project visibility requires the actual nearest Git root; trusting an ancestor does not make a nested project's Skill directory discoverable.

OpenCode's Claude compatibility sources respect `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_CLAUDE_CODE`. Its personal Claude compatibility directory remains `~/.claude/skills` when `CLAUDE_CONFIG_DIR` changes; AgentKib inspects that default location separately and does not claim that OpenCode reads the overridden Claude directory. AgentKib takes `CLAUDE_CONFIG_DIR` literally: `~` and `${VAR}` are not expanded, and a value that is not an absolute path without `..` is invalid, so Skills are read from the default directory and the personal Claude Code target cannot be written. Other agents and independently readable native locations retain their own visibility.

OpenCode compatibility inspection follows `.claude/skills` and `.agents/skills` from the selected project up to its nearest Git root. It includes hidden and nested Skill packages under those compatibility roots, with bounded traversal and link diagnostics. These additional observations retain their own entry paths and do not add writable targets or imply that every other agent can read them.

OpenCode inspection also includes `skill` and `skills` under its configuration directories, including `~/.opencode` and `OPENCODE_CONFIG_DIR`, plus the effective `skills.paths`. Later configuration layers replace earlier `skills.paths`; relative entries use the selected project session directory. These additional sources are read-only. `OPENCODE_DISABLE_PROJECT_CONFIG` removes project configuration sources from OpenCode visibility while retaining independently readable Home and explicit sources. Unresolved configuration is marked unverified, and reaching a scan limit produces an explicit warning.

OpenClaw excludes `~/.agents/skills` when using a non-default state directory or profile, unless that location is also an explicitly configured extra source or the state's own managed Skill directory. The target preview and observed usage locations use the same visibility rules.

| Agent           | Default personal location               | Project location                          |
| --------------- | --------------------------------------- | ----------------------------------------- |
| Codex           | `~/.agents/skills`                      | `.agents/skills`                          |
| Claude Code     | `~/.claude/skills`                      | `.claude/skills`                          |
| Cursor          | `~/.cursor/skills`                      | `.cursor/skills`                          |
| OpenCode        | `~/.config/opencode/skills`             | `.opencode/skills`                        |
| OpenClaw        | `~/.openclaw/skills`                    | `skills` in a configured native workspace |
| Hermes          | `skills` in the selected Hermes profile | `.hermes/skills`                          |
| Grok Build      | `~/.grok/skills`                        | `.grok/skills`                            |
| Antigravity CLI | `~/.gemini/antigravity-cli/skills`      | `.agents/skills`                          |

The dialog displays the resolved paths, including environment overrides. DeepSeek Harness remains read-only. These are deployment destinations; compatible and external discovery locations can be broader.

If a registered project overlaps a personal Skill directory, its overlapping project target is read-only. Use the personal target so Agent Home confirmation and deployment ownership remain consistent.

Several agents can discover the same physical directory. A shared location is one deployment, and the preview lists the agents that may discover it. **Withdraw deployment** removes only the unchanged AgentKib-owned copy at that location. It does not write native deny rules and cannot prevent discovery of another external copy.

Update deployments explicitly after updating their library package. Each deployment retains one previous version for rollback. External changes, an unowned destination or a legacy manifest conflict block replacement or withdrawal. A library package with active deployments cannot be removed until those deployments are withdrawn.

Updating a library package with local edits requires confirmation, including edits to its `SKILL.md` name or frontmatter. The update still uses the recorded source and stable library identity. File previews show both versions when a resource changes between a file and a directory.

The interface distinguishes files deployed successfully, visibility inferred from native rules, native configuration restrictions, pending project trust and unverified native loading. AgentKib does not start an agent or claim that a running session has reloaded a skill.

Deployment lists derive current readers from a fresh inventory, including aliases pointing to the deployed package. Changing a native visibility setting is reflected on refresh without rewriting the deployment receipt or its originally requested agents. An unreadable source is marked unverified; old reader lists are not reused as current evidence.

## Recovery and compatibility

Each physical target has an independent transaction and a result. Partial success is reported per target. Operations retain a durable journal, verify the reviewed hashes again before writing, and use backups outside native skill scan roots. Interrupted operations require recovery before the affected target can be changed again; retrying the same operation does not deploy twice.

For a location marked as requiring recovery, use **Recover operation** in Usage locations (or retry recovery in its result dialog). Recovery checks the original operation and either confirms its committed result or restores the prior package. External edits are preserved and reported; personal recovery retains the Agent Home confirmation. If recovery restored the prior state, prepare a new deployment to try the intended change again.

Before changing a project target, the manager saves a reservation in `.agentkib/skill-deployment-reservations.json`. The legacy manifest workflow respects this reservation even if the process stops before the final deployment receipt is written. Successful completion or recovery releases the reservation. Browsing does not create or migrate it.

Recovery requires Agent Home confirmation only when an unfinished personal target remains. Skipped or completed personal targets do not block recovery of project targets, and reading a completed operation's result does not modify native files.

The recovery dialog reloads unfinished targets after each attempt. Restoring the prior package also refreshes the derived asset catalog and records an audit event, even though the originally requested deployment remains unsuccessful.

Replacing a deployed directory with a symbolic link is reported as a change at its original location. It does not merge deployment records or transfer ownership to the external link destination, and other unchanged deployments remain manageable.

Project receipts live in `.agentkib/skill-deployments.json`; personal receipts live in AgentKib Home. Browsing does not migrate old records or take ownership of files. Existing `manifest.skills` continues to use its previous workflow. Its sources and outputs cannot overlap a Skill Hub deployment, including when applying a ChangeSet prepared before the deployment existed.

When a personal Agent Home overlaps a project, ownership follows the physical location. The project retains a versioned `.agentkib/skill-library-roots.json` reference to the owning library so legacy writers can still find its personal receipts after AgentKib Home changes. Creating this association is part of deployment, not browsing.

Project deployments also check personal ownership and pending reservations linked from other library roots. Switching AgentKib Home does not transfer ownership or permit a second receipt for the same location. Library removal checks the latest project records, including withdrawals made from another AgentKib Home; missing or unreadable records remain a reason to block removal.

Personal deployments check ancestor project receipts and reservations even when the project is absent from the current workspace list. A legacy ChangeSet containing only Home or application-data writes also checks and locks the projects containing its actual targets, including deployments created after its preview. It does not require write access to an unrelated source project.

New deployment records bind their package ID to the source library directory. A same-named package in another library cannot update that deployment. Older records without a verified source remain readable and support withdrawal and backup rollback, but cannot be updated or redeployed through an assumed source. Reading does not migrate them. The interface keeps deployments from other libraries separate from the current library's package usage.

Legacy manifest discovery and writes also respect deployments in nested projects. A parent workspace cannot adopt or rewrite instruction files inside a child workspace's managed Skill, including through an older prepared ChangeSet.

Personal targets record their associated library roots in the physical scope's `.agentkib/skill-personal-library-roots.json` before native writes. Other AgentKib Homes check those libraries' receipts and pending reservations as well. Reading does not create the index. Recovery of an operation that stopped before native activation does not claim a later copy merely because its content matches. A Git repository at the user Home does not turn personal receipts into workspace receipts.

The legacy workflow also checks this index when a project is registered after a personal deployment. The index does not mark its scope as a workspace; an unavailable associated library blocks writes because its ownership cannot be verified. If a project's receipt path overlaps the personal library's receipt path, project deployment is blocked to keep their records separate.

Each receipt file is limited to 4 MiB and 4,096 records, including withdrawn deployments. An operation that would exceed either limit fails safely and preserves the previous files and readable records.

Removing and re-registering the same physical project preserves deployment management. Browsing resolves the current project identity without rewriting its receipt; a successful deployment operation records the new identity. Default manifest discovery skips managed Skill packages and their operation backups, including any `AGENTS.md` resources they contain.

The manager is a local desktop feature. It does not add remote Web writes, cloud synchronization or native permission changes. Optional background updates run only while the desktop application or its tray process is running.

---

# Skill 管理

Skill Hub 将资源库与 Agent 实际读取的使用位置分开管理。默认情况下，添加或更新仅改变资源库。明确授权的位置可以自动跟随库中已接纳的版本。

## 查看与复制入库

“我的 Skills”展示资源库，“使用位置”同时展示个人和项目中的已有安装，“发现”保留 OpenAI 精选与公开 GitHub 导入。

CC Switch 等工具创建的目录或链接可以查看并复制入库。原始文件、链接和管理器元数据保持不变，不会按名称或内容自动接管。同名不同来源可在库内分别保存；原生目标目录重名时会阻止部署。

指向 AgentKib 部署的外部链接仍以自己的入口路径展示，并可按对应 Agent 筛选。详情会列出相关使用位置，不转移链接的管理归属。

本地 Skill 的 frontmatter 包含描述但省略 `name` 时，复制入库使用原目录名，并保留 `SKILL.md` 的原始字节。即使资源库已有同名包，该名称也会在详情、部署和移除恢复中保持稳定。GitHub 导入继续使用原有元数据校验。

本地显示名仍遵守既有的 64 UTF-8 字节元数据限制。非规范目录名及同名冲突通过独立的安全资源库 ID 处理，不替换显示名或重写来源。显式无效的 `name` 会被拒绝，不会回退为目录名。

详情展示正文和完整包文件，包括自定义资源目录、许可证、二进制及可执行权限。文本预览有大小限制，二进制展示元数据；不会执行包代码或自动加载远程资源。导入发现不安全路径、包内链接或私密资源时会报告，不会静默遗漏。

完整复制也保留脚本依赖的空目录，并将空目录变化纳入内容校验；不含空目录的已有包保持原有内容哈希。

目录在文件树和变更预览中以 `/` 结尾。即使没有文件内容变化，空目录的新增、删除也会列出。某一版本是二进制时，不会遮住另一版本的可读文本；前后版本分别展示正文或元数据。

私密资源检查覆盖文件名及每一级目录。例如 `secrets/config.json` 不会通过包预览或 MCP 资产读取接口暴露。

本地文件名必须能无歧义地表示为包内相对路径。例如 Unix 文件名中的字面反斜杠会被拒绝，避免预览内容与实际复制的文件不一致。

## 从本机 Agent 批量导入

桌面“资源库 → 技能”在技能库为空且使用位置有内容时，默认展示“使用位置”；显式页签和用户切换优先。空库页集中提供导入和浏览精选技能，不展示空筛选栏和检查更新。“同步设置”“同步记录”位于页头“更多”中；部署、撤销、恢复、版本与同步冲突的原有流程不变

可导入数量按实际可读的外部物理位置去重，不包含 AgentKib 所有的目录、已有活动部署或不可读位置。使用位置卡片只展示一次主路径，并保留其他入口及其 Agent、工作区关联；路径缩写仅用于显示，导入仍使用原观察记录和完整身份校验

在“我的 Skills”选择“从本机 Agent 导入”，可批量选择已有的个人、项目和外部安装。支持按 Agent、作用域或名称筛选，以及全选、取消全选筛选结果中的可读包；初始默认选中可读的外部包。原生禁用、待信任或未验证状态与文件能否复制分别展示，复制不会修改这些原生设置。

多个入口指向同一个真实包目录时，归并为一条导入项，并列出所有入口和关联 Agent。资源库已有实际来源与内容均相同的快照时会跳过；同一来源内容变化时保存为新快照。不同来源即使名称或内容相同，仍分别保存。预览展示分配后的资源库 ID；应用前出现新冲突时，该项失败，不覆盖已有包。

损坏或不可读的旧库快照不作为去重匹配。健康来源可使用新的资源库 ID 入库，预览会展示被忽略快照的诊断；旧快照及来源记录保持不变。库父目录或目标路径不安全时，仍会阻止操作。

应用时会重新核验已跳过项对应的资源库内容和来源记录。预览后对应快照被删除或发生变化时，该项失败并需要重新预览，其他导入项仍可成功。

应用前统一审查整批内容。每项展示文件、最终资源库 ID，以及可导入、已跳过或失败状态。批次预览有效期为 15 分钟，独立保留快照，选择超过四个包也不会相互淘汰预览。取消或过期后会清理临时文件。

并发准备共用预览保留检查。单包预览最多保留四个快照，批次独立保留其中的包；两者共用 1 GiB 的已保留快照上限。准备失败会释放占用，后续预览仍可继续。

应用结果逐项报告，失败项不撤销已成功的导入；通过“重试失败项”重新准备预览。当前应用运行期间重复提交同一批次请求会返回已有结果。重启后需重新扫描和准备，通过来源及内容匹配避免重复入库。文件安装成功但目录刷新失败时，仍报告导入成功，并单独显示刷新问题。

复制 CC Switch 安装不会修改原目录、链接或管理器元数据。导入后仅保存到资源库，需显式部署才能写入使用位置。本地复制包保留本地来源，不根据包名推断 GitHub 仓库，也不自动获得远程更新能力。

## GitHub 版本选择

GitHub 安装通过 API 和文件下载接口获取完整包快照，不创建本地 Git 克隆，也不运行包代码。安装时及已安装的 GitHub 资源库包均可通过“选择版本”使用可分页的 Tag、Branch 列表，或输入 7–40 位 Commit SHA。对话框展示所选引用，预览将其解析为完整提交 SHA，并展示提交标识；版本列表读取失败会显示错误，不改用默认分支。

选择其他 tag、分支或 commit 可完成升级、降级和跟踪分支切换，同时保持资源库 ID、仓库及包路径稳定。目标版本须在原路径中仍包含有效 Skill。预览固定解析后的 commit 及已下载文件，远程分支随后变化不会改变正在审查的内容。Tag 属于整个仓库，新 tag 不一定改变其中的每个 Skill。

准备期间或应用前，其他请求若已安装同一仓库及包路径，旧安装请求会失败并要求重新预览，不创建第二个资源库 ID，也不更改已安装的引用。重新准备相同来源会更新已有包；更换引用须使用“选择版本”。

包下载失败后会停止领取新文件，等待已开始的下载和文件写入结束，再清理暂存快照并报告原始错误，避免其他任务重建已清理的目录。已有资源库包及来源记录保持不变，可重新预览后重试。

“检查更新”和普通“更新”继续使用包已记录的引用。分支检查该分支的最新包内容；tag 或 commit 保持当前选择，不自动跳到其他 tag。更换选择须使用“选择版本”。缺少引用类型的旧来源记录沿用原有解析方式，读取不会迁移记录。

“回滚”同时恢复上一版本的包内容及来源选择，包括原跟踪分支或 tag。回滚入口保留上一版本；不可变快照另外保留已接纳版本和各位置的同步基线。手动回滚资源库会暂停该 Skill 的自动入库，回滚部署会固定该位置。版本切换仅向明确授权、没有冲突的跟随位置自动分发。本地复制包不推断远程版本，仍作为本地快照管理。

当前包损坏时仍可回滚到有效备份，包括本地文件超出包限制或缺少 `SKILL.md` 的情况。当前目录会保留为上一版备份，不读取或跟随其内部链接。当前目录及父目录、备份仍须满足路径安全要求，备份须通过完整包校验。

恢复后仍可更新或切换版本，替换损坏的旧备份。当前包和候选包仍须完整校验，旧备份须为安全父路径内的普通目录。已有接纳快照时直接复用，不读取旧备份内容；健康历史版本尚无快照时，包括旧 v1 记录，按既有包限制补齐归档。缺入口或已知结构损坏的目录不必成为合法 Skill 快照，由物理事务移动保留以供补偿，不跟随内部链接；真实 I/O 错误及归档期间的变化会明确报错。提交失败时恢复旧备份，成功后只保留更新前的健康当前包作为上一版本。

## 部署、更新与撤销

通过“部署到…”选择个人或项目位置，审查目标路径、文件变化、共享影响和冲突。个人目录写入保留独立的 Agent Home 确认。首版使用完整复制，不依赖指向资源库的软链接。

支持 Codex、Claude Code、Cursor、OpenCode、OpenClaw、Hermes、Grok Build 和 Antigravity CLI。后端解析环境覆盖与 profile；OpenClaw 项目目标须为原生配置的 workspace，Hermes 项目可能需要原生信任。AgentKib 不自动授权项目信任。Antigravity IDE 安装可查看、可复制入库，写入目标为 CLI。

OpenClaw 的显式 workspace 配置优先于 `OPENCLAW_WORKSPACE_DIR`。配置字符串支持原生环境变量替换；无法解析变量时会阻止部署，不选择其他目录代替。

OpenClaw workspace 变量按进程环境、有效 state directory 的 `.env`、配置 `env.vars` 的顺序取值，只读解析，不执行 shell。`default` profile 使用通常的 `.openclaw` 目录，名称大小写不影响该规则。

OpenClaw 项目发现读取当前的 `agents.entries` 映射，也兼容旧 `agents.list` 格式；两者同时存在时以 `entries` 为准。OpenCode Skill 权限按原生键顺序和通配规则匹配，最后匹配的规则生效。

原生限制检查也包含 OpenClaw 的各 Agent Skill 白名单，以及 OpenCode 的本地配置层和显式环境覆盖。OpenClaw 空白名单表示该 Agent 禁用全部 Skill。Hermes 项目可见性要求实际最近的 Git 根目录匹配；信任祖先仓库不会让子目录的 Skill 自动可发现。

OpenCode 的 Claude 兼容来源遵循 `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` 和 `OPENCODE_DISABLE_CLAUDE_CODE`。修改 `CLAUDE_CONFIG_DIR` 后，OpenCode 的个人兼容目录仍为 `~/.claude/skills`；AgentKib 单独查看该默认位置，不将自定义 Claude 目录误报为 OpenCode 可读。AgentKib 按字面使用 `CLAUDE_CONFIG_DIR`，不展开 `~` 与 `${VAR}`；值不是不含 `..` 的绝对路径时视为无效，此时从默认目录读取 Skill，Claude Code 的个人目录不可写入。其他 Agent 及独立可读的原生位置仍按各自规则展示。

OpenCode 兼容来源扫描包含从选定项目到最近 Git 根之间的 `.claude/skills` 和 `.agents/skills`，也包含这些兼容目录中的隐藏 Skill 和父包内嵌 Skill。遍历仍有边界限制及链接诊断。额外观察保留各自入口路径，不增加写入目标，也不将 OpenCode 的可读性套用到其他 Agent。

OpenCode 查看范围还包括配置目录下的 `skill`、`skills`，其中包含 `~/.opencode`、`OPENCODE_CONFIG_DIR`，以及最终生效的 `skills.paths`。后层配置整体替换前层 `skills.paths`；相对条目以选定项目的会话目录为基准。这些额外来源保持只读。`OPENCODE_DISABLE_PROJECT_CONFIG` 会从 OpenCode 可见性中移除项目配置来源，但保留独立可读的 Home 和显式来源。配置无法解析时标记未验证；扫描达到上限时明确提示。

OpenClaw 使用非默认 state directory 或 profile 时，不读取 `~/.agents/skills`；该位置被显式配置为额外来源、或同时是该 state 自有技能目录时除外。部署预览与使用位置采用一致的可见性规则。

默认路径见上表，部署对话框展示环境覆盖后的实际路径。DeepSeek Harness 保持只读。表内是写入目标，Agent 的兼容目录与外部来源可能使发现范围更广。Hermes 的项目技能还须处于 Git 项目内，并遵循所选 profile 的 `skills.trusted_project_dirs` 和 `skills.project_discovery` 配置；详见 [Hermes 官方技能说明](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills/#project-local-skills)。

如果登记的项目使项目技能目标与个人技能目录重合，重合的项目目标保持只读；请通过个人目标操作，以保留 Agent Home 确认和一致的部署归属。

多个 Agent 可能读取同一个目录，该物理位置只算一条部署。“撤销部署”只移除该处未被修改的 AgentKib 副本，不写入原生禁用规则；如果仍有共享或外部副本，Agent 仍可能发现它。

资源库更新后需显式更新部署。每条部署保留上一版本供回滚。外部改动、非受管同名目录或旧 manifest 冲突会阻止替换和撤销。有活动部署的资源库包须先撤销部署，才能移除。

资源库包有本地修改时，更新须确认覆盖，包括对 `SKILL.md` 名称或 frontmatter 的修改。更新仍校验已记录的来源和稳定资源库身份。资源在文件与目录之间转换时，预览可查看两个版本的对应内容。

“已部署”“按规则可发现”“被原生配置限制”“待项目信任”和“原生加载未验证”是不同状态。写入成功不代表运行中的 Agent 会话已经重新加载。

部署列表根据新的扫描结果计算当前读取方，并包含指向部署包的别名。修改原生可见性配置后，刷新即可反映变化，不重写部署记录或最初请求的 Agent。来源不可读时标记未验证，不用历史读取方代替当前证据。

## 恢复与兼容

每个物理位置独立执行并返回结果，部分失败逐项展示。持久操作日志记录进度，写入前复核预览时的哈希；备份位于原生技能扫描目录之外。中断操作恢复前不会继续覆盖受影响目标，重复请求不会重复部署。

位置显示待恢复时，可在“使用位置”选择“恢复操作”，或在结果对话框中重试恢复。系统会核对原操作，确认已提交结果或恢复之前的包；外部修改会保留并报告，个人位置仍需 Agent Home 确认。恢复到原状态后，如需继续原来的变更，请重新生成部署预览。

修改项目目标前，系统先在 `.agentkib/skill-deployment-reservations.json` 保存占用记录。即使进程在最终部署记录写入前中断，旧 manifest 流程也会识别该占用；操作完成或恢复成功后释放。浏览不会创建或迁移占用记录。

只有仍待恢复的个人目标需要 Agent Home 确认。已跳过或已完成的个人目标不会阻断项目目标恢复，读取已完成操作的结果不会修改原生文件。

恢复对话框在每次尝试后重新读取待恢复目标。恢复到原有包状态后，也会刷新派生资产索引并记录审计；原来请求的部署仍按未成功报告。

部署目录被替换为软链接时，系统按原位置报告变更，不合并部署记录，也不将外部链接目标认作受管安装；其他未被修改的部署仍可管理。

项目记录保存在 `.agentkib/skill-deployments.json`，个人记录保存在 AgentKib Home。浏览不迁移旧数据。旧 `manifest.skills` 保留原流程，但其源和生成目标不能与新部署重叠；应用旧 ChangeSet 时也会重新检查。

个人 Agent Home 与项目重叠时，按物理位置识别所有权。部署时在项目的版本化 `.agentkib/skill-library-roots.json` 中保留所属资源库引用，使切换 AgentKib Home 后的旧写入流程仍能找到个人部署记录；浏览不创建该关联。

项目部署也会检查其他资源库关联的个人所有权和待完成占用。切换 AgentKib Home 不会转移所有权，也不允许为同一位置新增第二条归属记录。移除资源库包时读取最新项目记录，包括从其他 AgentKib Home 完成的撤销；记录缺失或无法读取时仍会阻止移除。

个人部署也会检查祖先项目的部署和占用记录，即使当前工作区列表没有登记该项目。只包含 Home 或应用数据写入的旧 ChangeSet，同样检查并锁定实际目标所属的项目，包括预览之后新增的部署；不要求无关的来源项目可写。

新部署记录将包 ID 与来源资源库目录绑定，其他资源库的同名包不能更新该部署。未确认来源的旧记录仍可读取、撤销和从备份回滚，但不能通过猜测来源更新或重新部署；浏览不迁移记录。界面也不会把其他资源库的部署计入当前同名包的使用位置。

旧 manifest 的发现和写入同时保护嵌套项目的部署。父工作区不能接管或改写子工作区受管 Skill 内的指令文件，之前生成的 ChangeSet 在应用时也会重新检查。

个人目标在写入原生文件前，将来源库关联保存到物理作用域的 `.agentkib/skill-personal-library-roots.json`。切换 AgentKib Home 后，也会检查这些资源库的部署和待完成占用；浏览不会创建索引。尚未激活的操作在恢复时，不会仅凭内容相同认领后来出现的副本。用户 Home 本身是 Git 仓库时，个人记录仍按个人归属读取。

个人部署完成后才登记项目时，旧流程也会检查该索引。索引不会将其作用域标记为工作区；关联库失联时，因无法核实归属而阻止写入。如果项目部署记录路径与个人资源库记录路径重合，会阻止项目部署，避免混写两种记录。

每份部署记录文件上限为 4 MiB、4,096 条记录，包含已撤销的部署。操作若将超过任一上限，会安全失败并保留原有文件及可读取的记录。

移除并重新登记同一物理项目后，已有部署仍可管理。浏览只解析当前项目身份，不改写记录；部署操作成功后才记录新身份。默认 manifest 发现会跳过受管 Skill 包及其操作备份，包括其中的 `AGENTS.md` 资源。

本功能仅在本地桌面运行，不增加 Web 远程写入、云同步或原生权限修改。可选自动更新在应用运行或托盘驻留期间执行，真正退出后停止。

## Ownership and synchronization / 归属与同步

Library identity is the physical AgentKib library plus its stable package ID, never the display name. Each deployment records its origin (`agentkib`, `adopted`, or `legacy-unknown`) and its own accepted baseline. Reverse sync changes the original library package and advances only the source location's baseline. A GitHub source is retained, with its upstream baseline unchanged; ordinary update, selected-version update and automatic update all protect this local customization.

“仅复制入库”保留原有行为。“导入并纳入管理”只接管已发现、原生可写的普通目录；链接及额外只读来源仍只可导入。同名不同来源保持独立。关联已有库但内容不同时，必须选择目标版本或库版本。不会修改外部管理器的元数据。

The adoption preview defaults to a new independent library package. To share an existing library, select its stable package identity explicitly; matching names or contents never selects it automatically. If the copies differ, choose the library or installation version and review the newly prepared snapshot before confirming.

Choosing the installation version shows the existing library-to-installation file differences, including removed resources, and identifies the library that will be updated. Choosing the library version shows the reverse installation-to-library differences. Each preview's before and after contents match the files that operation can replace.

纳入管理默认新建独立资源库包；共用已有库时须明确选择对应包，不会按名称或内容自动认领。内容不同时，选择库版本或安装位置版本后重新生成预览，再确认应用。

采用安装位置版本时，展示现有库到该安装版本的文件差异，包括将移除的资源，并注明将更新的库；采用库版本时展示反方向的安装位置差异。预览的前后正文对应本次实际可能被替换的文件。

Each location compares its baseline B, accepted library L and current directory D:

| Comparison                                                  | State / 行为                                      |
| ----------------------------------------------------------- | ------------------------------------------------- |
| L = D = B                                                   | Current / 已同步                                  |
| L ≠ B, D = B                                                | Outgoing / 已授权跟随位置可分发                   |
| L = B, D ≠ B                                                | Incoming / 等待用户回收或覆盖                     |
| L = D ≠ B                                                   | Converged / 只推进基线，不改文件                  |
| Both changed differently                                    | Conflict / 暂停自动写入                           |
| Missing, invalid, unknown ownership or unavailable baseline | Missing/blocked/unverified / 不自动重建或传播删除 |

库工作目录偏离已记录的版本时，必须先明确接纳修改。整包冲突处理支持“使用库版本”“收入原库”“另存独立 Skill”和“解除管理、保留文件”；不自动合并文本。缺失位置只能显式恢复，旧的未知来源记录须显式绑定，不能按名称推断。

Manual resolution remains available when only the installation changed or when a valid local library edit has not yet been accepted. Unsafe paths, unverifiable ownership and invalid candidate packages still block content writes. Withdrawing management preserves the reviewed files even when `SKILL.md` is missing or has invalid frontmatter; location identity, contents and ownership are checked again before changing the receipt.

仅安装位置发生修改时，仍可选择收入库或用库版本覆盖；有效的库内本地编辑可经明确预览接纳。路径不安全、归属不明或候选包无效时仍禁止内容写入。解除管理会保留已审查的文件，即使 `SKILL.md` 缺失或 frontmatter 损坏；修改归属记录前仍复核位置身份、内容及归属。

同步预览固定候选内容，应用时复核内容、归属及策略版本。回收先提交资源库，再推进来源位置；后续步骤失败时报告待恢复，已保存的库内容保持可用，重复恢复不会再次导入同一候选版本。同步记录同时包含资源库操作和部署操作，保留逐包、逐位置结果。

## Automatic policy / 自动策略

The default is a daily check with automatic library updates and deployment writes disabled. Check intervals are off, one hour, six hours or 24 hours. Each library package can use manual/check/auto-update mode; each existing deployment can use manual/follow/pinned mode. Personal-directory grants bind the selected package, deployment incarnation and physical location. Discovery, replacement of a source, reinstalling or adopting a location does not inherit a previous write grant.

自动上游更新仅支持现有公开 GitHub 来源：分支跟随指定分支，每次下载固定完整 commit；tag 和 commit 在自动模式下固定已解析 commit，不自动寻找最新 release。反向回收始终需要用户确认。睡眠、锁屏期间暂停调度，恢复及启动后补查；托盘驻留继续运行。逐包网络失败退避并记录检查失败，无变化不通知。后台每轮限制网络包数和本地目标数，避免长时间占用 Skill worker。

策略保存在 `skill-sync.json`，独立于内容版本和回滚。撤销策略提交后不再启动新的写入，已开始提交的事务完成收尾。跟随分发每轮独立检查，不等待下一次 GitHub 检查周期。

## Storage and recovery / 存储与恢复

`skills.lock.json` and deployment receipts read v1/v2; writes upgrade relevant records to v2. Browsing, inventory and update checks do not migrate records. Snapshots use the existing `skill-package-v1` whole-package hash, including executable bits and empty directories, under `.skill-state/snapshots/`. The first implementation keeps snapshots and performs no automatic garbage collection, so live baselines and interrupted operations cannot lose their referenced versions.

Library transactions are journaled under `.skill-state/library-transactions/` before content activation. A unique metadata commit marker distinguishes committed content from an interrupted rename. Recovery preserves unexpected external replacements. Snapshot corruption blocks use; it is not silently replaced. Deployment transactions retain their existing per-scope journals and reservations. Physical library/scope leases are shared by manual, automatic, recovery and legacy manifest writers.

When recovery restores a library transaction that never committed, the synchronization result is recorded as recovered and the old operation is closed. Its candidate is not imported again; applying the intended change requires a new preview. Recovery of an already committed library continues only the remaining location step.

未提交的库事务恢复到原状态后，同步结果记录为已恢复并结束原操作，不再重放候选导入；继续原意图须重新预览。库已经提交时，只恢复尚未完成的位置步骤。

Sync RPCs are `skills.syncState`, `skills.prepareSync`, `skills.applySync`, `skills.syncPolicy`, `skills.saveSyncPolicy`, `skills.syncRuns`, and `skills.recoverSync`. Requests address library, observation and deployment IDs or preview tokens, never arbitrary filesystem roots. `skills.runDueSync` is a main-process-only scheduling entry with no renderer IPC exposure. Native context visibility is shown separately from legacy manifest declarations and from whether a running native session has loaded a change.

Privacy-restricted Context requests, including MCP previews, do not read personal or external native configuration to verify Skills. For agents whose visibility depends on that configuration, discovered workspace packages remain unverified and are omitted from `visible_skills`, with an explicit coverage warning. Legacy manifest declarations remain separate; the full desktop inventory can inspect the native restrictions.

MCP 等受隐私边界限制的 Context 请求不会为了验证 Skill 而读取个人或外部原生配置。可见性依赖这些配置的 Agent，其工作区候选保持未验证，不计入 `visible_skills`，并明确提示覆盖范围。旧 manifest 声明仍单独展示；完整桌面库存可核对原生限制。
