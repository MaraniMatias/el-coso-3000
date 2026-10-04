import {
  checkContrast,
  cssColor,
  deriveBackground,
  deriveForeground,
  hexToRgb,
  normalizeHex,
  palette,
  randomPalette,
  rgbToHsl,
} from "../core/color";
import { drawFrame } from "../core/draw-frame";
import { paintTexture, TEXTURE_REFERENCE_SECONDS } from "../core/texture";
import { downloadBlob } from "../core/download";
import { evenDimensions } from "../core/filename";
import { ensureFontLoaded } from "../core/font";
import { exportGif } from "../encoders/gif";
import { exportImage, type StillImageFormat } from "../encoders/image";
import { exportJpegZip, exportMjpegAvi } from "../encoders/mjpeg";
import { availableVideoFormats, exportVideo } from "../encoders/video";
import type {
  ImageFormat,
  PaletteEntry,
  ProgressInfo,
  Spec,
  TimelineFormat,
  VideoFormat,
  VideoTone,
} from "../core/types";
import {
  DEFAULT_IMAGE_TEXTURE,
  DEFAULT_TEXTURE_SPEED,
  DEFAULT_VIDEO_TEXTURE,
  DEFAULT_VIDEO_TONE,
  supportsAlpha,
  supportsTexture,
  TEXTURES,
  TEXTURE_SPEEDS,
  VIDEO_TONES,
  type Texture,
  type TextureSpeed,
} from "../core/types";
import {
  CATEGORIES,
  categoryOf,
  COUNT_MAX,
  COUNT_MIN,
  CUSTOM_PRESET,
  DEFAULT_COUNT,
  formatRows,
  generateRows,
  generatorLabel,
  GENERATORS,
  PRESETS,
  PRESET_KEYS,
  TEXT_FORMAT_INFO,
  TEXT_FORMATS,
  textFilename,
  type CategoryKey,
  type GeneratorKey,
  type TextFormat,
  type TextLocale,
  type TextSpec,
} from "./text-generators";
import { setupWebMcp, webmcpStatusText } from "./webmcp";

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const form = $<HTMLFormElement>("#panel");
const canvas = $<HTMLCanvasElement>("#canvas");
const stageEl = $<HTMLElement>("#stage");
// The context is resolved once and asserted non-null. Narrowing with `throw`
// does not survive the closures, so it is resolved here. It keeps its alpha
// channel (the default): the preview has to be able to show a transparent
// background, which an opaque context would render as black.
const ctx2d: CanvasRenderingContext2D = (() => {
  const c = canvas.getContext("2d");
  if (!c) throw new Error("the browser does not support canvas 2D");
  return c;
})();

let selectedPalette: PaletteEntry | null = null;
let abortController: AbortController | null = null;
let previewAnimation = 0;

/**
 * Which color of the pair is the one that was picked by hand. The other one is
 * computed from it every time, which is the whole legibility guarantee of the
 * app: the pair is only as good as the contrast of the one that was not chosen.
 *
 * `"none"` is the pair where neither follows: a measured palette pair, or two
 * colors of the person's own. A palette counts as neither because its pair is
 * declared, not computed, so the first color of their own replaces the whole
 * pair instead of following from it. Then the contrast indicator is the only
 * thing telling them how the pair came out.
 */
type Hand = "none" | "bg" | "fg";
let hand: Hand = "none";

/**
 * What each tab chose for the background, so switching tabs does not throw the
 * choice away: the image tab keeps the background it started with while the
 * video one keeps its own.
 *
 * An image gets `fog`, which is soft enough to stay behind the dimensions. A
 * video gets `mix`, which is the liveliest of the four and has the grain to
 * make the movement read on a small frame.
 */
const BACKGROUND_BY_KIND = new Map<MediaKind, string>([
  ['image', DEFAULT_IMAGE_TEXTURE],
  ['video', DEFAULT_VIDEO_TEXTURE],
]);

/** Names of the background kinds. The first two are the flat ones. */
const BACKGROUND_LABEL: Record<string, string> = {
  solid: 'Solid',
  transparent: 'Transparent',
  mix: 'Bokeh + grain',
  fog: 'Fog',
  focus: 'Center focus',
  rise: 'Rise',
};

/** Image formats that carry a timeline of their own, now offered in the video tab. */
const ANIMATED_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>([
  "gif",
  "mjpeg-avi",
  "jpeg-zip",
]);
/** Formats that accept the quality slider. */
const LOSSY: ReadonlySet<ImageFormat | VideoFormat> = new Set<
  ImageFormat | VideoFormat
>(["jpeg", "webp", "gif", "mjpeg-avi", "jpeg-zip"]);

// ── Reading the form ───────────────────────────────────────────────────

/** The pixel ceiling, the same one the `max="4096"` of the size inputs has. */
const DIM_MAX = 4096;

/**
 * A pair of dimensions as they are copied around: "1629×420", "1629x420",
 * "1629 420 px", "1629*420", "1629,420".
 *
 * The separator is required on purpose. If it were optional, "1629420" would
 * match as 1629×420 and a single size would turn into two.
 */
const DIMS_PAIR = /^\s*(\d{1,4})\s*(?:[x×*,]|\s)\s*(\d{1,4})\s*(?:px)?\s*$/i;

function num(name: string, fallback: number): number {
  const el = form.elements.namedItem(name);
  if (el instanceof RadioNodeList) {
    const v = Number.parseInt(el.value, 10);
    return Number.isFinite(v) ? v : fallback;
  }
  if (el instanceof HTMLInputElement) {
    const v = Number.parseInt(el.value, 10);
    if (Number.isFinite(v)) return v;
  }
  return fallback;
}

/**
 * Reads a text field, the selected value of a radio group, or the value of a
 * select.
 *
 * Watch out for the radio case: for a radio group, `form.elements.namedItem`
 * does NOT return an input, it returns a `RadioNodeList`. An
 * `instanceof HTMLInputElement` check returns false and the value is lost
 * silently, so the form looks like it never changes. The `.value` of the
 * `RadioNodeList` is the one of the checked radio.
 */
function str(name: string, fallback: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof RadioNodeList) return el.value || fallback;
  if (el instanceof HTMLInputElement && el.value) return el.value;
  if (el instanceof HTMLSelectElement && el.value) return el.value;
  return fallback;
}

function checked(name: string): boolean {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLInputElement && el.checked;
}

/**
 * The kind of background the form asks for.
 *
 * It is a single radio group with the two flat backgrounds and the four
 * textures in it, because they answer the same question: what is behind the
 * text. Splitting them would have made the user cross two controls for one
 * decision.
 */
function selectedBackground(): string {
  return str('background', BACKGROUND_BY_KIND.get(mediaKind()) ?? 'solid');
}

/** The texture that kind means. Both flat backgrounds are `none`. */
function selectedTexture(): Texture {
  const value = selectedBackground();
  return TEXTURES.includes(value as Texture) ? (value as Texture) : 'none';
}

/** The three tabs. Text joins image and video as a way to download something. */
type Kind = "image" | "video" | "text";

/** The tabs that draw to a canvas and share the background and palette state. */
type MediaKind = Exclude<Kind, "text">;

function currentKind(): Kind {
  const value = str("kind", "image");
  return value === "video" || value === "text" ? value : "image";
}

/**
 * The same answer narrowed to the tabs that have a canvas.
 *
 * `BACKGROUND_BY_KIND` is per media tab because each one keeps its own pick,
 * and the text tab has no background to keep. Reading the map with the full
 * `Kind` would need a lie in the map or a cast at every call, so the narrowing
 * is a named function instead.
 */
