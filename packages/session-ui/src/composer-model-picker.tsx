import {
  Fragment,
  useEffect,
  useId,
  useImperativeHandle,
  useRef,
  useState,
  type ComponentProps,
  type CSSProperties,
  type Ref,
} from "react";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import { Tooltip } from "@base-ui/react/tooltip";
import { Check, ChevronDown, ChevronRight, RotateCcw } from "lucide-react";
import { ComposerFastIcon } from "./composer-fast-icon";
import { modelEffortsForTier, modelSupportsTier } from "./model-capabilities";
import { composerButtonClasses } from "./composer-control-style";
import type {
  CodexSessionSettings,
  CodexSettingValues,
  SessionProviderCapabilities,
} from "@agentkib/web-client";
import { composerModelCopy, type ComposerModelLocale } from "./composer-model-copy";
import "./composer-model-picker.css";

export type ComposerModelChange = {
  model?: string;
  effort?: string | null;
  serviceTierId?: string | null;
  restoreDefaults?: true;
};

type ComposerModelPage = "effort" | "models";

type ModelPreview = {
  scope: string;
  selection: Pick<CodexSettingValues, "modelId" | "effort" | "serviceTierId">;
};

export type ComposerModelPickerHandle = {
  open(page: ComposerModelPage): void;
};

function Button({
  variant,
  className = "",
  ...props
}: ComponentProps<"button"> & { variant: "ghost" | "outline" }) {
  return (
    <button
      className={`${composerButtonClasses} ${variant === "outline" ? "border-border bg-background" : ""} ${className}`}
      {...props}
    />
  );
}

function TooltipContent({ className, children }: ComponentProps<"div">) {
  return (
    <Tooltip.Portal>
      <Tooltip.Positioner side="top" sideOffset={4} className="isolate z-[100]">
        <Tooltip.Popup
          className={`w-fit max-w-xs rounded-md border border-border px-2.5 py-1.5 text-xs font-medium shadow-lg ${className ?? "bg-foreground text-background"}`}
        >
          {children}
        </Tooltip.Popup>
      </Tooltip.Positioner>
    </Tooltip.Portal>
  );
}

// Older hosts only report the tier IDs.
const LEGACY_FAST_TIERS = ["fast", "priority"];

const effortParticles = (() => {
  let seed = 0x51a7c0de;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  return Array.from({ length: 18 }, () => ({
    x: random() * 100,
    y: 15 + random() * 70,
    size: 1.2 + random() * 1.5,
    opacity: 0.25 + random() * 0.5,
    drift: 1 + random() * 2,
    duration: 6 + random() * 6,
    delay: -random() * 18,
  }));
})();

/** Keep each CSS animation's phase while Fast ramps its playback rate. */
function useEffortMotion(element: HTMLDivElement | null, enabled: boolean, fast: boolean) {
  useEffect(() => {
    if (!enabled || !element) return;
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-reduced-motion: reduce)")
        : undefined;
    const track = element.querySelector<HTMLElement>(".composer-effort-track");
    const measure = () => {
      const width = track && (track.clientWidth || track.getBoundingClientRect().width);
      if (width && width > 0) element.style.setProperty("--composer-track-width", String(width));
    };
    measure();
    const resize =
      track && typeof ResizeObserver === "function" ? new ResizeObserver(measure) : undefined;
    if (track) resize?.observe(track);
    const collect = () =>
      Array.from(
        new Set(
          Array.from(
            element.querySelectorAll<HTMLElement>(
              ".composer-effort-fill, .composer-effort-flow, .composer-effort-particle",
            ),
          ).flatMap((target) =>
            typeof target.getAnimations === "function" ? target.getAnimations() : [],
          ),
        ),
      ).filter(
        (animation) =>
          ["composer-fast-flow", "composer-fast-spectrum", "composer-particle-bob"].includes(
            (animation as CSSAnimation).animationName,
          ) && typeof animation.updatePlaybackRate === "function",
      );
    let animations = collect();
    let frame: number | undefined;
    const cancelFrame = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      frame = undefined;
    };
    const pause = () => {
      cancelFrame();
      for (const animation of animations) if (animation.playState !== "idle") animation.pause();
    };
    const sync = () => {
      cancelFrame();
      if (document.hidden || media?.matches) {
        pause();
        return;
      }
      animations = collect();
      const rates = animations.map((animation) => ({
        animation,
        from: animation.playbackRate,
        // CSS traverses the full track at 20px/s when WAAPI is absent. Fast
        // reaches 200px/s, while vertical drifting stays deliberately subtler.
        to: fast
          ? (animation as CSSAnimation).animationName === "composer-particle-bob"
            ? 2
            : 10
          : 1,
      }));
      for (const { animation } of rates) if (animation.playState !== "running") animation.play();
      if (!rates.some(({ from, to }) => from !== to)) return;
      const started = window.performance.now();
      const step = () => {
        const progress = Math.min(1, Math.max(0, (window.performance.now() - started) / 600));
        const eased = progress * progress * (3 - 2 * progress);
        for (const { animation, from, to } of rates)
          animation.updatePlaybackRate(from + (to - from) * eased);
        frame = progress < 1 ? window.requestAnimationFrame(step) : undefined;
      };
      frame = window.requestAnimationFrame(step);
    };
    sync();
    document.addEventListener("visibilitychange", sync);
    media?.addEventListener?.("change", sync);
    return () => {
      pause();
      resize?.disconnect();
      document.removeEventListener("visibilitychange", sync);
      media?.removeEventListener?.("change", sync);
    };
  }, [element, enabled, fast]);
}

