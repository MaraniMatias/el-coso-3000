/**
 * Compresión LZW tal y como la exige el bloque de datos de imagen del GIF.
 *
 * Es la variante "de cadena" del algoritmo: no comprime bytes sino índices de
 * paleta, y el diccionario de subcadenas se reconstruye en el decodificador a
 * partir de los mismos códigos que ve, así que nunca viaja en el archivo. Por
 * eso el codificador y el decodificador tienen que crecer el ancho de código
 * exactamente en el mismo instante; desfasarse un código y el archivo entero
 * queda ilegible.
 */

/**
 * Bytes recién asignados. El genérico importa: `Blob` sólo acepta vistas sobre
 * un `ArrayBuffer` real, y un `Uint8Array` pelado se tipa como potencialmente
 * compartido.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** La spec topa el diccionario en 12 bits (4096 entradas). */
const MAX_CODES = 1 << 12;
/** Los datos de imagen del GIF viajan en trozos de a lo sumo 255 bytes. */
const MAX_SUB_BLOCK = 255;

/**
 * Buffer de bytes que crece de a poco.
 *
 * El tamaño comprimido de un frame no se conoce de antemano: depende del
 * contenido y del propio nivel de compresión, así que pedir un máximo "por si
 * acaso" desperdicia memoria (un frame de 1080p son 2 MB de índices) y pedirlo
 * chico obliga a calcular el peor caso. Crecer al doble cuando se llena es lo
 * único que nunca desborda.
 */
export class ByteWriter {
  private buf: Uint8Array<ArrayBuffer>;
  private len = 0;

  constructor(initial = 1024) {
    this.buf = new Uint8Array(initial);
  }

  get length(): number {
    return this.len;
  }

  push(byte: number): void {
    if (this.len === this.buf.length) {
      const grown = new Uint8Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.len++] = byte;
  }

  pushBytes(bytes: Uint8Array): void {
    for (let i = 0; i < bytes.length; i++) this.push(bytes[i]!);
  }

  /** Recorta al largo real. El `slice` devuelve un `ArrayBuffer` propio. */
  finish(): Bytes {
    return this.buf.slice(0, this.len);
  }
}

/** Escribe un entero de 16 bits en little-endian, como manda el GIF. */
export function pushUint16(out: ByteWriter, value: number): void {
  out.push(value & 0xff);
  out.push((value >>> 8) & 0xff);
}

/**
 * Los payloads largos del GIF (datos LZW, comentarios) van en sub-bloques de
 * hasta 255 bytes, cada uno precedido por su largo, y la cadena termina con un
 * sub-bloque de largo 0.
 */
export function writeSubBlocks(out: ByteWriter, data: Uint8Array): void {
  for (let at = 0; at < data.length; at += MAX_SUB_BLOCK) {
    const len = Math.min(MAX_SUB_BLOCK, data.length - at);
    out.push(len);
    out.pushBytes(data.subarray(at, at + len));
  }
  out.push(0x00);
}

/**
 * Comprime índices de paleta con LZW de GIF.
 *
 * @param indices Un byte por píxel, todos menores a `1 << minCodeSize`.
 * @param minCodeSize Bits por índice en la entrada. La spec exige 2..8.
 * @returns La cadena de sub-bloques lista para escribir: el límite de 255 bytes
 *   por bloque forma parte de la codificación, no del armador del archivo.
 */