function mediaKind(): MediaKind {
  return currentKind() === "video" ? "video" : "image";
}

/** The format the current tab is going to produce. */
function currentFormat(): ImageFormat | TimelineFormat {
  return currentKind() === "video"
    ? (str("videoFormat", "mp4") as TimelineFormat)
    : (str("imageFormat", "png") as ImageFormat);
}

/** The sound that was asked for, defaulting to the tango. */
function selectedTone(): VideoTone {
  const value = str("soundTone", DEFAULT_VIDEO_TONE);
  return VIDEO_TONES.includes(value as VideoTone)
    ? (value as VideoTone)
    : DEFAULT_VIDEO_TONE;
}

/** How fast the background moves, defaulting to the one the app asks for. */
function selectedTextureSpeed(): TextureSpeed {
  const value = Number.parseFloat(str("textureSpeed", String(DEFAULT_TEXTURE_SPEED)));
  return TEXTURE_SPEEDS.includes(value as TextureSpeed)
    ? (value as TextureSpeed)
    : DEFAULT_TEXTURE_SPEED;
}

function readSpec(): Spec {
  const quality = num("quality", 90) / 100;
  // Only the video tab has a timeline now, so that is the only thing that
  // decides whether the output has more than one frame.
  const timed = currentKind() === "video";
  return {
    width: Math.max(1, num("width", 300)),
    height: Math.max(1, num("height", 200)),
    bg: normalizeHex(str("bg", "E0E0E0")),
    fg: normalizeHex(str("fg", "2B2B2B")),
    paletteName: selectedPalette?.name ?? "custom",
    duration: timed ? num("duration", 5) : 0,
    fps: num("fps", 15),
    // The bar and the clock only make sense with a real timeline.
    showProgressBar: timed && checked("showProgressBar"),
    showTime: timed && checked("showTime"),
    // Sound is an extra that has to be turned on, and only the video
    // containers can take it.
    tone: timed && checked("sound") ? selectedTone() : undefined,
    // Formats that cannot store alpha never get it, whatever is selected. The
    // radio stays on Transparent so going back to PNG restores the choice, but
    // the spec is what the encoders read.
    transparent:
      selectedBackground() === "transparent" && supportsAlpha(currentFormat()),
    // A texture paints every pixel, so it is only offered where the file is
    // drawn: the SVG is written as text and stays flat.
    texture: supportsTexture(currentFormat()) ? selectedTexture() : "none",
    // A single frame is the same picture at every speed, so the value only
    // travels with an output that has more than one. Unchecked movement is a
    // speed of 0: painted, and held still.
    textureSpeed: !timed
      ? DEFAULT_TEXTURE_SPEED
      : checked("textureMove")
        ? selectedTextureSpeed()
        : 0,
    quality,
  };
}

/** The FPS a GIF will really have, given that the delay goes in hundredths. */
export function effectiveGifFps(fps: number): number {
  const delayCs = Math.max(1, Math.round(100 / fps));
  return 100 / delayCs;
}

// ── Contrast ──────────────────────────────────────────────────────────

function refreshContrast(): void {
  const spec = readSpec();
  const result = checkContrast(spec.fg, spec.bg);
  $("#ratio").textContent = result.label;
  const level = $("#level");
  level.textContent = result.level;
  level.dataset.level = result.level;
  // The badge already carries the level, so the note only says what the badge
  // cannot: where the pair comes from, and what a level short of AA means.
  $("#levelNote").textContent =
    result.level === "fail"
      ? `${colorSource()} · unreadable`
      : result.level === "AA-large"
        ? `${colorSource()} · large text only`
        : colorSource();
  // The way back exists exactly when the pair cannot be read, which is also the
  // only moment it could be reached: a computed color clears AA by
  // construction, and a palette pair is measured above it.
  $("#fix").hidden = result.level !== "fail";
}

/** Where the pair on screen came from, in words. */
function colorSource(): string {
  if (selectedPalette) return `${selectedPalette.label} palette`;
  if (hand === "bg") return "text follows background";
  if (hand === "fg") return "background follows text";
  return "both colors yours";
}

/**
 * Opens the color picker on one of the two fields.
 *
 * `showPicker` is the way to open it without a click landing on the input, and
 * it refuses to run without a gesture of the person's own. A click is the older
 * path to the same dialog and works everywhere, so it is the fallback.
 */
function openPicker(which: "bg" | "fg"): void {
  const input = $<HTMLInputElement>(`#${which}`);
  try {
    input.showPicker();
  } catch {
    input.click();
  }
}

/** The pair as it stands in the form, normalized the way a `Spec` wants it. */
function currentColors(): { bg: string; fg: string } {
  return {
    bg: normalizeHex(str("bg", "E0E0E0")),
    fg: normalizeHex(str("fg", "2B2B2B")),
  };
}

/**
 * A color of their own came out of the picker.
 *
 * The other one follows it while it has NOT been a color of their own yet: either
 * it was being computed, or the pair was the measured one of a palette and this
 * is the first color they pick. Once both are theirs, picking one again leaves
 * the other exactly as it is, because throwing away a color someone chose to
 * satisfy a rule they already broke would be worse than the low contrast the
 * indicator is already reporting.
 */
function pickColor(which: "bg" | "fg", value: string): void {
  const clean = normalizeHex(value);
  const now = currentColors();
  const next = which === "bg" ? { ...now, bg: clean } : { ...now, fg: clean };
  const follows = hand === which || selectedPalette !== null;
  const partner = !follows
    ? next.fg
    : which === "bg"
      ? deriveForeground(next.bg)
      : deriveBackground(next.fg);
  applyColors(next.bg, partner, follows ? which : "none");
}

/**
 * Hands the pair back to the rule: the text is computed again from the
 * background, which is the guarantee the app can stand behind.
 *
 * This is what the `fix` button does, and it is the only way back from a pair
 * of two colors of their own, so the background it keeps is whatever was there.
 */
function fixPair(): void {
  const { bg } = currentColors();
  applyColors(bg, deriveForeground(bg), "bg");
}

function applyColors(
  bg: string,
  fg: string,
  source: Hand,
  entry: PaletteEntry | null = null,
): void {
  const cleanBg = normalizeHex(bg);
  const cleanFg = normalizeHex(fg);
  $<HTMLInputElement>("#bg").value = `#${cleanBg}`;
  $<HTMLInputElement>("#fg").value = `#${cleanFg}`;
  applyPageTheme(cleanBg);
  selectedPalette = entry;
  hand = source;
  // The custom swatch is the one that is not part of the palette, so it is the
  // pressed one exactly when no palette is.
  const pressed = entry === null ? "custom" : entry.name;
  for (const btn of document.querySelectorAll<HTMLButtonElement>(".swatch")) {
    btn.setAttribute("aria-pressed", String(btn.dataset.name === pressed));
  }
  // Until a color of their own exists, the custom swatch offers a measured pair
  // nobody asked for. Once one does, it is that color and the icon steps aside.
  const custom = document.querySelector<HTMLButtonElement>(".swatch.custom");
  if (custom) {
    const shown =
      entry === null ? { bg: cleanBg, fg: cleanFg } : { bg: customTileColor.bg, fg: customTileColor.fg };
    custom.style.background = swatchGradient(shown.bg, shown.fg);
    custom.querySelector("svg")?.toggleAttribute("hidden", entry === null);
    // The tile carries the two hexes the same way the palette ones do, which is
    // where a color of their own can be read back: the mosaic is the only
    // control, so there is nowhere else to write it down.
    custom.title = `Custom: ${cleanBg} background / ${cleanFg} text · click the large triangle for the background, the small one for the text`;
  }
  refreshContrast();
  // The tiles are examples of these two colors, so they follow them.
  renderBackgroundTiles();
  renderPreview();
}