/** Select a model, its reasoning effort and any service tier supported by the host. */
export function ComposerModelPicker({
  locale,
  settings,
  selection: savedSelection,
  reportedSettings,
  displayFallback,
  disabled,
  triggerDisabled = false,
  saving,
  status,
  provider = settings?.provider,
  modelDefault = provider?.models.modelDefault,
  effortDefault = provider?.models.effortDefault,
  clearEffort = provider?.models.clearEffort ?? false,
  pickerRef,
  side = "top",
  onOpen,
  onChange,
}: {
  locale: ComposerModelLocale;
  settings?: CodexSessionSettings;
  selection?: CodexSettingValues;
  reportedSettings?: Pick<CodexSettingValues, "modelId" | "effort" | "serviceTierId">;
  displayFallback?: Pick<CodexSettingValues, "modelId" | "effort" | "serviceTierId"> & {
    name?: string;
  };
  disabled: boolean;
  triggerDisabled?: boolean;
  saving: boolean;
  status?: string;
  provider?: SessionProviderCapabilities;
  /** A new session can delegate the model choice to the Agent. */
  modelDefault?: boolean;
  /**
   * No effort means the model's own default, as Claude Code and DeepSeek Harness report it, not an
   * unknown one.
   */
  effortDefault?: boolean;
  /** The host accepts clearing the effort without resetting the model or permissions. */
  clearEffort?: boolean;
  pickerRef?: Ref<ComposerModelPickerHandle>;
  /** Where the picker opens: above a composer at the bottom, below one at the top of a page. */
  side?: "top" | "bottom";
  onOpen: () => void;
  /** False rejects a write. True keeps its preview until the next authoritative read. */
  onChange: (change: ComposerModelChange) => Promise<boolean | void>;
}) {
  const copy = composerModelCopy[locale];
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<ComposerModelPage>("effort");
  const triggerId = useId();
  const [popover] = useState(() => Popover.createHandle<ComposerModelPage>());
  const openState = useRef(false);
  const requestedPage = useRef<ComposerModelPage | undefined>(undefined);
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [preview, setPreview] = useState<ModelPreview>();
  const [writing, setWriting] = useState(false);
  const [draft, setDraft] = useState<{ scope: string; effort: string }>();
  const selectionScope = JSON.stringify([
    settings?.sessionId,
    settings?.revision,
    settings?.available,
    settings?.applicationStatus,
    settings?.current.modelId,
    settings?.current.effort,
    settings?.current.serviceTierId,
    savedSelection?.modelId,
    savedSelection?.effort,
    savedSelection?.serviceTierId,
    reportedSettings?.modelId,
    reportedSettings?.effort,
    reportedSettings?.serviceTierId,
  ]);
  if (preview && preview.scope !== selectionScope) setPreview(undefined);
  const activePreview = preview?.scope === selectionScope ? preview : undefined;
  const selection = activePreview?.selection ?? savedSelection;
  const effortScope = JSON.stringify([
    selectionScope,
    selection?.modelId,
    selection?.effort,
    selection?.serviceTierId,
  ]);
  const draftEffort = draft?.scope === effortScope ? draft.effort : undefined;
  const setDraftEffort = (effort?: string) =>
    setDraft(effort === undefined ? undefined : { scope: effortScope, effort });
  const flight = useRef(false);
  const unknownEffortPointer = useRef<number | undefined>(undefined);
  const modelId = selection?.modelId;
  const liveReport =
    !activePreview && (reportedSettings?.modelId || reportedSettings?.effort)
      ? reportedSettings
      : undefined;
  const knownModel =
    liveReport?.modelId ?? modelId ?? (!activePreview ? settings?.current.modelId : undefined);
  const knownEffort = liveReport
    ? liveReport.effort
    : (selection?.effort ?? (!activePreview && !modelId ? settings?.current.effort : undefined));
  // A display fallback must never become the editable selection.
  const fallback =
    !activePreview && !knownModel && displayFallback?.modelId ? displayFallback : undefined;
  const displayModel = fallback?.modelId ?? knownModel;
  const displayEffort = knownEffort ?? fallback?.effort;
  const findModel = (id?: string) =>
    id
      ? settings?.options.models?.find((item) => item.id === id || item.resolvedModel === id)
      : undefined;
  const model = findModel(modelId);
  const displayOption = modelId === displayModel ? model : findModel(displayModel);
  const cachedModelName =
    !activePreview && displayFallback?.modelId === displayModel ? displayFallback?.name : undefined;
  const missingModelLabel = modelDefault ? copy.defaultModel : copy.modelSettings;
  const displayModelName =
    displayOption?.name || cachedModelName || displayModel || missingModelLabel;
  const panelModel = fallback ? displayOption : model;
  const panelModelName =
    modelId && modelId !== displayModel ? model?.name || modelId : displayModelName;
  const selectedTier = selection?.serviceTierId ?? "";
  const standardEfforts = panelModel?.efforts ?? [];
  const nativeVariants = provider?.models.selection === "variants";
  const variants = nativeVariants ? panelModel?.variants : undefined;
  const efforts = variants
    ? modelEffortsForTier(panelModel, selectedTier || undefined)
    : standardEfforts;
  const fastTierIds = provider?.models.fastTierIds ?? LEGACY_FAST_TIERS;
  const isFastTier = (id: string) => fastTierIds.includes(id);
  // The model's default effort runs; the slider shows where it stands.
  const followsDefault = effortDefault === true && !!settings?.available && !selection?.effort;
  const effort =
    draftEffort ??
    selection?.effort ??
    (fallback && displayEffort) ??
    (followsDefault ? model?.defaultEffort : undefined);
  const effortIndex = effort ? efforts.indexOf(effort) : -1;
  const peak = effortIndex >= 0 && effortIndex === efforts.length - 1;
  const effortLabels: Record<string, string> = copy.efforts;
  const effortText = (value: string) => effortLabels[value] ?? value;
  const hasDisplaySelection = !!displayModel || modelDefault;
  const showsEffort = !!displayModel && (!panelModel || panelModel.efforts.length > 0);
  const triggerLabel = showsEffort ? copy.chooseEffort : copy.chooseModel;
  const overviewLabel = showsEffort ? copy.chooseEffort : copy.modelSettings;
  const writable = settings?.available && !disabled && !saving && !writing;
  const fast = isFastTier(selectedTier);
  const displayFast = isFastTier(
    selection?.serviceTierId ?? liveReport?.serviceTierId ?? fallback?.serviceTierId ?? "",
  );
  const supportedTiers = settings?.options.serviceTiers?.filter((item) =>
    panelModel?.serviceTierIds?.includes(item.id),
  );
  const permitsTier = (tier: string) =>
    !variants || modelSupportsTier(panelModel, tier || undefined, effort);
  const fastTier = supportedTiers?.find((item) => isFastTier(item.id) && permitsTier(item.id));
  const otherTiers =
    supportedTiers?.filter((item) => !isFastTier(item.id) && permitsTier(item.id)) ?? [];
  const selectedTierOption = settings?.options.serviceTiers?.find(
    (item) => item.id === selectedTier,
  );
  const fastSupported = fast && variants ? permitsTier("") : !!fastTier;
  // An agent that knows no service tiers at all (DeepSeek Harness) has no Fast mode to offer.
  const tiered =
    !settings ||
    settings.options.serviceTiers?.length > 0 ||
    settings.options.models?.some((item) => !!item.serviceTierIds?.length);
  // DSH lists models under their provider; so does this, once there is more than one.
  const grouped = new Set(settings?.options.models?.map((item) => item.group)).size > 1;
  // An effort or tier-only write may target another model until a selection is known.
  const tierWritable = writable && !fallback && settings?.writable.serviceTier?.available;
  const fastWritable = tierWritable && fastSupported;
  const effortWritable = writable && !fallback && settings?.writable.effort?.available;
  const restoresDefaults = settings?.writable.restoreDefaults?.available === true;
  const clearsEffort = !restoresDefaults && clearEffort && !!selection?.effort;
  const resetLabel = clearsEffort ? copy.useDefaultEffort : copy.reset;
  const onlyEffort = efforts.length === 1 ? efforts[0] : undefined;
  useEffortMotion(popup, open && page === "effort", fast);

  useImperativeHandle(
    pickerRef,
    () => ({
      open(next) {
        if (triggerDisabled) return;
        if (openState.current) {
          setPage(next);
          return;
        }
        requestedPage.current = next;
        popover.open(triggerId);
      },
    }),
    [popover, triggerId, triggerDisabled],
  );

  useEffect(() => {
    unknownEffortPointer.current = undefined;
  }, [effortScope]);
  useEffect(() => {
    if (!triggerDisabled || !openState.current) return;
    openState.current = false;
    requestedPage.current = undefined;
    setOpen(false);
    setDraft(undefined);
  }, [triggerDisabled]);

  async function change(value: ComposerModelChange) {
    if (!writable || flight.current) return;
    flight.current = true;
    const changesVariantFamily = nativeVariants && value.model !== undefined;
    const next: ModelPreview = {
      scope: selectionScope,
      selection: value.restoreDefaults
        ? modelDefault
          ? {}
          : (settings?.defaults ?? {})
        : {
            modelId: value.model ?? selection?.modelId,
            effort:
              value.effort === undefined && !changesVariantFamily
                ? selection?.effort
                : (value.effort ?? undefined),
            serviceTierId:
              value.serviceTierId === undefined && !changesVariantFamily
                ? selection?.serviceTierId
                : (value.serviceTierId ?? undefined),
          },
    };
    setDraftEffort(undefined);
    setPreview(next);
    setWriting(true);
    let accepted = false;
    try {
      accepted = (await onChange(value)) === true;
    } catch {
      // The caller reports the operation error. Remove its unconfirmed values here.
    } finally {
      flight.current = false;
      setWriting(false);
      if (!accepted) setPreview((current) => (current === next ? activePreview : current));
    }
  }

  const effortLabel =
    followsDefault && draftEffort === undefined
      ? model?.defaultEffort
        ? `${copy.defaultEffort} · ${effortText(model.defaultEffort)}`
        : copy.defaultEffort
      : effort
        ? effortText(effort)
        : copy.effortUnknown;
  return (
    <Popover.Root
      handle={popover}
      open={open && !triggerDisabled}
      onOpenChange={(next) => {
        if (next === openState.current || (next && triggerDisabled)) return;
        openState.current = next;
        setOpen(next);
        setDraftEffort(undefined);
        unknownEffortPointer.current = undefined;
        if (next) {
          setPage(requestedPage.current ?? "effort");
          requestedPage.current = undefined;
          onOpen();
        }
      }}
    >
      <Tooltip.Root>
        <Tooltip.Trigger
          render={
            <Popover.Trigger
              handle={popover}
              id={triggerId}
              payload={page}
              disabled={triggerDisabled}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 min-w-0 max-w-64 gap-1.5 rounded-full px-2 text-sm font-normal"
                  title={triggerDisabled ? status : undefined}
                  aria-description={triggerDisabled ? status : undefined}
                  aria-label={
                    !hasDisplaySelection
                      ? copy.modelSettings
                      : `${triggerLabel}: ${displayModelName}${displayEffort ? ` · ${effortText(displayEffort)}` : ""}${displayFast ? ` · ${copy.fast}` : ""}`
                  }
                />
              }
            />
          }
        >
          <span className="truncate">
            {open && !fallback && showsEffort ? copy.chooseEffort : displayModelName}
          </span>
          {hasDisplaySelection && (!open || fallback) && displayEffort && (
            <span
              className={`shrink-0 @max-[25rem]:hidden ${displayEffort === efforts.at(-1) ? "text-violet-600 dark:text-violet-400" : "text-muted-foreground"}`}
            >
              {effortText(displayEffort)}
            </span>
          )}
          {displayFast && <ComposerFastIcon active />}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </Tooltip.Trigger>
        <TooltipContent>
          {triggerDisabled ? (status ?? overviewLabel) : overviewLabel}
        </TooltipContent>
      </Tooltip.Root>
      <Popover.Portal>
        <Popover.Positioner
          side={side}
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="composer-model-positioner z-[100]"
        >
          <Popover.Popup
            ref={setPopup}
            aria-label={page === "models" ? copy.chooseModel : overviewLabel}
            className="composer-model-popup w-64 max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none dark:border-white/15 dark:bg-[#2b2b2b]"
            data-peak={peak || undefined}
            data-fast={fast || undefined}
          >
            <Popover.Viewport className="composer-model-viewport">
              <div key={page} className="composer-model-page" data-page={page}>
                {page === "models" ? (
                  <>
                    <Popover.Title className="mb-2 px-1 text-sm font-normal text-muted-foreground">
                      {copy.model}
                    </Popover.Title>
                    <div
                      role="group"
                      aria-label={copy.chooseModel}
                      className="max-h-[min(24rem,60vh)] overflow-y-auto"
                    >
                      <Button
                        type="button"
                        variant="ghost"
                        className="mb-1 h-auto min-h-12 w-full justify-start rounded-lg px-2 py-2 text-left font-normal"
                        aria-pressed={modelDefault ? !modelId : undefined}
                        disabled={!writable || !restoresDefaults}
                        onClick={() => {
                          if (!nativeVariants) setPage("effort");
                          void change({ restoreDefaults: true });
                        }}
                      >
                        <span>
                          <span className="block">{copy.defaultModel}</span>
                          {!modelDefault && (
                            <span className="block text-xs text-muted-foreground">
                              {copy.recommended}
                            </span>
                          )}
                        </span>
                      </Button>
                      {settings?.options.models?.map((item, index, models) => (
                        <Fragment key={item.id}>
                          {grouped && item.group && item.group !== models[index - 1]?.group && (
                            <div className="px-2 pt-2 pb-1 text-xs text-muted-foreground">
                              {item.group}
                            </div>
                          )}
                          <Button
                            type="button"
                            variant="ghost"
                            className="h-9 w-full justify-between gap-3 rounded-lg px-2 text-left font-normal"
                            aria-pressed={model?.id === item.id}
                            disabled={!writable || !settings.writable.model?.available}
                            onClick={() => {
                              if (
                                !nativeVariants ||
                                item.efforts?.length ||
                                item.serviceTierIds?.length
                              )
                                setPage("effort");
                              if (model?.id === item.id) return;
                              if (nativeVariants) {
                                void change({ model: item.id });
                                return;
                              }
                              const nextEffort =
                                item.defaultEffort ?? (clearEffort ? undefined : item.efforts?.[0]);
                              void change({
                                model: item.id,
                                // A default effort stays the default of the model chosen.
                                ...(settings.writable.effort?.available &&
                                !followsDefault &&
                                !item.efforts?.includes(selection?.effort ?? "") &&
                                (nextEffort !== undefined || clearEffort || !effortDefault)
                                  ? { effort: nextEffort ?? null }
                                  : {}),
                                ...(settings.writable.serviceTier?.available &&
                                selection?.serviceTierId &&
                                !item.serviceTierIds?.includes(selection.serviceTierId)
                                  ? { serviceTierId: null }
                                  : {}),
                              });
                            }}
                          >
                            <span className="truncate">{item.name || item.id}</span>
                            {model?.id === item.id && (
                              <Check className="size-4 text-muted-foreground" aria-hidden="true" />
                            )}
                          </Button>
                        </Fragment>
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      {fastTierIds.length > 0 &&
                      tiered &&
                      (!nativeVariants ||
                        displayFast ||
                        !!panelModel?.serviceTierIds?.some(isFastTier)) ? (
                        <Tooltip.Root>
                          <Tooltip.Trigger
                            render={
                              <Button
                                type="button"
                                variant="ghost"
                                className={`size-7 rounded-lg p-0 ${displayFast ? "composer-effort-color bg-muted" : "text-muted-foreground"}`}
                                aria-label={copy.fast}
                                aria-pressed={displayFast}
                                disabled={!fastWritable}
                                onClick={() =>
                                  void change({ serviceTierId: fast ? null : fastTier!.id })
                                }
                              />
                            }
                          >
                            <ComposerFastIcon active={displayFast} className="size-4" />
                          </Tooltip.Trigger>
                          <TooltipContent className="border-border bg-popover text-popover-foreground dark:bg-[#2b2b2b]">
                            {fastSupported
                              ? (fast ? selectedTierOption : fastTier)?.description ||
                                copy.fastDetail
                              : variants
                                ? effort === undefined
                                  ? copy.fastNeedsEffort
                                  : copy.fastEffortUnavailable
                                : copy.fastUnavailable}
                          </TooltipContent>
                        </Tooltip.Root>
                      ) : (
                        // Keeps the title centred between the corners.
                        <span className="size-7 shrink-0" aria-hidden="true" />
                      )}
                      <div className="min-w-0 flex-1 text-center">
                        <Popover.Title className="composer-effort-color text-sm font-medium">
                          {showsEffort ? (
                            <>
                              <span className="sr-only">{copy.chooseEffort}: </span>
                              {effortLabel}
                            </>
                          ) : (
                            overviewLabel
                          )}
                        </Popover.Title>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-5 max-w-full gap-0.5 rounded-md px-1 text-xs font-normal text-muted-foreground"
                          aria-label={
                            hasDisplaySelection
                              ? `${copy.chooseModel}: ${panelModelName}`
                              : copy.chooseModel
                          }
                          onClick={() => setPage("models")}
                        >
                          <span className="truncate">
                            {hasDisplaySelection ? panelModelName : copy.model}
                          </span>
                          <ChevronRight className="size-3" aria-hidden="true" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="size-7 rounded-full p-0 text-muted-foreground"
                        aria-label={resetLabel}
                        title={resetLabel}
                        disabled={clearsEffort ? !effortWritable : !writable || !restoresDefaults}
                        onClick={() =>
                          void change(clearsEffort ? { effort: null } : { restoreDefaults: true })
                        }
                      >
                        <RotateCcw className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    {efforts.length > 1 && (
                      <Slider.Root
                        value={Math.max(0, effortIndex)}
                        min={0}
                        max={efforts.length - 1}
                        step={1}
                        largeStep={1}
                        thumbAlignment="edge"
                        disabled={!effortWritable}
                        onValueChange={(value) => {
                          unknownEffortPointer.current = undefined;
                          setDraftEffort(efforts[value]);
                        }}
                        onValueCommitted={(value) => {
                          if (efforts[value] && efforts[value] !== selection?.effort)
                            void change({ effort: efforts[value] });
                        }}
                        className="mt-2 h-7 w-full rounded-lg px-2.5 text-sm"
                      >
                        <Slider.Control
                          className="composer-effort-track relative flex h-7 w-full touch-none items-center select-none"
                          onPointerDownCapture={(event) => {
                            if (event.button === 0)
                              unknownEffortPointer.current =
                                effortWritable && effortIndex < 0 ? event.pointerId : undefined;
                          }}
                          onPointerUp={(event) => {
                            if (unknownEffortPointer.current !== event.pointerId) return;
                            unknownEffortPointer.current = undefined;
                            // Unknown is displayed at the first stop. BaseUI does not commit
                            // an unchanged numeric zero, but choosing it is an explicit choice.
                            // A drag that changed the draft uses BaseUI's normal commit instead.
                            if (effortWritable && effortIndex < 0)
                              void change({ effort: efforts[0] });
                          }}
                          onPointerCancel={() => {
                            unknownEffortPointer.current = undefined;
                          }}
                          onLostPointerCapture={() => {
                            unknownEffortPointer.current = undefined;
                          }}
                        >
                          <Slider.Track className="relative h-6 w-full overflow-hidden rounded-full bg-black/10 dark:bg-white/10">
                            <Slider.Indicator
                              className="composer-effort-fill overflow-hidden rounded-full"
                              data-known={effortIndex >= 0}
                            >
                              <span
                                className="composer-effort-flow absolute inset-0"
                                aria-hidden="true"
                              >
                                {[0, 1].flatMap((layer) =>
                                  effortParticles.map((particle, index) => (
                                    <span
                                      key={`${layer}-${index}`}
                                      className="composer-effort-particle"
                                      style={
                                        {
                                          left: `${particle.x + layer * 100}%`,
                                          top: `${particle.y}%`,
                                          width: particle.size,
                                          height: particle.size,
                                          opacity: particle.opacity,
                                          "--particle-bob-distance": `${particle.drift}px`,
                                          "--particle-bob-duration": `${particle.duration}s`,
                                          "--particle-bob-delay": `${particle.delay}s`,
                                        } as CSSProperties
                                      }
                                    />
                                  )),
                                )}
                              </span>
                            </Slider.Indicator>
                          </Slider.Track>
                          <div
                            className={`pointer-events-none absolute inset-x-3.5 flex justify-between ${peak ? "invisible" : ""}`}
                            aria-hidden="true"
                          >
                            {efforts.map((item) => (
                              <span key={item} className="size-1 rounded-full bg-white/40" />
                            ))}
                          </div>
                          <Slider.Thumb
                            aria-label={copy.chooseEffort}
                            aria-valuetext={
                              effortIndex >= 0 || followsDefault ? effortLabel : copy.effortUnknown
                            }
                            onKeyDown={(event) => {
                              if (
                                effortWritable &&
                                effortIndex < 0 &&
                                ["Home", "ArrowLeft", "ArrowDown", "PageDown"].includes(event.key)
                              ) {
                                event.preventDefault();
                                void change({ effort: efforts[0] });
                              }
                            }}
                            className="size-7 rounded-full border border-black/5 bg-white shadow-sm outline-none focus-visible:ring-2 focus-visible:ring-violet-400 focus-visible:ring-offset-2"
                          />
                        </Slider.Control>
                      </Slider.Root>
                    )}
                    {onlyEffort && effort !== onlyEffort && (
                      <Button
                        type="button"
                        variant="outline"
                        className="mt-2 h-7 w-full rounded-lg px-2.5 text-sm"
                        aria-label={`${copy.chooseEffort}: ${effortText(onlyEffort)}`}
                        disabled={!effortWritable}
                        onClick={() => void change({ effort: onlyEffort })}
                      >
                        {effortText(onlyEffort)}
                      </Button>
                    )}
                    {otherTiers.length > 0 && (
                      <label className="mt-2 flex flex-wrap items-center justify-between gap-1.5 text-xs text-muted-foreground">
                        {copy.serviceTier}
                        <select
                          className="max-w-36 rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50"
                          title={selectedTierOption?.description}
                          value={selectedTier}
                          disabled={!tierWritable}
                          onChange={(event) => {
                            const value = event.currentTarget.value;
                            if (
                              tierWritable &&
                              (value === "" || otherTiers.some((tier) => tier.id === value))
                            )
                              void change({ serviceTierId: value || null });
                          }}
                        >
                          <option value="">{copy.defaultModel}</option>
                          {selectedTier && !otherTiers.some((tier) => tier.id === selectedTier) && (
                            <option value={selectedTier} disabled>
                              {selectedTierOption?.name ?? selectedTier}
                            </option>
                          )}
                          {otherTiers.map((tier) => (
                            <option key={tier.id} value={tier.id}>
                              {tier.name}
                            </option>
                          ))}
                        </select>
                      </label>
                    )}
                  </>
                )}
                {status && (
                  <p role="status" className="mt-2 px-1 text-xs leading-4 text-muted-foreground">
                    {status}
                  </p>
                )}
              </div>
            </Popover.Viewport>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
