/**
 * Verificación en navegador real, vía Chrome DevTools Protocol.
 *
 * Corre: `bun run verify:browser`
 *
 * Esto existe porque los tests de Bun no tienen DOM ni canvas: verifican la
 * lógica de bytes con entradas sintéticas, pero no que el render y los
 * exportadores funcionen de verdad. Acá se abre el HTML construido en un
 * Chrome headless, se exercise la interfaz y se descargan archivos reales
 * para inspeccionarlos.
 *
 * Cubre: errores de consola, el render del canvas, el auto-ajuste en varias
 * dimensiones, y que cada exportador produzca un archivo con la firma y el
 * tamaño esperados.
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
    console.log(`  FALLA ${name}${detail ? `  ${detail}` : ''}`);
  }
};

async function waitFor<T>(fn: () => T | undefined, ms = 15000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error('timeout esperando en el navegador');
    await Bun.sleep(80);
  }
}

// ── Arranque de Chrome y del servidor ────────────────────────────────

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
  // El endpoint de DevTools publica la lista de targets cuando está listo.
  const listUrl = `http://localhost:${PORT}/json/list`;
  let wsUrl = '';
  for (let i = 0; i < 200 && !wsUrl; i++) {
    try {
      const list = (await fetch(listUrl).then((r) => r.json())) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = list.find((t) => t.type === 'page');
      if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* todavía no levanta */
    }
    if (!wsUrl) await Bun.sleep(100);
  }
  if (!wsUrl) throw new Error('Chrome no expuso el endpoint de DevTools');

  const socket = new WebSocket(wsUrl);
  ws = socket;
  await new Promise<void>((res, rej) => {
    socket.onopen = () => res();
    socket.onerror = () => rej(new Error('no se pudo abrir el websocket de DevTools'));
  });

  // ── Cliente CDP mínimo ────────────────────────────────────────────
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

  // ── Carga ─────────────────────────────────────────────────────────
  console.log(`\nabriendo ${origin} (${(await stat(DIST)).size} bytes)\n`);
  await send('Page.navigate', { url: origin });
  await Bun.sleep(2500);

  // ── Consola limpia ────────────────────────────────────────────────
  console.log('consola:');
  check('sin excepciones sin capturar', exceptions.length === 0, exceptions[0]?.slice(0, 160) ?? '');
  check('sin errores de consola', consoleErrors.length === 0, consoleErrors[0]?.slice(0, 160) ?? '');

  // ── El render del canvas ──────────────────────────────────────────
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
  check('el canvas tiene el tamaño pedido', render.width === 1920 && render.height === 1080, `${render.width}x${render.height}`);
  check('el fondo es el pastel de la paleta, no negro', render.bg[0] > 200 && render.bg[1] > 200, `rgb(${render.bg})`);
  check('se dibuja el texto de las dimensiones', render.nonBg > 1000, `${render.nonBg} px distintos del fondo`);

  // ── El auto-ajuste escala ──────────────────────────────────────────
  console.log('\nauto-ajuste en el navegador real:');
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
    console.log(`  ${String(f.w+'x'+f.h).padEnd(11)} ${(f.ratio*100).toFixed(2)}% de la superficie con texto`);
  }
  check('el texto aparece en todas las dimensiones probadas', fit.every((f) => f.ink > 0));
  // El texto crece en cantidad ABSOLUTA de píxeles con la imagen. La
  // cobertura porcentual hace lo contrario (a 32x32 el padding es
  // proporcionalmente enorme y el texto llena todo el cuadro), así que
  // comparar proporciones daría una lectura equivocada.
  check(
    'más superficie, más texto en píxeles absolutos',
    (fit[0]?.ink ?? 0) > (fit[1]?.ink ?? 0) && (fit[1]?.ink ?? 0) > (fit[3]?.ink ?? 0),
    fit.map((f) => f.ink).join(' → '),
  );
  // Y nunca puede desbordar el cuadro: un texto mal calculado se saldría.
  check('el texto nunca desborda el lienzo', fit.every((f) => f.ratio < 0.6));

  // ── Los controles del formulario realmente cambian el estado ─────
  // Esto se rompió una vez: `form.elements.namedItem()` devuelve un
  // RadioNodeList para un grupo de radios, y el type check lo descartaba en
  // silencio. El formato se quedaba siempre en el default sin que nada
  // fallara. Es el tipo de bug que sólo aparece mirando el archivo
  // descargado.
  console.log('\ncontroles del formulario:');
  for (const format of ['svg', 'gif', 'webp', 'jpeg', 'png'] as const) {
    const got = await evaluate<string>(`(() => {
      document.querySelector('input[name="imageFormat"][value="${format}"]').click();
      return document.querySelector('input[name="imageFormat"]:checked').value;
    })()`);
    check(`eligir ${format} queda seleccionado`, got === format, `quedó ${got}`);
  }

  const kind = await evaluate<string>(`(() => {
    document.querySelector('input[name="kind"][value="video"]').click();
    return document.querySelector('input[name="kind"]:checked').value;
  })()`);
  check('cambiar a Video queda seleccionado', kind === 'video', `quedó ${kind}`);

  const afterKind = await evaluate<{ videoVisible: boolean; imageVisible: boolean }>(`(() => {
    const sec = (k) => document.querySelector('[data-kind="' + k + '"]');
    return { videoVisible: !sec('video').hidden, imageVisible: !sec('image').hidden };
  })()`);
  check('al cambiar a Video se muestra su sección', afterKind.videoVisible && !afterKind.imageVisible,
    `video ${afterKind.videoVisible ? 'visible' : 'oculto'}, imagen ${afterKind.imageVisible ? 'visible' : 'oculto'}`);

  // ── Los formatos animados tienen línea de tiempo propia ─────────
  // El GIF es una imagen, pero se anima. Los controles de duración y FPS
  // estaban dentro del tab de Video, así que al elegir GIF no había dónde
  // animarlo y salía con un único frame. ffprobe lo detectó: pedía 10 fps y
  // el archivo tenía 1 frame.
  console.log('\nformatos animados:');
  const animated = await evaluate<{ timelineVisible: boolean; nota: string; barra: boolean }>(`(() => {
    const pick = (n, v) => document.querySelector('input[name="' + n + '"][value="' + v + '"]').click();
    const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
    // El bloque anterior dejó el form en modo video. Sin volver a Imagen, la
    // nota del GIF no se muestra y todo lo de abajo genera video.
    pick('kind', 'image');
    pick('imageFormat', 'gif');
    set('#duration', '2');
    set('#fps', '12');
    return {
      timelineVisible: !document.querySelector('#timeline').hidden,
      nota: document.querySelector('#fpsEffective').textContent || '',
      notaVisible: !document.querySelector('#fpsEffective').hidden,
      barra: !document.querySelector('input[name="showProgressBar"]').disabled,
    };
  })()`);
  check('elegir GIF muestra los controles de línea de tiempo', animated.timelineVisible);
  check('avisa el FPS efectivo del GIF', animated.nota.includes('12.5'), animated.nota);
  check('la barra de progreso queda habilitada', animated.barra);

  // Y que el archivo salga con los frames de verdad, no con uno.
  await exportAndCheck(
    'GIF animado con los frames pedidos, no uno solo',
    `document.querySelector('input[name="kind"][value="image"]').click();
     document.querySelector('input[name="imageFormat"][value="gif"]').click();
     document.querySelector('#duration').value = '2';
     document.querySelector('#fps').value = '12';
     document.querySelector('#duration').dispatchEvent(new Event('input', { bubbles: true }));
     document.querySelector('#fps').dispatchEvent(new Event('input', { bubbles: true }));`,
    (b) => {
      // Cuenta los Graphic Control Extensions: uno por frame. 2s a 12fps son
      // 24 frames; con uno solo el GIF no se animaría.
      let frames = 0;
      for (let i = 0; i < b.length - 1; i++) if (b[i] === 0x21 && b[i + 1] === 0xf9) frames++;
      return frames >= 20;
    },
  );

  // ── Exportadores reales ───────────────────────────────────────────
  console.log('\nexportadores (archivos descargados de verdad):');
  // Cada exportación arranca desde un estado conocido, o el formato anterior
  // se arrastra y las verificaciones mienten.
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

    // Se espera a que aparezca un archivo nuevo y que su tamaño se estabilice
    // (Chrome escribe en streaming, así que hay que darle tiempo).
    //
    // En paralelo se mira el mensaje de la UI: si el exportador tira un error,
    // aparece ahí y no hay ningún archivo que esperar. Sin esto, un fallo
    // spendía el timeout entero en silencio.
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
          // Desapareció entre readdir y stat: es normal, se reintenta.
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
      check(label, false, uiError ? `la UI reportó: ${uiError}` : 'no se descargó ningún archivo');
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
    'PNG con firma y tEXt de metadata',
    `${setDims(320, 240)} document.querySelector('input[name="imageFormat"][value="png"]').click();`,
    (b) => b[0] === 0x89 && b[1] === 0x50 && new TextDecoder('latin1').decode(b).includes('el-coso-3000'),
  );

  await exportAndCheck(
    'SVG con la fuente embebida y metadata',
    `document.querySelector('input[name="imageFormat"][value="svg"]').click();`,
    (b) => {
      const s = new TextDecoder().decode(b);
      return s.includes('<svg') && s.includes('el-coso-3000') && s.includes('font/woff2');
    },
  );

  await exportAndCheck(
    'GIF89a con paleta global y loop infinito',
    `document.querySelector('input[name="imageFormat"][value="gif"]').click();`,
    (b) => new TextDecoder('latin1').decode(b.slice(0, 6)) === 'GIF89a' && new TextDecoder('latin1').decode(b).includes('NETSCAPP'),
  );

  await exportAndCheck(
    'JPEG con el comentario inyectado',
    `document.querySelector('input[name="imageFormat"][value="jpeg"]').click();`,
    (b) => b[0] === 0xff && b[1] === 0xd8 && new TextDecoder('latin1').decode(b).includes('el-coso-3000'),
  );

  await exportAndCheck(
    'WebP con chunk XMP',
    `document.querySelector('input[name="imageFormat"][value="webp"]').click();`,
    (b) => new TextDecoder('latin1').decode(b.slice(0, 4)) === 'RIFF' && new TextDecoder('latin1').decode(b.slice(8, 12)) === 'WEBP',
  );

  await exportAndCheck(
    'ZIP con el comentario de metadata',
    `document.querySelector('input[name="imageFormat"][value="jpeg-zip"]').click();`,
    (b) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04,
  );

  // El video depende de WebCodecs, así que sólo se exige si el navegador lo tiene.
  const hasWebCodecs = await evaluate<boolean>('"VideoEncoder" in window');
  console.log(`\nWebCodecs en este navegador: ${hasWebCodecs ? 'sí' : 'no'}`);
  if (hasWebCodecs) {
    await exportAndCheck(
      'MP4 con caja ftyp y metadatos',
      `document.querySelector('input[name="kind"][value="video"]').click();
       document.querySelector('input[name="videoFormat"][value="mp4"]').click();
       const set = (id, v) => { const e = document.querySelector(id); e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); };
       set('#width', 320); set('#height', 240);
       set('#fps', 4); set('#duration', 1);`,
      (b) => {
        const s = new TextDecoder('latin1').decode(b.slice(0, 64));
        return s.includes('ftyp');
      },
    );
  } else {
    console.log('  (se omite el video: este navegador no tiene WebCodecs)');
  }

  // ── WebMCP: API declarativa ───────────────────────────────────────
  // Son atributos HTML, así que existen siempre. Lo que cambia es si el
  // navegador los usa para exponer la herramienta: eso exige aislamiento de
  // origen, y `file://` no lo tiene. Los atributos igual tienen que estar
  // completos, porque el archivo puede servirse por HTTP después.
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
    const nombre = (c) => c.name || c.id || '(sin name)';
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

  check('el formulario declara toolname', webmcp.formTool === 'generate_placeholder', webmcp.formTool ?? 'falta');
  check('el formulario declara tooldescription', !!webmcp.formDesc && webmcp.formDesc.length > 40);
  // Cada campo necesita ambos: sin description el agente no sabe qué es, y
  // sin title tiene que parsear el texto largo para sacar el nombre.
  check(
    'todos los campos tienen toolparamdescription',
    webmcp.sinDesc.length === 0,
    `${webmcp.conDesc}/${webmcp.total}${webmcp.sinDesc.length ? ` — faltan: ${webmcp.sinDesc.join(', ')}` : ''}`,
  );
  check(
    'todos los campos tienen toolparamtitle',
    webmcp.sinTitle.length === 0,
    `${webmcp.conTitle}/${webmcp.total}${webmcp.sinTitle.length ? ` — faltan: ${webmcp.sinTitle.join(', ')}` : ''}`,
  );
  check(
    'sin romper si el navegador no soporta WebMCP',
    true,
    webmcp.present ? 'registrado' : 'degradó en silencio (los atributos siguen en el HTML)',
  );
} finally {
  try { ws?.close(); } catch { /* ya estaba cerrado */ }
  chrome.kill();
  server.stop(true);
}

console.log(failures === 0 ? '\n✔ navegador OK' : `\n✘ ${failures} fallo(s)`);
process.exit(failures === 0 ? 0 : 1);
