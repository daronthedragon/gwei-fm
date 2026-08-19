import type { BlockNote } from './chain.js'

/**
 * The chain picks the style.
 *
 * Nothing here is a preset the user chooses. Every knob below is read off the
 * blocks themselves: the opening block's RANDAO reveal seeds the key and the
 * feel, the builder who dominated the range sets the tempo, the spread of
 * fees sets the mode, and what the transactions actually did sets the
 * palette of instruments. Two ranges with different personalities get two
 * different genres. The same range always gets the same one.
 */

export type ModeName = 'minor' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'major' | 'harmonicMinor' | 'pentatonicMinor' | 'whole'

export const MODES: Record<ModeName, number[]> = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  dorian: [0, 2, 3, 5, 7, 9, 10],
  phrygian: [0, 1, 3, 5, 7, 8, 10],
  lydian: [0, 2, 4, 6, 7, 9, 11],
  mixolydian: [0, 2, 4, 5, 7, 9, 10],
  major: [0, 2, 4, 5, 7, 9, 11],
  harmonicMinor: [0, 2, 3, 5, 7, 8, 11],
  pentatonicMinor: [0, 3, 5, 7, 10],
  whole: [0, 2, 4, 6, 8, 10],
}

/** Chord cycles as scale-degree roots, ordered home-outward. */
export const CADENCES: Record<ModeName, number[]> = {
  minor: [0, 5, 2, 6, 3, 4],
  dorian: [0, 3, 6, 2, 4, 1],
  phrygian: [0, 1, 6, 3, 5, 4],
  lydian: [0, 1, 4, 6, 2, 3],
  mixolydian: [0, 6, 3, 4, 1, 2],
  major: [0, 5, 3, 4, 1, 2],
  harmonicMinor: [0, 5, 3, 4, 2, 6],
  pentatonicMinor: [0, 2, 3, 1, 4],
  whole: [0, 2, 4, 1, 3, 5],
}

export const ROOT_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'] as const

/** The instrument a voice slot is rendered with. Each has its own timbre. */
export type Instrument =
  | 'saw-lead' | 'sine-lead' | 'square-lead' | 'fm-bell' | 'pluck'
  | 'warm-pad' | 'glass-pad' | 'choir-pad' | 'organ'
  | 'sub-bass' | 'saw-bass' | 'acid-bass' | 'pluck-bass'
  | 'kick-soft' | 'kick-hard' | 'kick-808'
  | 'snare-tight' | 'snare-clap' | 'snare-noise'
  | 'hat-closed' | 'hat-open' | 'shaker'

export interface Style {
  /** Human-readable label, for the summary and the image. */
  name: string
  rootMidi: number
  rootName: string
  mode: ModeName
  /** Seconds per beat. */
  secondsPerBeat: number
  bpm: number
  /** Beats per bar: 4 is straight, 3 is a waltz, 5 and 7 are odd. */
  beatsPerBar: number
  /** 0 = straight, up to ~0.33 = heavy swing on the off-beats. */
  swing: number
  /** 0 = dry, 1 = cathedral. */
  reverb: number
  /** Average lead note length as a fraction of a beat. */
  legato: number
  /** How far the melody wanders. 1 = an octave, 2 = two. */
  melodicRange: number
  /** Density knob for the whole arrangement: how readily layers enter. */
  busyness: number
  lead: Instrument
  pad: Instrument
  bass: Instrument
  kick: Instrument
  snare: Instrument
  hat: Instrument
  /** What the transactions were mostly doing. Drives per-block colour. */
  character: Character
  /** Who built most of the range. */
  builder: string
  /** The seed everything derives from, for the record. */
  seed: string
}

export type Character = 'swaps' | 'transfers' | 'tokens' | 'rollups' | 'deploys' | 'mixed'

