/**
 * Sounds for the video exports.
 *
 * A placeholder video is meant to be thrown away, so the sound is not content:
 * it only has to prove that the file carries an audio track and that the track
 * does not drift from the picture. A short beep every second says both at a
 * glance, and the tango is there for when the placeholder should not be silent
 * in a room where it plays.
 *
 * The two kinds are made in two different ways, and that is the whole reason
 * they live in two parts of this file:
 *
 * - **Test tones** (`beep`, `tone`, `noise`) are plain math over a
 *   `Float32Array`: no Web Audio, no `AudioBuffer`, no DOM, so they are
 *   testable in Bun exactly like the frames are.
 * - **The tango** is music. It is the graph from `placeholder-audio.html`,
 *   rendered through an `OfflineAudioContext`, which renders faster than it
 *   plays, so a ten second video does not cost ten seconds of waiting.
 *
 * Quality means the same two things for both, and both are about not being
 * annoying or broken:
 *
 * - **Level.** A 440 Hz sine at −20 dBFS is the usual alignment level for a
 *   test signal. The tones that never stop sit lower still, because a
 *   continuous sound is tiring in a way a periodic one is not.
 * - **No clicks.** Every sound starts and ends at zero, with a raised-cosine
 *   fade, because a waveform that starts at full amplitude is an audible click
 *   in every player.
 */

import type { VideoTone } from './types';

/** The sounds that are plain math, without Web Audio. */
export type TestTone = Exclude<VideoTone, 'tango'>;

/** Sample rate of the test tones. Every encoder prefers 48 kHz. */
export const AUDIO_SAMPLE_RATE = 48000;

/** Sample rate of the tango, the one it was rendered at in the source page. */
export const TANGO_SAMPLE_RATE = 44100;

/** Pitch of the beep and the continuous tone, in hertz. 440 is the reference A. */
const TONE_HZ = 440;

/** Peak of the beep: −20 dBFS, the level a test signal is aligned at. */
const BEEP_PEAK = 0.1;
/** Peak of the continuous tones: −26 dBFS, lower because they never stop. */
const TONE_PEAK = 0.05;

/** Seconds between beeps. */
const BEEP_PERIOD = 1;
/** Seconds each beep lasts. Long enough to hear, short enough to leave the gap. */
const BEEP_SECONDS = 0.08;
/** Seconds of fade at the two ends of a sound that would otherwise start or stop abruptly. */
const FADE_SECONDS = 0.03;

/**
 * Mono samples of a test sound, `seconds` long at `sampleRate`.
 *
 * The noise is derived from the sample index rather than from a running random
 * generator, so a given index always holds the same value: two exports of the
 * same video carry the same sound, and the result does not depend on how the
 * track was built.
 */
export function toneSamples(
  tone: TestTone,
  seconds: number,
  sampleRate: number = AUDIO_SAMPLE_RATE,
): Float32Array<ArrayBuffer> {
  const length = Math.max(0, Math.round(seconds * sampleRate));
  const samples = new Float32Array(length);
  for (let i = 0; i < length; i++) {
    const t = i / sampleRate;
    if (tone === 'beep') {
      samples[i] = beepAt(t);
    } else {
      const window = edgeWindow(t, seconds);
      const signal = tone === 'tone' ? Math.sin(2 * Math.PI * TONE_HZ * t) : noiseAt(i);
      samples[i] = window * TONE_PEAK * signal;
    }
  }
  return samples;
}

/** One burst of the repeating beep, or silence while the second goes by. */
function beepAt(t: number): number {
  const p = (t % BEEP_PERIOD) / BEEP_SECONDS;
  if (p >= 1) return 0;
  // The burst is a full raised cosine, so it starts and ends at zero.
  const window = 0.5 - 0.5 * Math.cos(2 * Math.PI * p);
  return BEEP_PEAK * window * Math.sin(2 * Math.PI * TONE_HZ * t);
}

/** 1 in the middle, 0 at the first and the last sample, over `FADE_SECONDS`. */
function edgeWindow(t: number, seconds: number): number {
  const w = Math.min(1, Math.min(t, seconds - t) / FADE_SECONDS);
  return 0.5 - 0.5 * Math.cos(Math.PI * w);
}