/**
 * Dumps the chosen color into the page theme, so the interface takes its hue.
 *
 * Only the hue and the saturation are passed: the lightness of each surface is
 * set by the CSS depending on the active scheme. That way the whole page gets
 * tinted without the legibility of the interface depending on the color that
 * was picked.
 */
function applyPageTheme(bg: string): void {
  const { r, g, b } = hexToRgb(bg);
  const { h, s } = rgbToHsl(r, g, b);
  const root = document.documentElement.style;
  root.setProperty("--tint-h", String(Math.round(h)));
  root.setProperty("--tint-s", `${Math.round(s * 100)}%`);
  // The color of the mobile browser bar, which would otherwise stay on the
  // color the page started with.
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", cssColor(bg));
}

// ── Preview ───────────────────────────────────────────────────────────

/**
 * Keeps the canvas inside the stage, whatever the window does.
 *
 * A percentage cannot do this job. The canvas is a replaced element, so its
 * height follows its width, and `max-height: 100%` would need the stage to have
 * a definite height. It does not: the stage is a grid item stretched by a
 * `1fr` track, and percentages do not resolve against that. Measured, it does
 * not resolve either, and the canvas spills over the labels. So the app
 * measures the box and hands the number to the stylesheet through `--fit`.
 *
 * It is called on resize and on every refresh, not from a ResizeObserver: the
 * box is read and written in the same frame, which is what makes the observer
 * report a loop.
 */
function fitCanvas(): void {
  const cs = getComputedStyle(stageEl);
  // `clientHeight` leaves out the border and rounds down, so the number handed
  // over can never be bigger than the box the canvas has to live in.
  const inner =
    stageEl.clientHeight -
    parseFloat(cs.paddingTop) -
    parseFloat(cs.paddingBottom);
  const px = `${Math.max(0, inner)}px`;
  if (stageEl.style.getPropertyValue("--fit") !== px) {
    stageEl.style.setProperty("--fit", px);
  }
}

function stopPreviewAnimation(): void {
  if (previewAnimation) cancelAnimationFrame(previewAnimation);
  previewAnimation = 0;
}

function renderPreview(progress?: number): void {
  const spec = readSpec();
  canvas.width = spec.width;
  canvas.height = spec.height;
  drawFrame(ctx2d, spec, progress);
  // The checkerboard lives in the CSS background of the canvas, so it only
  // shows through the transparent pixels.
  canvas.dataset.transparent = String(spec.transparent);
  $("#dimsLabel").textContent = `${spec.width} × ${spec.height}`;
  updateMetaLine(spec);
}

function updateMetaLine(spec: Spec): void {
  const parts = [
    `${spec.width}×${spec.height}`,
    `palette ${spec.paletteName}`,
    `contrast ${checkContrast(spec.fg, spec.bg).label}`,
  ];
  if (spec.duration > 0) parts.push(`${spec.duration}s at ${spec.fps} fps`);
  // The checkerboard alone can read as a texture, so the state is also said in
  // words.
  if (spec.transparent) parts.push("transparent background");
  // The texture the file really has, which is not the one picked when the format
  // cannot carry it.
  if (spec.texture !== "none")
    parts.push(`background ${BACKGROUND_LABEL[spec.texture]?.toLowerCase() ?? spec.texture}`);
  $("#metaLine").textContent = parts.join(" · ");
}

/**
 * A clip shorter than this is previewed slower than real time: 120ms of a
 * timeline is a couple of frames, and a preview nobody can follow is not a
 * preview. It only costs fidelity on clips that are already degenerate.
 */
const PREVIEW_MIN_SEC = 0.6;

/**
 * In video mode the bar is animated so it reads as progress. It is only the
 * preview; the real file is drawn by the encoder.
 *
 * It plays the frames of the file at the speed the file plays them: the first
 * `TEXTURE_REFERENCE_SECONDS` of the clip, in real time, looping. Compressing a
 * whole clip into a fixed number of seconds would be a time-lapse instead, and
 * the background would not move at the speed it moves in the file: 24 times
 * faster for a 120s clip, faster than real for a 5s one. As it is, every
 * duration is judged at the velocity of the 5s clip the app is tuned on.
 */
function animatePreview(): void {
  stopPreviewAnimation();
  const spec = readSpec();
  if (spec.duration <= 0) {
    renderPreview(0);
    return;
  }
  const windowSec = Math.max(PREVIEW_MIN_SEC, Math.min(TEXTURE_REFERENCE_SECONDS, spec.duration));
  const windowMs = windowSec * 1000;
  const start = performance.now();
  const tick = (now: number) => {
    // Progress in the *file*, not in the loop, so what is on screen is a frame
    // of the file and not an impression of it.
    const elapsed = (now - start) % windowMs;
    renderPreview(Math.min(1, elapsed / (spec.duration * 1000)));
    previewAnimation = requestAnimationFrame(tick);
  };
  previewAnimation = requestAnimationFrame(tick);
}

// ── Palette ───────────────────────────────────────────────────────────

/**
 * The palette icon that sits on the custom swatch.
 *
 * Built here with the rest of the swatches instead of in the markup: the row is
 * generated, and a tenth hardcoded tile next to nine generated ones is two
 * sources of truth for the same thing.
 */
function paletteIcon(): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("stroke-width", "2");
  svg.setAttribute("class", "swatchicon");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute(
    "d",
    "M12 22a1 1 0 010-20 10 9 0 0110 9 5 5 0 01-5 5h-2.25a1.75 1.75 0 00-1.4 2.8l.3.4a1.75 1.75 0 01-1.4 2.8z",
  );
  svg.append(path);
  for (const [cx, cy] of [
    [13.5, 6.5],
    [17.5, 10.5],
    [6.5, 12.5],
    [8.5, 7.5],
  ]) {
    const dot = document.createElementNS("http://www.w3.org/2000/svg", "circle");
    dot.setAttribute("cx", String(cx));
    dot.setAttribute("cy", String(cy));
    dot.setAttribute("r", ".5");
    dot.setAttribute("fill", "currentColor");
    svg.append(dot);
  }
  return svg;
}

/**
 * The custom swatch: the way out of the palette.
 *
 * It is painted with the pair, split in two, and each half opens the picker of
 * its own color, so both are chosen from the mosaic and nowhere else. Until a
 * color of the person's own exists, it offers a measured pair nobody asked for,
 * under the palette icon that says there is something to pick. It is the last
 * swatch because it is the one that is not part of the palette.
 */
