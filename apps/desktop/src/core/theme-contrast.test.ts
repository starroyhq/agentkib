// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

type Color = [number, number, number, number];
type Palette = Record<string, string>;

const desktopCss = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
const webCss = readFileSync(new URL("../../../web/src/style.css", import.meta.url), "utf8");
const conversationCss = readFileSync(
  new URL("../features/sessions/conversation/conversation.css", import.meta.url),
  "utf8",
);

function declarations(body: string): Palette {
  return Object.fromEntries(
    [...body.matchAll(/(--[\w-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2].trim()]),
  );
}

function blocks(css: string) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({
    selector: match[1].trim(),
    values: declarations(match[2]),
  }));
}

/** Plain declarations of the rule whose selector list contains `selector`. */
function rule(css: string, selector: string): Record<string, string> {
  for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const selectors = match[1]
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split(",")
      .map((item) => item.trim());
    if (selectors.includes(selector))
      return Object.fromEntries(
        [...match[2].matchAll(/([\w-]+):\s*([^;]+);/g)].map((item) => [item[1], item[2].trim()]),
      );
  }
  throw new Error(`Missing rule ${selector}`);
}

const desktopBlocks = blocks(desktopCss);
const root = desktopBlocks.find((block) => block.selector === ":root")!.values;
const desktopPalettes = ["vtron", "minimal-neutral", "claude", "sakura", "ocean-breeze"].flatMap(
  (accent) =>
    ["light", "dark"].map((mode) => {
      const modeColors = desktopBlocks.find(
        (block) => block.values["--green"] && block.selector.includes(`data-theme="${mode}"`),
      )!.values;
      const base = desktopBlocks.find(
        (block) =>
          block.values["--background"] &&
          !block.selector.includes("data-accent-theme") &&
          block.selector.includes(`data-theme="${mode}"`),
      )!.values;
      const own = desktopBlocks.find((block) =>
        block.selector.endsWith(`[data-theme="${mode}"][data-accent-theme="${accent}"]`),
      )?.values;
      return {
        name: `desktop/${accent}/${mode}`,
        palette: { ...root, ...modeColors, ...base, ...own },
      };
    }),
);

const webBlocks = blocks(webCss);
const webBase = webBlocks.find((block) => block.selector === ":root")!.values;
const webDark = webBlocks.find((block) => block.selector === ".dark")!.values;
const webPalettes = ["neutral", "violet", "green"].flatMap((accent) =>
  ["light", "dark"].map((mode) => ({
    name: `web/${accent}/${mode}`,
    palette: {
      ...webBase,
      ...(mode === "dark" ? webDark : {}),
      ...webBlocks.find(
        (block) =>
          block.selector === `${mode === "dark" ? ":root.dark" : ":root"}[data-accent="${accent}"]`,
      )?.values,
    },
  })),
);

function mix(first: Color, second: Color, amount: number): Color {
  const alpha = first[3] * amount + second[3] * (1 - amount);
  return [
    ...[0, 1, 2].map((channel) =>
      alpha
        ? (first[channel] * first[3] * amount + second[channel] * second[3] * (1 - amount)) / alpha
        : 0,
    ),
    alpha,
  ] as Color;
}

