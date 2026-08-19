import type { BlockNote } from './chain.js'
import type { Score } from './music.js'

/**
 * The piece as a picture: waveform on top, the block data it was built from
 * underneath, so a reader can see the relationship without hearing it.
 */
export function renderWaveformSvg(
  samples: Float32Array,
  score: Score,
  blocks: BlockNote[],
  title: string,
): string {
  const W = 960
  const waveH = 180
  const stripH = 70
  const pad = 24
  const H = pad + waveH + 16 + stripH + 16 + stripH + pad + 28

  const bg = '#0d1117'
  const border = '#30363d'
  const waveColour = '#58a6ff'
  const feeColour = '#d2a8ff'
  const blobColour = '#39c5cf'
  const text = '#8b949e'

  const out: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,monospace" font-size="12">`,
    `<rect width="${W}" height="${H}" rx="10" fill="${bg}" stroke="${border}"/>`,
    `<text x="${pad}" y="${pad - 4}" fill="${text}" font-size="13">${escape(title)}</text>`,
  ]

  // --- Waveform: min/max per pixel column -----------------------------------
  const inner = W - pad * 2
  const mid = pad + waveH / 2
  const per = Math.max(1, Math.floor(samples.length / inner))
  const path: string[] = []
  for (let x = 0; x < inner; x++) {
    let lo = 0
    let hi = 0
    const start = x * per
    for (let i = start; i < start + per && i < samples.length; i++) {
      const v = samples[i] as number
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    const y1 = mid - hi * (waveH / 2) * 0.95
    const y2 = mid - lo * (waveH / 2) * 0.95
    path.push(`M${pad + x} ${y1.toFixed(1)}V${y2.toFixed(1)}`)
  }
  out.push(`<path d="${path.join('')}" stroke="${waveColour}" stroke-width="1" opacity="0.9"/>`)
  out.push(`<line x1="${pad}" y1="${mid}" x2="${W - pad}" y2="${mid}" stroke="${border}"/>`)

  // Chord sections as a thin strip across the top of the waveform, shaded
  // by intensity, so the harmonic shape is readable at a glance.
  const px = inner / Math.max(1e-9, score.duration)
  for (const sec of score.sections) {
    const x = pad + sec.start * px
    const w = Math.max(1, (sec.end - sec.start) * px)
    const alpha = (0.15 + 0.6 * sec.intensity).toFixed(2)
    out.push(`<rect x="${x.toFixed(1)}" y="${pad}" width="${w.toFixed(1)}" height="10" fill="${feeColour}" opacity="${alpha}"/>`)
    if (w > 22) out.push(`<text x="${(x + 3).toFixed(1)}" y="${pad + 8}" fill="${bg}" font-size="8" font-weight="600">${sec.chord}</text>`)
  }

  // --- Strip 1: base fee per block -----------------------------------------
  const s1Top = pad + waveH + 16
  out.push(strip(blocks.map((b) => b.baseFeeGwei), s1Top, stripH, feeColour, 'base fee', pad, inner, text))

  // --- Strip 2: fullness, with blob blocks ticked --------------------------
  const s2Top = s1Top + stripH + 16
  out.push(strip(blocks.map((b) => b.fullness), s2Top, stripH, waveColour, 'block fullness', pad, inner, text))
  const bw = inner / Math.max(1, blocks.length)
  for (let i = 0; i < blocks.length; i++) {
    if ((blocks[i] as BlockNote).blobGasUsed > 0) {
      out.push(`<rect x="${(pad + i * bw).toFixed(1)}" y="${s2Top + stripH + 3}" width="${Math.max(1, bw - 0.5).toFixed(1)}" height="4" fill="${blobColour}"/>`)
    }
  }
  out.push(`<text x="${W - pad}" y="${s2Top + stripH + 14}" text-anchor="end" fill="${blobColour}" font-size="10">▪ carries blob data</text>`)

  // --- Footer -----------------------------------------------------------------
  const first = blocks[0]?.number ?? 0
  const last = blocks[blocks.length - 1]?.number ?? 0
  const mins = (score.duration / 60).toFixed(1)
  out.push(
    `<text x="${pad}" y="${H - 10}" fill="${text}">blocks ${first}-${last} | ${blocks.length} blocks | ${mins} min | ${score.style.name} | ${score.sections.length} sections | ${score.events.length} notes</text>`,
  )

  out.push('</svg>')
  return out.join('\n')
}

function strip(
  values: number[],
  top: number,
  height: number,
  colour: string,
  label: string,
  pad: number,
  inner: number,
  text: string,
): string {
  const max = Math.max(1e-9, ...values)
  const bw = inner / Math.max(1, values.length)
  const bars: string[] = []
  for (let i = 0; i < values.length; i++) {
    const h = ((values[i] as number) / max) * height
    bars.push(`<rect x="${(pad + i * bw).toFixed(1)}" y="${(top + height - h).toFixed(1)}" width="${Math.max(1, bw - 0.5).toFixed(1)}" height="${h.toFixed(1)}" fill="${colour}" opacity="0.75"/>`)
  }
  return (
    `<text x="${pad}" y="${top - 4}" fill="${text}" font-size="10">${label}</text>` +
    bars.join('')
  )
}

const escape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;')