function renderSwatches(): void {
  const host = $("#swatches");
  host.replaceChildren();
  for (const entry of palette()) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "swatch";
    btn.dataset.name = entry.name;
    btn.title = `${entry.label} · ${entry.bg} / ${entry.fg} · ${entry.contrast.label}`;
    btn.setAttribute(
      "aria-label",
      `Palette ${entry.label}, contrast ${entry.contrast.label}`,
    );
    btn.setAttribute("aria-pressed", "false");
    btn.style.background = swatchGradient(entry.bg, entry.fg);
    // The pair of a palette is measured, so it is used as declared: deriving it
    // would replace it with different colors and different ratios.
    btn.addEventListener("click", () => applyColors(entry.bg, entry.fg, "none", entry));
    host.append(btn);
  }

  const custom = document.createElement("button");
  custom.type = "button";
  custom.className = "swatch custom";
  custom.dataset.name = "custom";
  custom.title =
    "Custom color: the large triangle opens the picker for the background, the small one for the text";
  custom.setAttribute(
    "aria-label",
    "Custom color. Click the large triangle for the background color and the small one for the text color; with the keyboard, Enter is the background and the arrow keys reach the text.",
  );
  custom.setAttribute("aria-pressed", "false");
  custom.append(paletteIcon());
  // The tile is painted with the pair split in two, so the click itself says
  // which of the two colors is being picked. There is no second control: the
  // mosaic is the only place a color is chosen.
  custom.addEventListener("click", (ev) => openPicker(swatchHalf(custom, ev)));
  // The keyboard lands in the middle of the tile, which is the background half,
  // so the arrows are how the text one is reached without a mouse.
  custom.addEventListener("keydown", (ev) => {
    if (ev.key !== "ArrowRight" && ev.key !== "ArrowDown") return;
    ev.preventDefault();
    openPicker("fg");
  });
  host.append(custom);
}

/**
 * Where the diagonal split every swatch is painted with falls, as the share of
 * the tile the background takes. Half of it: the split goes corner to corner,
 * which is the one line that reads as "the same size" instead of as a background
 * with a corner cut off.
 *
 * It is the same number the gradient is built with, so the two halves of the
 * paint and the two halves of a click can never disagree.
 */
const SWATCH_SPLIT = 50;

/**
 * Which color of the pair a click on a swatch landed on.
 *
 * The swatches are square, so the 135° split crosses the tile from one corner to
 * the opposite one and the test is a single sum: past the diagonal is the text,
 * before it is the background.
 */
function swatchHalf(swatch: HTMLElement, ev: MouseEvent): "bg" | "fg" {
  const box = swatch.getBoundingClientRect();
  const x = (ev.clientX - box.left) / box.width;
  const y = (ev.clientY - box.top) / box.height;
  return x + y > (SWATCH_SPLIT / 100) * 2 ? "fg" : "bg";
}

/** The diagonal split every swatch is painted with. */
function swatchGradient(bg: string, fg: string): string {
  return `linear-gradient(135deg, ${cssColor(bg)} 0 ${SWATCH_SPLIT}%, ${cssColor(fg)} ${SWATCH_SPLIT}% 100%)`;
}

// ── Background tiles ───────────────────────────────────────────────────

/** Tile size, the same shape the palette swatches have. */
const TILE_WIDTH = 64;
const TILE_HEIGHT = 64;

/**
 * The pair the custom swatch offers while nobody has picked a color of their own.
 *
 * It is drawn once, not on every render: a swatch that changed color every time
 * the palette did would be noise, and the icon on top already says there is a
 * picker behind it.
 */
let customTileColor = randomPalette();

/**
 * Puts one example of every background on its own tile.
 *
 * It is the real renderer at tile size, not an approximation: the same
 * `paintTexture` the exports use, with the same seed, so a tile cannot promise
 * something the file will not deliver. A texture is drawn at a fixed moment of
 * its animation, and the transparent one gets no image at all, so the
 * checkerboard behind the tile is the example.
 *
 * The result is a PNG in the `src` of an `<img>`, not a live canvas: a tile is a
 * still of a moving thing, and it should not cost a repaint on every step of the
 * preview.
 *
 * The canvas is built once and reused for the whole row: each render overwrites
 * it and reads the data URL out, so the row costs one small surface.
 */
function renderBackgroundTiles(): void {
  const spec = readSpec();
  const surface = document.createElement("canvas");
  surface.width = TILE_WIDTH;
  surface.height = TILE_HEIGHT;
  const ctx = surface.getContext("2d");
  for (const img of document.querySelectorAll<HTMLImageElement>("img[data-preview]")) {
    const value = img.dataset.preview ?? "solid";
    // The transparent one keeps the transparent pixel it ships with: an `img`
    // with no `src` is a broken image, not an empty one. The checkerboard behind
    // it is the example.
    if (value === "transparent") continue;
    if (!ctx) break;
    ctx.clearRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
    ctx.fillStyle = cssColor(spec.bg);
    ctx.fillRect(0, 0, TILE_WIDTH, TILE_HEIGHT);
    if (TEXTURES.includes(value as Texture) && value !== "none") {
      paintTexture(
        ctx,
        { ...spec, width: TILE_WIDTH, height: TILE_HEIGHT, texture: value as Texture },
        // A moment of the animation and not the first frame: `rise` spends the
        // beginning of its cycle below the frame, where the tile would read empty.
        2,
      );
    }
    img.src = surface.toDataURL("image/png");
  }
}

// ── State derived from the controls ───────────────────────────────────

/** Names that differ from the upper-cased format id. */
const FORMAT_LABEL: Readonly<Record<string, string>> = {
  "mjpeg-avi": "AVI",
  "jpeg-zip": "ZIP",
};

function refreshDownloadLabel(): void {
  const label = $("#generateLabel");
  if (currentKind() === "text") {
    // The extension is said instead of the format name because the file is what
    // the person is about to open, and `json` twice for two different shapes
    // would be a poor way to name them.
    label.textContent = `Download .${TEXT_FORMAT_INFO[readTextSpec().format].extension}`;
    return;
  }
  const format = currentFormat();
  label.textContent = `Download ${FORMAT_LABEL[format] ?? format.toUpperCase()}`;
}

/**
 * Explains the selected format under each group. The text is the description
 * already written for WebMCP, so the person and the agent read the same facts
 * and there is a single place to edit them.
 */
function refreshFormatHints(): void {
  for (const hint of document.querySelectorAll<HTMLElement>(
    "[data-hint-for]",
  )) {
    const input = form.querySelector<HTMLInputElement>(
      `input[name="${hint.dataset.hintFor}"]:checked`,
    );
    hint.textContent = input?.getAttribute("toolparamdescription") ?? "";
  }
}