/** White noise in [−1, 1] from a plain 32-bit LCG, so it is reproducible. */
function noiseAt(index: number): number {
  const bits = (Math.imul(index + 1, 1664525) + 1013904223) >>> 0;
  return (bits / 0x80000000) - 1;
}

// ── The tango ──────────────────────────────────────────────────────────────

/**
 * The three numbers the track was generated with, fixed on purpose: the same
 * seed with the same parameters is the same music, so every placeholder built
 * from here carries the same tango.
 */
const TANGO_BPM = 100;
const TANGO_ROOT_HZ = 75;
const TANGO_SEED = 895;

/** mulberry32: the small seeded PRNG the source page used. */
function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The tango, `seconds` long, rendered offline.
 *
 * A "tango nuevo": Am–Dm–E–Am in marcato 3-3-2, staccato stabs on the chord
 * tones, a vibrato lead that is a seeded random walk over those same tones, and
 * the scraped 2 and 4. The graph is copied from `placeholder-audio.html` so the
 * result is that page's tango; the numbers above are the ones from its
 * controls. The lead only enters on the third bar, so a clip shorter than about
 * five seconds is stabs and bass alone.
 *
 * The fade at both ends is the page's, scaled to the length: a clip that cuts
 * the music off mid-note would click.
 */
export async function tangoBuffer(seconds: number): Promise<AudioBuffer> {
  // One frame at least: a zero-length context is an error, and there is never
  // a video here with no time in it.
  const length = Math.max(1, Math.round(seconds * TANGO_SAMPLE_RATE));
  const ctx = new OfflineAudioContext(2, length, TANGO_SAMPLE_RATE);
  const rand = mulberry32(TANGO_SEED);

  const master = ctx.createGain();
  const fade = Math.min(1, seconds / 4);
  master.gain.setValueAtTime(0, 0);
  master.gain.linearRampToValueAtTime(0.6, fade);
  master.gain.setValueAtTime(0.6, seconds - fade);
  master.gain.linearRampToValueAtTime(0, seconds);
  master.connect(ctx.createDynamicsCompressor()).connect(ctx.destination);

  const sixteenth = 15 / TANGO_BPM;
  const bar = sixteenth * 16;
  const progression: ReadonlyArray<readonly [number, 'm' | 'M']> = [
    [1, 'm'],
    [4 / 3, 'm'],
    [3 / 2, 'M'],
    [1, 'm'],
  ];
  const third = { m: 6 / 5, M: 5 / 4 };
  // 3-3-2, in sixteenths: when each stab and the lead note land.
  const rhythm = [0, 6, 12];
  const stabLen = [5, 5, 3];
  const leadLen = [6, 6, 4];

  const vib = ctx.createOscillator();
  vib.frequency.value = 5.5;
  const vibDepth = ctx.createGain();
  vibDepth.gain.value = 14; // cents
  vib.connect(vibDepth);
  vib.start();
  vib.stop(seconds);

  const scrapeNoise = ctx.createBuffer(1, Math.floor(TANGO_SAMPLE_RATE * 0.2), TANGO_SAMPLE_RATE);
  const noiseData = scrapeNoise.getChannelData(0);
  for (let i = 0; i < noiseData.length; i++) noiseData[i] = rand() * 2 - 1;

  const note = (
    type: OscillatorType,
    freq: number,
    at: number,
    len: number,
    peak: number,
    cutoff: number,
    lead = false,
  ): void => {
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    if (lead) vibDepth.connect(osc.detune);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = cutoff;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, at);
    if (lead) {
      // The lead is sung, not stabbed: it swells and holds instead of decaying
      // from the attack.
      gain.gain.linearRampToValueAtTime(peak, at + 0.04);
      gain.gain.setValueAtTime(peak, Math.max(at + 0.04, at + len - 0.08));
      gain.gain.linearRampToValueAtTime(0.0001, at + len);
    } else {
      gain.gain.exponentialRampToValueAtTime(peak, at + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, at + len);
    }
    osc.connect(filter).connect(gain).connect(master);
    osc.start(at);
    osc.stop(at + len + 0.05);
  };

  const scrape = (at: number, peak: number): void => {
    const source = ctx.createBufferSource();
    source.buffer = scrapeNoise;
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1800;
    band.Q.value = 0.8;
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(peak, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.12);
    source.connect(band).connect(gain).connect(master);
    source.start(at);
  };

  let melodyIndex = 2;
  for (let b = 0; b * bar < seconds - 0.2; b++) {
    const [ratio, quality] = progression[b % progression.length]!;
    const base = TANGO_ROOT_HZ * ratio;
    const tones = [1, third[quality], 1.5].map((x) => base * x);
    const pool = [...tones.map((f) => f * 4), ...tones.map((f) => f * 8)];
    rhythm.forEach((step, k) => {
      const at = b * bar + step * sixteenth;
      if (at >= seconds - 0.2) return;
      note('sawtooth', base, at, (stabLen[k] ?? 0) * sixteenth, 0.3, 500);
      for (const f of tones) note('sawtooth', f * 2, at, (stabLen[k] ?? 0) * sixteenth * 1.1, 0.05, 2600);
      if (b >= 2) {
        melodyIndex = Math.max(0, Math.min(pool.length - 1, melodyIndex + Math.floor(rand() * 5) - 2));
        note('sawtooth', pool[melodyIndex] ?? base, at, (leadLen[k] ?? 0) * sixteenth, 0.12, 2400, true);
      }
    });
    for (const step of [4, 12]) {
      const at = b * bar + step * sixteenth;
      if (at < seconds - 0.2) scrape(at, 0.35);
    }
  }

  return ctx.startRendering();
}

