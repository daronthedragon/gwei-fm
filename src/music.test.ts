import assert from 'node:assert/strict'
import test from 'node:test'
import type { BlockNote, TxMix, TxNote } from './chain.js'
import { compose, degreeToMidi, midiToHz } from './music.js'
import { characterOf, deriveStyle, MODES, type Style } from './style.js'
import { encodeWav, render, SAMPLE_RATE, toMono } from './synth.js'

const mix = (over: Partial<TxMix> = {}): TxMix => ({
  transfers: 60, tokenTransfers: 40, swaps: 6, creates: 0, blobs: 2, setCode: 0, other: 50, ...over,
})

const tx = (over: Partial<TxNote> = {}): TxNote => ({
  kind: 'transfer', valueEth: 0.5, gasLimit: 21_000, position: 0.5, variant: 0.5, ...over,
})

function block(over: Partial<BlockNote> & { number: number }): BlockNote {
  return {
    timestamp: 1_700_000_000 + over.number * 12,
    baseFeeGwei: 10,
    fullness: 0.5,
    txCount: 150,
    blobGasUsed: 0,
    interval: 12,
    miner: '0xbuilderA',
    mixHash: '0x' + (over.number * 2654435761 >>> 0).toString(16).padStart(64, '0'),
    builderTag: 'testbuilder',
    tx: mix(),
    notable: [
      tx({ valueEth: 1 + (over.number % 5), position: 0.1, variant: (over.number % 10) / 10 }),
      tx({ kind: 'token', valueEth: 0, gasLimit: 60_000, position: 0.4, variant: ((over.number * 3) % 10) / 10 }),
      tx({ kind: 'swap', valueEth: 0, gasLimit: 180_000, position: 0.7, variant: ((over.number * 7) % 10) / 10 }),
    ],
    ...over,
  }
}

/** A piece that builds: calm, surge at 60%, calm. */
function arc(n = 96, extra: (i: number, t: number) => Partial<BlockNote> = () => ({})): BlockNote[] {
  return Array.from({ length: n }, (_, i) => {
    const t = i / (n - 1)
    const surge = Math.exp(-((t - 0.6) ** 2) / 0.02)
    return block({
      number: i,
      baseFeeGwei: 5 + 80 * surge,
      fullness: 0.2 + 0.75 * surge,
      txCount: 80 + Math.round(600 * surge),
      blobGasUsed: i % 3 === 0 ? 131_072 : 0,
      ...extra(i, t),
    })
  })
}

/** A fixed style so composer tests are not at the mercy of style derivation. */
const FIXED: Style = {
  name: 'test', rootMidi: 69, rootName: 'A', mode: 'minor', secondsPerBeat: 0.5, bpm: 120, beatsPerBar: 4,
  swing: 0, reverb: 0.2, legato: 0.6, melodicRange: 1.3, busyness: 0.55,
  lead: 'saw-lead', pad: 'warm-pad', bass: 'saw-bass', kick: 'kick-soft', snare: 'snare-tight', hat: 'hat-closed',
  character: 'mixed', builder: 'test', seed: '0xabc',
}
const run = (blocks: BlockNote[], style: Style = FIXED) => compose(blocks, { style })

const hzToMidi = (hz: number): number => Math.round(69 + 12 * Math.log2(hz / 440))
const pitchClasses = (rootMidi: number, mode: number[]) => new Set(mode.map((s) => (rootMidi + s) % 12))

// ===================================================================== style

test('the chain picks the key: different opening blocks give different roots', () => {
  const roots = new Set<string>()
  for (let seed = 0; seed < 24; seed++) {
    const blocks = arc(32, (i) => ({ mixHash: '0x' + ((seed * 7919 + i) * 2654435761 >>> 0).toString(16).padStart(64, '0') }))
    roots.add(deriveStyle(blocks).rootName)
  }
  assert.ok(roots.size >= 6, `24 seeds should spread across keys, got ${[...roots]}`)
})

test('style is deterministic: the same blocks always choose the same style', () => {
  assert.deepEqual(deriveStyle(arc()), deriveStyle(arc()))
})

test('a volatile range goes to darker modes than a flat one', () => {
  const flat = arc(64, () => ({ baseFeeGwei: 10 }))
  const wild = arc(64, (_, t) => ({ baseFeeGwei: 5 + 200 * Math.exp(-((t - 0.5) ** 2) / 0.01) }))
  const bright = new Set(['major', 'lydian', 'mixolydian', 'pentatonicMinor'])
  const dark = new Set(['phrygian', 'harmonicMinor', 'whole', 'minor'])
  assert.ok(bright.has(deriveStyle(flat).mode), `flat day should be bright, got ${deriveStyle(flat).mode}`)
  assert.ok(dark.has(deriveStyle(wild).mode), `wild day should be dark, got ${deriveStyle(wild).mode}`)
})

