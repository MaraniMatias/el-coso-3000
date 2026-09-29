/**
 * WebMCP: expone la app como herramienta para agentes de IA.
 *
 * WebMCP es un estándar propuesto (origin trial en Chrome 149+). La página
 * tiene dos caminos y ambos son mejoras puras:
 *
 *  1. API declarativa — los atributos `toolname` / `tooldescription` /
 *     `toolparamdescription` que ya están en `src/index.html` sobre el
 *     formulario. El navegador convierte el form en una herramienta.
 *  2. API imperativa — `document.modelContext.registerTool`, que expone una
 *     herramienta con JSON Schema y permite devolver datos estructurados.
 *
 * Si el navegador no soporta nada de esto, `setupWebMcp` no hace nada y la
 * app sigue funcionando igual. Por eso todo va detrás de feature detection y
 * no hay ningún error en el camino normal.
 */

/** Subconjunto de la API que usamos. Todavía no está en los tipos del DOM. */
interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  }): Promise<void>;
}

/** Lo que la app le cede a la herramienta para que pueda operarla de verdad. */
export interface WebMcpHost {
  /** Aplica una configuración completa a los controles. */  applySettings(input: Record<string, unknown>): { ok: true } | { ok: false; error: string };
  /** Dispara la generación con la configuración actual. */
  generate(): Promise<string>;
  /** Lee la configuración actual, para que el agente sepa el estado. */
  describe(): Record<string, unknown>;
}

function modelContext(): ModelContext | null {
  const ctx = (document as unknown as { modelContext?: ModelContext }).modelContext;
  if (!ctx || typeof ctx.registerTool !== 'function') return null;
  return ctx;
}

export function isWebMcpSupported(): boolean {
  return modelContext() !== null;
}

const SCHEMA = {
  type: 'object',
  properties: {
    width: { type: 'integer', minimum: 1, maximum: 4096, description: 'Ancho en píxeles.' },
    height: { type: 'integer', minimum: 1, maximum: 4096, description: 'Alto en píxeles.' },
    kind: {
      type: 'string',
      enum: ['image', 'video'],
      description: 'Generar una imagen fija o un video en bucle.',
    },
    imageFormat: {
      type: 'string',
      enum: ['png', 'jpeg', 'webp', 'svg', 'gif', 'mjpeg-avi', 'jpeg-zip'],
      description: 'Formato de salida para kind=image. Por defecto png.',
    },
    videoFormat: {
      type: 'string',
      enum: ['mp4', 'webm', 'mov', 'mkv'],
      description: 'Contenedor de salida para kind=video. Por defecto mp4.',
    },
    palette: {
      type: 'string',
      description:
        'Nombre de la paleta pastel, por ejemplo "azul" o "salvia". Si además se pasa background, gana background.',
    },
    background: {
      type: 'string',
      description: 'Color de fondo en hex de 6 dígitos, por ejemplo "F2DEE2", sin #. El texto se deriva solo.',
    },
    duration: { type: 'number', minimum: 1, maximum: 30, description: 'Segundos. Sólo para video.' },
    fps: { type: 'integer', minimum: 1, maximum: 60, description: 'Cuadros por segundo. Sólo para video.' },
    showProgressBar: { type: 'boolean', description: 'Dibujar la barra de progreso al pie. Sólo para video.' },
    showTime: { type: 'boolean', description: 'Dibujar el reloj 0:03 / 0:10. Sólo para video.' },
    download: {
      type: 'boolean',
      description: 'Si es false, sólo configura y devuelve la vista previa sin descargar. Por defecto true.',
    },
  },
} as const;

const DESCRIPTION = [
  'Genera un placeholder de imagen o video con el color del texto derivado automáticamente',
  'para garantizar contraste WCAG. El texto del placeholder son las dimensiones.',
  'Paletas pastel disponibles: rosa, coral, albaricoque, ámbar, lima, salvia, verde azulado,',
  'cielo, azul, índigo, violeta y orquídea.',
].join(' ');

/**
 * Registra la herramienta imperativa. Devuelve `true` si quedó registrada.
 *
 * Los errores acá son deliberadamente silenciosos: si el navegador tiró al
 * registrar, la app tiene que seguir andando igual.
 */
export async function setupWebMcp(host: WebMcpHost): Promise<boolean> {
  const ctx = modelContext();
  if (!ctx) return false;

  try {
    await ctx.registerTool({
      name: 'generate_placeholder',
      description: DESCRIPTION,
      inputSchema: SCHEMA as unknown as Record<string, unknown>,
      annotations: {
        // Generar un archivo y dispararle una descarga al usuario SÍ es un
        // efecto secundario, así que readOnlyHint va en false.
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      async execute(input) {
        const applied = host.applySettings(input);
        if (!applied.ok) return `No se pudo aplicar la configuración: ${applied.error}`;
        if (input.download === false) {
          return `Configurado sin descargar: ${JSON.stringify(host.describe())}`;
        }
        try {
          return await host.generate();
        } catch (err) {
          return `Falló la generación: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    return true;
  } catch {
    // El navegador puede exponer `modelContext` y rechazar el registro, por
    // ejemplo por la Permissions Policy. No es un error de la app.
    return false;
  }
}

/** Texto para el pie de la UI. */
export function webmcpStatusText(registered: boolean): string {
  return registered
    ? 'WebMCP activo: un agente de IA puede generar placeholders desde esta página.'
    : '';
}
