/**
 * WebMCP: exposes the app as a tool for AI agents.
 *
 * WebMCP is a proposed standard (origin trial in Chrome 149+). The page has
 * two paths and both are pure enhancements:
 *
 *  1. Declarative API — the `toolname` / `tooldescription` /
 *     `toolparamdescription` attributes already in `src/index.html` on the
 *     form. The browser turns the form into a tool.
 *  2. Imperative API — `document.modelContext.registerTool`, which exposes a
 *     tool with a JSON Schema and can return structured data.
 *
 * If the browser supports none of this, `setupWebMcp` does nothing and the app
 * keeps working exactly the same. That is why everything sits behind feature
 * detection and there is no error on the normal path.
 */
import { palette } from '../core/color';
import { TIMELINE_FORMATS } from '../core/types';

/** The subset of the API we use. It is not in the DOM types yet. */
interface ModelContext {
  registerTool(tool: {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    annotations?: Record<string, boolean>;
    execute: (input: Record<string, unknown>) => Promise<unknown>;
  }): Promise<void>;
}

/** What the app hands over to the tool so it can really drive it. */
export interface WebMcpHost {
  /** Applies a full configuration to the controls. */
  applySettings(input: Record<string, unknown>): { ok: true } | { ok: false; error: string };
  /** Triggers the generation with the current configuration. */
  generate(): Promise<string>;
  /** Reads the current configuration, so the agent knows the state. */
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
    width: { type: 'integer', minimum: 1, maximum: 4096, description: 'Width in pixels.' },
    height: { type: 'integer', minimum: 1, maximum: 4096, description: 'Height in pixels.' },
    kind: {
      type: 'string',
      enum: ['image', 'video'],
      description: 'Generate a still image or a looping output.',
    },
    imageFormat: {
      type: 'string',
      enum: ['png', 'jpeg', 'webp', 'svg'],
      description: 'Output format for kind=image. Defaults to png.',
    },
    videoFormat: {
      type: 'string',
      enum: [...TIMELINE_FORMATS],
      description:
        'Output format for kind=video, including the animated image containers. Defaults to mp4.',
    },
    palette: {
      type: 'string',
      description: 'Name of the pastel palette, for example "azure" or "sage". If background is passed too, background wins.',
    },
    background: {
      type: 'string',
      description: 'Background color as 6 hex digits, for example "E0E0E0", without #. The text is derived from it.',
    },
    duration: { type: 'number', minimum: 1, maximum: 30, description: 'Seconds. Video only.' },
    fps: { type: 'integer', minimum: 1, maximum: 60, description: 'Frames per second. Video only.' },
    showProgressBar: { type: 'boolean', description: 'Draw a progress bar at the bottom. Video only.' },
    showTime: { type: 'boolean', description: 'Draw the 0:03 / 0:10 clock. Video only.' },
    download: {
      type: 'boolean',
      description: 'If false, it only configures and returns the preview without downloading. Defaults to true.',
    },
  },
} as const;

const DESCRIPTION = [
  'Generates an image or video placeholder with the text color derived automatically',
  'to guarantee WCAG contrast. The text of the placeholder is the dimensions.',
  // The list comes from the real palette, so it cannot go stale.
  `Pastel palettes available: ${palette().map((p) => p.label.toLowerCase()).join(', ')}.`,
].join(' ');

/**
 * Registers the imperative tool. Returns `true` if it ended up registered.
 *
 * The errors here are deliberately silent: if the browser threw while
 * registering, the app still has to work.
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
        // Generating a file and triggering a download for the user IS a side
        // effect, so readOnlyHint goes to false.
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      async execute(input) {
        const applied = host.applySettings(input);
        if (!applied.ok) return `Could not apply the configuration: ${applied.error}`;
        if (input.download === false) {
          return `Configured without downloading: ${JSON.stringify(host.describe())}`;
        }
        try {
          return await host.generate();
        } catch (err) {
          return `Generation failed: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    });
    return true;
  } catch {
    // The browser can expose `modelContext` and refuse the registration, for
    // example because of a Permissions Policy. It is not an error of the app.
    return false;
  }
}

/** Text for the footer of the UI. */
export function webmcpStatusText(registered: boolean): string {
  return registered
    ? 'WebMCP active: an AI agent can generate placeholders from this page.'
    : '';
}