function refreshDependentUi(): void {
  const kind = currentKind();
  for (const section of document.querySelectorAll<HTMLElement>("[data-kind]")) {
    // A section lists every tab it belongs to, space separated. The three
    // canvas groups carry both media tabs, since a video is measured and colored
    // exactly like a still image.
    const kinds = section.dataset.kind?.split(" ") ?? [];
    section.hidden = !kinds.includes(kind);
  }
  // The stage and the text preview share the same slot in the layout, and
  // neither carries `data-kind` because they are not groups of controls. Which
  // one shows is decided here, once, for every tab: leaving it to the text
  // branch alone would hide the canvas on the way in and never bring it back.
  const text = kind === "text";
  $("#stage").hidden = text;
  $<HTMLElement>("#textPreview").hidden = !text;
  $("#textRegenerate").hidden = !text;
  $("#textCopy").hidden = !text;

  if (text) {
    refreshDownloadLabel();
    refreshTextUi();
    return;
  }
  if (kind === "image") stopPreviewAnimation();

  // The quality slider follows the format of the active tab: JPEG and WebP
  // take it in the image tab, and the animated formats in the video one.
  const format = currentFormat();
  refreshFormatHints();
  refreshDownloadLabel();
  const qualityField = form.querySelector<HTMLElement>(".quality");
  if (qualityField) qualityField.hidden = !LOSSY.has(format);

  // Transparency is a property of the background, so it is the formats that
  // bend: picking `Transparent` turns off every format that cannot store an
  // alpha channel, and picks one that can. The tile itself is never disabled,
  // because refusing the background would leave the person with no way to ask
  // for it. Textures are the other way around: SVG is written as text, so it
  // cannot carry one and the tiles go off.
  const canTexture = supportsTexture(format);
  const transparent = selectedBackground() === "transparent";
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="background"]')) {
    const supported = !input.hasAttribute("data-texture") || canTexture;
    input.disabled = !supported;
    // The tiles carry no name under them, so this is where it is written. It
    // goes on the tile because a disabled input does not take the hover.
    const tile = input.nextElementSibling as HTMLElement | null;
    const name = BACKGROUND_LABEL[input.value] ?? input.value;
    if (tile) {
      tile.title = supported ? name : `${name}: this format is written as text and stays flat`;
    }
  }

  // The formats follow the background: a transparent one turns off every format
  // that cannot store an alpha channel. The browser's own verdict is kept in a
  // dataset, because reading `input.disabled` back here would make the two
  // reasons indistinguishable and neither of them reversible.
  const formatName = kind === "video" ? "videoFormat" : "imageFormat";
  const formatInputs = [...form.querySelectorAll<HTMLInputElement>(`input[name="${formatName}"]`)];
  for (const input of formatInputs) {
    const encodable = input.dataset.encodable !== 'false';
    const keepsAlpha = !transparent || supportsAlpha(input.value as ImageFormat);
    input.disabled = !encodable || !keepsAlpha;
    // Two reasons to be off, and the one that applies is the one said out loud.
    const span = input.nextElementSibling as HTMLElement | null;
    if (span) {
      span.title = !encodable
        ? "This browser cannot encode this format"
        : keepsAlpha
          ? ""
          : "A transparent background needs a format with an alpha channel";
    }
  }
  // A radio that is off cannot stay checked without leaving the form pointing
  // at a format nobody can pick, so the selection moves to the first one that
  // can still carry what was asked for.
  const picked = formatInputs.find((input) => input.checked);
  if (picked?.disabled) {
    const fallback = formatInputs.find((input) => !input.disabled);
    if (fallback) {
      fallback.checked = true;
      refreshDependentUi();
      return;
    }
  }

  // Every format with a timeline lives in the video tab, so the section shows
  // up exactly there.
  const timeline = $("#timeline");
  const timed = kind === "video";
  timeline.hidden = !timed;

  const spec = readSpec();
  const even = evenDimensions(spec.width, spec.height);
  const evenWarning = $("#evenWarning");
  const rounds = kind === "video" && even.changed;
  evenWarning.hidden = !rounds;
  if (rounds) {
    evenWarning.textContent = `H.264 needs even dimensions: the video will be ${even.width}×${even.height}.`;
  }

  // The GIF only takes hundredth delays, so the real FPS is almost never the
  // requested one. It is reported with the number, not with a "may differ".
  const fpsEffective = $("#fpsEffective");
  if (format === "gif") {
    const eff = effectiveGifFps(spec.fps);
    fpsEffective.hidden = false;
    fpsEffective.textContent = `The GIF only takes hundredth delays: ${spec.fps} fps come out as ${eff.toFixed(1)} fps.`;
  } else {
    fpsEffective.hidden = true;
  }

  // With a single frame there is no bar to show.
  const singleFrame = Math.round(spec.duration * spec.fps) <= 1;
  for (const name of ["showProgressBar", "showTime"] as const) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.disabled = singleFrame;
  }

  // The speed only has something to speed up: an animated texture, and a
  // timeline to animate it on. A flat background or a single frame gives the
  // same picture at 1× and at 3×, so the control does not come out for them.
  const speedField = $("#textureSpeedField");
  const speedSelect = $<HTMLSelectElement>("#textureSpeed");
  const move = form.elements.namedItem("textureMove");
  const canSpeed = timed && !singleFrame && spec.texture !== "none";
  const moving = move instanceof HTMLInputElement && move.checked;
  speedField.hidden = !canSpeed;
  if (move instanceof HTMLInputElement) move.disabled = !canSpeed;
  // The speed is a property of the movement, so it follows its own box.
  speedSelect.disabled = !canSpeed || !moving;
  speedSelect.title = !canSpeed
    ? "Only an animated background on a format with more than one frame has a speed to pick."
    : moving
      ? ""
      : "The background is held still, so there is no speed to pick";

  // Only the four containers can carry an audio track, the animated outputs
  // have no room for one, and a single frame has no timeline to put it on. The
  // picker follows its own checkbox, so a sound is never chosen by accident.
  const sound = form.elements.namedItem("sound");
  const soundTone = $<HTMLSelectElement>("#soundTone");
  const canSound = !ANIMATED_IMAGE_FORMATS.has(format as ImageFormat) && !singleFrame;
  if (sound instanceof HTMLInputElement) sound.disabled = !canSound;
  soundTone.disabled = !canSound || !(sound instanceof HTMLInputElement) || !sound.checked;

  // The preview is animated for any format with a timeline, so the GIF shows
  // its bar moving.
  if (timed && !singleFrame) {
    animatePreview();
  } else {
    stopPreviewAnimation();
    renderPreview(0);
  }

  // The labels under the stage just changed, and with them the height the
  // canvas has to fit in.
  fitCanvas();
}

// ── Text ─────────────────────────────────────────────────────────────────

/**
 * The named separators. The picker offers words rather than the characters
 * themselves because a literal newline in the value of an `<option>` is
 * invisible in the markup and impossible to tell from a space when reading it.
 */
const SEPARATORS: Record<string, string> = {
  newline: "\n",
  comma: ",",
  semicolon: ";",
  tab: "\t",
  space: " ",
};

/** Resolves the separator picker, including whatever the custom box holds. */
function selectedSeparator(): string {
  const pick = str("textSeparator", "newline");
  if (pick !== "custom") return SEPARATORS[pick] ?? "\n";
  // An empty custom box is a separator of nothing, which would glue every row
  // together. A newline is the least surprising thing a blank box can mean.
  return $<HTMLInputElement>("#textSeparatorCustom").value || "\n";
}

/** What the text tab is currently set to generate. */
function readTextSpec(): TextSpec {
  const raw = num("textCount", DEFAULT_COUNT);
  return {
    preset: str("textPreset", PRESET_KEYS[0] ?? ""),
    category: str("textCategory", "lorem") as CategoryKey,
    generator: str("textGenerator", GENERATORS[0] ?? ("lorem.sentence" as GeneratorKey)) as GeneratorKey,
    locale: str("textLocale", "en") as TextLocale,
    // The box has min and max, but a value can arrive pasted, typed over or from
    // an agent, and generating a million rows would lock the tab up.
    count: Math.min(COUNT_MAX, Math.max(COUNT_MIN, Number.isFinite(raw) ? raw : DEFAULT_COUNT)),
    format: str("textFormat", "plain") as TextFormat,
    separator: selectedSeparator(),
  };
}

/**
 * Fills the preset and generator pickers from the registry.
 *
 * Nothing about the catalog is written in the markup: the options are built
 * here so adding a faker method to `text-generators.ts` is the only edit a new
 * generator needs. The `value` of a generator option is the full `category.key`
 * because that is the key the registry is looked up by and the key an agent
 * reads in the schema.
 */
function populateTextControls(): void {
  const preset = $<HTMLSelectElement>("#textPreset");
  for (const key of PRESET_KEYS) {
    const presetDef = PRESETS[key];
    const option = document.createElement("option");
    option.value = key;
    option.textContent = presetDef ? presetDef.label : key;
    preset.append(option);
  }
  // The hand-off back to the person. It is a real option because a select always
  // has something selected, and "nothing" would have to be an invisible value.
  const custom = document.createElement("option");
  custom.value = CUSTOM_PRESET;
  custom.textContent = "Custom…";
  preset.append(custom);

  const category = $<HTMLSelectElement>("#textCategory");
  for (const key of Object.keys(CATEGORIES) as CategoryKey[]) {
    const option = document.createElement("option");
    option.value = key;
    option.textContent = CATEGORIES[key].label;
    category.append(option);
  }
  // The generator list depends on the category, so it is built last and from
  // whatever the category select landed on.
  refreshGeneratorOptions(category.value);
}

