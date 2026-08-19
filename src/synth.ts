import type { NoteEvent, Score } from './music.js'
import type { Instrument } from './style.js'

export const SAMPLE_RATE = 44_100

interface Envelope {
  attack: number
  decay: number
  sustain: number
  release: number
}

/** One envelope per instrument family. */
const ENVELOPES: Record<Instrument, Envelope> = {
  'saw-lead': { attack: 0.015, decay: 0.25, sustain: 0.6, release: 0.35 },
  'sine-lead': { attack: 0.03, decay: 0.3, sustain: 0.7, release: 0.5 },
  'square-lead': { attack: 0.005, decay: 0.15, sustain: 0.5, release: 0.2 },
  'fm-bell': { attack: 0.002, decay: 0.6, sustain: 0.1, release: 1.2 },
  pluck: { attack: 0.002, decay: 0.18, sustain: 0.05, release: 0.15 },
  'warm-pad': { attack: 1.2, decay: 0.8, sustain: 0.85, release: 2.0 },
  'glass-pad': { attack: 0.8, decay: 1.0, sustain: 0.7, release: 2.5 },
  'choir-pad': { attack: 2.0, decay: 1.0, sustain: 0.9, release: 3.0 },
  organ: { attack: 0.01, decay: 0.05, sustain: 1.0, release: 0.08 },
  'sub-bass': { attack: 1.5, decay: 0.5, sustain: 0.9, release: 2.5 },
  'saw-bass': { attack: 0.008, decay: 0.25, sustain: 0.6, release: 0.25 },
  'acid-bass': { attack: 0.003, decay: 0.2, sustain: 0.3, release: 0.1 },
  'pluck-bass': { attack: 0.003, decay: 0.3, sustain: 0.2, release: 0.2 },
  'kick-soft': { attack: 0.001, decay: 0.25, sustain: 0, release: 0.05 },
  'kick-hard': { attack: 0.001, decay: 0.18, sustain: 0, release: 0.04 },
  'kick-808': { attack: 0.001, decay: 0.6, sustain: 0, release: 0.2 },
  'snare-tight': { attack: 0.001, decay: 0.12, sustain: 0, release: 0.05 },
  'snare-clap': { attack: 0.001, decay: 0.2, sustain: 0, release: 0.1 },
  'snare-noise': { attack: 0.001, decay: 0.25, sustain: 0, release: 0.1 },
  'hat-closed': { attack: 0.001, decay: 0.03, sustain: 0, release: 0.03 },
  'hat-open': { attack: 0.001, decay: 0.18, sustain: 0, release: 0.15 },
  shaker: { attack: 0.004, decay: 0.06, sustain: 0, release: 0.05 },
}

function envelope(env: Envelope, t: number, length: number): number {
  if (t < 0) return 0
  if (t < env.attack) return t / env.attack
  if (t < env.attack + env.decay) {
    const p = (t - env.attack) / env.decay
    return env.sustain + (1 - env.sustain) * (1 - p) * (1 - p)
  }
  if (t < length) return env.sustain
  const r = (t - length) / env.release
  return r >= 1 ? 0 : env.sustain * (1 - r) * (1 - r)
}

