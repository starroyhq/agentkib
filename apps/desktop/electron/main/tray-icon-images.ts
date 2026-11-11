/**
 * The menu bar icon's states, drawn over AgentKib's own mark so no extra artwork ships: an arc
 * that turns around a slightly smaller mark while a session runs, and a dot at the top right
 * while something waits for the person. Bitmaps are premultiplied BGRA, the layout of Electron's
 * `nativeImage.toBitmap()`; a macOS template image only uses their alpha.
 */
export interface TrayBitmap {
  width: number;
  height: number;
  /** Premultiplied BGRA, row by row. */
  data: Uint8Array;
}

export interface TrayColor {
  r: number;
  g: number;
  b: number;
}

/** A template image: the system paints it black or white to match the menu bar. */
export const TEMPLATE_COLOR: TrayColor = { r: 255, g: 255, b: 255 };

/** Positions on the 44 px (22 pt at 2x) canvas the tray icon is drawn on. */
export const TRAY_CANVAS = 44;
/** The mark is drawn this large while the arc turns around it. */
export const RUNNING_MARK_SIZE = 32;
export const RUNNING_FRAMES = 12;
const ARC = { radius: 19, width: 2.75, sweep: 110 };
const DOT = { x: 36.5, y: 7.5, radius: 5.5, gap: 2.75 };

function blank(width: number, height: number): TrayBitmap {
  return { width, height, data: new Uint8Array(width * height * 4) };
}

function copy(bitmap: TrayBitmap): TrayBitmap {
  return { width: bitmap.width, height: bitmap.height, data: new Uint8Array(bitmap.data) };
}

/** Draws `cover(x, y)` (0..1 of each pixel's centre) in `color` over what is there. */
function paint(bitmap: TrayBitmap, color: TrayColor, cover: (x: number, y: number) => number) {
  const { width, height, data } = bitmap;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = Math.min(1, Math.max(0, cover(x + 0.5, y + 0.5)));
      if (!alpha) continue;
      const index = (y * width + x) * 4;
      const keep = 1 - alpha;
      data[index] = Math.round(color.b * alpha + data[index] * keep);
      data[index + 1] = Math.round(color.g * alpha + data[index + 1] * keep);
      data[index + 2] = Math.round(color.r * alpha + data[index + 2] * keep);
      data[index + 3] = Math.round(255 * alpha + data[index + 3] * keep);
    }
}

/** Clears `cover(x, y)` of each pixel, leaving a transparent gap. */
function erase(bitmap: TrayBitmap, cover: (x: number, y: number) => number) {
  const { width, height, data } = bitmap;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const amount = Math.min(1, Math.max(0, cover(x + 0.5, y + 0.5)));
      if (!amount) continue;
      const index = (y * width + x) * 4;
      for (let channel = 0; channel < 4; channel++)
        data[index + channel] = Math.round(data[index + channel] * (1 - amount));
    }
}

/** Coverage of a pixel centre by a shape whose signed distance from its edge is `distance`. */
const coverage = (distance: number) => 0.5 - distance;

function disc(cx: number, cy: number, radius: number) {
  return (x: number, y: number) => coverage(Math.hypot(x - cx, y - cy) - radius);
}

/** An arc with round ends, starting at `start` degrees (0 = up, clockwise) for `sweep` degrees. */
function arc(cx: number, cy: number, radius: number, width: number, start: number, sweep: number) {
  const toPoint = (degrees: number) => {
    const radians = (degrees * Math.PI) / 180;
    return { x: cx + radius * Math.sin(radians), y: cy - radius * Math.cos(radians) };
  };
  const first = toPoint(start);
  const last = toPoint(start + sweep);
  return (x: number, y: number) => {
    const angle = ((Math.atan2(x - cx, cy - y) * 180) / Math.PI + 360) % 360;
    const along = (((angle - start) % 360) + 360) % 360;
    const distance =
      along <= sweep
        ? Math.abs(Math.hypot(x - cx, y - cy) - radius) - width / 2
        : Math.min(Math.hypot(x - first.x, y - first.y), Math.hypot(x - last.x, y - last.y)) -
          width / 2;
    return coverage(distance);
  };
}

/** Puts `image` on a transparent canvas of `size`, centred. */
function centred(image: TrayBitmap, size: number): TrayBitmap {
  const canvas = blank(size, size);
  const left = Math.round((size - image.width) / 2);
  const top = Math.round((size - image.height) / 2);
  for (let y = 0; y < image.height; y++)
    for (let x = 0; x < image.width; x++) {
      const tx = x + left;
      const ty = y + top;
      if (tx < 0 || ty < 0 || tx >= size || ty >= size) continue;
      const from = (y * image.width + x) * 4;
      canvas.data.set(image.data.subarray(from, from + 4), (ty * size + tx) * 4);
    }
  return canvas;
}

/**
 * One frame of the running icon: the mark at `RUNNING_MARK_SIZE` with an arc that has turned
 * `frame / RUNNING_FRAMES` of a circle. `smallMark` is the whole 44 px icon resized to that size.
 */
export function runningFrame(smallMark: TrayBitmap, frame: number, color: TrayColor): TrayBitmap {
  const canvas = centred(smallMark, TRAY_CANVAS);
  const centre = TRAY_CANVAS / 2;
  const start = ((frame % RUNNING_FRAMES) * 360) / RUNNING_FRAMES;
  paint(canvas, color, arc(centre, centre, ARC.radius, ARC.width, start, ARC.sweep));
  return canvas;
}

/** The waiting icon: the mark with a dot at its top right, set apart from it by a clear gap. */
export function waitingImage(mark: TrayBitmap, color: TrayColor): TrayBitmap {
  const canvas = copy(mark);
  erase(canvas, disc(DOT.x, DOT.y, DOT.radius + DOT.gap));
  paint(canvas, color, disc(DOT.x, DOT.y, DOT.radius));
  return canvas;
}
