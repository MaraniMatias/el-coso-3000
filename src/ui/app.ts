import { checkContrast, cssColor, deriveForeground, hexToRgb, normalizeHex, palette, randomPalette, rgbToHsl } from '../core/color';
import { drawFrame } from '../core/draw-frame';
import { downloadBlob } from '../core/download';
import { evenDimensions, filenameForSpec } from '../core/filename';
import { ensureFontLoaded } from '../core/font';
import { exportGif } from '../encoders/gif';
import { exportImage, type StillImageFormat } from '../encoders/image';
import { exportJpegZip, exportMjpegAvi } from '../encoders/mjpeg';
import { availableVideoFormats, exportVideo } from '../encoders/video';
import type { ImageFormat, PaletteEntry, ProgressInfo, Spec, TimelineFormat, VideoFormat } from '../core/types';
import { setupWebMcp, webmcpStatusText } from './webmcp';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`missing element ${sel}`);
  return el;
};

const form = $<HTMLFormElement>('#panel');
const canvas = $<HTMLCanvasElement>('#canvas');
// The context is resolved once and asserted non-null. Narrowing with `throw`
// does not survive the closures, so it is resolved here.
const ctx2d: CanvasRenderingContext2D = (() => {
  const c = canvas.getContext('2d', { alpha: false });
  if (!c) throw new Error('the browser does not support canvas 2D');
  return c;
})();

let selectedPalette: PaletteEntry | null = null;
let abortController: AbortController | null = null;
let previewAnimation = 0;

/** Image formats that carry a timeline of their own, now offered in the video tab. */
const ANIMATED_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['gif', 'mjpeg-avi', 'jpeg-zip']);
/** Formats that accept the quality slider. */
const LOSSY: ReadonlySet<ImageFormat | VideoFormat> = new Set<ImageFormat | VideoFormat>([
  'jpeg',
  'webp',
  'gif',
  'mjpeg-avi',
  'jpeg-zip',
]);

// ── Reading the form ───────────────────────────────────────────────────

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
 * Reads a text field or the selected value of a radio group.
 *
 * Watch out for this one: for a radio group, `form.elements.namedItem` does
 * NOT return an input, it returns a `RadioNodeList`. An
 * `instanceof HTMLInputElement` check returns false and the value is lost
 * silently, so the form looks like it never changes. The `.value` of the
 * `RadioNodeList` is the one of the checked radio.
 */
function str(name: string, fallback: string): string {
  const el = form.elements.namedItem(name);
  if (el instanceof RadioNodeList) return el.value || fallback;
  if (el instanceof HTMLInputElement && el.value) return el.value;
  return fallback;
}

function checked(name: string): boolean {
  const el = form.elements.namedItem(name);
  return el instanceof HTMLInputElement && el.checked;
}

function currentKind(): 'image' | 'video' {
  return str('kind', 'image') === 'video' ? 'video' : 'image';
}

/** The format the current tab is going to produce. */
function currentFormat(): ImageFormat | TimelineFormat {
  return currentKind() === 'video'
    ? (str('videoFormat', 'mp4') as TimelineFormat)
    : (str('imageFormat', 'png') as ImageFormat);
}

function readSpec(): Spec {
  const quality = num('quality', 90) / 100;
  // Only the video tab has a timeline now, so that is the only thing that
  // decides whether the output has more than one frame.
  const timed = currentKind() === 'video';
  return {
    width: Math.max(1, num('width', 300)),
    height: Math.max(1, num('height', 200)),
    bg: normalizeHex(str('bg', 'E0E0E0')),
    fg: normalizeHex(str('fg', '2B2B2B')),
    paletteName: selectedPalette?.name ?? 'custom',
    duration: timed ? num('duration', 5) : 0,
    fps: num('fps', 15),
    // The bar and the clock only make sense with a real timeline.
    showProgressBar: timed && checked('showProgressBar'),
    showTime: timed && checked('showTime'),
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
  $('#ratio').textContent = result.label;
  const level = $('#level');
  level.textContent = result.level;
  level.dataset.level = result.level;
  $('#levelNote').textContent = {
    AAA: 'beats the WCAG maximum',
    AA: 'meets WCAG AA',
    'AA-large': 'only fits large text',
    fail: 'not enough',
  }[result.level];
}

function applyColors(bg: string, entry: PaletteEntry | null): void {
  const clean = normalizeHex(bg);
  // A palette swatch carries the text that was measured with it, so it is used
  // as declared. Only a background the user typed has no pair, and there the
  // text is derived. Deriving it always would silently replace the measured
  // pairs with different colors and different ratios.
  const fg = entry ? entry.fg : deriveForeground(clean);
  ($<HTMLInputElement>('#bg')).value = `#${clean}`;
  // The text is never picked by hand: it comes from the background or from the
  // pair of the swatch. That is the whole legibility guarantee of the app,
  // which is why the input is readonly.
  ($<HTMLInputElement>('#fg')).value = `#${fg}`;
  applyPageTheme(clean);
  selectedPalette = entry;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.swatch')) {
    btn.setAttribute('aria-pressed', String(entry?.name === btn.dataset.name));
  }
  refreshContrast();
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
  root.setProperty('--tint-h', String(Math.round(h)));
  root.setProperty('--tint-s', `${Math.round(s * 100)}%`);
  // The color of the mobile browser bar, which would otherwise stay on the
  // color the page started with.
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', cssColor(bg));
}

