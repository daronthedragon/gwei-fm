/** The handful of block fields the music is built from. */
export interface BlockNote {
  number: number
  timestamp: number
  /** Base fee in gwei. Drives pitch. */
  baseFeeGwei: number
  /** Fraction of the gas limit consumed, 0..1. Drives loudness. */
  fullness: number
  txCount: number
  /** Blob gas used, if the chain has blobs. Drives a sub layer. */
  blobGasUsed: number
  /** Seconds since the previous block. Drives rhythm. */
  interval: number
  /** Who built it. A stretch dominated by one builder has one personality. */
  miner: string
  /** RANDAO reveal: per-block, unpredictable, and fixed forever. Seeds style. */
  mixHash: string
  /** Builder's tag from extraData, when it is printable. */
  builderTag: string
  /** Transaction character of the block. */
  tx: TxMix
  /**
   * The block's most salient transactions, each of which becomes a note.
   * Bounded and deterministically chosen, so a 1500-tx block still renders.
   */
  notable: TxNote[]
}

export type TxKind = 'swap' | 'transfer' | 'token' | 'deploy' | 'blob' | 'setCode' | 'other'

export interface TxNote {
  kind: TxKind
  /** ETH moved. Zero for most contract calls. */
  valueEth: number
  /** Gas limit: how much work the sender expected. Salience for 0-value calls. */
  gasLimit: number
  /** Position in the block, 0..1. Where in the beat the note lands. */
  position: number
  /**
   * Per-note timbre seed from the tx hash, 0..1. No two transactions share
   * one, so no two notes are the same sound.
   */
  variant: number
}

export interface TxMix {
  /** Plain ETH sends, no calldata. */
  transfers: number
  /** ERC-20 transfer() calls. */
  tokenTransfers: number
  /** DEX swaps: Uniswap universal router, V2/V3 routers, 1inch, 0x. */
  swaps: number
  /** Contract deployments. */
  creates: number
  /** Blob-carrying (type 3) transactions: rollup batches. */
  blobs: number
  /** EIP-7702 set-code transactions. */
  setCode: number
  /** Everything else that touched a contract. */
  other: number
}

export const PUBLIC_RPCS = [
  'https://eth.drpc.org',
  'https://ethereum-rpc.publicnode.com',
  'https://1rpc.io/eth',
] as const

interface RawTx {
  hash?: string
  type?: string
  to?: string | null
  input?: string
  value?: string
  gas?: string
}

interface RawBlock {
  number: string
  timestamp: string
  baseFeePerGas?: string
  gasUsed: string
  gasLimit: string
  transactions: RawTx[]
  blobGasUsed?: string
  miner: string
  mixHash: string
  extraData?: string
}

/** Selectors that mean "swap". Routers of the major DEX aggregators and AMMs. */
const SWAP_SELECTORS = new Set([
  '0x3593564c', // Uniswap universal router execute
  '0x24856bc3', // universal router execute (no deadline)
  '0x38ed1739', '0x7ff36ab5', '0x18cbafe5', '0x8803dbee', '0xfb3bdb41', // V2 router swaps
  '0x414bf389', '0xc04b8d59', '0xdb3e2198', '0xf28c0498', // V3 exactInput/Output
  '0x04e45aaf', '0x5023b4df', '0xb858183f', '0x09b81346', // V3 router 2
  '0x12aa3caf', '0x0502b1c5', '0xe449022e', '0x2e95b6c8', // 1inch
  '0xd9627aa4', '0x415565b0', '0x6af479b2', // 0x
  '0x5ae401dc', // multicall (usually swaps)
])
const TRANSFER_SELECTOR = '0xa9059cbb'

function classify(txs: RawTx[]): TxMix {
  const mix: TxMix = { transfers: 0, tokenTransfers: 0, swaps: 0, creates: 0, blobs: 0, setCode: 0, other: 0 }
  for (const t of txs) {
    const input = t.input ?? '0x'
    const selector = input.slice(0, 10)
    if (t.type === '0x3') mix.blobs++
    else if (t.type === '0x4') mix.setCode++
    else if (t.to === null || t.to === undefined) mix.creates++
    else if (input.length <= 2) mix.transfers++
    else if (selector === TRANSFER_SELECTOR) mix.tokenTransfers++
    else if (SWAP_SELECTORS.has(selector)) mix.swaps++
    else mix.other++
  }
  return mix
}