/**
 * Rebuilds the generator picker for a category.
 *
 * The category is a grouping for the person; the generator is what actually
 * runs. Rebuilding on every category change is the whole reason the catalog can
 * stay a plain data structure instead of needing an index built at startup.
 */
function refreshGeneratorOptions(category: string): void {
  const select = $<HTMLSelectElement>("#textGenerator");
  const def = CATEGORIES[category as CategoryKey];
  const previous = select.value;
  select.replaceChildren();
  for (const name of def?.gens ?? []) {
    const option = document.createElement("option");
    option.value = `${category}.${name}`;
    option.textContent = name;
    select.append(option);
  }
  // Switching category throws the old pick away on purpose: it belonged to the
  // other group. When the same generator survives, it is restored instead.
  if ([...select.options].some((option) => option.value === previous)) {
    select.value = previous;
  }
}

/** Points the category and generator pickers at a generator from a preset. */
function revealGenerator(generator: GeneratorKey): void {
  const category = categoryOf(generator);
  $<HTMLSelectElement>("#textCategory").value = category;
  refreshGeneratorOptions(category);
  $<HTMLSelectElement>("#textGenerator").value = generator;
}

/**
 * Keeps the text tab in step with its own controls.
 *
 * Two things are decided here rather than on every event: which pickers matter,
 * because a preset answers for them, and whether the output starts with a
 * header, which is the one difference the person cannot guess from the format
 * name alone.
 */
function refreshTextUi(): void {
  const spec = readTextSpec();
  const custom = spec.preset === CUSTOM_PRESET;
  // A preset is a bundle of generators, so the pickers below it would either
  // lie about what is being generated or sit there contradicting it.
  $<HTMLSelectElement>("#textCategory").disabled = !custom;
  $<HTMLSelectElement>("#textGenerator").disabled = !custom;

  const customBox = $<HTMLInputElement>("#textSeparatorCustom");
  customBox.hidden = str("textSeparator", "newline") !== "custom";

  // The preview is the output verbatim, so whatever is generated is what gets
  // copied and downloaded. It is regenerated here because this runs on every
  // text control change, and a preview that lags behind the controls is a
  // preview nobody trusts.
  renderText();
}

/** Generates the current spec and shows it. */
function renderText(): void {
  const spec = readTextSpec();
  let text: string;
  try {
    text = formatRows(generateRows(spec), spec.format, spec.separator);
  } catch (err) {
    // A generator the catalog lists but the installed faker does not have would
    // throw here. It is said in the note rather than left as a dead preview,
    // since the rest of the tab still works.
    $("#textNote").textContent = err instanceof Error ? err.message : String(err);
    $("#textPreview").textContent = "";
    updateTextMetaLine(0);
    return;
  }
  $("#textPreview").textContent = text;
  $("#textNote").textContent = "";
  updateTextMetaLine(spec.count);
  textOutput = text;
}

/** The size of the current text output, said the way the media tabs say theirs. */
function updateTextMetaLine(count: number): void {
  const spec = readTextSpec();
  const label = TEXT_FORMAT_INFO[spec.format].label;
  $("#dimsLabel").textContent = `${count} ${count === 1 ? "row" : "rows"}`;
  $("#metaLine").textContent = `${label} · ${spec.locale} · ${textFilename(spec)}`;
}

/** The last output rendered, kept so Copy has something to hand the clipboard. */
let textOutput = "";

/** Puts the preview on the clipboard, with a fallback for denied permission. */
async function copyText(): Promise<void> {
  if (!textOutput) return;
  try {
    await navigator.clipboard.writeText(textOutput);
    showMessage("Copied to the clipboard", "success");
  } catch {
    // The async clipboard needs a secure context, which a file:// page is not.
    // Selecting the text is the one thing that works everywhere, so the person
    // is told to press the keys rather than left with a button that did nothing.
    const preview = $<HTMLElement>("#textPreview");
    const range = document.createRange();
    range.selectNodeContents(preview);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    preview.focus();
    showMessage("The browser would not give the clipboard. The text is selected: press Ctrl or Cmd + C.", "error");
  }
}

/** Wraps the current output in a file and hands it to the download path. */
function downloadText(): void {
  const spec = readTextSpec();
  if (!textOutput) return;
  const blob = new Blob([textOutput], { type: TEXT_FORMAT_INFO[spec.format].mime });
  downloadBlob(blob, textFilename(spec));
  showMessage(`Downloaded ${textFilename(spec)} · ${(blob.size / 1024).toFixed(1)} KB`, "success");
}

// ── Generating ────────────────────────────────────────────────────────

function showMessage(
  text: string,
  tone: "error" | "info" | "success" = "error",
): void {
  const el = $("#message");
  el.textContent = text;
  el.dataset.tone = tone;
  el.setAttribute("role", tone === "error" ? "alert" : "status");
  el.hidden = false;
}

function clearMessage(): void {
  const el = $("#message");
  el.hidden = true;
  el.textContent = "";
}

function setBusy(busy: boolean): void {
  $<HTMLButtonElement>("#generate").disabled = busy;
  if (busy) $("#generateLabel").textContent = "Generating…";
  else refreshDownloadLabel();
  $("#cancel").hidden = !busy;
  $("#progress").hidden = !busy;
  if (!busy) {
    $("#progressFill").style.width = "0%";
  }
}

function onProgress(info: ProgressInfo): void {
  const pct = Math.max(0, Math.min(1, info.progress)) * 100;
  $("#progressFill").style.width = `${pct}%`;
  const text =
    info.frame !== undefined && info.totalFrames !== undefined
      ? `${info.message ?? "Processing"} (${info.frame}/${info.totalFrames})`
      : (info.message ?? `${pct.toFixed(0)}%`);
  $("#progressText").textContent = text;
}

async function generate(): Promise<void> {
  clearMessage();
  const kind = currentKind();
  // Text has no encoding and no timeline, so it does not go near the busy state,
  // the progress bar or the cancel button: it is a string that already exists by
  // the time the click is handled.
  if (kind === "text") {
    downloadText();
    return;
  }
  const spec = readSpec();
  abortController = new AbortController();
  setBusy(true);
  onProgress({ progress: 0, message: "Preparing…" });

  try {
    const signal = abortController.signal;
    const result =
      kind === "video"
        ? await exportTimeline(
            spec,
            str("videoFormat", "mp4") as TimelineFormat,
            onProgress,
            signal,
          )
        : await exportImage(
            spec,
            str("imageFormat", "png") as StillImageFormat,
            onProgress,
            signal,
          );

    onProgress({ progress: 1, message: "Done" });
    downloadBlob(result.blob, result.filename);
    showMessage(
      `Downloaded ${result.filename} · ${(result.size / 1024).toFixed(1)} KB`,
      "success",
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      showMessage("Cancelled.", "info");
    } else {
      showMessage(err instanceof Error ? err.message : String(err));
    }
  } finally {
    setBusy(false);
    abortController = null;
  }
}

/**
 * The video tab produces the four video containers plus the three animated
 * image formats, which have a timeline too and are written by their own
 * encoders.
 */