export function lzwCompress(indices: Uint8Array, minCodeSize: number): Bytes {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) {
    throw new RangeError(`minCodeSize fuera de rango: ${minCodeSize} (se admiten 2..8)`);
  }

  const out = new ByteWriter(Math.max(1024, indices.length >> 1));
  const block = new Uint8Array(MAX_SUB_BLOCK);
  let blockLen = 0;

  // El primer código debe ser un clear: si el archivo arranca con un código de
  // datos, el decodificador no tiene diccionario y no puede hacer nada.
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  // Los bits salen LSB-first: el bit 0 del código va al bit 0 del byte. Los que
  // no cierran un byte quedan en `acc` y se completan con el código siguiente.
  let acc = 0;
  let accBits = 0;

  const flushBlock = (): void => {
    if (blockLen === 0) return;
    out.push(blockLen);
    out.pushBytes(block.subarray(0, blockLen));
    blockLen = 0;
  };

  const emit = (code: number): void => {
    acc |= code << accBits;
    accBits += codeSize;
    while (accBits >= 8) {
      block[blockLen++] = acc & 0xff;
      acc >>>= 8;
      accBits -= 8;
      if (blockLen === MAX_SUB_BLOCK) flushBlock();
    }
  };

  // El diccionario se indexa por la clave entera `prefijo << 8 | byte`, que
  // abarca hasta 4095*256+255 = 1.048.576 casillas. Un `Int32Array` de
  // 4096 (el tope de códigos) dejaría fuera de rango casi todo y, como en un
  // typed array la escritura fuera de rango se descarta EN SILENCIO, el
  // diccionario parecería lleno y no comprimiría nada. Por eso va en un Map:
  // la clave es un entero directo, sin hashing ni objetos, y no tiene tope.
  const dict = new Map<number, number>();

  emit(clearCode);
  if (indices.length > 0) {
    // `prefix` es siempre el código de la cadena acumulada hasta acá; se busca
    // su extensión con el byte siguiente y, si existe, se sigue agregando.
    let prefix = indices[0]!;
    for (let i = 1; i < indices.length; i++) {
      const next = indices[i]!;
      const key = (prefix << 8) | next;
      const known = dict.get(key);
      if (known !== undefined) {
        prefix = known;
        continue;
      }

      emit(prefix);

      if (nextCode < MAX_CODES) {
        dict.set(key, nextCode++);
        // ── Momento exacto en que hay que AGRANDAR el ancho ────────────────
        //
        // Es `nextCode === (1 << codeSize) + 1`: la entrada 2^codeSize + 1, es
        // decir UN CÓDIGO más tarde que lo que haría falta para que la tabla
        // propia del encoder quepa en el ancho actual.
        //
        // El motivo es que el decodificador va una entrada POR DETRÁS. No
        // puede crear la cadena `prefijo + byte` hasta ver el código siguiente,
        // así que incorpora esa entrada recién DESPUÉS de haber leído el código
        // que el encoder acababa de emitir: cuando el encoder asigna la entrada
        // N, el decoder asigna la N-1. El decoder agranda su ancho cuando su
        // tabla alcanza 2^codeSize, o sea un código después que el encoder.
        //
        // Si acá se agrandara en `nextCode === 1 << codeSize` (que es lo que
        // hace la propia tabla del encoder) el encoder se adelantaría un
        // código: escribiría un código con el ancho nuevo que el decoder todavía
        // no conoce, el decoder leería ese código con el ancho viejo y a partir
        // de ahí TODOS los códigos quedarían desfasados un bit. El síntoma es
        // silencioso —el archivo se abre y parece casi correcto— y por eso la
        // regla va escrita así y no "como parece que debería".
        //
        // Referencia: es exactamente lo que hace el compresor de ffmpeg
        // (`libavcodec/lzwenc.c`), que sí se lee con cualquier decodificador de
        // GIF del mundo, y lo que su decodificador exige al leer
        // (`libavcodec/lzw.c`: `if (slot >= top_slot) cursize++`).
        if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
      } else {
        // Diccionario lleno: sin un clear, el código 4096 no entraría en 12
        // bits y el archivo deja de ser decodificable.
        emit(clearCode);
        dict.clear();
        nextCode = eoiCode + 1;
        codeSize = minCodeSize + 1;
      }
      prefix = next;
    }
    emit(prefix);
  }
  emit(eoiCode);

  if (accBits > 0) {
    block[blockLen++] = acc & 0xff;
  }
  flushBlock();
  out.push(0x00); // fin de la cadena de sub-bloques

  return out.finish();
}
