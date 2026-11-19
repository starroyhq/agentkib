import type { ComponentProps, Key, ReactNode } from "react";
import { SessionComposerAddMenu } from "./composer-add-menu";
import { ComposerModeChip } from "./composer-mode-chip";
import { ComposerModelPicker } from "./composer-model-picker";
import { ComposerPermissionMenu } from "./composer-permission-menu";
import { ComposerToolbar } from "./session-composer-input";

type ComposerLocale = ComponentProps<typeof ComposerModeChip>["locale"];
type AddMenu = Omit<ComponentProps<typeof SessionComposerAddMenu>, "locale"> & { scope?: Key };
type ModeChip = Omit<ComponentProps<typeof ComposerModeChip>, "mode" | "locale">;
type ModelPicker = Omit<ComponentProps<typeof ComposerModelPicker>, "locale"> & { scope?: Key };

type SessionComposerToolbarProps = {
  locale: ComposerLocale;
  add?: AddMenu;
  leadingStatus?: ReactNode;
  permission?: ComponentProps<typeof ComposerPermissionMenu>;
  permissionFallback?: ReactNode;
  permissionFeedback?: ReactNode;
  plan?: ModeChip;
  goal?: ModeChip;
  actions?: ReactNode;
  usage?: ReactNode;
  model?: ModelPicker;
  modelFallback?: ReactNode;
  modelFeedback?: ReactNode;
  action?: ReactNode;
};

export function SessionComposerToolbar({
  locale,
  add,
  leadingStatus,
  permission,
  permissionFallback,
  permissionFeedback,
  plan,
  goal,
  actions,
  usage,
  model,
  modelFallback,
  modelFeedback,
  action,
}: SessionComposerToolbarProps) {
  return (
    <ComposerToolbar
      leading={
        <>
          {add && renderAdd(locale, add)}
          {leadingStatus}
          <div className={permissionFeedback ? "grid min-w-0 justify-items-start" : "contents"}>
            {permission ? <ComposerPermissionMenu {...permission} /> : permissionFallback}
            {permissionFeedback}
          </div>
          {plan && <ComposerModeChip mode="plan" locale={locale} {...plan} />}
          {goal && <ComposerModeChip mode="goal" locale={locale} {...goal} />}
        </>
      }
      trailing={
        <>
          {actions}
          {usage}
          <div className={modelFeedback ? "grid min-w-0 justify-items-end" : "contents"}>
            {model ? renderModel(locale, model) : modelFallback}
            {modelFeedback}
          </div>
          {action}
        </>
      }
    />
  );
}

function renderAdd(locale: ComposerLocale, { scope, ...props }: AddMenu) {
  return <SessionComposerAddMenu key={scope} locale={locale} {...props} />;
}

function renderModel(locale: ComposerLocale, { scope, ...props }: ModelPicker) {
  return <ComposerModelPicker key={scope} locale={locale} {...props} />;
}