test('a packed chain is faster than a half-empty one', () => {
  const sparse = arc(64, () => ({ fullness: 0.25 }))
  const packed = arc(64, () => ({ fullness: 0.9 }))
  assert.ok(deriveStyle(packed).bpm > deriveStyle(sparse).bpm + 15)
})

test('what the transactions did decides the character', () => {
  const swappy = arc(32, () => ({ tx: mix({ swaps: 80, transfers: 20, tokenTransfers: 10 }) }))
  const sendy = arc(32, () => ({ tx: mix({ swaps: 0, transfers: 200, tokenTransfers: 5, other: 10 }) }))
  const shippy = arc(32, () => ({ tx: mix({ creates: 6 }) }))
  const rollupy = arc(32, () => ({ tx: mix({ blobs: 40, transfers: 10, tokenTransfers: 5, other: 5 }) }))
  assert.equal(characterOf(swappy), 'swaps')
  assert.equal(characterOf(sendy), 'transfers')
  assert.equal(characterOf(shippy), 'deploys')
  assert.equal(characterOf(rollupy), 'rollups')
})

test('character picks the instruments: a swap range and a send range get different bands', () => {
  const swappy = deriveStyle(arc(32, () => ({ tx: mix({ swaps: 80 }) })))
  const sendy = deriveStyle(arc(32, () => ({ tx: mix({ swaps: 0, transfers: 200, tokenTransfers: 5, other: 10 }) })))
  assert.notEqual(swappy.character, sendy.character)
  // The swap kit never uses the soft kick; the send kit only uses it.
  assert.notEqual(swappy.kick, 'kick-soft')
  assert.equal(sendy.kick, 'kick-soft')
})

test('uneven block arrival swings the feel', () => {
  const tight = arc(64, () => ({ interval: 12 }))
  const loose = arc(64, (i) => ({ interval: i % 3 === 0 ? 24 : 12 }))
  assert.ok(deriveStyle(loose).swing > deriveStyle(tight).swing + 0.1)
})

test('rollup-heavy ranges get a bigger room', () => {
  const roll = deriveStyle(arc(32, () => ({ tx: mix({ blobs: 40, transfers: 10, tokenTransfers: 5, other: 5 }) })))
  const send = deriveStyle(arc(32, () => ({ tx: mix({ swaps: 0, transfers: 200, tokenTransfers: 5, other: 10 }) })))
  assert.ok(roll.reverb > send.reverb + 0.2)
})

// ================================================================== composer

test('every pitched note is in the style’s key and mode', () => {
  for (const style of [FIXED, { ...FIXED, rootMidi: 64, mode: 'lydian' as const }, { ...FIXED, rootMidi: 62, mode: 'pentatonicMinor' as const }]) {
    const allowed = pitchClasses(style.rootMidi, MODES[style.mode])
    const pitched = run(arc(), style).events.filter((e) => e.frequency > 0 && !['kick', 'snare', 'hat', 'accent'].includes(e.role))
    assert.ok(pitched.length > 50)
    for (const ev of pitched) {
      const pc = ((hzToMidi(ev.frequency) % 12) + 12) % 12
      assert.ok(allowed.has(pc), `${style.mode}: ${ev.role} at ${ev.frequency.toFixed(1)}Hz is off the scale`)
    }
  }
})

test('odd meters place downbeats where the meter says', () => {
  const style: Style = { ...FIXED, beatsPerBar: 7 }
  const score = run(arc(56), style)
  const kicks = score.events.filter((e) => e.role === 'kick')
  const offsets = new Set(kicks.map((k) => k.blockNumber % 7))
  assert.ok([...offsets].every((o) => [0, 3, 5].includes(o)), `kicks at ${[...offsets]}`)
})

test('harmony opens on i and keeps returning to it', () => {
  const chords = run(arc()).sections.map((s) => s.chord)
  assert.equal(chords[0], 'i')
  assert.ok(chords.filter((c) => c === 'i').length >= 3)
})

test('a surge reaches chords the calm never does', () => {
  const calm = Array.from({ length: 48 }, (_, i) => block({ number: i, baseFeeGwei: 5 + (i % 3), fullness: 0.2 }))
  const calmChords = new Set(run(calm).sections.map((s) => s.chord))
  const surgeChords = new Set(run(arc()).sections.map((s) => s.chord))
  assert.ok(surgeChords.size > calmChords.size)
})

