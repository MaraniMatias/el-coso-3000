/**
 * LZW compression as required by the GIF image data block.
 *
 * This is the algorithm's "string" variant: it compresses palette indices, not
 * bytes, and the decoder rebuilds the substring dictionary from the same codes
 * it sees, so the dictionary is never stored in the file. The encoder and
 * decoder must therefore increase the code width at exactly the same moment;
 * one code of drift makes the entire file unreadable.
 */

/**
 * Newly allocated bytes. The generic matters: `Blob` only accepts views over
 * a real `ArrayBuffer`, while a bare `Uint8Array` is typed as potentially
 * shared.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

/** The spec caps the dictionary at 12 bits (4096 entries). */
const MAX_CODES = 1 << 12;
/** GIF image data is sent in blocks of at most 255 bytes. */
const MAX_SUB_BLOCK = 255;

/**
 * A byte buffer that grows incrementally.
 *
 * A frame's compressed size is unknown in advance: it depends on the content
 * and compression level, so requesting a maximum "just in case" wastes memory
 * (a 1080p frame has 2 MB of indices), while requesting too little requires
 * calculating the worst case. Doubling the buffer when full is the only option
 * that never overflows.
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

  /** Trims to the actual length. `slice` returns its own `ArrayBuffer`. */
  finish(): Bytes {
    return this.buf.slice(0, this.len);
  }
}

/** Writes a 16-bit integer in little-endian, as required by GIF. */
export function pushUint16(out: ByteWriter, value: number): void {
  out.push(value & 0xff);
  out.push((value >>> 8) & 0xff);
}

/**
 * Long GIF payloads (LZW data, comments) use sub-blocks of up to 255 bytes,
 * each preceded by its length, and the chain ends with a sub-block of length 0.
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
 * Compresses palette indices with GIF LZW.
 *
 * @param indices One byte per pixel, all less than `1 << minCodeSize`.
 * @param minCodeSize Bits per input index. The spec requires 2..8.
 * @returns The sub-block chain ready to write: the 255-byte limit per block
 *   is part of the encoding, not the file assembler.
 */
export function lzwCompress(indices: Uint8Array, minCodeSize: number): Bytes {
  if (!Number.isInteger(minCodeSize) || minCodeSize < 2 || minCodeSize > 8) {
    throw new RangeError(
      `minCodeSize out of range: ${minCodeSize} (expected 2..8)`,
    );
  }

  const out = new ByteWriter(Math.max(1024, indices.length >> 1));
  const block = new Uint8Array(MAX_SUB_BLOCK);
  let blockLen = 0;

  // The first code must be a clear: if the file starts with a data code, the
  // decoder has no dictionary and cannot do anything.
  const clearCode = 1 << minCodeSize;
  const eoiCode = clearCode + 1;
  let nextCode = eoiCode + 1;
  let codeSize = minCodeSize + 1;

  // Bits are written LSB-first: bit 0 of the code goes to bit 0 of the byte.
  // Bits that do not fill a byte stay in `acc` and are completed by the next code.
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

  // The dictionary uses the integer key `prefix << 8 | byte`, which spans up
  // to 4095*256+255 = 1,048,576 slots. An `Int32Array` of 4096 (the code limit)
  // would leave almost everything out of range; since typed arrays silently
  // discard out-of-range writes, the dictionary would appear full and compress
  // nothing. Use a Map instead: the key is a direct integer, with no hashing or
  // objects, and there is no fixed size limit.
  const dict = new Map<number, number>();

  emit(clearCode);
  if (indices.length > 0) {
    // `prefix` is always the code for the string accumulated so far; look up
    // its extension with the next byte and keep adding if it exists.
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
        // ── Exact point at which to INCREASE the width ─────────────────────
        //
        // It is `nextCode === (1 << codeSize) + 1`: entry 2^codeSize + 1, one
        // code later than the encoder's own table needs to fit in the current
        // width.
        //
        // The decoder is one entry BEHIND. It cannot create the string
        // `prefix + byte` until it sees the next code, so it adds that entry
        // only AFTER reading the code the encoder just emitted: when the
        // encoder assigns entry N, the decoder assigns N-1. The decoder
        // increases its width when its table reaches 2^codeSize, one code after
        // the encoder.
        //
        // If the width increased here at `nextCode === 1 << codeSize` (as the
        // encoder's own table would), the encoder would get one code ahead: it
        // would write a code at the new width before the decoder knows it, so
        // the decoder would read that code at the old width and every code
        // after it would be offset by one bit. The symptom is silent: the file
        // opens and looks almost correct. That is why the rule is written this
        // way, not "the way it seems it should work."
        //
        // Reference: this is exactly what the ffmpeg compressor does
        // (`libavcodec/lzwenc.c`), which is read by every GIF decoder, and what
        // its decoder requires when reading
        // (`libavcodec/lzw.c`: `if (slot >= top_slot) cursize++`).
        if (nextCode === (1 << codeSize) + 1 && codeSize < 12) codeSize++;
      } else {
        // Full dictionary: without a clear, code 4096 would not fit in 12 bits
        // and the file would no longer be decodable.
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
  out.push(0x00); // end of the sub-block chain

  return out.finish();
}
