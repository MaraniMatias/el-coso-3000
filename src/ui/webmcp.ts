/**
 * WebMCP: exposes the app as a tool for AI agents.
 *
 * WebMCP is a proposed standard (origin trial in Chrome 149+). The page has
 * two paths and both are pure enhancements:
 *
 *  1. Declarative API, the `toolname` / `tooldescription` /
 *     `toolparamdescription` attributes already in `src/index.html` on the
 *     form. The browser turns the form into a tool.
 *  2. Imperative API, `document.modelContext.registerTool`, which exposes a
 *     tool with a JSON Schema and can return structured data.
 *
 * If the browser supports none of this, `setupWebMcp` does nothing and the app
 * keeps working exactly the same. That is why everything sits behind feature
 * detection and there is no error on the normal path.
 */
import { palette } from "../core/color";
import { TIMELINE_FORMATS, VIDEO_TONES } from "../core/types";
import {
  DELIMITER_CHOICES,
  GENERATORS,
  PRESET_KEYS,
  TEXT_FORMATS,
  TEXT_FORMAT_INFO,
} from "./text-generators";

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
  applySettings(
    input: Record<string, unknown>,
  ): { ok: true } | { ok: false; error: string };
  /** Triggers the generation with the current configuration. */
  generate(): Promise<string>;
  /** Reads the current configuration, so the agent knows the state. */
  describe(): Record<string, unknown>;
  /**
   * The text the text tab is currently showing.
   *
   * It exists because the other two tabs hand the agent a file it cannot read,
   * and that is the right answer for a picture. Text is the data itself: an
   * agent that generated a hundred fake emails and got back "Downloaded
   * fake-user.json" would have nothing to show for it.
   */
  text(): string;
}

function modelContext(): ModelContext | null {
  const ctx = (document as unknown as { modelContext?: ModelContext })
    .modelContext;
  if (!ctx || typeof ctx.registerTool !== "function") return null;
  return ctx;
}

export function isWebMcpSupported(): boolean {
  return modelContext() !== null;
}

const SCHEMA = {
  type: "object",
  properties: {
    width: {
      type: "integer",
      minimum: 1,
      maximum: 4096,
      description: "Width in pixels.",
    },
    height: {
      type: "integer",
      minimum: 1,
      maximum: 4096,
      description: "Height in pixels.",
    },
    kind: {
      type: "string",
      enum: ["image", "video", "text"],
      description:
        "Generate a still image, a looping output, or a file of fake placeholder data. kind=text ignores every pixel setting below and uses the text* ones instead.",
    },
    imageFormat: {
      type: "string",
      enum: ["png", "jpeg", "webp", "svg"],
      description: "Output format for kind=image. Defaults to png.",
    },
    videoFormat: {
      type: "string",
      enum: [...TIMELINE_FORMATS],
      description:
        "Output format for kind=video, including the animated image containers. Defaults to mp4.",
    },
    palette: {
      type: "string",
      description:
        'Name of the pastel palette, for example "azure" or "sage". If background is passed too, background wins.',
    },
    background: {
      type: "string",
      description:
        'Background color as 6 hex digits, for example "E0E0E0", without #. The text color is derived from it to guarantee contrast, unless foreground is passed too.',
    },
    foreground: {
      type: "string",
      description:
        'Text color as 6 hex digits, for example "2B2B2B", without #. Only the dimensions are written on the placeholder, in this color. Passed without background, it keeps the background that is already set; the measured contrast is reported and may be below AA.',
    },
    duration: {
      type: "number",
      minimum: 1,
      maximum: 120,
      description: "Seconds. Video only.",
    },
    fps: {
      type: "integer",
      minimum: 1,
      maximum: 60,
      description: "Frames per second. Video only.",
    },
    showProgressBar: {
      type: "boolean",
      description: "Draw a progress bar at the bottom. Video only.",
    },
    showTime: {
      type: "boolean",
      description: "Draw the 0:03 / 0:10 clock. Video only.",
    },
    transparent: {
      type: "boolean",
      description:
        "Leaves the background unpainted so the file carries an alpha channel. The background color still decides the text color, so the contrast guarantee is unchanged. Only png, webp, svg and gif honor it; the other formats export opaque.",
    },
    sound: {
      type: "boolean",
      description:
        "Adds a soundtrack to the video. Defaults to false, and it only works for the video containers, not for gif, mjpeg-avi or jpeg-zip.",
    },
    soundTone: {
      type: "string",
      enum: [...VIDEO_TONES],
      description:
        "Which soundtrack: 'tango' is a synthesized tango nuevo at 100 BPM, 'beep' is a soft 440 Hz beep every second, 'tone' is the same pitch held quietly for the whole video, and 'noise' is white noise. Defaults to tango.",
    },
    textPreset: {
      type: "string",
      enum: [...PRESET_KEYS, "custom"],
      description:
        "A bundle of generators for kind=text: a lorem sentence or paragraph, a user profile, a company, a product, an address, a payment card, or an API response. 'custom' uses textCategory and textGenerator instead. Defaults to a lorem sentence.",
    },
    textCategory: {
      type: "string",
      description:
        "Group of generators for kind=text, for example lorem, person, internet, location, company, commerce, finance or string. Only with textPreset=custom.",
    },
    textGenerator: {
      type: "string",
      description:
        "The single generator to call for kind=text, written as category.method, for example internet.email or location.city. Only with textPreset=custom.",
    },
    textLocale: {
      type: "string",
      enum: ["en", "es"],
      description:
        "Which set of names, addresses and words kind=text draws on. A few generators come out the same in both: the lorem filler is latin in any language, and IBANs have no Spanish dataset, so finance.iban returns a Belgian one either way. Defaults to en.",
    },
    textCount: {
      type: "integer",
      minimum: 1,
      maximum: 1000,
      description: "How many rows to generate for kind=text. Defaults to 10.",
    },
    textFormat: {
      type: "string",
      enum: [...TEXT_FORMATS],
      description:
        "How the rows are written for kind=text. plain is bare text with no header, json is a JSON array with one object per row, csv and md are tables with a header row. Defaults to plain.",
    },
    textSeparator: {
      type: "string",
      description:
        "What goes between the fields of one row in the text format, as the literal characters. Only read when textFormat is plain.",
    },
    textDelimiter: {
      type: "string",
      enum: [...DELIMITER_CHOICES],
      description:
        "What goes between the columns in the CSV format, as the character itself. Only read when textFormat is csv. The default is ';', which is what a spreadsheet expects where the decimal separator is a comma, Spanish included.",
    },
    download: {
      type: "boolean",
      description:
        "If false, it only configures and returns the preview without downloading. Defaults to true.",
    },
  },
} as const;