test('drums drop out in the calm and arrive at the peak', () => {
  const score = run(arc())
  const inSection = (ev: { at: number }) => score.sections.findIndex((s) => ev.at >= s.start && ev.at < s.end)
  const calmest = score.sections.reduce((a, s, i) => (s.intensity < score.sections[a]!.intensity ? i : a), 0)
  const peak = score.sections.reduce((a, s, i) => (s.intensity > score.sections[a]!.intensity ? i : a), 0)
  const hats = score.events.filter((e) => e.role === 'hat')
  assert.equal(hats.filter((e) => inSection(e) === calmest).length, 0)
  assert.ok(hats.filter((e) => inSection(e) === peak).length > 0)
})

test('a contract deployment rings a bell on its own block', () => {
  const blocks = arc(32, (i) => (i === 10
    ? { notable: [tx({ kind: 'deploy', valueEth: 0, gasLimit: 900_000, position: 0.5, variant: 0.3 })] }
    : { notable: [tx({ position: 0.5 })] }))
  const bells = run(blocks).events.filter((e) => e.instrument === 'fm-bell')
  assert.ok(bells.length >= 1)
  assert.ok(bells.every((e) => e.blockNumber === 10))
})

test('swing pushes the off-beat subdivisions late', () => {
  const straight = run(arc(), { ...FIXED, swing: 0 })
  const swung = run(arc(), { ...FIXED, swing: 0.3 })
  const hatTimes = (s: typeof straight) => s.events.filter((e) => e.role === 'hat').map((e) => e.at)
  const a = hatTimes(straight)
  const b = hatTimes(swung)
  assert.equal(a.length, b.length)
  const later = b.filter((t, i) => t > (a[i] as number) + 1e-9).length
  assert.ok(later > a.length * 0.3, 'a good share of hats should land later when swung')
})

test('a whale transaction rings higher than a dust send', () => {
  const mk = (valueEth: number) =>
    Array.from({ length: 8 }, (_, i) => block({ number: i, notable: [tx({ valueEth, position: 0.2 })] }))
  const leadPitch = (blocks: BlockNote[]) => {
    const leads = run(blocks).events.filter((e) => e.role === 'lead')
    return leads.reduce((s2, e) => s2 + e.frequency, 0) / leads.length
  }
  assert.ok(leadPitch(mk(200)) > leadPitch(mk(0.01)) * 1.5, 'value should set the register')
})

test('every foreground note is a transaction', () => {
  const score = run(arc())
  for (const e of score.events) {
    if (e.role === 'lead' || e.role === 'tx') {
      assert.ok(e.variant >= 0 && e.variant <= 1)
    }
  }
  const foreground = score.events.filter((e) => e.role === 'lead' || e.role === 'tx')
  assert.ok(foreground.length > 100, 'the tx layer should carry the piece')
})

test('a transaction kind always speaks its own instrument family', () => {
  // The arc gives the piece a surge; in the surge all three txs are audible.
  // A flat range keeps only the two most salient, which is by design.
  const blocks = arc(48, () => ({
    notable: [
      tx({ kind: 'swap', valueEth: 0, gasLimit: 200_000, position: 0.3 }),
      tx({ kind: 'deploy', valueEth: 0, gasLimit: 900_000, position: 0.6 }),
      tx({ kind: 'token', valueEth: 0, gasLimit: 60_000, position: 0.8 }),
    ],
  }))
  // A deploy is important enough to take the lead slot, so look across both
  // foreground roles: the vocabulary holds wherever the note sits.
  const foreground = run(blocks).events.filter((e) => e.role === 'tx' || e.role === 'lead')
  const instruments = new Set(foreground.map((e) => e.instrument))
  assert.ok(foreground.some((e) => e.instrument === 'acid-bass'), 'swaps speak acid')
  assert.ok(foreground.some((e) => e.instrument === 'fm-bell'), 'deploys ring the bell')
  assert.ok(instruments.size >= 3, 'kinds must not collapse into one sound')
})

test('two transactions never render the identical sound', () => {
  const mkScore = (variant: number) => ({
    duration: 1.5,
    style: FIXED,
    sections: [],
    events: [{ at: 0, length: 0.4, frequency: 440, velocity: 0.5, instrument: 'pluck' as const, role: 'tx' as const, pan: 0, colour: 0.5, variant, blockNumber: 1 }],
  })
  const a = render(mkScore(0.15))
  const b = render(mkScore(0.85))
  let diff = 0
  for (let i = 0; i < a.left.length; i++) diff += Math.abs((a.left[i] as number) - (b.left[i] as number))
  assert.ok(diff > 5, `different hashes must sound different (diff ${diff.toFixed(2)})`)
})

