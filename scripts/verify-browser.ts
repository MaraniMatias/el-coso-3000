/**
 * Verification in a real browser, through the Chrome DevTools Protocol.
 *
 * Runs: `bun run verify:browser`
 *
 * This exists because Bun's tests have no DOM and no canvas: they verify the
 * byte-level logic with synthetic inputs, but not that the render and the
 * exporters really work. Here the built HTML is opened in headless Chrome, the
 * interface is exercised and real files are downloaded to inspect them.
 *
 * Covers: console errors, the canvas render, the auto-fit at several
 * dimensions, and that every exporter produces a file with the expected
 * signature and size.
 */
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readdir, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(root, 'dist', 'placeholder.html');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = 9333;

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  if (ok) {
    console.log(`  ok    ${name}${detail ? `  ${detail}` : ''}`);
  } else {
    failures++;
    console.log(`  FAIL  ${name}${detail ? `  ${detail}` : ''}`);
  }
};

async function waitFor<T>(fn: () => T | undefined, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timeout waiting in the browser');
    await Bun.sleep(80);
  }
}

// ── Chrome and server start-up ─────────────────────────────────────────

const downloads = await mkdtemp(join(tmpdir(), 'elcoso-dl-'));
const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(DIST)) });
const origin = `http://localhost:${server.port}/`;

const chrome = Bun.spawn(
  [
    CHROME, '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, '--user-data-dir=' + (await mkdtemp(join(tmpdir(), 'elcoso-ch-'))),
    'about:blank',
  ],
  { stdout: 'ignore', stderr: 'ignore' },
);

