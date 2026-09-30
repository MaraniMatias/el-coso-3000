/**
 * File saving.
 *
 * Prefer `showSaveFilePicker` when available because it writes the file to
 * disk during encoding instead of accumulating the entire video in memory.
 * Otherwise, fall back to the usual `<a download>`.
 */

export interface SaveTarget {
  /** Closes the target. A no-op in picker mode. */
  close(): Promise<void>;
  /** Writes a chunk. Only available in picker mode. */
  write?(chunk: Uint8Array): Promise<void>;
  /** `true` if incremental writing is supported. */
  readonly streaming: boolean;
}

export function supportsFilePicker(): boolean {
  return (
    typeof (globalThis as { showSaveFilePicker?: unknown })
      .showSaveFilePicker === "function"
  );
}

type PickerType = { description: string; accept: Record<string, string[]> };

const PICKER_TYPES: Record<string, PickerType> = {
  "image/png": { description: "PNG", accept: { "image/png": [".png"] } },
  "image/jpeg": {
    description: "JPEG",
    accept: { "image/jpeg": [".jpg", ".jpeg"] },
  },
  "image/webp": { description: "WebP", accept: { "image/webp": [".webp"] } },
  "image/svg+xml": {
    description: "SVG",
    accept: { "image/svg+xml": [".svg"] },
  },
  "image/gif": { description: "GIF", accept: { "image/gif": [".gif"] } },
  "video/mp4": { description: "MP4", accept: { "video/mp4": [".mp4"] } },
  "video/quicktime": {
    description: "QuickTime",
    accept: { "video/quicktime": [".mov"] },
  },
  "video/webm": { description: "WebM", accept: { "video/webm": [".webm"] } },
  "video/x-matroska": {
    description: "Matroska",
    accept: { "video/x-matroska": [".mkv"] },
  },
  "video/x-msvideo": {
    description: "AVI (Motion JPEG)",
    accept: { "video/x-msvideo": [".avi"] },
  },
  "application/zip": {
    description: "JPEG ZIP",
    accept: { "application/zip": [".zip"] },
  },
};

/**
 * Opens a write target for the requested file.
 *
 * Returns `null` if the user cancels the save dialog; that is cancellation,
 * not an error.
 */
export async function openSaveTarget(
  filename: string,
  mimeType: string,
): Promise<SaveTarget | null> {
  const picker = (
    globalThis as {
      showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
    }
  ).showSaveFilePicker;

  if (typeof picker !== "function") return null;

  const types = PICKER_TYPES[mimeType] ? [PICKER_TYPES[mimeType]] : [];
  try {
    const handle = await picker({ suggestedName: filename, types });
    const writable = await (
      handle as unknown as {
        createWritable: () => Promise<FileSystemWritableFileStream>;
      }
    ).createWritable();
    return {
      streaming: true,
      async write(chunk) {
        await (
          writable as unknown as { write: (c: Uint8Array) => Promise<void> }
        ).write(chunk);
      },
      async close() {
        await writable.close();
      },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") return null;
    throw err;
  }
}

/** Downloads an already-built blob. This is the non-streaming path. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Release on the next tick: Safari needs the URL to stay alive while the
  // click is processed.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
