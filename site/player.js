// Real-time first-order ambisonics (AmbiX: ACN order, SN3D) to binaural
// playback, built on Omnitone's FOA renderer (SH-domain HRIR convolution).
//
// Recordings are ~11 minutes of 4-channel 24-bit PCM (~380 MB), too large to
// download and decode in one go, so the player streams them: it reads PCM in
// short blocks through a byte-range reader, converts them itself, and
// schedules them back to back a few seconds ahead of the playhead.
import Omnitone from 'https://cdn.jsdelivr.net/npm/omnitone@1.3.0/build/omnitone.min.esm.js';

const DEG = Math.PI / 180;
const BLOCK_SECONDS = 2;
const AHEAD_SECONDS = 8;
const START_DELAY = 0.06;

// ------------------------------------------------------------------ WAV

const PCM = 1;
const FLOAT = 3;
const EXTENSIBLE = 0xfffe;

/**
 * Parse a RIFF/WAVE header. Returns the format and where the PCM data lives,
 * or `{ needBytes }` if the header continues past the bytes given.
 */
export function parseWavHeader(bytes, fileSize) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('Not a WAV file');
  let pos = 12;
  let fmt = null;
  while (pos + 8 <= bytes.length) {
    const id = tag(pos);
    const size = dv.getUint32(pos + 4, true);
    if (id === 'fmt ') {
      if (pos + 8 + 16 > bytes.length) break;
      let format = dv.getUint16(pos + 8, true);
      if (format === EXTENSIBLE) format = dv.getUint16(pos + 32, true);
      fmt = {
        format,
        channels: dv.getUint16(pos + 10, true),
        sampleRate: dv.getUint32(pos + 12, true),
        blockAlign: dv.getUint16(pos + 20, true),
        bits: dv.getUint16(pos + 22, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('WAV data before format');
      const supported = (fmt.format === PCM && [16, 24, 32].includes(fmt.bits)) || (fmt.format === FLOAT && fmt.bits === 32);
      if (!supported) throw new Error(`Unsupported WAV encoding (format ${fmt.format}, ${fmt.bits}-bit)`);
      const dataOffset = pos + 8;
      let dataSize = size;
      if (fileSize && (!dataSize || dataOffset + dataSize > fileSize)) dataSize = fileSize - dataOffset;
      const frames = Math.floor(dataSize / fmt.blockAlign);
      return { ...fmt, dataOffset, frames, duration: frames / fmt.sampleRate };
    }
    pos += 8 + size + (size & 1);
  }
  return { needBytes: Math.max(pos + 64, bytes.length * 2) };
}

/** Interleaved PCM bytes → one Float32Array per channel. */
export function decodePcm(bytes, info, frames = Math.floor(bytes.byteLength / info.blockAlign)) {
  const { channels, bits, format, blockAlign } = info;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = Array.from({ length: channels }, () => new Float32Array(frames));
  const bps = bits / 8;
  for (let f = 0; f < frames; f++) {
    const base = f * blockAlign;
    for (let c = 0; c < channels; c++) {
      const o = base + c * bps;
      let v;
      if (format === FLOAT) v = dv.getFloat32(o, true);
      else if (bits === 16) v = dv.getInt16(o, true) / 32768;
      else if (bits === 24) v = ((bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16)) << 8 >> 8) / 8388608;
      else v = dv.getInt32(o, true) / 2147483648;
      out[c][f] = v;
    }
  }
  return out;
}

// ------------------------------------------------------------- rotation

// Ambisonic axes (X front, Y left, Z up) expressed in Omnitone's OpenGL-style
// axes (x right, y up, z back): gl = P · ambi.
const P = [
  [0, -1, 0],
  [0, 0, 1],
  [-1, 0, 0],
];

const matmul = (a, b) => a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
const transpose = (m) => m[0].map((_, j) => m.map((row) => row[j]));

/**
 * Sound-field rotation for a listener whose head is turned by `yaw` (positive
 * = to the left, i.e. counter-clockwise seen from above) and tilted by
 * `pitch` (positive = looking up), in degrees. Returns the column-major 3x3
 * matrix Omnitone expects.
 */
export function rotationMatrix(yawDeg, pitchDeg) {
  const y = yawDeg * DEG;
  const p = pitchDeg * DEG;
  // Head orientation H = Rz(yaw)·Ry(-pitch); the scene rotates by Hᵀ.
  const RzT = [
    [Math.cos(y), Math.sin(y), 0],
    [-Math.sin(y), Math.cos(y), 0],
    [0, 0, 1],
  ];
  const RyT = [
    [Math.cos(p), 0, Math.sin(p)],
    [0, 1, 0],
    [-Math.sin(p), 0, Math.cos(p)],
  ];
  const scene = matmul(RyT, RzT);
  const gl = matmul(matmul(P, scene), transpose(P));
  const out = new Float32Array(9);
  for (let col = 0; col < 3; col++) for (let row = 0; row < 3; row++) out[col * 3 + row] = gl[row][col];
  return out;
}