// ── Preview ───────────────────────────────────────────────────────────

function stopPreviewAnimation(): void {
  if (previewAnimation) cancelAnimationFrame(previewAnimation);
  previewAnimation = 0;
}

function renderPreview(progress?: number): void {
  const spec = readSpec();
  canvas.width = spec.width;
  canvas.height = spec.height;
  drawFrame(ctx2d, spec, progress);
  $('#dimsLabel').textContent = `${spec.width} × ${spec.height}`;
  updateMetaLine(spec);
}

function updateMetaLine(spec: Spec): void {
  const parts = [
    `${spec.width}×${spec.height}`,
    `palette ${spec.paletteName}`,
    `contrast ${checkContrast(spec.fg, spec.bg).label}`,
  ];
  if (spec.duration > 0) parts.push(`${spec.duration}s at ${spec.fps} fps`);
  $('#metaLine').textContent = parts.join(' · ');
}

/**
 * In video mode the bar is animated so it reads as progress. It is only the
 * preview; the real file is drawn by the encoder.
 */
function animatePreview(): void {
  stopPreviewAnimation();
  const spec = readSpec();
  if (spec.duration <= 0) {
    renderPreview(0);
    return;
  }
  const cycleMs = Math.max(600, Math.min(4000, spec.duration * 1000));
  const start = performance.now();
  const tick = (now: number) => {
    const t = ((now - start) % cycleMs) / cycleMs;
    renderPreview(t);
    previewAnimation = requestAnimationFrame(tick);
  };
  previewAnimation = requestAnimationFrame(tick);
}

// ── Palette ───────────────────────────────────────────────────────────

function renderSwatches(): void {
  const host = $('#swatches');
  host.replaceChildren();
  for (const entry of palette()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.name = entry.name;
    btn.title = `${entry.label} · ${entry.bg} / ${entry.fg} · ${entry.contrast.label}`;
    btn.setAttribute('aria-label', `Palette ${entry.label}, contrast ${entry.contrast.label}`);
    btn.setAttribute('aria-pressed', 'false');
    btn.style.background = `linear-gradient(135deg, ${cssColor(entry.bg)} 0 58%, ${cssColor(entry.fg)} 58% 100%)`;
    btn.addEventListener('click', () => applyColors(entry.bg, entry));
    host.append(btn);
  }
}

// ── State derived from the controls ───────────────────────────────────

/**
 * Shows the preset that matches the dimensions, or `Custom` when there is
 * none. The raw field values are used on purpose: an empty input must read as
 * Custom, not as the fallback size.
 */
function syncPresetSelect(): void {
  const select = $<HTMLSelectElement>('#presetSize');
  const key = `${str('width', '')}x${str('height', '')}`;
  const match = [...select.options].some((option) => option.value === key);
  select.value = match ? key : '';
}