function lcg(seed: number): () => number {
  let state = seed >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function saw(phase: number, harmonics: number): number {
  let v = 0
  for (let n = 1; n <= harmonics; n++) v += Math.sin(n * phase) / n
  return v * (2 / Math.PI)
}

function square(phase: number, harmonics: number): number {
  let v = 0
  for (let n = 1; n <= harmonics; n += 2) v += Math.sin(n * phase) / n
  return v * (4 / Math.PI)
}

class OnePole {
  private y = 0
  constructor(private coeff: number) {}
  set(cutoffHz: number): void {
    this.coeff = 1 - Math.exp((-2 * Math.PI * cutoffHz) / SAMPLE_RATE)
  }
  step(x: number): number {
    this.y += this.coeff * (x - this.y)
    return this.y
  }
}

/** A resonant two-pole, for the acid bass. State-variable form. */
class Resonant {
  private low = 0
  private band = 0
  step(x: number, cutoffHz: number, q: number): number {
    const f = 2 * Math.sin((Math.PI * Math.min(cutoffHz, 12_000)) / SAMPLE_RATE)
    const high = x - this.low - q * this.band
    this.band += f * high
    this.low += f * this.band
    return this.low
  }
}

const lp = (hz: number): OnePole => {
  const f = new OnePole(0)
  f.set(hz)
  return f
}

/**
 * Render one event. Each instrument is its own small synthesis recipe, and
 * `colour` (0..1, set by the composer from the block data) steers whatever
 * that recipe's most characterful parameter is: filter cutoff, FM depth,
 * detune, noise mix.
 */
function renderEvent(ev: NoteEvent, left: Float32Array, right: Float32Array, noise: () => number): void {
  const env = ENVELOPES[ev.instrument]
  const start = Math.floor(ev.at * SAMPLE_RATE)
  const count = Math.min(left.length - start, Math.ceil((ev.length + env.release) * SAMPLE_RATE))
  if (count <= 0) return

  const angle = ((ev.pan + 1) / 2) * (Math.PI / 2)
  const gl = Math.cos(angle)
  const gr = Math.sin(angle)
  const c = ev.colour

  // Per-note filter state.
  let filter: OnePole | null = null
  let resonant: Resonant | null = null
  switch (ev.instrument) {
    case 'saw-lead': filter = lp(1200 + 3000 * c); break
    case 'square-lead': filter = lp(900 + 2500 * c); break
    case 'warm-pad': filter = lp(700 + 500 * c); break
    case 'glass-pad': filter = lp(2500); break
    case 'choir-pad': filter = lp(1100); break
    case 'organ': filter = lp(3500); break
    case 'saw-bass': filter = lp(350 + 250 * c); break
    case 'pluck-bass': filter = lp(600); break
    case 'acid-bass': resonant = new Resonant(); break
    case 'snare-tight': filter = lp(5000); break
    case 'snare-clap': filter = lp(3000); break
    case 'snare-noise': filter = lp(7000); break
    default: break
  }

  for (let i = 0; i < count; i++) {
    const t = i / SAMPLE_RATE
    const amp = envelope(env, t, ev.length) * ev.velocity
    if (amp <= 0) continue

    const phase = 2 * Math.PI * ev.frequency * t
    let s: number

    switch (ev.instrument) {
      // ---- leads ----
      case 'saw-lead': s = saw(phase, 12) * 0.55 + saw(phase * 1.004, 12) * 0.45; break
      case 'sine-lead': s = Math.sin(phase) * 0.85 + Math.sin(2 * phase) * 0.15 * c; break
      case 'square-lead': s = square(phase, 9) * 0.7 + square(phase * 1.006, 9) * 0.3; break
      case 'fm-bell': {
        // 2-op FM, ratio 3.5:1, index decays. Colour sets the index.
        const index = (1.5 + 4 * c) * Math.exp(-t * 3)
        s = Math.sin(phase + index * Math.sin(phase * 3.5))
        break
      }
      case 'pluck': {
        // Bright start that darkens: square blended toward sine over time.
        const bright = Math.exp(-t * 18)
        s = square(phase, 7) * bright * 0.5 + Math.sin(phase) * (1 - bright * 0.5)
        break
      }
      // ---- pads ----
      case 'warm-pad': s = (saw(phase, 10) + saw(phase * 1.006, 10) + saw(phase * 0.994, 10)) / 3; break
      case 'glass-pad': {
        // Sine cluster with octave and fifth, slow vibrato.
        const vib = 1 + 0.003 * Math.sin(2 * Math.PI * 5 * t)
        s = (Math.sin(phase * vib) + 0.5 * Math.sin(2 * phase * vib) + 0.3 * Math.sin(3 * phase * vib)) / 1.8
        break
      }
      case 'choir-pad': {
        // Formant-ish: fundamental plus two broad resonances.
        s = (Math.sin(phase) + 0.6 * Math.sin(phase * 2.01) + 0.35 * Math.sin(phase * 3.98) + 0.25 * Math.sin(phase * 5.02)) / 2.2
        break
      }
      case 'organ': {
        // Drawbars: 16', 8', 4', 2 2/3', 2'.
        s = (0.8 * Math.sin(phase * 0.5) + Math.sin(phase) + 0.6 * Math.sin(2 * phase) + 0.4 * Math.sin(3 * phase) + 0.3 * Math.sin(4 * phase)) / 3.1
        break
      }
      // ---- basses ----
      case 'sub-bass': s = Math.sin(phase); break
      case 'saw-bass': s = saw(phase, 8) * 0.6 + Math.sin(phase) * 0.4; break
      case 'acid-bass': {
        // The 303 move: saw through a resonant filter whose cutoff sweeps
        // down over the note, starting higher when the colour is hot.
        const cutoff = (250 + 2600 * c) * Math.exp(-t * 10) + 120
        s = (resonant as Resonant).step(saw(phase, 16), cutoff, 0.35)
        break
      }
      case 'pluck-bass': s = Math.sin(phase) * 0.7 + saw(phase, 5) * 0.3 * Math.exp(-t * 12); break
      // ---- drums ----
      case 'kick-soft': {
        const sweep = ev.frequency + 90 * Math.exp(-t * 40)
        s = Math.sin(2 * Math.PI * sweep * t)
        break
      }
      case 'kick-hard': {
        const sweep = ev.frequency + 160 * Math.exp(-t * 45)
        s = Math.sin(2 * Math.PI * sweep * t) * 0.9 + (t < 0.005 ? (noise() * 2 - 1) * 0.6 : 0)
        break
      }
      case 'kick-808': {
        const sweep = ev.frequency * 0.9 + 60 * Math.exp(-t * 25)
        s = Math.tanh(Math.sin(2 * Math.PI * sweep * t) * 1.6)
        break
      }
      case 'snare-tight': s = Math.sin(phase) * Math.exp(-t * 35) * 0.45 + (noise() * 2 - 1) * 0.65; break
      case 'snare-clap': {
        // Three quick noise bursts then a tail.
        const burst = t < 0.03 ? 1 : t < 0.04 ? 0.2 : t < 0.06 ? 0.9 : t < 0.07 ? 0.2 : t < 0.09 ? 0.8 : 0.5
        s = (noise() * 2 - 1) * burst
        break
      }
      case 'snare-noise': s = (noise() * 2 - 1); break
      case 'hat-closed': s = (noise() - noise()) * 1.2; break
      case 'hat-open': s = (noise() - noise()) * 1.0; break
      case 'shaker': {
        // Softer, band-limited-ish noise with a quick swell.
        const swell = Math.min(1, t / 0.008)
        s = (noise() - noise()) * 0.7 * swell
        break
      }
    }

    if (filter) s = filter.step(s)

    const v = s * amp
    left[start + i] = (left[start + i] as number) + v * gl
    right[start + i] = (right[start + i] as number) + v * gr
  }
}

/** Schroeder reverb. `size` 0..1 scales delay lengths and feedback. */
function reverb(input: Float32Array, mix: number, size: number, seedOffset: number): Float32Array<ArrayBuffer> {
  const scale = 0.7 + size * 0.9
  const combDelays = [1557, 1617, 1491, 1422].map((d) => Math.round(d * scale) + seedOffset)
  const allpassDelays = [225, 556]
  const feedback = 0.7 + size * 0.15
  const damp = 0.25

  const combs = combDelays.map((d) => ({ buf: new Float32Array(d), idx: 0, filt: 0 }))
  const allpasses = allpassDelays.map((d) => ({ buf: new Float32Array(d), idx: 0 }))
  const out = new Float32Array<ArrayBuffer>(new ArrayBuffer(input.length * 4))

  for (let i = 0; i < input.length; i++) {
    const x = input[i] as number
    let wet = 0
    for (const c of combs) {
      const y = c.buf[c.idx] as number
      c.filt = y * (1 - damp) + c.filt * damp
      c.buf[c.idx] = x + c.filt * feedback
      c.idx = (c.idx + 1) % c.buf.length
      wet += y
    }
    wet /= combs.length
    for (const a of allpasses) {
      const buffered = a.buf[a.idx] as number
      const y = -wet + buffered
      a.buf[a.idx] = wet + buffered * 0.5
      a.idx = (a.idx + 1) % a.buf.length
      wet = y
    }
    out[i] = x * (1 - mix) + wet * mix
  }
  return out
}

export interface Stereo {
  left: Float32Array
  right: Float32Array
}

export function render(score: Score): Stereo {
  const total = Math.ceil(score.duration * SAMPLE_RATE)
  let left = new Float32Array<ArrayBuffer>(new ArrayBuffer(total * 4))
  let right = new Float32Array<ArrayBuffer>(new ArrayBuffer(total * 4))
  const noise = lcg(0x5eed)

  for (const ev of score.events) renderEvent(ev, left, right, noise)

  const rv = score.style.reverb
  left = reverb(left, 0.1 + rv * 0.35, rv, 0)
  right = reverb(right, 0.1 + rv * 0.35, rv, 23)

  let peak = 0
  for (let i = 0; i < total; i++) {
    const l = Math.tanh((left[i] as number) * 0.85)
    const r = Math.tanh((right[i] as number) * 0.85)
    left[i] = l
    right[i] = r
    peak = Math.max(peak, Math.abs(l), Math.abs(r))
  }
  if (peak > 0) {
    const gain = 0.89 / peak
    for (let i = 0; i < total; i++) {
      left[i] = (left[i] as number) * gain
      right[i] = (right[i] as number) * gain
    }
  }
  return { left, right }
}

export function encodeWav(audio: Stereo, sampleRate = SAMPLE_RATE): Buffer {
  const frames = audio.left.length
  const blockAlign = 4
  const dataSize = frames * blockAlign
  const buffer = Buffer.alloc(44 + dataSize)
  buffer.write('RIFF', 0)
  buffer.writeUInt32LE(36 + dataSize, 4)
  buffer.write('WAVE', 8)
  buffer.write('fmt ', 12)
  buffer.writeUInt32LE(16, 16)
  buffer.writeUInt16LE(1, 20)
  buffer.writeUInt16LE(2, 22)
  buffer.writeUInt32LE(sampleRate, 24)
  buffer.writeUInt32LE(sampleRate * blockAlign, 28)
  buffer.writeUInt16LE(blockAlign, 32)
  buffer.writeUInt16LE(16, 34)
  buffer.write('data', 36)
  buffer.writeUInt32LE(dataSize, 40)
  let offset = 44
  for (let i = 0; i < frames; i++) {
    const l = Math.max(-1, Math.min(1, audio.left[i] as number))
    const r = Math.max(-1, Math.min(1, audio.right[i] as number))
    buffer.writeInt16LE(Math.round(l * 32767), offset)
    buffer.writeInt16LE(Math.round(r * 32767), offset + 2)
    offset += 4
  }
  return buffer
}

export function toMono(audio: Stereo): Float32Array {
  const out = new Float32Array(audio.left.length)
  for (let i = 0; i < out.length; i++) out[i] = ((audio.left[i] as number) + (audio.right[i] as number)) / 2
  return out
}

export function roleCounts(score: Score): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const ev of score.events) counts[ev.role] = (counts[ev.role] ?? 0) + 1
  return counts
}
