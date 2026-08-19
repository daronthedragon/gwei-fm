import type { BlockNote } from './chain.js'
import { CADENCES, MODES, deriveStyle, type Instrument, type Style } from './style.js'

/**
 * The composer. Given blocks and the style the chain chose for them, decide
 * every note. The chain still decides everything; it now decides the genre
 * too (see style.ts), and each block's transaction mix colours its own beat.
 */

export interface Score {
  events: NoteEvent[]
  duration: number
  style: Style
  sections: Section[]
}

export interface Section {
  start: number
  end: number
  chord: string
  intensity: number
  firstBlock: number
}

export interface NoteEvent {
  at: number
  length: number
  frequency: number
  velocity: number
  instrument: Instrument
  /** Which layer this is, for counting and for the image. */
  role: Role
  /** -1 left .. 1 right */
  pan: number
  /** 0..1, instrument-specific colour (filter cutoff, FM depth, etc). */
  colour: number
  blockNumber: number
}

export type Role = 'lead' | 'arp' | 'pad' | 'bass' | 'sub' | 'kick' | 'snare' | 'hat' | 'accent'

const DEGREE_NAMES = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii']

export const midiToHz = (midi: number): number => 440 * 2 ** ((midi - 69) / 12)

export function degreeToMidi(root: number, mode: number[], d: number): number {
  const degree = Math.round(d)
  const octave = Math.floor(degree / mode.length)
  const idx = ((degree % mode.length) + mode.length) % mode.length
  return root + octave * 12 + (mode[idx] as number)
}

function rank(values: number[]): (v: number) => number {
  const sorted = [...values].sort((a, b) => a - b)
  return (v: number) => {
    if (sorted.length < 2) return 0.5
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if ((sorted[mid] as number) < v) lo = mid + 1
      else hi = mid
    }
    return lo / (sorted.length - 1)
  }
}

const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? 0
}

/** Bars per harmonic section. */
const BARS_PER_SECTION = 2

export interface ComposeOptions {
  /** Override the chain-derived style, for tests. */
  style?: Style
}