function refreshDependentUi(): void {
  const kind = currentKind();
  for (const section of document.querySelectorAll<HTMLElement>('[data-kind]')) {
    section.hidden = section.dataset.kind !== kind;
  }
  if (kind === 'image') stopPreviewAnimation();

  // The quality slider follows the format of the active tab: JPEG and WebP
  // take it in the image tab, and the animated formats in the video one.
  const format = currentFormat();
  const qualityField = form.querySelector<HTMLElement>('.quality');
  if (qualityField) qualityField.hidden = !LOSSY.has(format);

  // Every format with a timeline lives in the video tab, so the section shows
  // up exactly there.
  const timeline = $('#timeline');
  const timed = kind === 'video';
  timeline.hidden = !timed;

  const spec = readSpec();
  syncPresetSelect();
  const even = evenDimensions(spec.width, spec.height);
  const evenWarning = $('#evenWarning');
  const rounds = kind === 'video' && even.changed;
  evenWarning.hidden = !rounds;
  if (rounds) {
    evenWarning.textContent = `H.264 needs even dimensions: the video will be ${even.width}×${even.height}.`;
  }

  // The GIF only takes hundredth delays, so the real FPS is almost never the
  // requested one. It is reported with the number, not with a "may differ".
  const fpsEffective = $('#fpsEffective');
  if (format === 'gif') {
    const eff = effectiveGifFps(spec.fps);
    fpsEffective.hidden = false;
    fpsEffective.textContent = `The GIF only takes hundredth delays: ${spec.fps} fps come out as ${eff.toFixed(1)} fps.`;
  } else {
    fpsEffective.hidden = true;
  }

  // With a single frame there is no bar to show.
  const singleFrame = Math.round(spec.duration * spec.fps) <= 1;
  for (const name of ['showProgressBar', 'showTime'] as const) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.disabled = singleFrame;
  }

  // The preview is animated for any format with a timeline, so the GIF shows
  // its bar moving.
  if (timed && !singleFrame) {
    animatePreview();
  } else {
    stopPreviewAnimation();
    renderPreview(0);
  }
}

// ── Generating ────────────────────────────────────────────────────────

function showMessage(text: string, tone: 'error' | 'info' = 'error'): void {
  const el = $('#message');
  el.textContent = text;
  el.dataset.tone = tone;
  el.hidden = false;
}

function clearMessage(): void {
  const el = $('#message');
  el.hidden = true;
  el.textContent = '';
}

function setBusy(busy: boolean): void {
  $<HTMLButtonElement>('#generate').disabled = busy;
  $('#cancel').hidden = !busy;
  $('#progress').hidden = !busy;
  if (!busy) {
    $('#progressFill').style.width = '0%';
  }
}

function onProgress(info: ProgressInfo): void {
  const pct = Math.max(0, Math.min(1, info.progress)) * 100;
  $('#progressFill').style.width = `${pct}%`;
  const text =
    info.frame !== undefined && info.totalFrames !== undefined
      ? `${info.message ?? 'Processing'} (${info.frame}/${info.totalFrames})`
      : (info.message ?? `${pct.toFixed(0)}%`);
  $('#progressText').textContent = text;
}

async function generate(): Promise<void> {
  clearMessage();
  const kind = currentKind();
  const spec = readSpec();
  abortController = new AbortController();
  setBusy(true);
  onProgress({ progress: 0, message: 'Preparing…' });

  try {
    const signal = abortController.signal;
    const result =
      kind === 'video'
        ? await exportTimeline(spec, str('videoFormat', 'mp4') as TimelineFormat, onProgress, signal)
        : await exportImage(spec, str('imageFormat', 'png') as StillImageFormat, onProgress, signal);

    onProgress({ progress: 1, message: 'Done' });
    downloadBlob(result.blob, result.filename);
    showMessage(
      `${result.filename} · ${(result.size / 1024).toFixed(1)} KB · generated by El Coso 3000`,
      'info',
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      showMessage('Cancelled.', 'info');
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
  if (format === 'gif') return exportGif(spec, onProgress_, signal);
  if (format === 'mjpeg-avi') return exportMjpegAvi(spec, onProgress_, signal);
  if (format === 'jpeg-zip') return exportJpegZip(spec, onProgress_, signal);
  return exportVideo(spec, format, onProgress_, signal);
}

// ── WebMCP: what an agent can drive ───────────────────────────────────

function applySettings(input: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
  try {
    if (input.width !== undefined) setNum('width', Number(input.width));
    if (input.height !== undefined) setNum('height', Number(input.height));
    if (input.duration !== undefined) setNum('duration', Number(input.duration));
    if (input.fps !== undefined) setNum('fps', Number(input.fps));

    if (typeof input.kind === 'string') {
      setRadio('kind', input.kind);
    }
    if (typeof input.imageFormat === 'string') {
      setRadio('imageFormat', input.imageFormat);
    }
    if (typeof input.videoFormat === 'string') {
      setRadio('videoFormat', input.videoFormat);
    }
    if (typeof input.showProgressBar === 'boolean') {
      setCheckbox('showProgressBar', input.showProgressBar);
    }
    if (typeof input.showTime === 'boolean') {
      setCheckbox('showTime', input.showTime);
    }

    // The color is resolved last, so a `background` without a palette takes
    // precedence over the palette and not the other way around.
    if (typeof input.palette === 'string') {
      const found = palette().find((p) => p.name === input.palette || p.label === input.palette);
      if (!found) return { ok: false, error: `unknown palette "${String(input.palette)}"` };
      applyColors(found.bg, found);
    }
    if (typeof input.background === 'string') {
      applyColors(input.background, null);
    }

    refreshDependentUi();
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function setNum(name: string, value: number): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement && Number.isFinite(value)) el.value = String(Math.round(value));
}
function setRadio(name: string, value: string): void {
  const el = form.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
  if (el) el.checked = true;
}
function setCheckbox(name: string, value: boolean): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLInputElement) el.checked = value;
}