// ── One entry point ────────────────────────────────────────────────────────

/**
 * The shape a sound is rendered at.
 *
 * The audio encoder is probed with it, and mediabunny configures the encoder
 * from the first buffer it is handed, so a buffer that did not match what was
 * asked about would only be discovered when the export fails.
 */
export function soundShape(tone: VideoTone): { numberOfChannels: number; sampleRate: number } {
  return tone === 'tango'
    ? { numberOfChannels: 2, sampleRate: TANGO_SAMPLE_RATE }
    : { numberOfChannels: 1, sampleRate: AUDIO_SAMPLE_RATE };
}

/**
 * The rendered `AudioBuffer` for a sound, `seconds` long and shaped by
 * `soundShape`.
 *
 * mediabunny checks `instanceof AudioBuffer`, so it has to be a real one: the
 * tones wrap their samples in one here instead of in the exporter, which is
 * also where the music has to be rendered.
 */
export async function renderSound(tone: VideoTone, seconds: number): Promise<AudioBuffer> {
  if (tone === 'tango') return tangoBuffer(seconds);
  const samples = toneSamples(tone, seconds);
  const buffer = new AudioBuffer({
    length: samples.length,
    numberOfChannels: 1,
    sampleRate: AUDIO_SAMPLE_RATE,
  });
  buffer.copyToChannel(samples, 0);
  return buffer;
}

/**
 * The same sound, cut into pieces of at most `chunkSeconds`.
 *
 * mediabunny's muxers wait for every track before they can write a chunk of the
 * file, so a track handed over all at once leaves the muxer holding the whole
 * other track in memory. Feeding the sound beside the picture keeps both sides
 * moving forward instead.
 *
 * `AudioBufferSource.add` takes a whole `AudioBuffer` and there is no offset,
 * so the pieces are built here rather than in the exporter.
 */
export function audioChunks(buffer: AudioBuffer, chunkSeconds: number): AudioBuffer[] {
  const framesPerChunk = Math.max(1, Math.round(chunkSeconds * buffer.sampleRate));
  const chunks: AudioBuffer[] = [];
  for (let start = 0; start < buffer.length; start += framesPerChunk) {
    const frames = Math.min(framesPerChunk, buffer.length - start);
    const chunk = new AudioBuffer({
      length: frames,
      numberOfChannels: buffer.numberOfChannels,
      sampleRate: buffer.sampleRate,
    });
    const channel = new Float32Array(frames);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      buffer.copyFromChannel(channel, c, start);
      chunk.copyToChannel(channel, c);
    }
    chunks.push(chunk);
  }
  return chunks;
}