const DESCRIPTION = [
  "Generates an image or video placeholder, or a file of fake placeholder data.",
  "For kind=image and kind=video: give a background and the text color is derived",
  "from it to guarantee WCAG contrast. Pass foreground as well to choose both",
  "yourself, and read the reported contrast to know how the pair came out. The text",
  "of the placeholder is the dimensions.",
  // The list comes from the real palette, so it cannot go stale.
  `Pastel palettes available: ${palette()
    .map((p) => p.label.toLowerCase())
    .join(", ")}.`,
  "For kind=text: writes fake data instead of pixels, so width, height, palette,",
  "background and foreground do not apply and are refused. Use textPreset for a",
  "ready-made bundle such as a user profile or an API response, or textPreset=custom",
  "with textCategory and textGenerator for one specific value.",
  // A count is not a list: the catalog has a few hundred entries and an agent
  // would spend its whole budget reading them. The useful ones are named here.
  "The catalog spans person, internet, location, company, commerce, phone, date,",
  "finance, string, color, number, word, git, system, database, vehicle, airline,",
  "book, music, food, animal, science and lorem. Common ones:",
  "internet.email, internet.url, person.fullName, person.jobTitle,",
  "location.city, location.country, location.zipCode, company.name,",
  "commerce.productName, finance.amount, string.uuid, lorem.paragraph.",
  // Said here because it is the one thing about the output that is not what the
  // format name suggests.
  `The file extension follows textFormat: ${Object.values(TEXT_FORMAT_INFO)
    .map((info) => `.${info.extension}`)
    .join(", ")}.`,
  "CSV separates its columns with ';' unless textDelimiter says otherwise, because",
  "that is the delimiter a spreadsheet expects where the decimal separator is a",
  "comma, which includes Spanish.",
].join(" ");

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
      name: "generate_placeholder",
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
        if (!applied.ok)
          return `Could not apply the configuration: ${applied.error}`;
        const isText = host.describe().kind === "text";
        if (input.download === false) {
          // Text is returned either way: asking for the configuration without the
          // file is exactly how an agent reads the data without saving it.
          return isText
            ? host.text()
            : `Configured without downloading: ${JSON.stringify(host.describe())}`;
        }
        try {
          await host.generate();
        } catch (err) {
          return `Generation failed: ${err instanceof Error ? err.message : String(err)}`;
        }
        if (isText) return host.text();
        return `Generated ${JSON.stringify(host.describe())}.`;
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
    ? "WebMCP active: an AI agent can generate placeholders from this page."
    : "";
}