async function exportTimeline(
  spec: Spec,
  format: TimelineFormat,
  onProgress_: (i: ProgressInfo) => void,
  signal: AbortSignal,
) {
  if (format === "gif") return exportGif(spec, onProgress_, signal);
  if (format === "mjpeg-avi") return exportMjpegAvi(spec, onProgress_, signal);
  if (format === "jpeg-zip") return exportJpegZip(spec, onProgress_, signal);
  return exportVideo(spec, format, onProgress_, signal);
}

// ── WebMCP: what an agent can drive ───────────────────────────────────

/** The settings that only mean something to a canvas, refused by the text tab. */
const PIXEL_PARAMS = [
  "width",
  "height",
  "imageFormat",
  "videoFormat",
  "duration",
  "fps",
  "texture",
  "palette",
  "background",
  "foreground",
] as const;

function applySettings(
  input: Record<string, unknown>,
): { ok: true } | { ok: false; error: string } {
  try {
    // Before anything is written, not after. An agent that asks for
    // `kind: text` together with a width should get the refusal and an
    // untouched form: applying half the input first would leave the tab
    // holding a width it was just told does not matter.
    if (input.kind === "text") {
      for (const name of PIXEL_PARAMS) {
        if (input[name] !== undefined) {
          return {
            ok: false,
            error: `"${name}" does not apply to kind "text", which has no pixels; use textPreset, textCategory, textGenerator, textLocale, textCount, textFormat or textSeparator`,
          };
        }
      }
    }

    if (input.width !== undefined) setNum("width", Number(input.width));
    if (input.height !== undefined) setNum("height", Number(input.height));
    if (input.duration !== undefined)
      setNum("duration", Number(input.duration));
    if (input.fps !== undefined) setNum("fps", Number(input.fps));

    if (typeof input.kind === "string") {
      setRadio("kind", input.kind);
    }
    // Text is driven through its own controls rather than through the canvas
    // ones, and each is validated against the registry the tab was built from,
    // because a bad key would otherwise be silently ignored and the agent would
    // get a file that is not what it asked for.
    if (typeof input.textPreset === "string") {
      const key = input.textPreset;
      if (key !== CUSTOM_PRESET && !(key in PRESETS)) {
        return {
          ok: false,
          error: `unknown text preset "${key}", expected one of ${PRESET_KEYS.join(", ")}`,
        };
      }
      setSelect("textPreset", key);
      const preset = PRESETS[key];
      if (preset) revealGenerator(preset.fields[0]?.gen ?? GENERATORS[0]!);
    }
    if (typeof input.textGenerator === "string") {
      const key = input.textGenerator as GeneratorKey;
      if (!GENERATORS.includes(key)) {
        return {
          ok: false,
          error: `unknown generator "${key}", expected category.method, one of ${GENERATORS.length} in the catalog`,
        };
      }
      setSelect("textPreset", CUSTOM_PRESET);
      revealGenerator(key);
    } else if (typeof input.textCategory === "string") {
      const key = input.textCategory;
      if (!(key in CATEGORIES)) {
        return {
          ok: false,
          error: `unknown category "${key}", expected one of ${Object.keys(CATEGORIES).join(", ")}`,
        };
      }
      setSelect("textCategory", key);
      refreshGeneratorOptions(key);
    }
    if (typeof input.textFormat === "string") {
      if (!TEXT_FORMATS.includes(input.textFormat as TextFormat)) {
        return {
          ok: false,
          error: `unknown text format "${input.textFormat}", expected one of ${TEXT_FORMATS.join(", ")}`,
        };
      }
      setRadio("textFormat", input.textFormat);
    }
    if (typeof input.textLocale === "string") {
      const key = input.textLocale;
      if (key !== "en" && key !== "es") {
        return {
          ok: false,
          error: `unknown text locale "${key}", expected "en" or "es"`,
        };
      }
      setSelect("textLocale", key);
    }
    if (input.textCount !== undefined) setNum("textCount", Number(input.textCount));

    if (typeof input.imageFormat === "string") {
      setRadio("imageFormat", input.imageFormat);
    }
    if (typeof input.videoFormat === "string") {
      setRadio("videoFormat", input.videoFormat);
    }
    if (typeof input.showProgressBar === "boolean") {
      setCheckbox("showProgressBar", input.showProgressBar);
    }
    if (typeof input.showTime === "boolean") {
      setCheckbox("showTime", input.showTime);
    }
    // `background` is already the flat color in the MCP contract, so the
    // treatment on top of it travels as `texture`. Its `none` is the flat
    // background, which the interface calls `solid`.
    if (typeof input.texture === "string") {
      if (!TEXTURES.includes(input.texture as Texture)) {
        return {
          ok: false,
          error: `unknown texture "${input.texture}", expected one of ${TEXTURES.join(", ")}`,
        };
      }
      setRadio("background", input.texture === "none" ? "solid" : input.texture);
      rememberBackground();
    }
    // Applied after `texture`, so asking for both ends with the transparent one,
    // which is the more explicit of the two.
    if (typeof input.transparent === "boolean") {
      setRadio("background", input.transparent ? "transparent" : "solid");
      rememberBackground();
    }
    if (input.textureMove !== undefined) {
      setCheckbox("textureMove", Boolean(input.textureMove));
    }
    if (input.textureSpeed !== undefined) {
      const speed = Number(input.textureSpeed);
      if (!TEXTURE_SPEEDS.includes(speed as TextureSpeed)) {
        return {
          ok: false,
          error: `unknown texture speed "${String(input.textureSpeed)}", expected one of ${TEXTURE_SPEEDS.join(", ")}`,
        };
      }
      // A speed of 0 is what the movement box says when it is off, so the two
      // controls cannot end up telling the form different things.
      setSelect("textureSpeed", String(speed || DEFAULT_TEXTURE_SPEED));
      setCheckbox("textureMove", speed > 0);
    }
    if (typeof input.sound === "boolean") {
      setCheckbox("sound", input.sound);
    }
    if (typeof input.soundTone === "string") {
      setSelect("soundTone", input.soundTone);
    }

    // The color is resolved last, so a `background` without a palette takes
    // precedence over the palette and not the other way around.
    if (typeof input.palette === "string") {
      const found = palette().find(
        (p) => p.name === input.palette || p.label === input.palette,
      );
      if (!found)
        return {
          ok: false,
          error: `unknown palette "${String(input.palette)}"`,
        };
      applyColors(found.bg, found.fg, "none", found);
    }
    // One color at a time, in the same order the interface applies them: a
    // `background` alone brings the text with it, and a `foreground` alone
    // keeps the background that is on screen.
    if (typeof input.background === "string") {
      pickColor("bg", input.background);
    }
    if (typeof input.foreground === "string") {
      pickColor("fg", input.foreground);
    }

    refreshDependentUi();
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function setNum(name: string, value: number): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement && Number.isFinite(value))
    el.value = String(Math.round(value));
}
function setRadio(name: string, value: string): void {
  const el = form.querySelector<HTMLInputElement>(
    `input[name="${name}"][value="${value}"]`,
  );
  if (el) el.checked = true;
}
function setCheckbox(name: string, value: boolean): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement) el.checked = value;
}
function setSelect(name: string, value: string): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLSelectElement) el.value = value;
}
/** Stores the background of the active tab, so switching tabs can restore it. */
function rememberBackground(): void {
  BACKGROUND_BY_KIND.set(mediaKind(), selectedBackground());
}