/** Build the FOA → binaural graph in any BaseAudioContext (also offline). */
export async function createFoaGraph(ctx) {
  const renderer = Omnitone.createFOARenderer(ctx);
  await renderer.initialize();
  const input = ctx.createGain();
  input.channelCount = 4;
  input.channelCountMode = 'explicit';
  input.channelInterpretation = 'discrete';
  const output = ctx.createGain();
  const binaural = ctx.createGain();
  const omni = ctx.createGain();
  const splitter = ctx.createChannelSplitter(4);
  input.connect(renderer.input);
  input.connect(splitter);
  renderer.output.connect(binaural).connect(output);
  splitter.connect(omni, 0); // W only, upmixed to both ears
  omni.connect(output);
  omni.gain.value = 0;
  return { renderer, input, output, binaural, omni, splitter };
}

// --------------------------------------------------------------- player

/**
 * Streams a WAV through the FOA renderer. `open()` takes a source:
 *   { info: parseWavHeader(...) result, read(offset, length, signal) → Promise<Uint8Array> }
 */
export class FoaPlayer extends EventTarget {
  constructor() {
    super();
    this.ctx = null;
    this.src = null;
    this.playing = false;
    this.loop = false;
    this._frame = 0; // playhead while paused
    this._epoch = 0; // bumps on every start/stop to cancel stale work
    this._segments = []; // scheduled blocks: { when, frame, frames, node }
    this._yaw = 0;
    this._pitch = 0;
    this._mode = 'binaural';
    this._gainDb = 0;
    this._intensity = [0, 0, 0];
    this._energy = 0;
  }

  async _ensureContext(sampleRate) {
    if (this.ctx && this.ctx.sampleRate === sampleRate) return;
    if (this.ctx) await this.ctx.close();
    // Run at the file's rate so consecutive blocks join sample-exactly.
    const ctx = new AudioContext({ latencyHint: 'playback', sampleRate });
    const graph = await createFoaGraph(ctx);
    this.master = ctx.createGain();
    graph.output.connect(this.master).connect(ctx.destination);
    // Per-channel analysers for the direction-of-arrival meter.
    this.analysers = [0, 1, 2, 3].map((ch) => {
      const a = ctx.createAnalyser();
      a.fftSize = 2048;
      graph.splitter.connect(a, ch);
      return a;
    });
    this._scratch = this.analysers.map((a) => new Float32Array(a.fftSize));
    this.ctx = ctx;
    this.graph = graph;
    this.setRotation(this._yaw, this._pitch);
    this.setMode(this._mode);
    this.master.gain.value = 10 ** (this._gainDb / 20);
  }

  get info() {
    return this.src?.info ?? null;
  }

  get duration() {
    return this.info ? this.info.duration : 0;
  }

  get isFoa() {
    return this.info?.channels === 4;
  }

  /** True while playing but waiting for audio to arrive. */
  get buffering() {
    if (!this.playing) return false;
    const last = this._segments[this._segments.length - 1];
    return !last || this.ctx.currentTime >= last.when + last.frames / this.info.sampleRate;
  }

  get currentFrame() {
    if (!this.playing || !this._segments.length) return this._frame;
    const t = this.ctx.currentTime;
    const sr = this.info.sampleRate;
    let seg = this._segments[0];
    for (const s of this._segments) if (s.when <= t) seg = s;
    const offset = Math.max(0, Math.min(seg.frames, Math.round((t - seg.when) * sr)));
    return seg.frame + offset;
  }

  get currentTime() {
    return this.info ? this.currentFrame / this.info.sampleRate : 0;
  }

  async open(src) {
    this.unload();
    await this._ensureContext(src.info.sampleRate);
    this.src = src;
    this._emit();
  }

  unload() {
    this._stop();
    this.src = null;
    this._frame = 0;
    this._emit();
  }

  async play() {
    if (!this.src || this.playing) return;
    await this.ctx.resume();
    if (this._frame >= this.info.frames) this._frame = 0;
    this.playing = true;
    const epoch = ++this._epoch;
    this._abort = new AbortController();
    this._emit();
    this._pump(epoch, this._frame, this._abort.signal).catch((err) => {
      if (epoch !== this._epoch || err.name === 'AbortError') return;
      this._frame = this.currentFrame;
      this._stop();
      this._emit();
      this.dispatchEvent(new CustomEvent('error', { detail: err }));
    });
  }

  pause() {
    if (!this.playing) return;
    this._frame = this.currentFrame;
    this._stop();
    this._emit();
  }

  toggle() {
    return this.playing ? this.pause() : this.play();
  }

  seek(seconds) {
    if (!this.src) return;
    const frame = Math.round(Math.max(0, Math.min(seconds, this.duration)) * this.info.sampleRate);
    const wasPlaying = this.playing;
    this._stop();
    this._frame = frame;
    if (wasPlaying) this.play();
    else this._emit();
  }

  setLoop(on) {
    this.loop = on;
  }

  setGainDb(db) {
    this._gainDb = db;
    if (this.master) this.master.gain.setTargetAtTime(10 ** (db / 20), this.ctx.currentTime, 0.02);
  }