/** 0..1 from a tx hash, deterministic. */
function hashVariant(hash: string | undefined): number {
  if (!hash) return 0.5
  let h = 2166136261
  for (let i = 2; i < Math.min(hash.length, 34); i++) {
    h ^= hash.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 0x1_0000_0000
}

function kindOf(t: RawTx): TxKind {
  const input = t.input ?? '0x'
  const selector = input.slice(0, 10)
  if (t.type === '0x3') return 'blob'
  if (t.type === '0x4') return 'setCode'
  if (t.to === null || t.to === undefined) return 'deploy'
  if (input.length <= 2) return 'transfer'
  if (selector === TRANSFER_SELECTOR) return 'token'
  if (SWAP_SELECTORS.has(selector)) return 'swap'
  return 'other'
}

/**
 * The transactions worth a note. Deploys and set-code always make the cut
 * (they are rare and mean something happened); the rest rank by salience:
 * ETH moved, or for value-less contract calls, how much work was requested.
 */
function notableTxs(txs: RawTx[], cap = 6): TxNote[] {
  const scored = txs.map((t, index) => {
    const kind = kindOf(t)
    const valueEth = t.value ? Number(BigInt(t.value)) / 1e18 : 0
    const gasLimit = t.gas ? Number(BigInt(t.gas)) : 21_000
    // Only deployments are unconditionally in: they are rare and mean
    // something shipped. setCode ranks normally (7702 batches arrive in
    // spam quantities) and is capped below so it stays a seasoning.
    const salience = kind === 'deploy' ? Number.MAX_SAFE_INTEGER : valueEth * 1e6 + gasLimit / 1e3
    return {
      salience,
      note: {
        kind,
        valueEth,
        gasLimit,
        position: txs.length > 1 ? index / (txs.length - 1) : 0,
        variant: hashVariant(t.hash),
      } as TxNote,
    }
  })
  scored.sort((a, b) => b.salience - a.salience)
  // At most two notes of any one kind per block, and one setCode: variety
  // in the block should be variety in the beat, not one kind repeated.
  const perKind = new Map<TxKind, number>()
  const picked: TxNote[] = []
  for (const { note } of scored) {
    const limit = note.kind === 'setCode' ? 1 : 2
    const used = perKind.get(note.kind) ?? 0
    if (used >= limit) continue
    perKind.set(note.kind, used + 1)
    picked.push(note)
    if (picked.length >= cap) break
  }
  return picked.sort((a, b) => a.position - b.position)
}

/** Printable ASCII from extraData, or empty. Builders sign their blocks here. */
function builderTag(extraData: string | undefined): string {
  if (!extraData || extraData.length <= 2) return ''
  const bytes = Buffer.from(extraData.slice(2), 'hex')
  const text = bytes.toString('latin1').replace(/[^ -~]/g, '')
  return text.length >= 3 ? text : ''
}

const hex = (value: string | undefined): number => (value ? Number(BigInt(value)) : 0)

async function rpc<T>(url: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  const body = (await res.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(body.error.message)
  if (body.result === undefined || body.result === null) throw new Error('empty result')
  return body.result
}

/** Batch getBlockByNumber calls into one HTTP round trip. */
async function rpcBatch(url: string, numbers: number[]): Promise<RawBlock[]> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(
      numbers.map((n, i) => ({
        jsonrpc: '2.0',
        id: i,
        method: 'eth_getBlockByNumber',
        params: [`0x${n.toString(16)}`, true],
      })),
    ),
  })
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`)
  const body = (await res.json()) as Array<{ id: number; result?: RawBlock; error?: { message: string } }>
  if (!Array.isArray(body)) throw new Error('batch response was not an array')

  const out: RawBlock[] = []
  for (const item of body.sort((a, b) => a.id - b.id)) {
    if (!item.result) throw new Error(item.error?.message ?? 'missing block in batch')
    out.push(item.result)
  }
  return out
}

export async function latestBlockNumber(endpoints: readonly string[]): Promise<number> {
  let lastError = 'no endpoints'
  for (const url of endpoints) {
    try {
      return hex(await rpc<string>(url, 'eth_blockNumber', []))
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(`Could not reach any RPC endpoint (${lastError})`)
}

/**
 * Fetch a contiguous range of blocks, batched, rotating endpoints on failure.
 * Public endpoints cap batch sizes, so chunks stay modest.
 */
export async function fetchBlocks(
  from: number,
  to: number,
  endpoints: readonly string[],
  onProgress?: (done: number, total: number) => void,
): Promise<BlockNote[]> {
  const CHUNK = 20
  const total = to - from + 1
  const raw: RawBlock[] = []

  for (let start = from; start <= to; start += CHUNK) {
    const numbers = Array.from({ length: Math.min(CHUNK, to - start + 1) }, (_, i) => start + i)

    let fetched: RawBlock[] | undefined
    let lastError = ''
    for (const url of endpoints) {
      try {
        fetched = await rpcBatch(url, numbers)
        break
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err)
      }
    }
    if (!fetched) throw new Error(`Every endpoint failed fetching blocks ${start}-${start + numbers.length - 1}: ${lastError}`)

    raw.push(...fetched)
    onProgress?.(raw.length, total)
  }

  // Interval needs the block before the first one, so one extra fetch.
  let previousTimestamp: number | undefined
  if (from > 0) {
    for (const url of endpoints) {
      try {
        const [prev] = await rpcBatch(url, [from - 1])
        previousTimestamp = prev ? hex(prev.timestamp) : undefined
        break
      } catch {
        // Not fatal: the first block just gets the median interval.
      }
    }
  }

  const notes: BlockNote[] = raw.map((b) => ({
    number: hex(b.number),
    timestamp: hex(b.timestamp),
    baseFeeGwei: hex(b.baseFeePerGas) / 1e9,
    fullness: hex(b.gasLimit) > 0 ? hex(b.gasUsed) / hex(b.gasLimit) : 0,
    txCount: b.transactions.length,
    blobGasUsed: hex(b.blobGasUsed),
    interval: 12,
    miner: b.miner.toLowerCase(),
    mixHash: b.mixHash,
    builderTag: builderTag(b.extraData),
    tx: classify(b.transactions),
    notable: notableTxs(b.transactions),
  }))

  for (let i = 0; i < notes.length; i++) {
    const current = notes[i] as BlockNote
    const before = i === 0 ? previousTimestamp : notes[i - 1]?.timestamp
    if (before !== undefined) current.interval = Math.max(1, current.timestamp - before)
  }

  return notes
}
