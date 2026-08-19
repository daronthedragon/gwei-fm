import type { BlockNote, TxKind, TxNote } from './chain.js'
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
  /**
   * 0..1 timbre seed. For transaction notes this comes from the tx hash, so
   * no two notes are ever the identical sound. Structural voices derive it
   * from the block's RANDAO.
   */
  variant: number
  blockNumber: number
}

export type Role = 'lead' | 'tx' | 'pad' | 'bass' | 'sub' | 'kick' | 'snare' | 'hat' | 'accent'

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

/**
 * What each kind of transaction sounds like. This is fixed across every
 * piece on purpose: a swap is always the acid family, a plain send is always
 * a pluck, a deploy is always the big bell. Learn the vocabulary once and
 * you can hear what a block was doing in any render. The style then chooses
 * the register and the room, and the tx hash makes each note one of a kind.
 */
const KIND_INSTRUMENT: Record<TxKind, Instrument> = {
  swap: 'acid-bass',
  transfer: 'pluck',
  token: 'sine-lead',
  deploy: 'fm-bell',
  blob: 'sub-bass',
  setCode: 'snare-noise',
  other: 'square-lead',
}

/** How loud a transaction is: ETH moved, or requested work for value-less calls. */
function salienceVelocity(t: TxNote): number {
  if (t.valueEth > 0) {
    // log scale: 0.01 ETH ~ 0.25, 1 ETH ~ 0.45, 100 ETH ~ 0.65
    return Math.max(0.15, Math.min(0.7, 0.45 + 0.1 * Math.log10(Math.max(1e-4, t.valueEth))))
  }
  return Math.max(0.12, Math.min(0.5, 0.1 + 0.08 * Math.log10(t.gasLimit)))
}

/**
 * Pitch of a transaction: its value on a log scale, snapped to the current
 * chord so the block's traffic plays the harmony. Small sends sit low,
 * whale moves ring high. Value-less calls pitch by requested gas instead.
 */
