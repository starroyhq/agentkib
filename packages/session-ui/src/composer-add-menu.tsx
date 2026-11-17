import { Popover } from "@base-ui/react/popover";
import { Check, Lightbulb, Plus } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";
import { composerButtonClasses } from "./composer-control-style";

const planCopy = {
  "zh-CN": { title: "计划模式", clear: "清除已保存的协作模式" },
  "zh-Hant": { title: "計畫模式", clear: "清除已儲存的協作模式" },
  "en-US": { title: "Plan mode", clear: "Clear saved collaboration mode" },
  "ja-JP": { title: "計画モード", clear: "保存した協調モードを解除" },
};

const addCopy = {
  "zh-CN": { back: "返回", filesAndFolders: "文件和文件夹", unavailable: "暂无可添加的内容" },
  "zh-Hant": { back: "返回", filesAndFolders: "檔案和資料夾", unavailable: "暫無可新增的內容" },
  "en-US": { back: "Back", filesAndFolders: "Files and folders", unavailable: "Nothing to add" },
  "ja-JP": {
    back: "戻る",
    filesAndFolders: "ファイルとフォルダー",
    unavailable: "追加できる項目はありません",
  },
};

export function composerAddCopy(locale: keyof typeof addCopy) {
  return addCopy[locale];
}

export function planModeCopy(locale: keyof typeof planCopy) {
  return planCopy[locale];
}

export function ComposerAddMenu({
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

export function ComposerAddAction({
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

export function ComposerPlanAction({
  label,
  active,
  disabled,
  disabledReason,
  onToggle,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  disabledReason?: string;
  onToggle: () => void;
}) {
  return (
    <ComposerAddAction
      label={label}
      icon={<Lightbulb className="size-4" aria-hidden />}
      pressed={active}
      disabled={disabled}
      title={disabledReason}
      onClick={onToggle}
    />
  );
}
