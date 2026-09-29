import { checkContrast, cssColor, deriveForeground, normalizeHex, palette, randomPalette } from '../core/color';
import { drawFrame } from '../core/draw-frame';
import { downloadBlob } from '../core/download';
import { evenDimensions, filenameForSpec } from '../core/filename';
import { ensureFontLoaded } from '../core/font';
import { exportGif } from '../encoders/gif';
import { exportImage, type StillImageFormat } from '../encoders/image';
import { exportJpegZip, exportMjpegAvi } from '../encoders/mjpeg';
import { availableVideoFormats, exportVideo } from '../encoders/video';
import type { ImageFormat, PaletteEntry, ProgressInfo, Spec, VideoFormat } from '../core/types';
import { setupWebMcp, webmcpStatusText } from './webmcp';

const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`falta el elemento ${sel}`);
  return el;
};

const form = $<HTMLFormElement>('#panel');
const canvas = $<HTMLCanvasElement>('#canvas');
// El contexto se resuelve una vez y se asegura no nulo. Narrowing con `throw`
// no sobrevive a los closures, así que se resuelve acá adentro.
const ctx2d: CanvasRenderingContext2D = (() => {
  const c = canvas.getContext('2d', { alpha: false });
  if (!c) throw new Error('el navegador no soporta canvas 2D');
  return c;
})();

let selectedPalette: PaletteEntry | null = null;
let abortController: AbortController | null = null;
let previewAnimation = 0;

/** Imágenes que se pueden pedir en un click, sin pasar por un submenú. */
const ANIMATED_IMAGE_FORMATS: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['gif', 'mjpeg-avi', 'jpeg-zip']);
/** Formatos que aceptan el slider de calidad. */
const LOSSY: ReadonlySet<ImageFormat> = new Set<ImageFormat>(['jpeg', 'webp', 'gif', 'mjpeg-avi', 'jpeg-zip']);

// ── Lectura del formulario ────────────────────────────────────────────

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
 * Lee un campo de texto o el valor seleccionado de un grupo de radios.
 *
 * Ojo con esto: para un grupo de radios, `form.elements.namedItem` NO devuelve
 * un input, devuelve un `RadioNodeList`. Un `instanceof HTMLInputElement` da
 * false y el valor se pierde en silencio, con lo que el form parece no cambiar
 * nunca. El `.value` del `RadioNodeList` sí es el del radio marcado.
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

function readSpec(): Spec {
  const quality = num('quality', 90) / 100;
  const isVideo = currentKind() === 'video';
  // GIF, AVI y ZIP son imágenes pero tienen línea de tiempo. Si se les
  // forzara `duration: 0` saldrían con un único frame, que no es un GIF
  // animado sino una imagen con extensión de GIF.
  const timed = isVideo || ANIMATED_IMAGE_FORMATS.has(str('imageFormat', 'png') as ImageFormat);
  return {
    width: Math.max(1, num('width', 300)),
    height: Math.max(1, num('height', 200)),
    bg: normalizeHex(str('bg', 'F2DEE2')),
    fg: normalizeHex(str('fg', '962C41')),
    paletteName: selectedPalette?.name ?? 'custom',
    duration: timed ? num('duration', 5) : 0,
    fps: num('fps', 15),
    // La barra y el reloj sólo tienen sentido con una línea de tiempo real.
    showProgressBar: timed && checked('showProgressBar'),
    showTime: timed && checked('showTime'),
    quality,
  };
}

/** FPS que un GIF realmente va a tener, dado que el delay va en centésimas. */
export function effectiveGifFps(fps: number): number {
  const delayCs = Math.max(1, Math.round(100 / fps));
  return 100 / delayCs;
}

// ── Contraste ────────────────────────────────────────────────────────

function refreshContrast(): void {
  const spec = readSpec();
  const result = checkContrast(spec.fg, spec.bg);
  $('#ratio').textContent = result.label;
  const level = $('#level');
  level.textContent = result.level;
  level.dataset.level = result.level;
  $('#levelNote').textContent = {
    AAA: 'supera el máximo de WCAG',
    AA: 'cumple WCAG AA',
    'AA-large': 'sólo apto para texto grande',
    fail: 'insuficiente',
  }[result.level];
}