  setMode(mode) {
    this._mode = mode;
    if (!this.graph) return;
    const t = this.ctx.currentTime;
    this.graph.binaural.gain.setTargetAtTime(mode === 'binaural' ? 1 : 0, t, 0.02);
    this.graph.omni.gain.setTargetAtTime(mode === 'omni' ? 1 : 0, t, 0.02);
  }

  setRotation(yawDeg, pitchDeg) {
    this._yaw = yawDeg;
    this._pitch = pitchDeg;
    if (this.graph) this.graph.renderer.setRotationMatrix3(rotationMatrix(yawDeg, pitchDeg));
  }

  /** Fetch and schedule blocks until stopped, keeping AHEAD_SECONDS queued. */
  async _pump(epoch, startFrame, signal) {
    const { sampleRate: sr, frames: total, channels } = this.info;
    const blockFrames = Math.round(BLOCK_SECONDS * sr);
    const fetchBlock = (frame) => {
      const count = Math.min(blockFrames, total - frame);
      const data = this._read(frame, count, signal);
      data.catch(() => {}); // a stop aborts prefetches nobody awaits
      return { frame, count, data };
    };
    let next = fetchBlock(startFrame);

    while (epoch === this._epoch) {
      const last = this._segments[this._segments.length - 1];
      const queuedUntil = last ? last.when + last.frames / sr : 0;
      if (last && queuedUntil - this.ctx.currentTime > AHEAD_SECONDS) {
        await sleep(200);
        this._dropFinished();
        continue;
      }
      if (!next) {
        // End of file: let the queue play out, then stop.
        while (epoch === this._epoch && this.ctx.currentTime < queuedUntil) await sleep(100);
        if (epoch !== this._epoch) return;
        this._frame = total;
        this._stop();
        this._emit();
        return;
      }

      const block = next;
      const data = await block.data;
      if (epoch !== this._epoch) return;
      // Fetch the following block while this one is scheduled.
      const after = block.frame + block.count;
      next = after < total ? fetchBlock(after) : this.loop ? fetchBlock(0) : null;

      const buffer = this.ctx.createBuffer(channels, block.count, sr);
      decodePcm(data, this.info, block.count).forEach((ch, i) => buffer.copyToChannel(ch, i));
      const node = this.ctx.createBufferSource();
      node.buffer = buffer;
      // Non-FOA files (mono/stereo) bypass the renderer and play as they are.
      node.connect(this.isFoa ? this.graph.input : this.master);
      const now = this.ctx.currentTime;
      // Join seamlessly, or restart a little ahead after a stall.
      const when = last && queuedUntil > now + 0.01 ? queuedUntil : now + START_DELAY;
      node.start(when);
      this._segments.push({ when, frame: block.frame, frames: block.count, node });
      this._emit();
    }
  }

  _read(frame, count, signal) {
    const { dataOffset, blockAlign } = this.info;
    return this.src.read(dataOffset + frame * blockAlign, count * blockAlign, signal);
  }

  _dropFinished() {
    const t = this.ctx.currentTime;
    const sr = this.info.sampleRate;
    while (this._segments.length > 1 && this._segments[0].when + this._segments[0].frames / sr < t) {
      this._segments.shift();
    }
  }

  _stop() {
    this._epoch++;
    this._abort?.abort();
    for (const s of this._segments) {
      try { s.node.stop(); } catch { /* not started */ }
      s.node.disconnect();
    }
    this._segments = [];
    this.playing = false;
  }

  /**
   * Smoothed direction of arrival from the pseudo-intensity vector
   * I = <W·(X, Y, Z)>, in the scene's own frame. `directness` is
   * |I| / E (1 for a single plane wave, ~0 for a diffuse field).
   */
  readDirection() {
    if (!this.playing || !this.isFoa || this.buffering) {
      this._energy *= 0.85;
      return null;
    }
    const [w, y, z, x] = this._scratch;
    this.analysers.forEach((a, i) => a.getFloatTimeDomainData(this._scratch[i]));
    let ix = 0, iy = 0, iz = 0, e = 0;
    for (let n = 0; n < w.length; n++) {
      ix += w[n] * x[n];
      iy += w[n] * y[n];
      iz += w[n] * z[n];
      e += 0.5 * (w[n] * w[n] + x[n] * x[n] + y[n] * y[n] + z[n] * z[n]);
    }
    const k = 0.25;
    const I = this._intensity;
    I[0] += k * (ix - I[0]);
    I[1] += k * (iy - I[1]);
    I[2] += k * (iz - I[2]);
    this._energy += k * (e - this._energy);
    const norm = Math.hypot(I[0], I[1], I[2]);
    const meanSquare = (2 * this._energy) / (w.length * 4);
    return {
      azimuth: Math.atan2(I[1], I[0]) / DEG,
      elevation: Math.atan2(I[2], Math.hypot(I[0], I[1])) / DEG,
      directness: this._energy > 0 ? Math.min(1, norm / this._energy) : 0,
      levelDb: 10 * Math.log10(meanSquare + 1e-12),
    };
  }

  _emit() {
    this.dispatchEvent(new Event('change'));
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