function color(value: string, palette: Palette): Color {
  if (value === "transparent") return [0, 0, 0, 0];
  if (value === "white") return [1, 1, 1, 1];
  if (value === "black") return [0, 0, 0, 1];
  const variable = /^var\((--[\w-]+)\)$/.exec(value);
  if (variable) {
    if (!palette[variable[1]]) throw new Error(`Missing ${variable[1]}`);
    return color(palette[variable[1]], palette);
  }
  if (/^#[a-f\d]{6}$/i.test(value)) {
    return [1, 3, 5]
      .map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16) / 255)
      .concat(1) as Color;
  }
  const blend = /^color-mix\(in srgb, (.+) (\d+)%, (.+)\)$/.exec(value);
  if (blend) return mix(color(blend[1], palette), color(blend[3], palette), Number(blend[2]) / 100);
  const oklch = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/.exec(value);
  if (!oklch) throw new Error(`Unsupported CSS color ${value}`);
  const [, lightness, chroma, hue] = oklch.map(Number);
  const a = chroma * Math.cos((hue * Math.PI) / 180);
  const b = chroma * Math.sin((hue * Math.PI) / 180);
  const l = (lightness + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (lightness - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (lightness - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    ...[
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
    ].map((channel) =>
      Math.max(
        0,
        Math.min(1, channel <= 0.0031308 ? channel * 12.92 : 1.055 * channel ** (1 / 2.4) - 0.055),
      ),
    ),
    1,
  ] as Color;
}

function over(foreground: Color, background: Color): Color {
  return [
    ...[0, 1, 2].map(
      (channel) => foreground[channel] * foreground[3] + background[channel] * (1 - foreground[3]),
    ),
    1,
  ] as Color;
}

function luminance(value: Color) {
  return [0.2126, 0.7152, 0.0722].reduce((result, weight, index) => {
    const channel = value[index];
    return (
      result + weight * (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    );
  }, 0);
}

function contrast(foreground: Color, background: Color) {
  const [low, high] = [luminance(over(foreground, background)), luminance(background)].sort(
    (a, b) => a - b,
  );
  return (high + 0.05) / (low + 0.05);
}

for (const { name, palette } of [...desktopPalettes, ...webPalettes]) {
  describe(name, () => {
    const get = (token: string) => color(palette[token], palette);
    const surfaces = ["--background", "--card", "--muted", "--sidebar"];
    if (palette["--popover"]) surfaces.push("--popover");

    for (const surface of surfaces) {
      it(`keeps readable text on ${surface}, including tinted and hovered surfaces`, () => {
        const background = get(surface);
        const check = (foreground: string, base: Color) => {
          expect(
            contrast(get(foreground), base),
            `${foreground} on ${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        };
        check("--primary-text", background);
        check("--primary-text", over(mix(get("--primary"), [0, 0, 0, 0], 0.1), background));
        check("--muted-foreground", background);
        check("--tab-inactive-foreground", background);
        check("--destructive-text", background);
        check("--destructive-text", over(mix(get("--destructive"), [0, 0, 0, 0], 0.1), background));
        if (palette["--destructive-soft-hover"]) {
          check("--destructive-text", over(get("--destructive-soft-hover"), background));
        } else {
          // Web destructive menu items use a 20% focus surface in dark mode.
          check(
            "--destructive-text",
            over(mix(get("--destructive"), [0, 0, 0, 0], 0.2), background),
          );
        }
        check("--primary-foreground", get("--primary"));
        check("--primary-foreground", over(get("--primary-hover"), background));
        check("--primary-foreground", over(get("--primary-hover-strong"), background));
        check("--destructive-foreground", get("--destructive"));
        check("--destructive-foreground", over(get("--destructive-hover"), background));
        if (palette["--destructive-badge-bg"]) {
          check("--destructive-badge-foreground", over(get("--destructive-badge-bg"), background));
        }
        if (palette["--destructive-control-bg"]) {
          check(
            "--destructive-control-foreground",
            over(get("--destructive-control-bg"), background),
          );
          check(
            "--destructive-control-foreground",
            over(get("--destructive-control-hover"), background),
          );
        }
      });
    }

    it("keeps selected text readable", () => {
      const background = get(
        palette["--primary-selected-bg"] ? "--primary-selected-bg" : "--accent",
      );
      expect(
        contrast(
          get(palette["--primary-selected-bg"] ? "--primary-text" : "--accent-foreground"),
          background,
        ),
      ).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get("--accent-foreground"), get("--accent"))).toBeGreaterThanOrEqual(4.5);
      if (palette["--sidebar-accent"]) {
        expect(
          contrast(get("--sidebar-accent-foreground"), get("--sidebar-accent")),
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  });
}

describe.each(desktopPalettes)("$name achievement cards", ({ palette }) => {
  const get = (token: string) => color(palette[token], palette);
  // The wall uses bg-muted/20 over its card; unlocked cards replace bg-card
  // with a translucent green surface. Focus adds a ring without changing it.
  const wall = over(mix(get("--muted"), [0, 0, 0, 0], 0.2), get("--card"));
  const unlocked = over(mix(get("--green"), [0, 0, 0, 0], 0.07), wall);
  const hoverForeground = get("--muted-accent-foreground");

  it("keeps metadata readable on locked and unlocked cards, including focus and hover", () => {
    for (const [state, foreground, background] of [
      ["locked/rest-or-focus", get("--muted-foreground"), get("--card")],
      ["unlocked/rest-or-focus", get("--muted-foreground"), unlocked],
      ["locked-or-unlocked/hover", hoverForeground, get("--accent")],
    ] as const) {
      expect(contrast(foreground, background), state).toBeGreaterThanOrEqual(4.5);
      expect(contrast(get("--foreground"), background), `${state} title`).toBeGreaterThanOrEqual(
        4.5,
      );
    }
  });

  it("keeps unlocked status text readable on its actual tinted and hovered surfaces", () => {
    expect(contrast(get("--green"), unlocked)).toBeGreaterThanOrEqual(4.5);
    expect(
      contrast(get("--achievement-status-hover-foreground"), get("--accent")),
    ).toBeGreaterThanOrEqual(4.5);
  });
});

it.each(desktopPalettes)("$name keeps active quota metadata readable", ({ palette }) => {
  const actual = color(palette["--quota-active-foreground"], palette);
  expect(contrast(actual, color(palette["--background"], palette))).toBeGreaterThanOrEqual(4.5);
});

it.each(desktopPalettes)("$name keeps home metric labels readable on hover", ({ palette }) => {
  const get = (token: string) => color(palette[token], palette);
  // The desktop shell's ::after paints --background beneath main (above its
  // --sidebar surface); narrow windows use the root background directly.
  const summary = over(mix(get("--muted"), [0, 0, 0, 0], 0.55), get("--background"));
  const hover = over(mix(get("--primary"), [0, 0, 0, 0], 0.1), summary);
  expect(contrast(get("--muted-foreground"), summary)).toBeGreaterThanOrEqual(4.5);
  expect(contrast(get("--home-metric-hover-foreground"), hover)).toBeGreaterThanOrEqual(4.5);
});

it.each(desktopPalettes)(
  "$name retains compliant home metric hover labels",
  ({ name, palette }) => {
    const get = (token: string) => color(palette[token], palette);
    if (
      ![
        "desktop/minimal-neutral/light",
        "desktop/sakura/light",
        "desktop/sakura/dark",
        "desktop/ocean-breeze/light",
      ].includes(name)
    ) {
      expect(get("--home-metric-hover-foreground")).toEqual(get("--muted-foreground"));
    }
  },
);

it.each(desktopPalettes)("$name retains already compliant component roles", ({ name, palette }) => {
  const get = (token: string) => color(palette[token], palette);
  if (
    ![
      "desktop/minimal-neutral/dark",
      "desktop/sakura/light",
      "desktop/sakura/dark",
      "desktop/ocean-breeze/dark",
    ].includes(name)
  ) {
    expect(get("--muted-accent-foreground")).toEqual(get("--muted-foreground"));
  }
  if (!["desktop/claude/light", "desktop/sakura/light"].includes(name)) {
    expect(get("--achievement-status-hover-foreground")).toEqual(get("--green"));
  }
  if (!["desktop/sakura/light", "desktop/ocean-breeze/light"].includes(name)) {
    expect(get("--quota-active-foreground")).toEqual(mix(get("--foreground"), [0, 0, 0, 0], 0.7));
  }
});

it.each(["vtron", "minimal-neutral"])(
  "preserves the compliant original 60%% inactive tab foreground in light %s",
  (accent) => {
    const palette = desktopPalettes.find(
      (entry) => entry.name === `desktop/${accent}/light`,
    )!.palette;
    const original = mix(color("var(--foreground)", palette), [0, 0, 0, 0], 0.6);
    const retained = color(palette["--tab-inactive-foreground"], palette);
    expect(retained).toEqual(original);
    expect(contrast(retained, color(palette["--card"], palette))).toBeGreaterThanOrEqual(4.5);
  },
);

it("uses the approved VTRON text tones without changing the primary button background", () => {
  const palette = desktopPalettes.find((entry) => entry.name === "desktop/vtron/light")!.palette;
  expect(palette["--primary"]).toBe("#2e67ff");
  expect(palette["--primary-text"]).toBe("#285ae0");
  expect(palette["--muted-foreground"]).toBe("#626a7e");
  expect(palette["--destructive"]).toBe("#bd3a48");
  expect(palette["--destructive-icon"]).toBe("#ff6c35");
  expect(contrast(color("#285ae0", palette), color("#ebf0ff", palette))).toBeCloseTo(5.081, 2);
  expect(contrast(color("white", palette), color("#2e67ff", palette))).toBeCloseTo(4.667, 2);
});

// User messages put Markdown on --primary in --primary-foreground. The Markdown fills and colours
// for code, quotes and links suit page surfaces, so each user-message scope overrides them.
describe.each([
  {
    name: "Web transcript",
    css: webCss,
    palettes: webPalettes,
    scope: '[data-message-role="user"] .aui-markdown',
  },
  {
    name: "desktop transcript",
    css: conversationCss,
    palettes: desktopPalettes,
    scope: '.agentkib-conversation [data-message-role="user"] .aui-markdown',
  },
  {
    name: "desktop session list",
    css: desktopCss,
    palettes: desktopPalettes,
    scope: ".markdown-on-primary",
  },
])("$name user messages", ({ css, palettes, scope }) => {
  it.each(palettes)("$name keeps code, quotes and links readable", ({ palette }) => {
    const get = (token: string) => color(palette[token], palette);
    const bubble = over(get("--primary"), get("--background"));
    const resolve = (value: string) =>
      value === "inherit" ? get("--primary-foreground") : color(value, palette);
    // Code and code blocks are filled on page surfaces; quotes and links are coloured there.
    for (const [element, property] of [
      [":not(pre) > code", "background-color"],
      ["pre", "background-color"],
      ["blockquote", "color"],
      ["a", "color"],
    ]) {
      const values = rule(css, `${scope} ${element}`);
      expect(values[property], `${element} ${property}`).toBeDefined();
      const fill = values["background-color"]
        ? over(resolve(values["background-color"]), bubble)
        : bubble;
      expect(
        contrast(resolve(values.color ?? "inherit"), fill),
        `${scope} ${element}`,
      ).toBeGreaterThanOrEqual(4.5);
    }
  });
});