function describe(): Record<string, unknown> {
  // Text answers with its own settings only. Reporting the size, the palette and
  // the contrast of a picture that is not being generated would tell the agent
  // the canvas is configured, and it would believe it.
  if (currentKind() === "text") {
    const spec = readTextSpec();
    const preset = PRESETS[spec.preset];
    return {
      kind: "text",
      format: spec.format,
      locale: spec.locale,
      count: spec.count,
      ...(spec.preset ? { preset: spec.preset } : {}),
      ...(preset ? { columns: preset.fields.map((field) => field.as) } : {}),
      ...(preset ? {} : { category: spec.category, generator: spec.generator }),
      // What the file on disk will be called, which is the part an agent that
      // saves the result has to write down.
      filename: textFilename(spec),
    };
  }
  const spec = readSpec();
  return {
    width: spec.width,
    height: spec.height,
    kind: currentKind(),
    format: currentFormat(),
    background: spec.bg,
    foreground: spec.fg,
    palette: spec.paletteName,
    // Which of the two is the one that was picked: the other is computed from
    // it, and that is what keeps the pair at AA. With neither, both are of
    // their own and only `contrast` says how the pair came out.
    textIsDerived: hand === "bg",
    backgroundIsDerived: hand === "fg",
    contrast: checkContrast(spec.fg, spec.bg).label,
    ...(spec.duration > 0 ? { duration: spec.duration, fps: spec.fps } : {}),
    ...(spec.tone ? { sound: spec.tone } : {}),
    transparent: spec.transparent,
    // The texture the file really gets, which is not always the one asked for:
    // a format that cannot carry it falls back to the flat background.
    texture: spec.texture,
    // Only worth reporting when it changes something: a flat background or a
    // single frame looks the same at every speed.
    ...(spec.texture !== "none" && spec.duration > 0
      ? { textureSpeed: spec.textureSpeed, textureMove: spec.textureSpeed > 0 }
      : {}),
  };
}

// ── Start-up ──────────────────────────────────────────────────────────

async function syncVideoAvailability(): Promise<void> {
  const spec = readSpec();
  const supported = await availableVideoFormats(spec.width, spec.height);
  for (const input of form.querySelectorAll<HTMLInputElement>(
    'input[name="videoFormat"]',
  )) {
    // The animated image formats are not encoders of this browser, they are
    // always available.
    const animated = ANIMATED_IMAGE_FORMATS.has(input.value as ImageFormat);
    const available =
      animated || supported.includes(input.value as VideoFormat);
    // Recorded, not just applied: the background rules re-derive `disabled`
    // from this, and a disabled input cannot say whether it was this browser
    // or the background that turned it off.
    input.dataset.encodable = String(available);
    input.disabled = !available;
    const span = input.nextElementSibling as HTMLElement | null;
    if (span)
      span.title = available ? "" : "This browser cannot encode this format";
  }
  refreshDependentUi();
  const warn = $("#videoUnsupported");
  if (supported.length === 0) {
    warn.hidden = false;
    warn.textContent =
      "This browser has no WebCodecs support, so video cannot be generated. Images and the GIF still work. There is no support in Firefox for Android.";
  } else {
    warn.hidden = true;
  }
}

function wireEvents(): void {
  form.addEventListener("input", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (!abortController) clearMessage();

    if (target.id === "bg" || target.id === "fg") {
      // A color of their own drops the palette: the person is intervening.
      pickColor(target.id, target.value);
      return;
    }
    switch (target.name) {
      case "quality":
        $("#qualityOut").textContent = `${target.value}%`;
        break;
      case "kind":
        // Each tab has its own background, and this is where the other one comes
        // back. `refreshDependentUi` already decides whether the preview
        // animates.
        if (currentKind() !== "text") {
          setRadio(
            "background",
            BACKGROUND_BY_KIND.get(mediaKind()) ?? "solid",
          );
        }
        refreshDependentUi();
        void syncVideoAvailability();
        return;
      case "background":
        rememberBackground();
        break;
    }
    refreshDependentUi();
  });

  form.addEventListener("change", (ev) => {
    const target = ev.target;
    // The text pickers have to settle before the tab is refreshed, because the
    // refresh generates from whatever they say. The generic `refreshDependentUi`
    // below runs last for that reason.
    if (target instanceof HTMLSelectElement) {
      switch (target.name) {
        case "textCategory":
          refreshGeneratorOptions(target.value);
          break;
        case "textPreset": {
          const preset = PRESETS[target.value];
          // The pickers point at the first generator of the bundle so they agree
          // with what is being generated instead of contradicting it. On
          // `Custom…` they are left alone: that is the one option that means the
          // person is choosing.
          if (preset) revealGenerator(preset.fields[0]?.gen ?? GENERATORS[0]!);
          break;
        }
        case "textSeparator":
          // The custom box belongs to the option that asks for it, so it is
          // revealed here rather than on every refresh of the tab.
          $<HTMLInputElement>("#textSeparatorCustom").hidden = target.value !== "custom";
          break;
      }
    }
    refreshContrast();
    refreshDependentUi();
  });

  // Regenerating is its own button because for text, unlike a picture, the only
  // reason to want a new one is to want a different one. Every control already
  // regenerates on change; this changes nothing and rerolls.
  $("#textRegenerate").addEventListener("click", () => {
    clearMessage();
    renderText();
  });
  $("#textCopy").addEventListener("click", () => {
    void copyText();
  });

  // Pasting a size into either field fills both. A `type="number"` input runs
  // the value sanitization algorithm, so "1629×420" would land there empty:
  // the `paste` event still carries the raw text, which is the only chance to
  // read it.
  form.addEventListener("paste", (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;
    if (target.id !== "width" && target.id !== "height") return;

    const m = DIMS_PAIR.exec(ev.clipboardData?.getData("text") ?? "");
    if (!m) return; // not a pair: the paste stays the one the browser does
    ev.preventDefault();

    // Left to right, like the `×` between the two labels. Pasting into the
    // height fills the width too, it does not flip.
    const width = Number(m[1]);
    const height = Number(m[2]);
    if (width < 1 || height < 1 || width > DIM_MAX || height > DIM_MAX) {
      showMessage(`Sizes must be between 1 and ${DIM_MAX} px.`, "error");
      return;
    }
    setNum("width", width);
    setNum("height", height);
    clearMessage();
    refreshDependentUi();
  });

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    void generate();
  });

  $("#cancel").addEventListener("click", () => {
    abortController?.abort();
  });

  // The window resizing is the other thing that moves the stage.
  window.addEventListener("resize", fitCanvas);

  $("#swap").addEventListener("click", () => {
    const w = num("width", 300);
    setNum("width", num("height", 200));
    setNum("height", w);
    refreshDependentUi();
  });

  // The way back to the rule, next to the number it repairs.
  $("#fix").addEventListener("click", fixPair);
}

async function main(): Promise<void> {
  await ensureFontLoaded();
  renderSwatches();

  const start = palette().at(0);
  if (!start) throw new Error("No palette found");
  applyColors(start.bg, start.fg, "none", start);

  // The text pickers start empty because the catalog is not written in the
  // markup, so they are filled before the first refresh reads them.
  populateTextControls();

  wireEvents();
  refreshDependentUi();
  void syncVideoAvailability();

  const registered = await setupWebMcp({
    applySettings,
    generate: async () => {
      await generate();
      const el = $("#message");
      return el.hidden ? "Generated." : (el.textContent ?? "Generated.");
    },
    describe,
    text: () => textOutput,
  });

  const status = $("#webmcpStatus");
  if (registered) {
    status.textContent = webmcpStatusText(true);
    status.hidden = false;
  }
}

void main();