let ws: WebSocket | undefined;
try {
  // The DevTools endpoint publishes the list of targets once it is ready.
  const listUrl = `http://localhost:${PORT}/json/list`;
  let wsUrl = '';
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try {
      const list = (await fetch(listUrl).then((r) => r.json())) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
    if (!wsUrl) await Bun.sleep(100);
  }
  if (!wsUrl) throw new Error('Chrome did not expose the DevTools endpoint');

  const socket = new WebSocket(wsUrl);
  ws = socket;
  await new Promise<void>((res, rej) => {
    socket.onopen = () => res();
    socket.onerror = () => rej(new Error('could not open the DevTools websocket'));
  });

  // ── Minimal CDP client ─────────────────────────────────────────────
  let nextId = 1;
  const pending = new Map<number, (v: unknown) => void>();
  const consoleErrors: string[] = [];
  const exceptions: string[] = [];

  socket.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number; result?: unknown;
      method?: string; params?: Record<string, unknown>;
    };
    if (msg.id !== undefined) {
      pending.get(msg.id)?.(msg.result);
      pending.delete(msg.id);
      return;
    }
    if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
      consoleErrors.push(
        (msg.params.args as Array<{ value?: unknown; description?: string }>).map((a) => String(a.value ?? a.description)).join(' '),
      );
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      const details = msg.params?.['exceptionDetails'] as { exception?: { description?: string } } | undefined;
      exceptions.push(details?.exception?.description ?? JSON.stringify(msg.params));
    }
  };

  const send = (method: string, params: Record<string, unknown> = {}): Promise<unknown> =>
    new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      socket.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async <T>(expression: string): Promise<T> => {
    const r = (await send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true,
    })) as {
      result: { value: T };
      exceptionDetails?: { text: string; exception?: { description?: string } };
    };
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    }
    return r.result.value;
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });

  // ── Load ───────────────────────────────────────────────────────────
  console.log(`\nopening ${origin} (${(await stat(DIST)).size} bytes)\n`);
  await send('Page.navigate', { url: origin });
  await Bun.sleep(2500);

  // The generator keeps a full-height desktop shell; its explanatory content
  // should extend the document and remain reachable by scrolling below it.
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  });
  await Bun.sleep(100);
  const pageLayout = await evaluate<{
    viewport: number; shell: number; page: number; panel: number; panelBottom: number; shellBottom: number;
  }>(`(() => {
    const shell = document.querySelector('.app-shell').getBoundingClientRect();
    const panel = document.querySelector('.panel');
    return {
      viewport: innerHeight,
      shell: shell.height,
      page: document.scrollingElement.scrollHeight,
      panel: panel.clientHeight,
      panelBottom: panel.getBoundingClientRect().bottom,
      shellBottom: shell.bottom,
    };
  })()`);
  check('desktop app shell fills the viewport', Math.abs(pageLayout.shell - pageLayout.viewport) < 1, `${pageLayout.shell}px / ${pageLayout.viewport}px`);
  check('desktop content scrolls below the shell', pageLayout.page > pageLayout.viewport, `${pageLayout.page}px document`);
  check('desktop controls remain usable inside the shell', pageLayout.panel > 0 && pageLayout.panelBottom <= pageLayout.shellBottom, `${pageLayout.panel}px panel`);
  await send('Emulation.clearDeviceMetricsOverride');

  // ── Clean console ──────────────────────────────────────────────────
  console.log('console:');
  check('no uncaught exceptions', exceptions.length === 0, exceptions[0]?.slice(0, 160) ?? '');
  check('no console errors', consoleErrors.length === 0, consoleErrors[0]?.slice(0, 160) ?? '');

  // ── The canvas render ──────────────────────────────────────────────
  console.log('\nrender:');
  const render = await evaluate<{
    bg: [number, number, number]; fg: [number, number, number];
    width: number; height: number; nonBg: number; total: number;
  }>(`(() => {
    const c = document.querySelector('#canvas');
    const g = c.getContext('2d');
    const px = g.getImageData(0, 0, c.width, c.height).data;
    const first = [px[0], px[1], px[2]];
    let nonBg = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i] !== first[0] || px[i+1] !== first[1] || px[i+2] !== first[2]) nonBg++;
    }
    return { bg: first, width: c.width, height: c.height, nonBg, total: px.length / 4 };
  })()`);
  check('the canvas has the requested size', render.width === 1920 && render.height === 1080, `${render.width}x${render.height}`);
  check('the background is the pastel of the palette, not black', render.bg[0] > 200 && render.bg[1] > 200, `rgb(${render.bg})`);
  check('the dimensions are drawn', render.nonBg > 1000, `${render.nonBg} px different from the background`);

  // ── The page takes the hue of the palette ──────────────────────────
  console.log('\npage theme:');
  const theme = await evaluate<Record<string, string>>(`(() => {
    const cs = getComputedStyle(document.documentElement);
    const read = () => ({
      tint: cs.getPropertyValue('--tint-h').trim(),
      body: getComputedStyle(document.body).backgroundColor,
      panel: getComputedStyle(document.querySelector('.panel')).backgroundColor,
      accent: getComputedStyle(document.querySelector('button.primary')).backgroundColor,
      bg: document.querySelector('#bg').value.toUpperCase(),
    });
    const before = read();
    const swatches = [...document.querySelectorAll('.swatch')];
    const last = swatches[swatches.length - 1];
    last.click();
    return { ...read(), before: JSON.stringify(before), count: String(swatches.length), name: last.dataset.name };
  })()`);
  const themeBefore = JSON.parse(theme.before ?? '{}') as Record<string, string>;
  check('the grid shows the whole palette', Number(theme.count) === 9, `${theme.count} colors`);
  check('picking another palette changes the placeholder color', theme.bg !== themeBefore.bg, `${themeBefore.bg} → ${theme.bg} (${theme.name})`);
  check('the page gets re-tinted with the palette', theme.tint !== themeBefore.tint && theme.body !== themeBefore.body, `hue ${themeBefore.tint} → ${theme.tint}°`);
  check('the panel and the accent follow the palette', theme.panel !== themeBefore.panel && theme.accent !== themeBefore.accent, theme.accent);

  // ── The auto-fit scales ────────────────────────────────────────────
  console.log('\nauto-fit in the real browser:');
  const fit = await evaluate<Array<{ w: number; h: number; ink: number; ratio: number }>>(`(() => {
    const out = [];
    for (const [w, h] of [[1920,1080],[640,480],[128,128],[64,64],[32,32]]) {
      const wi = document.querySelector('#width'), hi = document.querySelector('#height');
      wi.value = String(w); hi.value = String(h);
      wi.dispatchEvent(new Event('input', { bubbles: true }));
      const c = document.querySelector('#canvas');
      const g = c.getContext('2d');
      const px = g.getImageData(0, 0, c.width, c.height).data;
      const first = [px[0], px[1], px[2]];
      let ink = 0;
      for (let i = 0; i < px.length; i += 4) {
        if (px[i] !== first[0] || px[i+1] !== first[1] || px[i+2] !== first[2]) ink++;
      }
      out.push({ w, h, ink, ratio: ink / (w * h) });
    }
    return out;
  })()`);
  for (const f of fit) {
    console.log(`  ${String(f.w+'x'+f.h).padEnd(11)} ${(f.ratio*100).toFixed(2)}% of the surface with text`);
  }
  check('text appears at every size tested', fit.every((f) => f.ink > 0));
  // The text grows in ABSOLUTE pixels with the image. Percentage coverage does
  // the opposite (at 32x32 the padding is proportionally huge and the text
  // fills the whole box), so comparing proportions would give a wrong reading.
  check(
    'more surface, more text in absolute pixels',
    (fit[0]?.ink ?? 0) > (fit[1]?.ink ?? 0) && (fit[1]?.ink ?? 0) > (fit[3]?.ink ?? 0),
    fit.map((f) => f.ink).join(' → '),
  );
  // And it can never overflow the box: a badly computed text would spill out.
  check('the text never overflows the canvas', fit.every((f) => f.ratio < 0.6));

  // ── The form controls really change the state ──────────────────────
  // This broke once: `form.elements.namedItem()` returns a RadioNodeList for a
  // radio group, and the type check discarded it silently. The format stayed on
  // the default and nothing failed. It is the kind of bug that only shows up
  // when you look at the downloaded file.
  console.log('\nform controls:');
  for (const format of ['svg', 'webp', 'jpeg', 'png'] as const) {
    const got = await evaluate<string>(`(() => {
      document.querySelector('input[name="imageFormat"][value="${format}"]').click();
      return document.querySelector('input[name="imageFormat"]:checked').value;
    })()`);
    check(`choosing ${format} stays selected`, got === format, `stuck on ${got}`);
  }

  // The preset dropdown is the other half of the same contract: it has to
  // fill the two fields, and it has to follow them when they are typed by hand.
  const preset = await evaluate<{ w: string; h: string; cw: number; ch: number; matched: string; custom: string; options: number }>(`(() => {
    const s = document.querySelector('#presetSize');
    s.value = '300x250';
    s.dispatchEvent(new Event('change', { bubbles: true }));
    const canvas = document.querySelector('#canvas');
    const picked = { w: document.querySelector('#width').value, h: document.querySelector('#height').value, cw: canvas.width, ch: canvas.height };
    const wi = document.querySelector('#width'), hi = document.querySelector('#height');
    hi.value = '600';
    wi.dispatchEvent(new Event('input', { bubbles: true }));
    const matched = s.value;
    wi.value = '301';
    wi.dispatchEvent(new Event('input', { bubbles: true }));
    return { ...picked, matched, custom: s.value, options: s.options.length };
  })()`);
  check('choosing a preset fills width and height', preset.w === '300' && preset.h === '250', `${preset.w}×${preset.h}`);
  check('the preview takes the preset size', preset.cw === 300 && preset.ch === 250, `${preset.cw}×${preset.ch}`);
  check('typing a size that is a preset selects it', preset.matched === '300x600', preset.matched);
  check('a size that is not a preset falls back to Custom', preset.custom === '', `"${preset.custom}"`);
  check('the dropdown carries every standard size', preset.options >= 15, `${preset.options} options`);

  // Pasting a size into either field has to fill both. The inputs are
  // `type="number"`, so the browser would sanitize "1629×420" into an empty
  // field on its own: the `paste` event is the only place the raw text is still
  // readable. `dispatchEvent` returns false when the listener called
  // `preventDefault`, which is how a synthetic paste reports that it was taken.
  console.log('\npasting a size:');
  const pasted = await evaluate<{ w: string; h: string; cw: number; ch: number; blocked: boolean; plain: boolean; kept: string; msg: string }>(`(() => {
    const w = document.querySelector('#width'), h = document.querySelector('#height');
    const paste = (el, text) => {
      const data = new DataTransfer();
      data.setData('text/plain', text);
      return el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    };
    const blocked = !paste(w, '1629×420');
    const canvas = document.querySelector('#canvas');
    const filled = { w: w.value, h: h.value, cw: canvas.width, ch: canvas.height, blocked };
    // A lone number is not a pair, so the browser has to keep handling it.
    const plain = paste(h, '800');
    // A pair outside the range the inputs declare fills nothing.
    paste(w, '5000×10');
    const kept = w.value + '×' + h.value;
    return { ...filled, plain, kept, msg: document.querySelector('#message').textContent };
  })()`);
  check('pasting 1629×420 fills both fields', pasted.w === '1629' && pasted.h === '420', `${pasted.w}×${pasted.h}`);
  check('the preview takes the pasted size', pasted.cw === 1629 && pasted.ch === 420, `${pasted.cw}×${pasted.ch}`);
  check('the paste is taken instead of sanitized away', pasted.blocked);
  check('pasting a lone number is left to the browser', pasted.plain);
  check('a size out of range fills nothing', pasted.kept === '1629×420' && pasted.msg.includes('4096'), `${pasted.kept} · ${pasted.msg}`);

  // Back to a size the exporters below expect, and the input event clears the
  // error message the refused paste left.
  await evaluate(`(() => {
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#width', 320); set('#height', 240);
  })()`);

  const kind = await evaluate<string>(`(() => {
    document.querySelector('input[name="kind"][value="video"]').click();
    return document.querySelector('input[name="kind"]:checked').value;
  })()`);
  check('switching to Video stays selected', kind === 'video', `stuck on ${kind}`);

  const afterKind = await evaluate<{ videoVisible: boolean; imageVisible: boolean }>(`(() => {
    const sec = (k) => document.querySelector('[data-kind="' + k + '"]');
    return { videoVisible: !sec('video').hidden, imageVisible: !sec('image').hidden };
  })()`);
  check('switching to Video shows its section', afterKind.videoVisible && !afterKind.imageVisible,
    `video ${afterKind.videoVisible ? 'visible' : 'hidden'}, image ${afterKind.imageVisible ? 'visible' : 'hidden'}`);

  // ── Every format with a timeline lives in the video tab ────────────
  // The GIF, the AVI and the ZIP are images, but they animate. Their controls
  // used to be inside the Video tab only, so choosing the GIF in the Image tab
  // left nowhere to animate it and the file came out with a single frame.
  // ffprobe caught it: it asked for 10 fps and the file had 1 frame.
  console.log('\nformats with a timeline:');
  const tabs = await evaluate<{ image: string[]; video: string[] }>(`(() => ({
    image: [...document.querySelectorAll('input[name="imageFormat"]')].map((i) => i.value),
    video: [...document.querySelectorAll('input[name="videoFormat"]')].map((i) => i.value),
  }))()`);
  check(
    'the image tab only has the still formats',
    !tabs.image.some((f) => ['gif', 'mjpeg-avi', 'jpeg-zip'].includes(f)),
    tabs.image.join(', '),
  );
  check(
    'the video tab has the animated ones',
    ['gif', 'mjpeg-avi', 'jpeg-zip'].every((f) => tabs.video.includes(f)),
    tabs.video.join(', '),
  );

  const animated = await evaluate<{ timelineVisible: boolean; note: string; bar: boolean; quality: boolean }>(`(() => {
    const pick = (n, v) => document.querySelector('input[name="' + n + '"][value="' + v + '"]').click();
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    pick('kind', 'video');
    pick('videoFormat', 'gif');
    set('#duration', '2');
    set('#fps', '12');
    return {
      timelineVisible: !document.querySelector('#timeline').hidden,
      note: document.querySelector('#fpsEffective').textContent || '',
      noteVisible: !document.querySelector('#fpsEffective').hidden,
      bar: !document.querySelector('input[name="showProgressBar"]').disabled,
      quality: !document.querySelector('.quality').hidden,
    };
  })()`);
  check('choosing the GIF shows the timeline controls', animated.timelineVisible);
  check('it reports the effective GIF FPS', animated.note.includes('12.5'), animated.note);
  check('the progress bar is enabled', animated.bar);
  check('the quality slider follows the format', animated.quality);

  // And that the file comes out with the real frames, not with one.
  await exportAndCheck(
    'animated GIF with the requested frames, not a single one',
    `document.querySelector('input[name="kind"][value="video"]').click();
     document.querySelector('input[name="videoFormat"][value="gif"]').click();
     document.querySelector('#duration').value = '2';
     document.querySelector('#fps').value = '12';
     document.querySelector('#duration').dispatchEvent(new Event('input', { bubbles: true }));
     document.querySelector('#fps').dispatchEvent(new Event('input', { bubbles: true }));`,
    (b) => {
      // Counts the Graphic Control Extensions: one per frame. 2s at 12fps is
      // 24 frames; with a single one the GIF would not animate.
      let frames = 0;
      for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
      return frames >= 20;
    },
  );

  // ── Real exporters ─────────────────────────────────────────────────
  console.log('\nexporters (really downloaded files):');
  // Every export starts from a known state, or the previous format carries
  // over and the checks lie.
  await evaluate(`(() => {
    document.querySelector('input[name="kind"][value="image"]').click();
    document.querySelector('input[name="imageFormat"][value="png"]').click();
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#width', 320); set('#height', 240);
  })()`);

  async function exportAndCheck(
    label: string,
    setup: string,
    magic: (bytes: Uint8Array) => boolean,
  ): Promise<void> {
    const before = new Set(await readdir(downloads));
    await evaluate(`(() => { ${setup} })()`);
    await evaluate(`document.querySelector('#generate').click()`);

    // It waits for a new file to appear and for its size to settle (Chrome
    // writes in streaming, so it needs time).
    //
    // In parallel it looks at the message of the UI: if the exporter throws,
    // it shows up there and there is no file to wait for. Without this, a
    // failure spent the whole timeout in silence.
    let name: string | undefined;
    let uiError = '';
    const started = Date.now();
    while (!name && Date.now() - started < 60_000) {
      const fresh = (await readdir(downloads)).filter((f) => !before.has(f) && !f.endsWith('.crdownload'));
      const candidate = fresh[0];
      if (candidate) {
        try {
          const p = join(downloads, candidate);
          const first = (await stat(p)).size;
          if (first > 0) {
            await Bun.sleep(220);
            if ((await stat(p)).size === first) name = candidate;
          }
        } catch {
          // It vanished between readdir and stat: normal, it retries.
        }
      }
      if (!name) {
        const msg = await evaluate<{ hidden: boolean; text: string }>(
          `({ hidden: document.querySelector('#message').hidden, text: document.querySelector('#message').textContent })`,
        );
        if (!msg.hidden && msg.text && /KB/.test(msg.text) === false) {
          uiError = msg.text;
          break;
        }
        await Bun.sleep(250);
      }
    }

    if (!name) {
      check(label, false, uiError ? `the UI reported: ${uiError}` : 'no file was downloaded');
      return;
    }
    const bytes = new Uint8Array(await readFile(join(downloads, name)));
    check(label, magic(bytes), `${name} · ${(bytes.length / 1024).toFixed(1)} KB`);
  }

  const setDims = (w: number, h: number) => `
    const w = document.querySelector('#width'), h = document.querySelector('#height');
    w.value='${w}'; h.value='${h}';
    w.dispatchEvent(new Event('input',{bubbles:true}));`;

  await exportAndCheck(
    'PNG with signature and tEXt metadata',
    `${setDims(320, 240)} document.querySelector('input[name="imageFormat"][value="png"]').click();`,
    (b) => b[0] === 0x89 && b[1] === 0x50 && new TextDecoder('latin1').decode(b).includes('El Coso 3000'),
  );

  await exportAndCheck(
    'SVG with the embedded font and metadata',
    `document.querySelector('input[name="imageFormat"][value="svg"]').click();`,
    (b) => {
      const s = new TextDecoder().decode(b);
      return s.includes('<svg') && s.includes('El Coso 3000') && s.includes('font/woff2');
    },
  );

  await exportAndCheck(
    'JPEG with the injected comment',
    `document.querySelector('input[name="imageFormat"][value="jpeg"]').click();`,
    (b) => b[0] === 0xff && b[1] === 0xd8 && new TextDecoder('latin1').decode(b).includes('El Coso 3000'),
  );

  await exportAndCheck(
    'WebP with an XMP chunk',
    `document.querySelector('input[name="imageFormat"][value="webp"]').click();`,
    (b) => new TextDecoder('latin1').decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder('latin1').decode(b.slice(8, 12)) === 'WEBP',
  );

  // ── The transparent background ────────────────────────────────────
  // The only place this can be proven: Bun has no canvas, and the difference
  // lives in the pixels the preview leaves at alpha 0 and in the color type the
  // PNG declares.
  console.log('\nthe transparent background:');
  const alpha = await evaluate<{
    boxVisible: boolean;
    defaultOff: boolean;
    corner: number;
    flag: string;
    checker: string;
    noteVisible: boolean;
  }>(`(() => {
    const pick = (f) => document.querySelector('input[name="imageFormat"][value="' + f + '"]').click();
    const box = document.querySelector('input[name="transparent"]');
    pick('png');
    const boxVisible = !document.querySelector('#alphaBox').hidden;
    const defaultOff = !box.checked;
    box.click();
    const c = document.querySelector('#canvas');
    const g = c.getContext('2d');
    return {
      boxVisible,
      defaultOff,
      corner: g.getImageData(0, 0, 1, 1).data[3],
      flag: c.dataset.transparent,
      checker: getComputedStyle(c).backgroundImage,
      noteVisible: !document.querySelector('#alphaNote').hidden,
    };
  })()`);
  check('the box is offered for PNG', alpha.boxVisible);
  check('it is off by default', alpha.defaultOff);
  // The corner is where the text never reaches, so anything but 0 means the
  // background was painted anyway.
  check('the preview really leaves the corner transparent', alpha.corner === 0, `alpha ${alpha.corner}`);
  check('the canvas is told to show the checker', alpha.flag === 'true', `data-transparent="${alpha.flag}"`);
  check('the checkerboard is a real gradient', alpha.checker.includes('conic-gradient'), alpha.checker.slice(0, 60));
  check('the note explains what happens to the color', alpha.noteVisible);

  // The IHDR color type is the fact: 6 is truecolor with alpha, 2 is
  // truecolor without it. It sits after the 8-byte signature, the 4-byte
  // length, "IHDR", and the two 4-byte dimensions. A width of its own, because
  // Chrome overwrites a file whose name it has already used and the wait for a
  // new download cannot tell that apart from nothing happening.
  await exportAndCheck(
    'PNG with a real alpha channel when the background is transparent',
    `document.querySelector('input[name="imageFormat"][value="png"]').click();
     const w = document.querySelector('#width'); w.value = '321'; w.dispatchEvent(new Event('input', { bubbles: true }));
     const c = document.querySelector('input[name="transparent"]');
     c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));`,
    (b) => new TextDecoder('latin1').decode(b.slice(12, 16)) === 'IHDR' && b[25] === 6,
  );

  await exportAndCheck(
    'SVG with no background rect when it is transparent',
    `document.querySelector('input[name="imageFormat"][value="svg"]').click();
     const w = document.querySelector('#width'); w.value = '322'; w.dispatchEvent(new Event('input', { bubbles: true }));`,
    (b) => {
      const s = new TextDecoder().decode(b);
      return s.includes('<svg') && !/<rect width="\d+" height="\d+" fill="#/.test(s);
    },
  );

  // A format that cannot store alpha has to ignore the box, which is still
  // ticked: the file must not come out with a background nobody chose.
  const forced = await evaluate<{ boxVisible: boolean; corner: number; flag: string }>(`(() => {
    document.querySelector('input[name="imageFormat"][value="jpeg"]').click();
    const c = document.querySelector('#canvas');
    return {
      boxVisible: !document.querySelector('#alphaBox').hidden,
      corner: c.getContext('2d').getImageData(0, 0, 1, 1).data[3],
      flag: c.dataset.transparent,
    };
  })()`);
  check('JPEG hides the box', !forced.boxVisible);
  check('and exports an opaque background anyway', forced.corner === 255 && forced.flag === 'false', `alpha ${forced.corner}, flag ${forced.flag}`);

  // Back to PNG the choice is still there: the box was never unchecked.
  const restored = await evaluate<string>(`(() => {
    document.querySelector('input[name="imageFormat"][value="png"]').click();
    return document.querySelector('input[name="transparent"]').checked ? 'kept' : 'cleared';
  })()`);
  check('going back to PNG restores the choice', restored === 'kept', restored);

  const pickTimeline = (f: string) => `
    document.querySelector('input[name="kind"][value="video"]').click();
    document.querySelector('input[name="videoFormat"][value="${f}"]').click();
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    set('#duration', 1); set('#fps', 4);`;

  await exportAndCheck(
    'GIF89a with a global palette and an infinite loop',
    `${setDims(320, 240)}${pickTimeline('gif')}`,
    (b) => new TextDecoder('latin1').decode(b.slice(0, 6)) === 'GIF89a' && new TextDecoder('latin1').decode(b).includes('NETSCAPP'),
  );

  await exportAndCheck(
    'ZIP with the metadata comment',
    `${setDims(320, 240)}${pickTimeline('jpeg-zip')}`,
    (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  );

  // The sound control has two halves that can each break on their own: the
  // checkbox has to enable the picker, and the picker has to stay out of the
  // way for the formats that cannot carry a track.
  console.log('\nthe sound control:');
  const sound = await evaluate<{
    defaultOn: boolean;
    defaultTone: string;
    toneDisabledUntilChecked: boolean;
    toneEnabledAfterChecked: boolean;
    toneOptions: string[];
    gifDisabled: boolean;
    backEnabled: boolean;
  }>(`(() => {
    const pick = (f) => document.querySelector('input[name="videoFormat"][value="' + f + '"]').click();
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    const check = document.querySelector('input[name="sound"]');
    const tone = document.querySelector('#soundTone');
    // The Video tab has to be the active one, or the timeline reads zero and
    // the control is correctly disabled.
    document.querySelector('input[name="kind"][value="video"]').click();
    pick('mp4'); set('#duration', 2); set('#fps', 4);
    const defaultOn = check.checked;
    const before = tone.disabled;
    check.click();
    const after = tone.disabled;
    const options = [...tone.options].map((o) => o.value);
    const defaultTone = tone.value;
    pick('gif');
    const gifDisabled = check.disabled;
    pick('mp4');
    return { defaultOn, defaultTone, toneDisabledUntilChecked: before, toneEnabledAfterChecked: !after, toneOptions: options, gifDisabled, backEnabled: !check.disabled };
  })()`);
  check('video is silent by default', !sound.defaultOn);
  check('the picker is disabled until the box is ticked', sound.toneDisabledUntilChecked);
  check('ticking the box enables the picker', sound.toneEnabledAfterChecked);
  check('the sound it picks is the tango', sound.defaultTone === 'tango', sound.defaultTone);
  check(
    'the picker carries the four sounds, tango first',
    sound.toneOptions.join() === 'tango,beep,tone,noise',
    sound.toneOptions.join(', '),
  );
  check('the GIF cannot be given a sound', sound.gifDisabled);
  check('going back to MP4 restores it', sound.backEnabled);

  // Video depends on WebCodecs, so it is only required when the browser has it.
  const hasWebCodecs = await evaluate<boolean>('"VideoEncoder" in window');
  console.log(`\nWebCodecs in this browser: ${hasWebCodecs ? 'yes' : 'no'}`);
  if (hasWebCodecs) {
    await exportAndCheck(
      'MP4 with an ftyp box and metadata',
      `${setDims(320, 240)} document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="mp4"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#fps', 4); set('#duration', 1);
       document.querySelector('input[name="sound"]').checked = false;
       document.querySelector('#soundTone').dispatchEvent(new Event('change', { bubbles: true }));`,
      (b) => {
        const s = new TextDecoder('latin1').decode(b.slice(0, 64));
        return s.includes('ftyp');
      },
    );

    // The sound track is the one thing in the video path that no Bun test can
    // reach, and the way to tell it worked is in the file: an audio track in
    // MP4 announces itself with an `mp4a` sample entry and a `soun` handler.
    // Each of these gets its own duration on purpose: the filename carries it,
    // and Chrome overwrites a file whose name it has already used, which the
    // wait for a new download cannot tell apart from nothing happening.
    await exportAndCheck(
      'MP4 with a real audio track when the sound is on',
      `${setDims(320, 240)} document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="mp4"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#fps', 4); set('#duration', 2);
       const c = document.querySelector('input[name="sound"]');
       c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
       const t = document.querySelector('#soundTone');
       t.value = 'beep'; t.dispatchEvent(new Event('change', { bubbles: true }));`,
      (b) => {
        const s = new TextDecoder('latin1').decode(b);
        return s.includes('mp4a') && s.includes('soun');
      },
    );

    await exportAndCheck(
      'MP4 stays silent with the sound off',
      `${setDims(320, 240)} document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="mp4"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#fps', 4); set('#duration', 3);
       const c = document.querySelector('input[name="sound"]');
       c.checked = false; c.dispatchEvent(new Event('change', { bubbles: true }));`,
      (b) => !new TextDecoder('latin1').decode(b).includes('mp4a'),
    );

    // The tango is the one sound that is music rather than a formula, and no
    // Bun test can reach it: it is rendered by a Web Audio graph, so the only
    // honest check is a real export. Six seconds is two bars and a half, and
    // it is timed, because the whole point of generating it is that it costs
    // seconds of rendering rather than six seconds of waiting.
    const tangoStarted = Date.now();
    await exportAndCheck(
      'MP4 with the tango soundtrack, the default, in AAC',
      `${setDims(320, 240)} document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="mp4"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#fps', 6); set('#duration', 6);
       const c = document.querySelector('input[name="sound"]');
       c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));`,
      (b) => {
        const s = new TextDecoder('latin1').decode(b);
        return s.includes('mp4a') && s.includes('soun');
      },
    );
    console.log(`        (six seconds of tango in ${((Date.now() - tangoStarted) / 1000).toFixed(1)} s wall clock)`);

    await exportAndCheck(
      'WebM with an Opus track, the codec it is native to',
      `${setDims(320, 240)} document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="webm"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#fps', 4); set('#duration', 4);
       const c = document.querySelector('input[name="sound"]');
       c.checked = true; c.dispatchEvent(new Event('change', { bubbles: true }));
       const t = document.querySelector('#soundTone');
       t.value = 'noise'; t.dispatchEvent(new Event('change', { bubbles: true }));`,
      (b) => {
        // The EBML header ID is the four bytes 1a45dfa3, not the word EBML.
        const ebml = b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3;
        return ebml && new TextDecoder('latin1').decode(b).includes('A_OPUS');
      },
    );
  } else {
    console.log('  (video is skipped: this browser has no WebCodecs)');
  }

  // ── WebMCP: declarative API ────────────────────────────────────────
  // These are HTML attributes, so they are always there. What changes is
  // whether the browser uses them to expose the tool: that needs origin
  // isolation, and `file://` does not have it. The attributes still have to
  // be complete, because the file may be served over HTTP later.
  console.log('\nwebmcp:');
  const webmcp = await evaluate<{
    present: boolean;
    formTool: string | null;
    formDesc: string | null;
    total: number;
    conDesc: number;
    conTitle: number;
    sinDesc: string[];
    sinTitle: string[];
  }>(`(() => {
    const f = document.querySelector('#panel');
    const campos = [...f.querySelectorAll('input, select, textarea')];
    const nombre = (c) => c.name || c.id || '(no name)';
    return {
      present: 'modelContext' in document,
      formTool: f.getAttribute('toolname'),
      formDesc: f.getAttribute('tooldescription'),
      total: campos.length,
      conDesc: campos.filter(c => c.hasAttribute('toolparamdescription')).length,
      conTitle: campos.filter(c => c.hasAttribute('toolparamtitle')).length,
      sinDesc: campos.filter(c => !c.hasAttribute('toolparamdescription')).map(nombre),
      sinTitle: campos.filter(c => !c.hasAttribute('toolparamtitle')).map(nombre),
    };
  })()`);

  check('the form declares toolname', webmcp.formTool === 'generate_placeholder', webmcp.formTool ?? 'missing');
  check('the form declares tooldescription', !!webmcp.formDesc && webmcp.formDesc.length > 40);
  // Every field needs both: without the description the agent does not know
  // what it is, and without the title it has to parse the long text to get
  // the name.
  check(
    'every field has a toolparamdescription',
    webmcp.sinDesc.length === 0,
    `${webmcp.conDesc}/${webmcp.total}${webmcp.sinDesc.length ? ` — missing: ${webmcp.sinDesc.join(', ')}` : ''}`,
  );
  check(
    'every field has a toolparamtitle',
    webmcp.sinTitle.length === 0,
    `${webmcp.conTitle}/${webmcp.total}${webmcp.sinTitle.length ? ` — missing: ${webmcp.sinTitle.join(', ')}` : ''}`,
  );
  check(
    'no break when the browser does not support WebMCP',
    true,
    webmcp.present ? 'registered' : 'degraded silently (the attributes are still in the HTML)',
  );
} finally {
  try { ws?.close(); } catch { /* already closed */ }
  chrome.kill();
  server.stop(true);
}

console.log(failures === 0 ? '\n✔ browser OK' : `\n✘ ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
