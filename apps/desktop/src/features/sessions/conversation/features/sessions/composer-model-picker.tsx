import { useEffect, useRef, useState, type CSSProperties } from "react";
import { Popover } from "@base-ui/react/popover";
import { Slider } from "@base-ui/react/slider";
import { Check, ChevronDown, ChevronRight, LoaderCircle, RotateCcw, Zap } from "lucide-react";
import type { CodexSessionSettings, CodexSettingValues } from "@agentkib/web-client";
import type { SupportedLocale as Locale } from "@/core/types";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { composerTerm } from "./composer-layout-copy";
import { composerModelCopy } from "./composer-model-copy";
import "./composer-model-picker.css";

export type ComposerModelChange = {
  model?: string;
  effort?: string | null;
  serviceTierId?: string | null;
  restoreDefaults?: true;
};

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

/** A quick selection uses the same checked settings action as the advanced dialog. */
export function ComposerModelPicker({
  locale,
  settings,
  selection,
  disabled,
  saving,
  status,
  onOpen,
  onChange,
}: {
  locale: Locale;
  settings?: CodexSessionSettings;
  selection?: CodexSettingValues;
  disabled: boolean;
  saving: boolean;
  status?: string;
  onOpen: () => void;
  onChange: (change: ComposerModelChange) => Promise<void>;
}) {
  const copy = composerModelCopy[locale];
  const [open, setOpen] = useState(false);
  const [page, setPage] = useState<"effort" | "models">("effort");
  const [popup, setPopup] = useState<HTMLDivElement | null>(null);
  const [draft, setDraft] = useState<{ scope: string; effort: string }>();
  const effortScope = JSON.stringify([settings?.revision, selection?.modelId, selection?.effort]);
  const draftEffort = draft?.scope === effortScope ? draft.effort : undefined;
  const setDraftEffort = (effort?: string) =>
    setDraft(effort === undefined ? undefined : { scope: effortScope, effort });
  const flight = useRef(false);
  const unknownEffortPointer = useRef<number | undefined>(undefined);
  const model = settings?.options.models.find(
    (item) => item.id === selection?.modelId || item.resolvedModel === selection?.modelId,
  );
  const modelName = model?.name || selection?.modelId || copy.unknown;
  const efforts = model?.efforts ?? [];
  const effort = draftEffort ?? selection?.effort;
  const effortIndex = effort ? efforts.indexOf(effort) : -1;
  const peak = effortIndex >= 0 && effortIndex === efforts.length - 1;
  const effortText = (value: string) => (value === "ultra" ? "Ultra" : composerTerm(locale, value));
  const writable = settings?.available && !disabled && !saving;
  const fast = selection?.serviceTierId === "fast" || selection?.serviceTierId === "priority";
  // Codex 0.163 reports the Fast catalog entry as `priority`; older hosts use `fast`.
  const fastTier = settings?.options.serviceTiers.find(
    (item) => ["fast", "priority"].includes(item.id) && model?.serviceTierIds.includes(item.id),
  );
  const fastSupported = !!fastTier;
  const fastWritable = writable && settings?.writable.serviceTier.available && fastSupported;
  const effortWritable = writable && settings?.writable.effort.available && efforts.length > 1;
  useEffortMotion(popup, open && page === "effort", fast);

  useEffect(() => {
    unknownEffortPointer.current = undefined;
  }, [settings?.revision, selection?.modelId, selection?.effort]);

  async function change(value: ComposerModelChange) {
    if (!writable || flight.current) return;
    flight.current = true;
    try {
      await onChange(value);
    } finally {
      flight.current = false;
      setDraftEffort(undefined);
    }
  }

  const effortLabel = effort ? effortText(effort) : copy.effortUnknown;
  return (
    <Popover.Root
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        setDraftEffort(undefined);
        unknownEffortPointer.current = undefined;
        if (next) {
          setPage("effort");
          onOpen();
        }
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <Popover.Trigger
              payload={page}
              render={
                <Button
                  type="button"
                  variant="ghost"
                  className="h-9 min-w-0 max-w-64 gap-1.5 rounded-full px-2 text-sm font-normal"
                  aria-label={`${copy.chooseEffort}: ${modelName}${selection?.effort ? ` · ${effortText(selection.effort)}` : ""}`}
                />
              }
            />
          }
        >
          <span className="truncate">{open ? copy.chooseEffort : modelName}</span>
          {!open && selection?.effort && (
            <span
              className={`shrink-0 @max-[25rem]:hidden ${selection.effort === efforts.at(-1) ? "text-violet-600 dark:text-violet-400" : "text-muted-foreground"}`}
            >
              {effortText(selection.effort)}
            </span>
          )}
          <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
        </TooltipTrigger>
        <TooltipContent>{copy.chooseEffort}</TooltipContent>
      </Tooltip>
      <Popover.Portal>
        <Popover.Positioner
          side="top"
          align="end"
          sideOffset={8}
          collisionPadding={12}
          className="composer-model-positioner z-[100]"
        >
          <Popover.Popup
            ref={setPopup}
            aria-label={page === "models" ? copy.chooseModel : copy.chooseEffort}
            className="composer-model-popup w-64 max-w-[calc(100vw-24px)] rounded-2xl border border-border bg-popover p-3 text-popover-foreground shadow-xl outline-none dark:border-white/15 dark:bg-[#2b2b2b]"
            data-peak={peak || undefined}
            data-fast={fast || undefined}
          >
            <Popover.Viewport className="composer-model-viewport">
              <div key={page} className="composer-model-page" data-page={page}>
                {page === "models" ? (
                  <>
                    <Popover.Title className="mb-2 px-1 text-sm font-normal text-muted-foreground">
                      {copy.chooseModel}
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
                        disabled={!writable || !settings?.writable.restoreDefaults.available}
                        onClick={() => {
                          setPage("effort");
                          void change({ restoreDefaults: true });
                        }}
                      >
                        <span>
                          <span className="block">{copy.defaultModel}</span>
                          <span className="block text-xs text-muted-foreground">
                            {copy.recommended}
                          </span>
                        </span>
                      </Button>
                      {settings?.options.models.map((item) => (
                        <Button
                          key={item.id}
                          type="button"
                          variant="ghost"
                          className="h-9 w-full justify-between gap-3 rounded-lg px-2 text-left font-normal"
                          aria-pressed={model?.id === item.id}
                          disabled={!writable || !settings.writable.model.available}
                          onClick={() => {
                            setPage("effort");
                            if (model?.id === item.id) return;
                            void change({
                              model: item.id,
                              ...(settings.writable.effort.available &&
                              !item.efforts.includes(selection?.effort ?? "")
                                ? { effort: item.defaultEffort ?? item.efforts[0] ?? null }
                                : {}),
                              ...(settings.writable.serviceTier.available &&
                              selection?.serviceTierId &&
                              !item.serviceTierIds.includes(selection.serviceTierId)
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
                      ))}
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              variant="ghost"
                              className={`size-7 rounded-lg p-0 ${fast ? "composer-effort-color bg-muted" : "text-muted-foreground"}`}
                              aria-label={copy.fast}
                              aria-pressed={fast}
                              disabled={!fastWritable}
                              onClick={() =>
                                void change({ serviceTierId: fast ? null : fastTier!.id })
                              }
                            />
                          }
                        >
                          <Zap
                            className="size-4"
                            fill={fast ? "currentColor" : "none"}
                            aria-hidden="true"
                          />
                        </TooltipTrigger>
                        <TooltipContent className="border-border bg-popover text-popover-foreground dark:bg-[#2b2b2b]">
                          {fastSupported
                            ? fastTier?.description || copy.fastDetail
                            : copy.fastUnavailable}
                        </TooltipContent>
                      </Tooltip>
                      <div className="min-w-0 flex-1 text-center">
                        <Popover.Title className="composer-effort-color text-sm font-medium">
                          <span className="sr-only">{copy.chooseEffort}: </span>
                          {effortLabel}
                        </Popover.Title>
                        <Button
                          type="button"
                          variant="ghost"
                          className="h-5 max-w-full gap-0.5 rounded-md px-1 text-xs font-normal text-muted-foreground"
                          aria-label={`${copy.chooseModel}: ${modelName}`}
                          onClick={() => setPage("models")}
                        >
                          <span className="truncate">{modelName}</span>
                          <ChevronRight className="size-3" aria-hidden="true" />
                        </Button>
                      </div>
                      <Button
                        type="button"
                        variant="ghost"
                        className="size-7 rounded-full p-0 text-muted-foreground"
                        aria-label={copy.reset}
                        title={copy.reset}
                        disabled={!writable || !settings?.writable.restoreDefaults.available}
                        onClick={() => void change({ restoreDefaults: true })}
                      >
                        <RotateCcw className="size-4" aria-hidden="true" />
                      </Button>
                    </div>
                    {efforts.length > 0 && (
                      <Slider.Root
                        value={Math.max(0, effortIndex)}
                        min={0}
                        max={Math.max(1, efforts.length - 1)}
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
                        className="mt-2 w-full"
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
                            aria-valuetext={effortIndex >= 0 ? effortLabel : copy.effortUnknown}
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
                  </>
                )}
                {(saving || status) && (
                  <p
                    role="status"
                    className="mt-2 flex items-start gap-1.5 px-1 text-xs leading-4 text-muted-foreground"
                  >
                    {saving && (
                      <LoaderCircle
                        className="mt-0.5 size-3 shrink-0 animate-spin"
                        aria-hidden="true"
                      />
                    )}
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
