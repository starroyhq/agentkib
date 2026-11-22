import { Popover } from "@base-ui/react/popover";
import {
  SESSION_RESOURCE_LIMIT,
  type SessionResources,
  type SessionResource,
} from "@agentkib/web-client";
import {
  ArrowLeft,
  Check,
  ChevronRight,
  Folder,
  Goal,
  Lightbulb,
  Paperclip,
  Plus,
  Search,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { composerButtonClasses } from "./composer-control-style";

const planCopy = {
  "zh-CN": { title: "计划模式", clear: "清除已保存的协作模式" },
  "zh-Hant": { title: "計畫模式", clear: "清除已儲存的協作模式" },
  "en-US": { title: "Plan mode", clear: "Clear saved collaboration mode" },
  "ja-JP": { title: "計画モード", clear: "保存した協調モードを解除" },
};

const addCopy = {
  "zh-CN": {
    attachment: "选择附件文件",
    back: "返回",
    filesAndFolders: "文件和文件夹",
    unavailable: "暂无可添加的内容",
  },
  "zh-Hant": {
    attachment: "選取附件檔案",
    back: "返回",
    filesAndFolders: "檔案和資料夾",
    unavailable: "暫無可新增的內容",
  },
  "en-US": {
    attachment: "Choose attachment files",
    back: "Back",
    filesAndFolders: "Files and folders",
    unavailable: "Nothing to add",
  },
  "ja-JP": {
    attachment: "添付ファイルを選択",
    back: "戻る",
    filesAndFolders: "ファイルとフォルダー",
    unavailable: "追加できる項目はありません",
  },
};

const resourceBrowserCopy = {
  "zh-CN": {
    enterDirectory: "进入文件夹",
    parentDirectory: "返回上级",
    contextRoot: "工作区根目录",
    contextLoading: "正在加载资源…",
    contextRetry: "重试",
    done: "完成",
    selected: "已选",
    selectionLimit: "最多可选 {limit} 项",
    computerFiles: "电脑文件与文件夹",
    skillsPlugins: "技能、插件与应用",
    resourceSearch: "搜索可用资源",
    resourceEmpty: "没有可用资源",
    resourceUnavailable: "这台电脑尚未提供受控上下文引用",
    directoryReference: "文件夹仅作为引用，不会递归上传",
  },
  "zh-Hant": {
    enterDirectory: "進入資料夾",
    parentDirectory: "返回上層",
    contextRoot: "工作區根目錄",
    contextLoading: "正在載入資源…",
    contextRetry: "重試",
    done: "完成",
    selected: "已選",
    selectionLimit: "最多可選 {limit} 項",
    computerFiles: "電腦檔案與資料夾",
    skillsPlugins: "技能、外掛與應用程式",
    resourceSearch: "搜尋可用資源",
    resourceEmpty: "沒有可用資源",
    resourceUnavailable: "這台電腦尚未提供受控上下文引用",
    directoryReference: "資料夾僅作為引用，不會遞迴上傳",
  },
  "en-US": {
    enterDirectory: "Open folder",
    parentDirectory: "Parent folder",
    contextRoot: "Workspace root",
    contextLoading: "Loading resources…",
    contextRetry: "Retry",
    done: "Done",
    selected: "Selected",
    selectionLimit: "Select up to {limit} items",
    computerFiles: "Computer files and folders",
    skillsPlugins: "Skills, plugins and apps",
    resourceSearch: "Search available resources",
    resourceEmpty: "No resources available",
    resourceUnavailable: "The computer does not provide controlled context references",
    directoryReference: "Folders are referenced without recursively uploading their contents",
  },
  "ja-JP": {
    enterDirectory: "フォルダーを開く",
    parentDirectory: "上の階層へ",
    contextRoot: "ワークスペースのルート",
    contextLoading: "リソースを読み込み中…",
    contextRetry: "再試行",
    done: "完了",
    selected: "選択済み",
    selectionLimit: "選択できるのは {limit} 件までです",
    computerFiles: "コンピューターのファイルとフォルダー",
    skillsPlugins: "スキル、プラグイン、アプリ",
    resourceSearch: "利用可能なリソースを検索",
    resourceEmpty: "利用可能なリソースはありません",
    resourceUnavailable: "このコンピューターは制御されたコンテキスト参照を提供していません",
    directoryReference: "フォルダーは再帰アップロードせず参照として追加されます",
  },
};

const resourceKindCopy = {
  "zh-CN": {
    file: "文件",
    directory: "文件夹",
    skill: "技能",
    plugin: "插件",
    app: "应用",
  },
  "zh-Hant": {
    file: "檔案",
    directory: "資料夾",
    skill: "技能",
    plugin: "外掛",
    app: "應用",
  },
  "en-US": {
    file: "File",
    directory: "Folder",
    skill: "Skill",
    plugin: "Plugin",
    app: "App",
  },
  "ja-JP": {
    file: "ファイル",
    directory: "フォルダー",
    skill: "スキル",
    plugin: "プラグイン",
    app: "アプリ",
  },
};

const goalCopy = {
  "zh-CN": {
    title: "持续目标",
    objective: "目标内容",
    budget: "Token 预算（可选）",
    close: "关闭",
    saveDraft: "保存目标草稿",
    clearDraft: "移除目标",
    planNeedsMessage: "启用计划模式时，请添加首条消息再启动目标。",
  },
  "zh-Hant": {
    title: "持續目標",
    objective: "目標內容",
    budget: "Token 預算（選填）",
    close: "關閉",
    saveDraft: "儲存目標草稿",
    clearDraft: "移除目標",
    planNeedsMessage: "啟用規劃模式時，請新增第一則訊息再啟動目標。",
  },
  "en-US": {
    title: "Persistent goal",
    objective: "Objective",
    budget: "Token budget (optional)",
    close: "Close",
    saveDraft: "Save goal draft",
    clearDraft: "Remove goal draft",
    planNeedsMessage: "Add a first message to start a goal with Plan mode enabled.",
  },
  "ja-JP": {
    title: "継続目標",
    objective: "目標",
    budget: "Token 予算（任意）",
    close: "閉じる",
    saveDraft: "目標の下書きを保存",
    clearDraft: "目標を削除",
    planNeedsMessage: "計画モードで目標を開始するには、最初のメッセージを追加してください。",
  },
};

export function composerAddCopy(locale: keyof typeof addCopy) {
  return addCopy[locale];
}

export function planModeCopy(locale: keyof typeof planCopy) {
  return planCopy[locale];
}

export function composerGoalCopy(locale: keyof typeof goalCopy) {
  return goalCopy[locale];
}

function ComposerAddMenu({
  label,
  side = "top",
  disabled,
  disabledReason,
  open,
  onOpenChange,
  children,
}: {
  label: string;
  side?: "top" | "bottom";
  disabled?: boolean;
  disabledReason?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode;
}) {
  const [anchor, setAnchor] = useState<HTMLFormElement | null>(null);
  const anchorForm = useCallback((element: HTMLButtonElement | null) => {
    setAnchor(element?.form ?? null);
  }, []);
  return (
    <Popover.Root open={open} onOpenChange={onOpenChange} modal={false}>
      <Popover.Trigger
        ref={anchorForm}
        className={`${composerButtonClasses} size-11 rounded-full p-0 text-muted-foreground hover:text-foreground`}
        aria-label={label}
        title={disabledReason ?? label}
        disabled={disabled}
      >
        <Plus className="size-5" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          anchor={anchor ?? undefined}
          align="start"
          side={side}
          sideOffset={6}
          collisionPadding={8}
          className="z-[90]"
        >
          <Popover.Popup
            aria-label={label}
            className="max-h-[min(26rem,var(--available-height))] w-[var(--anchor-width,20rem)] max-w-[var(--available-width)] overflow-y-auto overscroll-contain rounded-2xl border border-border bg-popover p-2 text-popover-foreground shadow-lg outline-none"
          >
            {children}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function ComposerAddAction({
  label,
  icon,
  disabled,
  title,
  onClick,
  pressed,
}: {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
  pressed?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${composerButtonClasses} min-h-9 w-full justify-start gap-2 rounded-lg px-2.5 text-left text-sm pointer-coarse:min-h-11`}
      disabled={disabled}
      title={title}
      aria-pressed={pressed}
      onClick={onClick}
    >
      {icon}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {pressed && <Check className="size-4 text-primary-text" aria-hidden />}
    </button>
  );
}

type ComposerLocale = keyof typeof addCopy;
type ActionAvailability = { disabled?: boolean; reason?: string };

export type ComposerResourceBrowser = ActionAvailability & {
  page?: Pick<SessionResources, "directoryId" | "parentId" | "resources">;
  path: readonly string[];
  selected: readonly SessionResource[];
  loading?: boolean;
  error?: string;
  offline?: boolean;
  selectable: boolean;
  selectionReason?: string;
  reasonText?: (code?: string) => string;
  load: (directoryId?: string, path?: string[]) => void;
  retry?: () => void;
  onSelect: (items: SessionResource[]) => void;
};

/** A surface supplies only its supported actions and their current authorization. */
export function SessionComposerAddMenu({
  locale,
  label,
  side,
  disabled,
  disabledReason,
  open: controlledOpen,
  onOpenChange,
  attachment,
  resources,
  goal,
  plan,
  clearMode,
}: {
  locale: ComposerLocale;
  label: string;
  side?: "top" | "bottom";
  disabled?: boolean;
  disabledReason?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  attachment?: ActionAvailability & { label?: string; onPick: () => void };
  resources?: ComposerResourceBrowser;
  goal?: ActionAvailability & { selected?: boolean; onOpen: () => void };
  plan?: ActionAvailability & { active: boolean; onToggle: () => void };
  clearMode?: ActionAvailability & { onClear: () => void };
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const focusNavigation = useRef(false);
  const focusRow = useCallback((row: HTMLDivElement | null) => {
    if (!row || !focusNavigation.current) return;
    focusNavigation.current = false;
    row.querySelector("button")?.focus();
  }, []);
  const offered = !!(attachment || resources || goal || plan || clearMode);
  const open = (controlledOpen ?? localOpen) && !disabled && offered;
  useEffect(() => {
    if (!open || resources?.disabled) {
      setBrowsing(false);
      focusNavigation.current = false;
    }
  }, [open, resources?.disabled]);
  const close = (next: boolean) => {
    if (!next) {
      setBrowsing(false);
      focusNavigation.current = false;
    }
    if (controlledOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const run = (action: () => void) => {
    close(false);
    action();
  };
  const add = composerAddCopy(locale);
  return (
    <ComposerAddMenu
      label={label}
      side={side}
      open={open}
      onOpenChange={close}
      disabled={disabled || !offered}
      disabledReason={disabledReason ?? (!offered ? add.unavailable : undefined)}
    >
      {browsing && resources ? (
        <section className="space-y-2">
          <div ref={focusRow}>
            <ComposerAddAction
              label={add.back}
              icon={<ArrowLeft className="size-4" aria-hidden />}
              onClick={() => {
                focusNavigation.current = true;
                setBrowsing(false);
              }}
            />
          </div>
          <ResourceBrowser locale={locale} resources={resources} done={() => close(false)} />
        </section>
      ) : (
        <>
          {attachment && (
            <ComposerAddAction
              label={attachment.label ?? add.attachment}
              icon={<Paperclip className="size-4" aria-hidden />}
              disabled={attachment.disabled}
              title={attachment.reason}
              onClick={() => run(attachment.onPick)}
            />
          )}
          {resources && (
            <div ref={focusRow}>
              <ComposerAddAction
                label={add.filesAndFolders}
                icon={<Folder className="size-4" aria-hidden />}
                disabled={resources.disabled}
                title={resources.disabled ? resources.reason : undefined}
                onClick={() => {
                  focusNavigation.current = true;
                  setBrowsing(true);
                  if (
                    !resources.page &&
                    !resources.loading &&
                    !resources.error &&
                    !resources.offline
                  )
                    resources.load();
                }}
              />
            </div>
          )}
          {goal && (
            <ComposerAddAction
              label={composerGoalCopy(locale).title}
              icon={<Goal className="size-4" aria-hidden />}
              disabled={goal.disabled}
              title={goal.reason}
              pressed={goal.selected}
              onClick={() => run(goal.onOpen)}
            />
          )}
          {plan && (
            <ComposerAddAction
              label={planModeCopy(locale).title}
              icon={<Lightbulb className="size-4" aria-hidden />}
              pressed={plan.active}
              disabled={plan.disabled}
              title={plan.reason}
              onClick={() => run(plan.onToggle)}
            />
          )}
          {clearMode && (
            <ComposerAddAction
              label={planModeCopy(locale).clear}
              icon={<Lightbulb className="size-4" aria-hidden />}
              disabled={clearMode.disabled}
              title={clearMode.reason}
              onClick={() => run(clearMode.onClear)}
            />
          )}
        </>
      )}
    </ComposerAddMenu>
  );
}

const resourceControl =
  "inline-flex min-h-9 shrink-0 items-center justify-center gap-2 rounded-md border px-2.5 text-sm hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50 pointer-coarse:min-h-11";
const inputControl =
  "block w-full rounded-md border bg-background px-3 py-2 text-sm focus-visible:outline-2 focus-visible:outline-ring disabled:opacity-50";
const isFileResource = (item: SessionResource) => item.kind === "file" || item.kind === "directory";
// The session send action accepts at most this many resource references.

function ResourceBrowser({
  locale,
  resources,
  done,
}: {
  locale: ComposerLocale;
  resources: ComposerResourceBrowser;
  done: () => void;
}) {
  const copy = resourceBrowserCopy[locale];
  const {
    page,
    path,
    selected,
    loading,
    error,
    offline,
    selectable,
    selectionReason,
    reasonText = (reason) => reason ?? "",
    load,
    retry,
    onSelect,
  } = resources;
  const [query, setQuery] = useState("");
  const selectionNoticeId = useId();
  const selectionNotice = !selectable && selectionReason ? reasonText(selectionReason) : undefined;
  const atLimit = selected.length >= SESSION_RESOURCE_LIMIT;
  const limitText = copy.selectionLimit.replace("{limit}", String(SESSION_RESOURCE_LIMIT));
  const needle = query.trim().toLocaleLowerCase();
  const visible =
    page?.resources.filter((item) =>
      `${item.name} ${item.description ?? ""}`.toLocaleLowerCase().includes(needle),
    ) ?? [];
  const groups = [
    { label: copy.computerFiles, items: visible.filter(isFileResource) },
    { label: copy.skillsPlugins, items: visible.filter((item) => !isFileResource(item)) },
  ];
  const browse = (directoryId: string, names: string[]) => {
    setQuery("");
    load(directoryId, names);
  };
  return (
    <>
      <div className="flex min-w-0 items-center gap-2 rounded-lg border p-2">
        <button
          type="button"
          className={resourceControl}
          disabled={!page?.parentId || loading || offline}
          onClick={() => page?.parentId && browse(page.parentId, path.slice(0, -1))}
        >
          <ArrowLeft className="size-4" aria-hidden />
          {copy.parentDirectory}
        </button>
        <span className="min-w-0 break-words text-xs text-muted-foreground">
          {[copy.contextRoot, ...path].join(" / ")}
        </span>
      </div>
      {loading && (
        <p role="status" className="text-sm">
          {copy.contextLoading}
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm">
          <p>{reasonText(error)}</p>
          <button
            type="button"
            className={resourceControl}
            disabled={loading || offline}
            onClick={() => (retry ? retry() : load(page?.directoryId, [...path]))}
          >
            {copy.contextRetry}
          </button>
        </div>
      )}
      {!page && !loading && !error && (
        <p role="status" className="text-sm text-muted-foreground">
          {copy.resourceUnavailable}
        </p>
      )}
      {page && (
        <>
          {selectionNotice && (
            <p id={selectionNoticeId} role="status" className="text-xs text-muted-foreground">
              {selectionNotice}
            </p>
          )}
          <div className="relative">
            <Search
              className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden
            />
            <input
              type="search"
              aria-label={copy.resourceSearch}
              placeholder={copy.resourceSearch}
              value={query}
              className={`${inputControl} h-10 pl-9`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <p className="text-xs text-muted-foreground">{copy.directoryReference}</p>
          {!visible.length && <p className="text-sm text-muted-foreground">{copy.resourceEmpty}</p>}
          {groups.map(
            ({ label, items }) =>
              items.length > 0 && (
                <section key={label} className="space-y-2">
                  <h3 className="text-xs font-medium text-muted-foreground">{label}</h3>
                  {items.map((item) => {
                    const checked = selected.some((resource) => resource.id === item.id);
                    const disabled = !item.available || loading || offline || !selectable;
                    const why =
                      !item.available && item.reason && item.reason !== selectionReason
                        ? reasonText(item.reason)
                        : "";
                    const directoryId = item.kind === "directory" ? item.navigationId : undefined;
                    return (
                      <div
                        key={item.id}
                        className={`flex items-center gap-2 rounded-lg border p-3 text-sm ${checked ? "border-primary/40 bg-primary/5" : "hover:bg-muted/30"}`}
                      >
                        <label className="flex min-w-0 flex-1 items-start gap-3">
                          <input
                            type="checkbox"
                            className="mt-0.5 size-4 shrink-0 accent-primary disabled:opacity-50"
                            checked={checked}
                            disabled={disabled || (atLimit && !checked)}
                            title={why || (atLimit && !checked ? limitText : undefined)}
                            aria-describedby={selectionNotice ? selectionNoticeId : undefined}
                            onChange={(event) =>
                              onSelect(
                                event.target.checked
                                  ? [...selected, item]
                                  : selected.filter((resource) => resource.id !== item.id),
                              )
                            }
                          />
                          <span className="min-w-0">
                            <span className="block break-words font-medium">{item.name}</span>
                            <span className="block text-xs text-muted-foreground">
                              {[resourceKindCopy[locale][item.kind], item.description, why]
                                .filter(Boolean)
                                .join(" · ")}
                            </span>
                          </span>
                        </label>
                        {directoryId && (
                          <button
                            type="button"
                            className="inline-flex size-11 shrink-0 items-center justify-center rounded-md hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring disabled:pointer-events-none disabled:opacity-50"
                            aria-label={`${copy.enterDirectory}: ${item.name}`}
                            disabled={loading || offline}
                            onClick={() => browse(directoryId, [...path, item.name])}
                          >
                            <ChevronRight className="size-4" aria-hidden />
                          </button>
                        )}
                      </div>
                    );
                  })}
                </section>
              ),
          )}
        </>
      )}
      <div className="flex items-center justify-between gap-2 pt-1">
        <div className="text-xs text-muted-foreground" aria-live="polite">
          <p>
            {copy.selected}: {selected.length}
          </p>
          {atLimit && <p>{limitText}</p>}
        </div>
        <button type="button" className={resourceControl} onClick={done}>
          {copy.done}
        </button>
      </div>
    </>
  );
}

export function ComposerGoalFields({
  locale,
  objective,
  budget,
  disabled,
  hideBudget,
  onObjectiveChange,
  onBudgetChange,
}: {
  locale: ComposerLocale;
  objective: string;
  budget: string;
  disabled?: boolean;
  hideBudget?: boolean;
  onObjectiveChange: (objective: string) => void;
  onBudgetChange: (budget: string) => void;
}) {
  const copy = composerGoalCopy(locale);
  return (
    <>
      <label className="block space-y-1 text-sm">
        {copy.objective}
        <textarea
          className={`${inputControl} min-h-24 resize-y`}
          value={objective}
          disabled={disabled}
          onChange={(event) => onObjectiveChange(event.target.value)}
        />
      </label>
      {!hideBudget && (
        <label className="block space-y-1 text-sm">
          {copy.budget}
          <input
            className={inputControl}
            type="number"
            min={1}
            value={budget}
            disabled={disabled}
            onChange={(event) => onBudgetChange(event.target.value)}
          />
        </label>
      )}
    </>
  );
}