function applyColors(bg: string, entry: PaletteEntry | null): void {
  const clean = normalizeHex(bg);
  ($<HTMLInputElement>('#bg')).value = `#${clean}`;
  // El texto nunca se elige a mano: sale del fondo. Esa es toda la garantía
  // de legibilidad de la app, y por eso el input es readonly.
  ($<HTMLInputElement>('#fg')).value = `#${deriveForeground(clean)}`;
  selectedPalette = entry;
  for (const btn of document.querySelectorAll<HTMLButtonElement>('.swatch')) {
    btn.setAttribute('aria-pressed', String(entry?.name === btn.dataset.name));
  }
  refreshContrast();
  renderPreview();
}

// ── Vista previa ─────────────────────────────────────────────────────

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
    `paleta ${spec.paletteName}`,
    `contraste ${checkContrast(spec.fg, spec.bg).label}`,
  ];
  if (spec.duration > 0) parts.push(`${spec.duration}s a ${spec.fps} fps`);
  $('#metaLine').textContent = parts.join(' · ');
}

/**
 * En modo video la barra se anima para que se entienda que representa el
 * avance. Es sólo preview; el archivo real lo dibuja el encoder.
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

// ── Paleta ───────────────────────────────────────────────────────────

function renderSwatches(): void {
  const host = $('#swatches');
  host.replaceChildren();
  for (const entry of palette()) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'swatch';
    btn.dataset.name = entry.name;
    btn.title = `${entry.label} · ${entry.bg} / ${entry.fg} · ${entry.contrast.label}`;
    btn.setAttribute('aria-label', `Paleta ${entry.label}, contraste ${entry.contrast.label}`);
    btn.setAttribute('aria-pressed', 'false');
    btn.style.background = `linear-gradient(135deg, ${cssColor(entry.bg)} 0 58%, ${cssColor(entry.fg)} 58% 100%)`;
    btn.addEventListener('click', () => applyColors(entry.bg, entry));
    host.append(btn);
  }
}

// ── Estado derivado de los controles ─────────────────────────────────

function refreshDependentUi(): void {
  const kind = currentKind();
  for (const section of document.querySelectorAll<HTMLElement>('[data-kind]')) {
    section.hidden = section.dataset.kind !== kind;
  }
  if (kind === 'image') stopPreviewAnimation();

  const imageFormat = str('imageFormat', 'png') as ImageFormat;
  const qualityField = form.querySelector<HTMLElement>('.quality');
  if (qualityField) qualityField.hidden = !LOSSY.has(imageFormat);

  // La línea de tiempo aparece si el formato elegido la tiene, sin importar
  // en qué tab esté: el GIF es una imagen, pero se anima.
  const timeline = $('#timeline');
  const timed = kind === 'video' || ANIMATED_IMAGE_FORMATS.has(imageFormat);
  timeline.hidden = !timed;

  const spec = readSpec();
  const even = evenDimensions(spec.width, spec.height);
  const evenWarning = $('#evenWarning');
  const rounds = kind === 'video' && even.changed;
  evenWarning.hidden = !rounds;
  if (rounds) {
    evenWarning.textContent = `H.264 exige dimensiones pares: el video se hará de ${even.width}×${even.height}.`;
  }

  // El GIF sólo admite retardos en centésimas, así que el FPS real casi
  // nunca es el que se pidió. Se avisa con el número, no con un "puede diferir".
  const fpsEffective = $('#fpsEffective');
  if (kind === 'image' && imageFormat === 'gif') {
    const eff = effectiveGifFps(spec.fps);
    fpsEffective.hidden = false;
    fpsEffective.textContent = `El GIF sólo admite retardos en centésimas: ${spec.fps} fps salen como ${eff.toFixed(1)} fps.`;
  } else {
    fpsEffective.hidden = true;
  }

  // Con un solo frame no hay barra que mostrar.
  // Con un solo frame no hay barra que mostrar.
  const singleFrame = Math.round(spec.duration * spec.fps) <= 1;
  for (const name of ['showProgressBar', 'showTime'] as const) {
    const el = form.elements.namedItem(name);
    if (el instanceof HTMLInputElement) el.disabled = singleFrame;
  }

  // El preview se anima para cualquier formato con línea de tiempo, no sólo
  // para el tab de video: así el GIF muestra su barra moviéndose.
  if (timed && !singleFrame) {
    animatePreview();
  } else {
    stopPreviewAnimation();
    renderPreview(0);
  }
}

// ── Generación ───────────────────────────────────────────────────────

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
      ? `${info.message ?? 'Procesando'} (${info.frame}/${info.totalFrames})`
      : (info.message ?? `${pct.toFixed(0)}%`);
  $('#progressText').textContent = text;
}

async function generate(): Promise<void> {
  clearMessage();
  const kind = currentKind();
  const spec = readSpec();
  abortController = new AbortController();
  setBusy(true);
  onProgress({ progress: 0, message: 'Preparando…' });

  try {
    const signal = abortController.signal;
    const result =
      kind === 'video'
        ? await exportVideo(spec, str('videoFormat', 'mp4') as VideoFormat, onProgress, signal)
        : await exportImageDispatch(spec, str('imageFormat', 'png') as ImageFormat, onProgress, signal);

    onProgress({ progress: 1, message: 'Listo' });
    downloadBlob(result.blob, result.filename);
    showMessage(
      `${result.filename} · ${(result.size / 1024).toFixed(1)} KB · generado por el-coso-3000`,
      'info',
    );
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      showMessage('Cancelado.', 'info');
    } else {
      showMessage(err instanceof Error ? err.message : String(err));
    }
  } finally {
    setBusy(false);
    abortController = null;
  }
}

async function exportImageDispatch(
  spec: Spec,
  format: ImageFormat,
  onProgress_: (i: ProgressInfo) => void,
  signal: AbortSignal,
) {
  if (format === 'gif') return exportGif(spec, onProgress_, signal);
  if (format === 'mjpeg-avi') return exportMjpegAvi(spec, onProgress_, signal);
  if (format === 'jpeg-zip') return exportJpegZip(spec, onProgress_, signal);
  return exportImage(spec, format as StillImageFormat, onProgress_, signal);
}

// ── WebMCP: lo que el agente puede tocar ─────────────────────────────

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

    // El color se resuelve al final, para que un `background` sin palette
    // tenga prioridad sobre la paleta y no al revés.
    if (typeof input.palette === 'string') {
      const found = palette().find((p) => p.name === input.palette || p.label === input.palette);
      if (!found) return { ok: false, error: `no conozco la paleta "${String(input.palette)}"` };
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
  const kind = currentKind();
  return {
    width: spec.width,
    height: spec.height,
    kind,
    format: kind === 'video' ? str('videoFormat', 'mp4') : str('imageFormat', 'png'),
    background: spec.bg,
    foreground: spec.fg,
    palette: spec.paletteName,
    contrast: checkContrast(spec.fg, spec.bg).label,
    ...(kind === 'video' ? { duration: spec.duration, fps: spec.fps } : {}),
  };
}

// ── Arranque ─────────────────────────────────────────────────────────

async function syncVideoAvailability(): Promise<void> {
  const spec = readSpec();
  const supported = await availableVideoFormats(spec.width, spec.height);
  for (const input of form.querySelectorAll<HTMLInputElement>('input[name="videoFormat"]')) {
    const available = supported.includes(input.value as VideoFormat);
    input.disabled = !available;
    const span = input.nextElementSibling as HTMLElement | null;
    if (span) span.title = available ? '' : 'Este navegador no puede codificar en este formato';
  }
  const warn = $('#videoUnsupported');
  if (supported.length === 0) {
    warn.hidden = false;
    warn.textContent =
      'Este navegador no soporta WebCodecs, así que no se puede generar video. Las imágenes y el GIF siguen funcionando. En Firefox Android no hay soporte.';
  } else {
    warn.hidden = true;
  }
}

function wireEvents(): void {
  form.addEventListener('input', (ev) => {
    const target = ev.target;
    if (!(target instanceof HTMLInputElement)) return;

    if (target.id === 'bg') {
      // Cambiar el fondo a mano saca la paleta: el usuario está interveniendo.
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
        // `refreshDependentUi` ya decide si el preview se anima.
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

  for (const btn of form.querySelectorAll<HTMLButtonElement>('.presets button')) {
    btn.addEventListener('click', () => {
      setNum('width', Number(btn.dataset.w));
      setNum('height', Number(btn.dataset.h));
      refreshDependentUi();
    });
  }
}

async function main(): Promise<void> {
  await ensureFontLoaded();
  renderSwatches();

  const first = palette()[0];
  if (first) {
    applyColors(first.bg, first);
  }

  wireEvents();
  refreshDependentUi();
  void syncVideoAvailability();

  const registered = await setupWebMcp({
    applySettings,
    generate: async () => {
      await generate();
      const el = $('#message');
      return el.hidden ? 'Generado.' : (el.textContent ?? 'Generado.');
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