function describe(): Record<string, unknown> {
  const spec = readSpec();
  return {
    width: spec.width,
    height: spec.height,
    kind: currentKind(),
    format: currentFormat(),
    background: spec.bg,
    foreground: spec.fg,
    palette: spec.paletteName,
    contrast: checkContrast(spec.fg, spec.bg).label,
    ...(spec.duration > 0 ? { duration: spec.duration, fps: spec.fps } : {}),
  };
}

// ── Start-up ──────────────────────────────────────────────────────────

async function syncVideoAvailability(): Promise<void> {
  const spec = readSpec();
  const supported = await availableVideoFormats(spec.width, spec.height);
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="videoFormat"]')) {
    // The animated image formats are not encoders of this browser, they are
    // always available.
    const animated = ANIMATED_IMAGE_FORMATS.has(input.value as ImageFormat);
    const available = animated || supported.includes(input.value as VideoFormat);
    input.disabled = !available;
    const span = input.nextElementSibling as HTMLElement | null;
    if (span) span.title = available ? '' : 'This browser cannot encode this format';
  }
  const warn = $('#videoUnsupported');
  if (supported.length === 0) {
    warn.hidden = false;
    warn.textContent =
      'This browser has no WebCodecs support, so video cannot be generated. Images and the GIF still work. There is no support in Firefox for Android.';
  } else {
    warn.hidden = true;
  }
}

function wireEvents(): void {
  form.addEventListener('input', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.id === 'bg') {
      // Changing the background by hand drops the palette: the user is
      // intervening.
      applyColors(target.value, null);
      return;
    }
    switch (target.name) {
      case 'quality':
        $('#qualityOut').textContent = `${target.value}%`;
        break;
      case 'duration':
        $('#durationOut').textContent = `${target.value}s`;
        break;
      case 'fps':
        $('#fpsOut').textContent = target.value;
        break;
      case 'kind':
        // `refreshDependentUi` already decides whether the preview animates.
        refreshDependentUi();
        void syncVideoAvailability();
        return;
    }
    refreshDependentUi();
  });

  form.addEventListener('change', () => {
    refreshContrast();
    refreshDependentUi();
  });

  form.addEventListener('submit', (ev) => {
    ev.preventDefault();
    void generate();
  });

  $('#cancel').addEventListener('click', () => {
    abortController?.abort();
  });

  $('#random').addEventListener('click', () => {
    const entry = randomPalette();
    applyColors(entry.bg, entry);
    refreshDependentUi();
  });

  $('#swap').addEventListener('click', () => {
    const w = num('width', 300);
    setNum('width', num('height', 200));
    setNum('height', w);
    refreshDependentUi();
  });

  $('#presetSize').addEventListener('change', (ev) => {
    const key = (ev.target as HTMLSelectElement).value;
    if (!key) return;
    const [w, h] = key.split('x');
    setNum('width', Number(w));
    setNum('height', Number(h));
    refreshDependentUi();
  });
}

async function main(): Promise<void> {
  await ensureFontLoaded();
  renderSwatches();

  // It starts on a random palette, not on the first one of the list: every
  // visit opens with a different color.
  const start = randomPalette();
  applyColors(start.bg, start);

  wireEvents();
  refreshDependentUi();
  void syncVideoAvailability();

  const registered = await setupWebMcp({
    applySettings,
    generate: async () => {
      await generate();
      const el = $('#message');
      return el.hidden ? 'Generated.' : (el.textContent ?? 'Generated.');
    },
    describe,
  });

  const status = $('#webmcpStatus');
  if (registered) {
    status.textContent = webmcpStatusText(true);
    status.hidden = false;
  }
}

void main();
