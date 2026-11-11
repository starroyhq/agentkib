import { describe, expect, it } from "vitest";
import {
  RUNNING_FRAMES,
  RUNNING_MARK_SIZE,
  TEMPLATE_COLOR,
  TRAY_CANVAS,
  runningFrame,
  waitingImage,
  type TrayBitmap,
} from "./tray-icon-images";

/** An opaque white square standing in for the mark, inset like the real 44 px asset. */
function mark(size: number, inset: number): TrayBitmap {
  const data = new Uint8Array(size * size * 4);
  for (let y = inset; y < size - inset; y++)
    for (let x = inset; x < size - inset; x++) data.set([255, 255, 255, 255], (y * size + x) * 4);
  return { width: size, height: size, data };
}

const alpha = (bitmap: TrayBitmap, x: number, y: number) =>
  bitmap.data[(y * bitmap.width + x) * 4 + 3];

/** The pixel on the arc's circle at `degrees` (0 = up, clockwise). */
function onCircle(degrees: number, radius = 19) {
  const radians = (degrees * Math.PI) / 180;
  const centre = TRAY_CANVAS / 2;
  return [
    Math.floor(centre + radius * Math.sin(radians)),
    Math.floor(centre - radius * Math.cos(radians)),
  ] as const;
}

describe("tray icon states", () => {
  it("puts a dot at the top right, set apart from the mark by a clear gap", () => {
    const source = mark(TRAY_CANVAS, 6);
    const image = waitingImage(source, TEMPLATE_COLOR);
    expect(alpha(image, 36, 7)).toBe(255);
    // Inside the gap ring the mark is cleared; far from the dot it is untouched.
    expect(alpha(image, 29, 7)).toBe(0);
    expect(alpha(image, 10, 30)).toBe(255);
    // The source is not changed.
    expect(alpha(source, 29, 7)).toBe(255);
  });

  it("draws the running arc around a smaller mark and turns it frame by frame", () => {
    const small = mark(RUNNING_MARK_SIZE, 4);
    const first = runningFrame(small, 0, TEMPLATE_COLOR);
    expect(first.width).toBe(TRAY_CANVAS);
    // The smaller mark sits in the middle, inside the arc's circle.
    expect(alpha(first, 22, 22)).toBe(255);
    expect(alpha(first, 6, 22)).toBe(0);
    // Frame 0 starts at the top and sweeps clockwise.
    expect(alpha(first, ...onCircle(55))).toBeGreaterThan(200);
    expect(alpha(first, ...onCircle(235))).toBe(0);
    // A quarter turn later the arc has moved round with it.
    const later = runningFrame(small, RUNNING_FRAMES / 4, TEMPLATE_COLOR);
    expect(alpha(later, ...onCircle(145))).toBeGreaterThan(200);
    expect(alpha(later, ...onCircle(55 - 30))).toBe(0);
  });

  it("repeats after a full turn", () => {
    const small = mark(RUNNING_MARK_SIZE, 4);
    expect(runningFrame(small, RUNNING_FRAMES + 2, TEMPLATE_COLOR).data).toEqual(
      runningFrame(small, 2, TEMPLATE_COLOR).data,
    );
  });

  it("paints a colour icon's arc and dot in their own colour, premultiplied", () => {
    const red = { r: 239, g: 68, b: 68 };
    const image = waitingImage(mark(TRAY_CANVAS, 6), red);
    const index = (7 * TRAY_CANVAS + 36) * 4;
    expect([...image.data.subarray(index, index + 4)]).toEqual([68, 68, 239, 255]);
  });
});