test('texture thins out when the chain is calm', () => {
  const score = run(arc())
  const inSection = (ev: { at: number }) => score.sections.findIndex((x) => ev.at >= x.start && ev.at < x.end)
  const calmest = score.sections.reduce((a, x, i) => (x.intensity < score.sections[a]!.intensity ? i : a), 0)
  const peak = score.sections.reduce((a, x, i) => (x.intensity > score.sections[a]!.intensity ? i : a), 0)
  const txNotes = score.events.filter((e) => e.role === 'tx')
  const calmCount = txNotes.filter((e) => inSection(e) === calmest).length
  const peakCount = txNotes.filter((e) => inSection(e) === peak).length
  assert.ok(peakCount > calmCount, `peak ${peakCount} should out-note calm ${calmCount}`)
})

test('a missed slot lengthens its section; an absurd gap is clamped to the same stretch', () => {
  const mk = (interval: number) => Array.from({ length: 16 }, (_, i) => block({ number: i, interval: i === 3 ? interval : 12 }))
  const len = (blocks: BlockNote[]) => { const s = run(blocks).sections[0]!; return s.end - s.start }
  assert.ok(len(mk(24)) > len(mk(12)) * 1.1)
  assert.ok(Math.abs(len(mk(3600)) - len(mk(24))) < 1e-9)
})

test('the same blocks always compose the same score', () => {
  assert.deepEqual(compose(arc()), compose(arc()))
})

test('an empty range is silence, not a crash', () => {
  assert.equal(compose([]).events.length, 0)
})

// ===================================================================== synth

test('every instrument renders without NaN or clipping', () => {
  const styles: Style[] = [
    { ...FIXED, lead: 'square-lead', pad: 'glass-pad', bass: 'acid-bass', kick: 'kick-808', snare: 'snare-clap', hat: 'hat-open', character: 'swaps' },
    { ...FIXED, lead: 'fm-bell', pad: 'choir-pad', bass: 'sub-bass', kick: 'kick-hard', snare: 'snare-noise', hat: 'shaker', character: 'rollups' },
    { ...FIXED, lead: 'pluck', pad: 'organ', bass: 'pluck-bass', kick: 'kick-soft', snare: 'snare-tight', hat: 'hat-closed' },
    { ...FIXED, lead: 'sine-lead', pad: 'warm-pad', bass: 'saw-bass' },
  ]
  for (const style of styles) {
    const blocks = arc(24, (i) => ({ tx: mix({ swaps: 40, creates: i === 5 ? 1 : 0, setCode: i === 6 ? 1 : 0 }) }))
    const audio = render(run(blocks, style))
    let peak = 0
    for (let i = 0; i < audio.left.length; i++) {
      const l = audio.left[i] as number, r = audio.right[i] as number
      assert.ok(Number.isFinite(l) && Number.isFinite(r), `${style.lead}/${style.bass}: NaN at ${i}`)
      peak = Math.max(peak, Math.abs(l), Math.abs(r))
    }
    assert.ok(peak <= 0.9 + 1e-6 && peak > 0.3, `${style.lead}: peak ${peak}`)
  }
})

test('stereo channels differ and a busy stretch is louder than a calm one', () => {
  const score = run(arc(96))
  const audio = render(score)
  let diff = 0
  for (let i = 0; i < audio.left.length; i += 97) diff += Math.abs((audio.left[i] as number) - (audio.right[i] as number))
  assert.ok(diff > 1)
  const mono = toMono(audio)
  const rms = (a: number, b: number) => {
    const s = Math.floor(a * SAMPLE_RATE), e = Math.floor(b * SAMPLE_RATE)
    let acc = 0
    for (let i = s; i < e; i++) acc += (mono[i] as number) ** 2
    return Math.sqrt(acc / (e - s))
  }
  const peak = score.sections.reduce((a, s) => (s.intensity > a.intensity ? s : a))
  const calm = score.sections.reduce((a, s) => (s.intensity < a.intensity ? s : a))
  assert.ok(rms(peak.start, peak.end) > rms(calm.start, calm.end) * 1.2)
})

test('rendering is deterministic, noise and reverb included', () => {
  const a = render(run(arc(16)))
  const b = render(run(arc(16)))
  assert.deepEqual(Array.from(a.left.subarray(0, 4000)), Array.from(b.left.subarray(0, 4000)))
})

test('writes a valid 16-bit stereo WAV that clamps instead of wrapping', () => {
  const wav = encodeWav({ left: new Float32Array([2, 0]), right: new Float32Array([-2, 0]) })
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF')
  assert.equal(wav.readUInt16LE(22), 2)
  assert.equal(wav.readUInt32LE(24), SAMPLE_RATE)
  assert.equal(wav.readInt16LE(44), 32767)
  assert.equal(wav.readInt16LE(46), -32767)
})

test('degreeToMidi and midiToHz behave', () => {
  assert.equal(degreeToMidi(69, MODES.minor, 7), 81)
  assert.equal(degreeToMidi(69, MODES.minor, -1), 67)
  assert.equal(midiToHz(69), 440)
})