export function compose(blocks: BlockNote[], opts: ComposeOptions = {}): Score {
  const style = opts.style ?? deriveStyle(blocks)
  if (blocks.length === 0) return { events: [], duration: 0, style, sections: [] }

  const root = style.rootMidi
  const mode = MODES[style.mode]
  const cadence = CADENCES[style.mode]
  const BAR = style.beatsPerBar
  const SECTION = BAR * BARS_PER_SECTION

  const feeRank = rank(blocks.map((b) => b.baseFeeGwei))
  const txRank = rank(blocks.map((b) => b.txCount))
  const fullRank = rank(blocks.map((b) => b.fullness))
  const blobRank = rank(blocks.map((b) => b.blobGasUsed))
  const medianInterval = median(blocks.map((b) => b.interval))

  // ---- Intensity ----------------------------------------------------------
  const fees = blocks.map((b) => b.baseFeeGwei)
  const feeLo = Math.max(1e-6, Math.min(...fees))
  const feeHi = Math.max(1e-6, Math.max(...fees))
  const feeSwing = Math.min(1, Math.log2(feeHi / feeLo) / Math.log2(10))
  const raw = blocks.map((b) => 0.5 * feeRank(b.baseFeeGwei) * feeSwing + 0.3 * b.fullness + 0.2 * txRank(b.txCount))
  const smooth = (span: number) =>
    raw.map((_, i) => {
      const w = raw.slice(Math.max(0, i - span + 1), i + 1)
      return w.reduce((s, v) => s + v, 0) / w.length
    })
  const smoothed = smooth(SECTION)
  const pulseRaw = smooth(3)
  const lo = Math.min(...smoothed)
  const hi = Math.max(...smoothed)
  const MEANINGFUL = 0.25
  const span = hi - lo
  const stretch = (v: number) => (span < 1e-9 ? 0.2 : ((v - lo) / span) * Math.min(1, span / MEANINGFUL))
  const intensity = smoothed.map(stretch)
  const pulse = pulseRaw.map(stretch)

  // ---- Per-block colour: what the block was *doing* ------------------------
  // Share of each kind of activity in the block, so a block full of swaps
  // sounds different from a block full of plain sends even at equal volume.
  const share = (b: BlockNote) => {
    const t = b.tx
    const total = Math.max(1, t.transfers + t.tokenTransfers + t.swaps + t.creates + t.blobs + t.setCode + t.other)
    return { swaps: t.swaps / total, transfers: t.transfers / total, tokens: t.tokenTransfers / total, creates: t.creates, blobs: t.blobs }
  }

  const events: NoteEvent[] = []
  const sections: Section[] = []
  let clock = 0

  // Swing: every other subdivision is pushed late by the swing amount.
  const swung = (base: number, beat: number, sub: number, of: number) =>
    base + (beat * sub) / of + (sub % 2 === 1 ? beat * style.swing * (1 / of) : 0)

  // ---- Motif --------------------------------------------------------------
  // A short melodic cell is derived from the seed once, then the lead plays
  // it, transposes it, inverts it as intensity changes. Real melodies repeat.
  const motifRng = seedRng(style.seed)
  const motif = Array.from({ length: 4 }, () => Math.floor(motifRng() * 5) - 2) // steps in -2..2
  let leadDegree = 7
  let lastLeadAt = -Infinity
  let motifPos = 0

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as BlockNote
    const beat = style.secondsPerBeat * Math.min(2, Math.max(0.5, b.interval / medianInterval))
    const inten = intensity[i] as number
    const fast = pulse[i] as number
    const beatInBar = i % BAR
    const sectionStart = i % SECTION === 0
    const colour = share(b)

    // Arrangement tiers scaled by the style's busyness: a swap-heavy range
    // brings drums in sooner, a rollup range holds them back.
    const drumsIn = inten > 0.45 - style.busyness * 0.25
    const fullKit = inten > 0.8 - style.busyness * 0.25

    // ---- Harmony ----------------------------------------------------------
    const sectionIdx = Math.floor(i / SECTION)
    const reach = 2 + Math.round(inten * (cadence.length - 2))
    const chordDegree = cadence[sectionIdx % reach] as number
    const chordTones = mode.length === 5
      ? [chordDegree, chordDegree + 2, chordDegree + 4]
      : [chordDegree, chordDegree + 2, chordDegree + 4, chordDegree + 6]
    const chordName = DEGREE_NAMES[chordDegree % 7] ?? '?'

    if (sectionStart) {
      const prev = sections[sections.length - 1]
      if (prev) prev.end = clock
      sections.push({ start: clock, end: clock, chord: chordName, intensity: inten, firstBlock: b.number })

      for (let t = 0; t < 3; t++) {
        events.push({
          at: clock, length: beat * SECTION,
          frequency: midiToHz(degreeToMidi(root - 12, mode, chordTones[t % chordTones.length] as number)),
          velocity: 0.07 + 0.16 * inten, instrument: style.pad, role: 'pad',
          pan: (t - 1) * 0.55, colour: inten, blockNumber: b.number,
        })
      }

      const sectionBlobs = blocks.slice(i, i + SECTION).reduce((s, x) => s + blobRank(x.blobGasUsed), 0) / Math.min(SECTION, blocks.length - i)
      if (sectionBlobs > 0) {
        events.push({
          at: clock, length: beat * SECTION,
          frequency: midiToHz(degreeToMidi(root - 36, mode, chordDegree)),
          velocity: 0.1 + 0.2 * sectionBlobs, instrument: 'sub-bass', role: 'sub',
          pan: 0, colour: sectionBlobs, blockNumber: b.number,
        })
      }
    }

    // ---- Bass -------------------------------------------------------------
    if (beatInBar === 0 || (drumsIn && beatInBar === Math.floor(BAR / 2) && fast > 0.3)) {
      const up = beatInBar !== 0 && fast > 0.6 ? 12 : 0
      events.push({
        at: clock, length: beat * (beatInBar === 0 ? 1.6 : 0.7),
        frequency: midiToHz(degreeToMidi(root - 24, mode, chordDegree) + up),
        velocity: 0.3 + 0.45 * inten, instrument: style.bass, role: 'bass',
        pan: 0, colour: fast, blockNumber: b.number,
      })
    }
    // Acid bass gets the sixteenth-note pattern when the block is swap-heavy:
    // the DEX traffic literally drives the bassline.
    if (style.bass === 'acid-bass' && fullKit && colour.swaps > 0.15) {
      for (let s = 1; s < 4; s++) {
        events.push({
          at: swung(clock, beat, s, 4), length: beat * 0.18,
          frequency: midiToHz(degreeToMidi(root - 24, mode, chordDegree + (s === 2 ? 4 : 0))),
          velocity: 0.25 + 0.3 * colour.swaps, instrument: 'acid-bass', role: 'bass',
          pan: 0, colour: 0.5 + 0.5 * colour.swaps, blockNumber: b.number,
        })
      }
    }

    // ---- Drums ------------------------------------------------------------
    const downbeats = BAR === 3 ? [0] : BAR === 5 ? [0, 3] : BAR === 7 ? [0, 3, 5] : BAR === 6 ? [0, 3] : [0, Math.floor(BAR / 2)]
    const backbeats = BAR === 3 ? [2] : BAR === 5 ? [2, 4] : BAR === 7 ? [2, 4, 6] : BAR === 6 ? [2, 5] : [1, 3]

    if ((drumsIn && downbeats.includes(beatInBar)) || (!drumsIn && beatInBar === 0)) {
      events.push({
        at: clock, length: 0.22, frequency: 52,
        velocity: (drumsIn ? 0.55 : 0.3) + 0.4 * fullRank(b.fullness),
        instrument: style.kick, role: 'kick', pan: 0, colour: fullRank(b.fullness), blockNumber: b.number,
      })
    }
    if (drumsIn && backbeats.includes(beatInBar)) {
      events.push({
        at: clock, length: 0.2, frequency: 190, velocity: 0.3 + 0.4 * fast,
        instrument: style.snare, role: 'snare', pan: 0.08, colour: fast, blockNumber: b.number,
      })
    }
    if (fullKit && beatInBar === BAR - 1 && fast > 0.55) {
      events.push({
        at: clock + beat * 0.5, length: 0.12, frequency: 190, velocity: 0.2,
        instrument: style.snare, role: 'snare', pan: -0.12, colour: 0.3, blockNumber: b.number,
      })
    }
    const density = txRank(b.txCount)
    const subdiv = !drumsIn ? 0 : density > 0.66 ? 4 : density > 0.33 ? 2 : 1
    for (let s = 0; s < subdiv; s++) {
      const off = s % 2 === 1
      events.push({
        at: swung(clock, beat, s, subdiv), length: off ? 0.04 : 0.07, frequency: 0,
        velocity: (off ? 0.07 : 0.15) + 0.1 * fast,
        instrument: off && style.hat === 'hat-closed' && fast > 0.7 ? 'hat-open' : style.hat,
        role: 'hat', pan: off ? 0.4 : -0.25, colour: density, blockNumber: b.number,
      })
    }

    // ---- Accents from what the block did ----------------------------------
    // A contract deployment is a bell: something new exists. A set-code tx is
    // a glitch. These are rare, so they stay special.
    if (b.tx.creates > 0) {
      events.push({
        at: clock, length: beat * 2,
        frequency: midiToHz(degreeToMidi(root + 12, mode, chordTones[0] as number)),
        velocity: 0.22 + 0.1 * Math.min(3, b.tx.creates), instrument: 'fm-bell', role: 'accent',
        pan: 0.6, colour: 0.8, blockNumber: b.number,
      })
    }
    if (b.tx.setCode > 0 && fullKit) {
      events.push({
        at: clock + beat * 0.25, length: 0.06, frequency: 0, velocity: 0.18,
        instrument: 'snare-noise', role: 'accent', pan: -0.6, colour: 1, blockNumber: b.number,
      })
    }

    // ---- Arp --------------------------------------------------------------
    // Token traffic drives the arp: a block shuffling ERC-20s is a block that
    // sparkles. Only with the full kit, faded in by intensity.
    if (fullKit && (fast > 0.45 || colour.tokens > 0.3)) {
      const steps = 4
      const gain = Math.max(0, (fast - 0.45) / 0.55) * 0.6 + colour.tokens * 0.4
      for (let s = 0; s < steps; s++) {
        const tone = chordTones[(i + s) % chordTones.length] as number
        events.push({
          at: swung(clock, beat, s, steps), length: (beat / steps) * 0.8,
          frequency: midiToHz(degreeToMidi(root, mode, tone + 7)),
          velocity: (0.1 + 0.2 * gain) * (s % 2 === 0 ? 1 : 0.7),
          // The arp borrows the lead's character so the layers agree.
          instrument: style.lead === 'saw-lead' || style.lead === 'square-lead' ? 'square-lead' : style.lead === 'fm-bell' ? 'fm-bell' : 'pluck',
          role: 'arp',
          pan: Math.sin(i + s) * 0.6, colour: gain, blockNumber: b.number,
        })
      }
    }

    // ---- Lead -------------------------------------------------------------
    // The melody plays a motif, stepping toward where the fee points. Fee
    // sets the register; the motif sets the shape; fullness decides whether
    // this beat gets a note at all.
    const target = Math.round(5 + feeRank(b.baseFeeGwei) * 7 * style.melodicRange)
    const wantsToPlay = fullRank(b.fullness) > 0.35 || beatInBar === 0
    if (wantsToPlay && clock - lastLeadAt >= beat * 0.9) {
      // Motif step, then drift toward the target so the line has direction.
      const drift = Math.sign(target - leadDegree)
      const step = (motif[motifPos % motif.length] as number) + (Math.abs(target - leadDegree) > 3 ? drift : 0)
      leadDegree += Math.max(-3, Math.min(3, step))
      motifPos++
      if (beatInBar === 0) {
        const candidates = chordTones.map((t) => t + 7)
        const nearest = candidates.reduce((best, c) => (Math.abs(c - leadDegree) < Math.abs(best - leadDegree) ? c : best), candidates[0] as number)
        if (Math.abs(nearest - leadDegree) <= 1) leadDegree = nearest
      }
      // Keep the melody in a sane register.
      // The ceiling must be an integer: a fractional degree indexes off the
      // end of the mode array and the note comes out NaN.
      leadDegree = Math.max(3, Math.min(Math.round(5 + 7 * style.melodicRange + 4), leadDegree))
      const hold = beatInBar === 0 ? beat * 1.8 : beat * (0.3 + style.legato * fullRank(b.fullness))
      events.push({
        at: clock, length: hold,
        frequency: midiToHz(degreeToMidi(root, mode, leadDegree)),
        velocity: 0.2 + 0.5 * fullRank(b.fullness) * (0.4 + 0.6 * inten),
        instrument: style.lead, role: 'lead', pan: 0.15,
        // Brightness follows fullness: a full block is a bright note.
        colour: 0.3 + 0.7 * fullRank(b.fullness), blockNumber: b.number,
      })
      lastLeadAt = clock
    }

    clock += beat
  }

  const last = sections[sections.length - 1]
  if (last) last.end = clock

  return { events, duration: clock + 3, style, sections }
}

function seedRng(seedHex: string): () => number {
  let h = 2166136261
  for (let i = 2; i < seedHex.length; i++) {
    h ^= seedHex.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = (h ^ 0x9e3779b9) >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}
