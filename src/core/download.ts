/**
 * Guardado de archivos.
 *
 * Se prefiere `showSaveFilePicker` cuando está disponible, porque permite
 * escribir el archivo a disco mientras se codifica en vez de acumular el
 * video entero en memoria. Si no está, se cae al `<a download>` de siempre.
 */

export interface SaveTarget {
  /** Cierra el destino. En el modo picker es un no-op. */
  close(): Promise<void>;
  /** Escribe un chunk. Sólo disponible en modo picker. */
  write?(chunk: Uint8Array): Promise<void>;
  /** `true` si soporta escritura incremental. */
  readonly streaming: boolean;
}

export function supportsFilePicker(): boolean {
  return typeof (globalThis as { showSaveFilePicker?: unknown }).showSaveFilePicker === 'function';
}

type PickerType = { description: string; accept: Record<string, string[]> };

const PICKER_TYPES: Record<string, PickerType> = {
  'image/png': { description: 'PNG', accept: { 'image/png': ['.png'] } },
  'image/jpeg': { description: 'JPEG', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
  'image/webp': { description: 'WebP', accept: { 'image/webp': ['.webp'] } },
  'image/svg+xml': { description: 'SVG', accept: { 'image/svg+xml': ['.svg'] } },
  'image/gif': { description: 'GIF', accept: { 'image/gif': ['.gif'] } },
  'video/mp4': { description: 'MP4', accept: { 'video/mp4': ['.mp4'] } },
  'video/quicktime': { description: 'QuickTime', accept: { 'video/quicktime': ['.mov'] } },
  'video/webm': { description: 'WebM', accept: { 'video/webm': ['.webm'] } },
  'video/x-matroska': { description: 'Matroska', accept: { 'video/x-matroska': ['.mkv'] } },
  'video/x-msvideo': { description: 'AVI (Motion JPEG)', accept: { 'video/x-msvideo': ['.avi'] } },
  'application/zip': { description: 'ZIP de JPEG', accept: { 'application/zip': ['.zip'] } },
};

/**
 * Abre un destino de escritura para el archivo pedido.
 *
 * Devuelve `null` si el usuario cancela el diálogo de guardado; eso no es un
 * error, es una cancelación.
 */
export async function openSaveTarget(filename: string, mimeType: string): Promise<SaveTarget | null> {
  const picker = (globalThis as {
    showSaveFilePicker?: (opts: unknown) => Promise<FileSystemFileHandle>;
  }).showSaveFilePicker;

  if (typeof picker !== 'function') return null;

  const types = PICKER_TYPES[mimeType] ? [PICKER_TYPES[mimeType]] : [];
  try {
    const handle = await picker({ suggestedName: filename, types });
    const writable = await (handle as unknown as {
      createWritable: () => Promise<FileSystemWritableFileStream>;
    }).createWritable();
    return {
      streaming: true,
      async write(chunk) {
        await (writable as unknown as { write: (c: Uint8Array) => Promise<void> }).write(chunk);
      },
      async close() {
        await writable.close();
      },
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') return null;
    throw err;
  }
}

/** Descarga un blob ya construido. Es el camino sin streaming. */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Se libera en el siguiente tick: Safari necesita que la URL siga viva
  // mientras el click se procesa.
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