function txDegree(t: TxNote, chordTones: number[], variant: number): number {
  const magnitude = t.valueEth > 0
    ? Math.max(0, Math.min(1, (Math.log10(Math.max(1e-4, t.valueEth)) + 4) / 7))
    : Math.max(0, Math.min(1, (Math.log10(t.gasLimit) - 4.3) / 2.5))
  const octave = Math.floor(magnitude * 3) * 7 // three octaves of room
  const tone = chordTones[Math.floor(variant * chordTones.length) % chordTones.length] as number
  return tone + 7 + octave
}

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


  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i] as BlockNote
    const beat = style.secondsPerBeat * Math.min(2, Math.max(0.5, b.interval / medianInterval))
    const inten = intensity[i] as number
    const fast = pulse[i] as number
    const beatInBar = i % BAR
    const sectionStart = i % SECTION === 0
    const colour = share(b)
    // Structural voices vary per block too: seeded by this block's RANDAO.
    const blockVariant = hashTo01(b.mixHash)

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
          pan: (t - 1) * 0.55, colour: inten, variant: blockVariant, blockNumber: b.number,
        })
      }

      const sectionBlobs = blocks.slice(i, i + SECTION).reduce((s, x) => s + blobRank(x.blobGasUsed), 0) / Math.min(SECTION, blocks.length - i)
      if (sectionBlobs > 0) {
        events.push({
          at: clock, length: beat * SECTION,
          frequency: midiToHz(degreeToMidi(root - 36, mode, chordDegree)),
          velocity: 0.1 + 0.2 * sectionBlobs, instrument: 'sub-bass', role: 'sub',
          pan: 0, colour: sectionBlobs, variant: blockVariant, blockNumber: b.number,
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
        pan: 0, colour: fast, variant: blockVariant, blockNumber: b.number,
      })
    }
    // ---- Drums ------------------------------------------------------------
    const downbeats = BAR === 3 ? [0] : BAR === 5 ? [0, 3] : BAR === 7 ? [0, 3, 5] : BAR === 6 ? [0, 3] : [0, Math.floor(BAR / 2)]
    const backbeats = BAR === 3 ? [2] : BAR === 5 ? [2, 4] : BAR === 7 ? [2, 4, 6] : BAR === 6 ? [2, 5] : [1, 3]

    if ((drumsIn && downbeats.includes(beatInBar)) || (!drumsIn && beatInBar === 0)) {
      events.push({
        at: clock, length: 0.22, frequency: 52,
        velocity: (drumsIn ? 0.55 : 0.3) + 0.4 * fullRank(b.fullness),
        instrument: style.kick, role: 'kick', pan: 0, colour: fullRank(b.fullness),
        variant: blockVariant, blockNumber: b.number,
      })
    }
    if (drumsIn && backbeats.includes(beatInBar)) {
      events.push({
        at: clock, length: 0.2, frequency: 190, velocity: 0.3 + 0.4 * fast,
        instrument: style.snare, role: 'snare', pan: 0.08, colour: fast,
        variant: blockVariant, blockNumber: b.number,
      })
    }
    if (fullKit && beatInBar === BAR - 1 && fast > 0.55) {
      events.push({
        at: clock + beat * 0.5, length: 0.12, frequency: 190, velocity: 0.2,
        instrument: style.snare, role: 'snare', pan: -0.12, colour: 0.3,
        variant: blockVariant, blockNumber: b.number,
      })
    }
    const density = txRank(b.txCount)
    const subdiv = !drumsIn ? 0 : density > 0.66 ? 4 : density > 0.33 ? 2 : 1
    for (let sd = 0; sd < subdiv; sd++) {
      const off = sd % 2 === 1
      events.push({
        at: swung(clock, beat, sd, subdiv), length: off ? 0.04 : 0.07, frequency: 0,
        velocity: (off ? 0.07 : 0.15) + 0.1 * fast,
        instrument: off && style.hat === 'hat-closed' && fast > 0.7 ? 'hat-open' : style.hat,
        role: 'hat', pan: off ? 0.4 : -0.25, colour: density,
        variant: blockVariant, blockNumber: b.number,
      })
    }

    // ---- The transactions themselves --------------------------------------
    // Every pitched foreground note IS a transaction. Pitch is its value on
    // a log scale snapped to the current chord; where it lands in the beat is
    // where it sat in the block; its kind decides the instrument family; its
    // hash makes the exact timbre one of a kind. The biggest transaction of
    // the block is the lead voice, held longer and brighter; the rest are
    // the texture behind it.
    const audibleTxs = drumsIn ? b.notable : b.notable.slice(0, 2)
    let leadDone = false
    for (const t of audibleTxs) {
      const isLead = !leadDone && (t.valueEth > 0 || t.kind === 'deploy')
      const degree = txDegree(t, chordTones, t.variant)
      const at = isLead ? clock : swung(clock, beat, Math.round(t.position * 7), 8)
      const baseVelocity = salienceVelocity(t)
      const velocity = isLead
        ? baseVelocity * (0.7 + 0.5 * inten)
        : baseVelocity * (0.35 + 0.4 * fast)
      const length = isLead
        ? beat * (0.6 + style.legato * fullRank(b.fullness))
        : t.kind === 'deploy' ? beat * 2 : beat * 0.22

      events.push({
        at,
        length,
        // setCode is unpitched: a glitch, not a note.
        frequency: t.kind === 'setCode' ? 0 : midiToHz(degreeToMidi(root, mode, degree)),
        velocity,
        // The lead borrows the style's voice so each piece keeps its own
        // colour; the texture speaks the fixed kind-vocabulary.
        instrument: isLead && t.kind !== 'deploy' && t.kind !== 'setCode' ? style.lead : KIND_INSTRUMENT[t.kind],
        role: isLead ? 'lead' : 'tx',
        pan: (t.position - 0.5) * 1.2,
        colour: 0.3 + 0.7 * fullRank(b.fullness),
        variant: t.variant,
        blockNumber: b.number,
      })
      if (isLead) leadDone = true
    }

    clock += beat
  }

  const last = sections[sections.length - 1]
  if (last) last.end = clock

  return { events, duration: clock + 3, style, sections }
}

function hashTo01(hex: string): number {
  let h = 2166136261
  for (let i = 2; i < Math.min(hex.length, 34); i++) {
    h ^= hex.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 0x1_0000_0000
}
