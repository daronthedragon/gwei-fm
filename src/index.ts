#!/usr/bin/env node
import { writeFile } from 'node:fs/promises'
import { fetchBlocks, latestBlockNumber, PUBLIC_RPCS, type BlockNote } from './chain.js'
import { compose } from './music.js'
import { deriveStyle } from './style.js'
import { encodeWav, render, roleCounts, toMono } from './synth.js'
import { renderWaveformSvg } from './waveform.js'

const USAGE = `
  gwei-fm — a stretch of Ethereum, as a piece of music

  The chain picks the style. Key, mode, tempo, meter, swing, the instruments
  and the amount of room are all read off the blocks themselves, so two
  different stretches are two different pieces, and the same stretch is
  always the same one.

  Usage
    gwei-fm [options]

  Range (pick one)
    --last <n>              the most recent n blocks       (default 300)
    --from <block> --to <block>

  Output
    -o, --out <file.wav>    (default gwei-fm.wav)
    --svg <file.svg>        also draw the waveform + block data
    --style                 print the derived style and exit (no audio)
    --rpc <url>             RPC endpoint, repeatable
    -h, --help

  A day of mainnet is ~7200 blocks. The cap is one day per run.
`

interface Args {
  last?: number
  from?: number
  to?: number
  out: string
  svg?: string
  styleOnly: boolean
  endpoints: string[]
}

function parseArgs(argv: string[]): Args {
  const values = new Map<string, string>()
  const endpoints: string[] = []
  let styleOnly = false

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string
    if (token === '-h' || token === '--help') throw new Error(USAGE.trim())
    if (token === '--style') {
      styleOnly = true
      continue
    }
    if (!token.startsWith('-')) throw new Error(`Unexpected argument "${token}"\n${USAGE}`)

    const body = token.replace(/^--?/, '')
    const eq = body.indexOf('=')
    let name = body
    let value: string | undefined
    if (eq >= 0) {
      name = body.slice(0, eq)
      value = body.slice(eq + 1)
    } else {
      value = argv[i + 1]
      if (value === undefined || value.startsWith('-')) throw new Error(`--${name} needs a value`)
      i++
    }
    if (name === 'rpc') endpoints.push(value)
    else values.set(name === 'o' ? 'out' : name, value)
  }

  const int = (name: string): number | undefined => {
    const raw = values.get(name)
    if (raw === undefined) return undefined
    if (!/^\d+$/.test(raw)) throw new Error(`--${name} must be a whole number, got "${raw}"`)
    return Number(raw)
  }

  const from = int('from')
  const to = int('to')
  if ((from === undefined) !== (to === undefined)) throw new Error('--from and --to go together')
  if (from !== undefined && to !== undefined && to < from) throw new Error('--to must not be before --from')
  const last = int('last')
  if (last !== undefined && last < 1) throw new Error('--last must be at least 1')
  const span = from !== undefined && to !== undefined ? to - from + 1 : (last ?? 300)
  if (span > 7200) throw new Error(`${span} blocks is more than a day. Cap is 7200 per run.`)

  return {
    last: from === undefined ? (last ?? 300) : undefined,
    from,
    to,
    out: values.get('out') ?? 'gwei-fm.wav',
    svg: values.get('svg'),
    styleOnly,
    endpoints: endpoints.length ? endpoints : [...PUBLIC_RPCS],
  }
}

function summarise(blocks: BlockNote[]): string {
  const fees = blocks.map((b) => b.baseFeeGwei)
  const full = Math.round((blocks.reduce((s, b) => s + b.fullness, 0) / blocks.length) * 100)
  const mix = blocks.reduce(
    (m, b) => ({ swaps: m.swaps + b.tx.swaps, transfers: m.transfers + b.tx.transfers, tokens: m.tokens + b.tx.tokenTransfers, creates: m.creates + b.tx.creates, blobs: m.blobs + b.tx.blobs }),
    { swaps: 0, transfers: 0, tokens: 0, creates: 0, blobs: 0 },
  )
  return (
    `  base fee ${Math.min(...fees).toFixed(2)}-${Math.max(...fees).toFixed(2)} gwei | ${full}% full\n` +
    `  ${mix.swaps} swaps | ${mix.transfers} eth sends | ${mix.tokens} token transfers | ${mix.creates} deploys | ${mix.blobs} blob txs`
  )
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const log = (s: string) => process.stderr.write(s + '\n')

  let from = args.from
  let to = args.to
  if (from === undefined || to === undefined) {
    const head = await latestBlockNumber(args.endpoints)
    to = head - 1
    from = Math.max(0, to - (args.last as number) + 1)
  }

  log(`fetching blocks ${from}-${to}...`)
  const blocks = await fetchBlocks(from, to, args.endpoints, (done, total) => {
    if (done % 100 === 0 || done === total) process.stderr.write(`\r  ${done}/${total}`)
  })
  process.stderr.write('\n')
  log(summarise(blocks))

  const style = deriveStyle(blocks)
  log('')
  log(`  the chain chose: ${style.name}`)
  log(`  ${style.lead} / ${style.pad} / ${style.bass} / ${style.kick} ${style.snare} ${style.hat}`)
  log(`  swing ${(style.swing * 100).toFixed(0)}% | room ${(style.reverb * 100).toFixed(0)}% | built mostly by ${style.builder}`)
  log(`  seed ${style.seed.slice(0, 18)}... (block ${from} RANDAO)`)
  if (args.styleOnly) return

  const score = compose(blocks, { style })
  log('')
  log(`composed ${score.events.length} notes, ${(score.duration / 60).toFixed(1)} minutes, ${score.sections.length} sections`)

  const audio = render(score)
  await writeFile(args.out, encodeWav(audio))
  const counts = roleCounts(score)
  log(`wrote ${args.out}  (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(' | ')})`)

  if (args.svg) {
    const title = `gwei-fm | blocks ${from}-${to} | ${style.name}`
    await writeFile(args.svg, renderWaveformSvg(toMono(audio), score, blocks, title) + '\n')
    log(`wrote ${args.svg}`)
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`\n${err instanceof Error ? err.message : String(err)}\n\n`)
  process.exit(1)
})