/** A small deterministic PRNG from a hex seed. Same seed, same stream. */
export function rng(seedHex: string): () => number {
  let h = 2166136261
  for (let i = 2; i < seedHex.length; i++) {
    h ^= seedHex.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  let state = h >>> 0 || 1
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

const pick = <T>(r: () => number, items: readonly T[]): T => items[Math.floor(r() * items.length)] as T

const logSpread = (values: number[]): number => {
  const lo = Math.max(1e-9, Math.min(...values))
  const hi = Math.max(1e-9, Math.max(...values))
  return Math.log2(hi / lo)
}

export function dominantBuilder(blocks: BlockNote[]): { miner: string; tag: string; share: number } {
  const counts = new Map<string, { n: number; tag: string }>()
  for (const b of blocks) {
    const e = counts.get(b.miner) ?? { n: 0, tag: '' }
    e.n++
    if (!e.tag && b.builderTag) e.tag = b.builderTag
    counts.set(b.miner, e)
  }
  let best: { miner: string; tag: string; share: number } = { miner: '', tag: '', share: 0 }
  for (const [miner, e] of counts) {
    const share = e.n / blocks.length
    if (share > best.share) best = { miner, tag: e.tag, share }
  }
  return best
}

export function characterOf(blocks: BlockNote[]): Character {
  const sum = { swaps: 0, transfers: 0, tokens: 0, rollups: 0, deploys: 0, other: 0 }
  for (const b of blocks) {
    sum.swaps += b.tx.swaps
    sum.transfers += b.tx.transfers
    sum.tokens += b.tx.tokenTransfers
    sum.rollups += b.tx.blobs
    sum.deploys += b.tx.creates
    sum.other += b.tx.other
  }
  const total = Object.values(sum).reduce((a, v) => a + v, 0) || 1
  // Swaps and deploys are rarer per-tx than transfers, so they get a thumb
  // on the scale: a range where a fifth of calls are swaps is a swap range.
  // Plain ETH sends are the background radiation of the chain, so they are
  // discounted; what makes a stretch distinctive is what is unusually
  // present. Weights are roughly the inverse of each kind's base rate.
  const scored: [Character, number][] = [
    ['swaps', (sum.swaps / total) * 12],
    ['tokens', (sum.tokens / total) * 1.6],
    ['transfers', (sum.transfers / total) * 0.9],
    ['rollups', (sum.rollups / total) * 40],
    ['deploys', (sum.deploys / total) * 250],
  ]
  scored.sort((a, b) => b[1] - a[1])
  const [top, second] = scored
  if (!top || !second) return 'mixed'
  return top[1] > second[1] * 1.15 ? top[0] : 'mixed'
}

/**
 * Derive the style of a range from the range itself.
 *
 * The seed is the first block's mixHash: RANDAO output, which no one could
 * predict before the block landed and which will never change. It decides
 * the things that are genuinely arbitrary (which key, which feel). The
 * things that should *mean* something are read off the data directly.
 */
export function deriveStyle(blocks: BlockNote[]): Style {
  const first = blocks[0]
  const seed = first?.mixHash ?? '0x0'
  const r = rng(seed)

  const fees = blocks.map((b) => b.baseFeeGwei)
  const feeSpread = logSpread(fees) // ~0 flat, 1 = 2x, 3 = 8x
  const fullness = blocks.reduce((s, b) => s + b.fullness, 0) / Math.max(1, blocks.length)
  const builder = dominantBuilder(blocks)
  const character = characterOf(blocks)

  // ---- Key: arbitrary, so RANDAO picks it. ------------------------------
  const rootIdx = Math.floor(r() * 12)
  const rootMidi = 60 + rootIdx

  // ---- Mode: how volatile the range was decides how dark or strange. ------
  // A flat day is bright and open. A volatile day goes darker. A wild one
  // (8x+ swings) reaches for modes that sound unsettled. RANDAO breaks ties.
  let modePool: ModeName[]
  if (feeSpread < 0.6) modePool = ['major', 'lydian', 'mixolydian', 'pentatonicMinor']
  else if (feeSpread < 1.8) modePool = ['dorian', 'minor', 'mixolydian']
  else if (feeSpread < 3.2) modePool = ['minor', 'harmonicMinor', 'phrygian']
  else modePool = ['phrygian', 'harmonicMinor', 'whole']
  const mode = pick(r, modePool)

  // ---- Tempo: how hard the chain was working. -----------------------------
  // Average fullness picks the band (a half-empty chain ambles, a packed one
  // drives), fee volatility pushes faster within it, and RANDAO adds a few
  // BPM of character so two similar ranges do not tick identically.
  const band = fullness < 0.4 ? 70 : fullness < 0.55 ? 84 : fullness < 0.7 ? 98 : 112
  const bpm = band + Math.round(Math.min(1, feeSpread / 3) * 14) + Math.floor(r() * 9)
  const secondsPerBeat = 60 / bpm

  // ---- Meter: mostly 4, sometimes 3, rarely odd. Deploy-heavy ranges
  // (builders shipping) get the odd meters; it suits them.
  const meterRoll = r()
  const beatsPerBar =
    character === 'deploys' && meterRoll < 0.5 ? pick(r, [5, 7] as const)
    : meterRoll < 0.12 ? 3
    : meterRoll < 0.17 ? 6
    : 4

  // ---- Feel: swing comes from how unevenly blocks arrived. A range with
  // many late blocks swings; a metronomic one is straight.
  const lateShare = blocks.filter((b) => b.interval > 12).length / Math.max(1, blocks.length)
  const swing = Math.min(0.33, lateShare * 1.4 + (character === 'swaps' ? 0.08 : 0))

  // ---- Space: rollup-heavy ranges are big and washy (the L2s are far away);
  // transfer-heavy ones are dry and close.
  const reverb =
    character === 'rollups' ? 0.45 + r() * 0.25
    : character === 'transfers' ? 0.08 + r() * 0.1
    : 0.18 + r() * 0.2

  // ---- Instruments by character. -----------------------------------------
  // This is where a swap-heavy hour and a transfer-heavy hour stop sounding
  // like the same band. Each character has a palette; RANDAO picks inside it.
  type Kit = { lead: Instrument[]; pad: Instrument[]; bass: Instrument[]; kick: Instrument[]; snare: Instrument[]; hat: Instrument[] }
  const KITS: Record<Character, Kit> = {
    // DEX traffic: bright, busy, electronic. Acid bass, square lead, tight drums.
    swaps: { lead: ['square-lead', 'saw-lead', 'pluck'], pad: ['glass-pad', 'warm-pad'], bass: ['acid-bass', 'saw-bass'], kick: ['kick-hard', 'kick-808'], snare: ['snare-clap', 'snare-tight'], hat: ['hat-closed', 'hat-open'] },
    // Plain ETH sends: sparse, human, acoustic-ish. Plucks, soft kicks, shaker.
    transfers: { lead: ['pluck', 'sine-lead', 'fm-bell'], pad: ['warm-pad', 'choir-pad'], bass: ['pluck-bass', 'sub-bass'], kick: ['kick-soft'], snare: ['snare-tight'], hat: ['shaker', 'hat-closed'] },
    // ERC-20 shuffling: mid-energy, groovy. Organ, saw bass, clap.
    tokens: { lead: ['saw-lead', 'fm-bell', 'organ'], pad: ['organ', 'warm-pad'], bass: ['saw-bass', 'pluck-bass'], kick: ['kick-soft', 'kick-hard'], snare: ['snare-clap', 'snare-noise'], hat: ['hat-closed', 'shaker'] },
    // Blob batches: vast, slow, ambient. Choir pads, sub, soft everything.
    rollups: { lead: ['sine-lead', 'fm-bell'], pad: ['choir-pad', 'glass-pad'], bass: ['sub-bass'], kick: ['kick-808', 'kick-soft'], snare: ['snare-noise'], hat: ['hat-open', 'shaker'] },
    // Contract deployments: industrial, odd. Square lead, acid, noise snare.
    deploys: { lead: ['square-lead', 'fm-bell'], pad: ['glass-pad', 'organ'], bass: ['acid-bass', 'sub-bass'], kick: ['kick-hard'], snare: ['snare-noise', 'snare-clap'], hat: ['hat-closed'] },
    mixed: { lead: ['saw-lead', 'sine-lead', 'pluck', 'fm-bell'], pad: ['warm-pad', 'glass-pad', 'choir-pad'], bass: ['saw-bass', 'sub-bass', 'pluck-bass'], kick: ['kick-soft', 'kick-hard'], snare: ['snare-tight', 'snare-clap'], hat: ['hat-closed', 'shaker'] },
  }
  const kit = KITS[character]

  const legato = character === 'rollups' ? 0.9 : character === 'swaps' ? 0.45 : 0.6 + r() * 0.2
  const melodicRange = feeSpread > 2 ? 2 : 1.3
  const busyness = character === 'swaps' ? 0.8 : character === 'rollups' ? 0.3 : character === 'transfers' ? 0.4 : 0.55

  const name = `${ROOT_NAMES[rootIdx]} ${mode} | ${bpm} bpm | ${beatsPerBar}/4 | ${character}`

  return {
    name, rootMidi, rootName: ROOT_NAMES[rootIdx] as string, mode, secondsPerBeat, bpm, beatsPerBar,
    swing, reverb, legato, melodicRange, busyness,
    lead: pick(r, kit.lead), pad: pick(r, kit.pad), bass: pick(r, kit.bass),
    kick: pick(r, kit.kick), snare: pick(r, kit.snare), hat: pick(r, kit.hat),
    character, builder: builder.tag || builder.miner.slice(0, 10), seed,
  }
}
