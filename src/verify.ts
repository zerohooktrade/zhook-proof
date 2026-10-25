import { formatUnits, getAddress, parseAbi, type PublicClient, type TransactionReceipt } from "viem";
import { CHAIN_ID, isNative, lc, NATIVE, RHC, type Address, type Hex } from "./chain.js";
import { decodeLogs, findTrade } from "./decode.js";
import { isHookFree, listedPoolById, poolIdOf, POOL_LIST, type PoolKey } from "./pools.js";
import { usdPrice } from "./price.js";
import { bestPlans, type QuoteContext } from "./quote.js";
import { makeClients, type Clients, type RpcOptions } from "./rpc.js";

export const SPEC_VERSION = "zhook-proof/1";

/** Gap within ±1 bps of the baseline counts as matched (SPEC 6). */
export const MATCH_BAND_BPS = 1;

export interface TokenInfo {
  address: Address;
  symbol: string;
  decimals: number;
}

export interface ProofOfExecution {
  spec: typeof SPEC_VERSION;
  chainId: number;
  tx: Hex;
  block: number;
  /** Unix seconds. */
  timestamp: number;
  sender: Address;
  /** The address the trade is measured for. */
  trader: Address;
  measuredFor: "sender" | "router-recipient";
  to: Address | null;
  viaUniversalRouter: boolean;
  tokenIn: TokenInfo;
  tokenOut: TokenInfo;
  amountIn: string;
  amountInRaw: string;
  received: string;
  receivedRaw: string;
  /** Best Uniswap-only route at baselineBlock; null when none could be priced. */
  baseline: {
    amountOut: string;
    amountOutRaw: string;
    kind: "single" | "split" | "multi-hop";
    legs: { shareBps: number; hops: string[] }[];
  } | null;
  baselineBlock: number;
  gap: {
    /** received − baseline, raw units of tokenOut. */
    raw: string;
    /** received − baseline, in tokenOut. */
    amount: string;
    /** (received − baseline) / baseline × 10,000, truncated to 2 decimals. */
    bps: number;
    /** Gap in USD at today's price; null when skipped or tokenOut has no price. */
    usd: number | null;
    price: { usd: number; via: "par" | "usdg" | "eth"; venue: string; block: number } | null;
  } | null;
  verdict: "better" | "matched" | "worse" | "no-baseline";
  venuesUsed: { venue: "v3" | "v4"; pool: string; hooked: boolean | null; hook: Address | null; key: PoolKey | null }[];
  poolList: { version: number; block: number; pools: number };
  notes: string[];
}

export class ProofError extends Error {
  constructor(
    readonly code: "bad-input" | "not-found" | "reverted" | "unreadable" | "rpc-failed",
    message: string,
  ) {
    super(message);
    this.name = "ProofError";
  }
}

export interface VerifyOptions extends RpcOptions {
  /** Ready-made clients (overrides the RPC options). */
  clients?: Clients;
  /** Read today's price of tokenOut for the USD gap (default true). */
  usd?: boolean;
  /** Block for the USD price (default: latest). */
  priceBlock?: bigint;
  /** Extra hook-free v4 pools to add to the baseline set (SPEC 3.2). Hooked keys are ignored. */
  extraPools?: PoolKey[];
}

const erc20Abi = parseAbi(["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
const positionManagerAbi = parseAbi([
  "function poolKeys(bytes25 poolId) view returns (address currency0, address currency1, uint24 fee, int24 tickSpacing, address hooks)",
]);

async function tokenInfo(client: PublicClient, address: Address): Promise<TokenInfo> {
  const a = lc(address);
  if (isNative(a)) return { address: NATIVE, symbol: "ETH", decimals: 18 };
  if (a === lc(RHC.usdg)) return { address: getAddress(a), symbol: "USDG", decimals: 6 };
  if (a === lc(RHC.weth)) return { address: getAddress(a), symbol: "WETH", decimals: 18 };
  const [symbol, decimals] = await client.multicall({
    contracts: [
      { address: a, abi: erc20Abi, functionName: "symbol" },
      { address: a, abi: erc20Abi, functionName: "decimals" },
    ],
    allowFailure: true,
  });
  if (decimals.status !== "success") throw new ProofError("unreadable", `${a} does not answer decimals()`);
  const sym = symbol.status === "success" ? String(symbol.result).slice(0, 24) : "?";
  return { address: getAddress(a), symbol: sym, decimals: Number(decimals.result) };
}

/** v4 pool key for a pool id: the bundled list first, then PositionManager.poolKeys(bytes25(id)). */
async function poolKeys(client: PublicClient, ids: Hex[]): Promise<Map<Hex, PoolKey | null>> {
  const out = new Map<Hex, PoolKey | null>();
  const unknown: Hex[] = [];
  for (const id of new Set(ids)) {
    const k = listedPoolById(id);
    if (k) out.set(id, k);
    else unknown.push(id);
  }
  if (unknown.length) {
    const res = await client
      .multicall({
        contracts: unknown.map((id) => ({
          address: RHC.v4.positionManager,
          abi: positionManagerAbi,
          functionName: "poolKeys" as const,
          args: [id.slice(0, 52) as Hex] as const,
        })),
        allowFailure: true,
      })
      .catch(() => unknown.map(() => ({ status: "failure" as const })));
    unknown.forEach((id, i) => {
      const r = res[i];
      if (r?.status !== "success") return out.set(id, null);
      const [currency0, currency1, fee, tickSpacing, hooks] = r.result as readonly [
        Address,
        Address,
        number,
        number,
        Address,
      ];
      const key: PoolKey = { currency0: lc(currency0), currency1: lc(currency1), fee, tickSpacing, hooks: lc(hooks) };
      out.set(id, poolIdOf(key) === id ? key : null);
    });
  }
  return out;
}

/** bps = (received − baseline) × 10,000 / baseline, truncated toward zero to 2 decimals. */
export function gapBps(received: bigint, baseline: bigint): number {
  if (baseline <= 0n) throw new Error("baseline must be positive");
  return Number(((received - baseline) * 1_000_000n) / baseline) / 100;
}

export function verdictFor(bps: number | null): ProofOfExecution["verdict"] {
  if (bps === null) return "no-baseline";
  return bps > MATCH_BAND_BPS ? "better" : bps < -MATCH_BAND_BPS ? "worse" : "matched";
}

/** Measures one swap transaction against the best Uniswap-only route at the block before it (SPEC.md). */
export async function verifyExecution(hash: string, opts: VerifyOptions = {}): Promise<ProofOfExecution> {
  if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new ProofError("bad-input", "Not a transaction hash");
  const h = hash.toLowerCase() as Hex;
  const { read, archive } = opts.clients ?? makeClients(opts);
  const either = <T>(f: (c: PublicClient) => Promise<T>) => f(read).catch(() => f(archive));
  let tx: Awaited<ReturnType<PublicClient["getTransaction"]>>;
  let receipt: TransactionReceipt;
  try {
    [tx, receipt] = await Promise.all([
      either((c) => c.getTransaction({ hash: h })),
      either((c) => c.getTransactionReceipt({ hash: h })),
    ]);
  } catch {
    throw new ProofError("not-found", "Transaction not found on Robinhood Chain");
  }
  if (receipt.status !== "success") throw new ProofError("reverted", "The transaction reverted; nothing was executed");
  const block = Number(receipt.blockNumber);
  const sender = lc(tx.from);
  const notes: string[] = [];
  const decoded = decodeLogs(receipt.logs);

  const fee = receipt.gasUsed * receipt.effectiveGasPrice + ((receipt as { l1Fee?: bigint }).l1Fee ?? 0n);
  const balances = new Map<Address, Promise<bigint | null>>();
  const rawDelta = (who: Address) => {
    let p = balances.get(who);
    if (!p) {
      p = Promise.all([
        archive.getBalance({ address: who, blockNumber: BigInt(block - 1) }),
        archive.getBalance({ address: who, blockNumber: BigInt(block) }),
      ])
        .then(([before, after]) => after - before)
        .catch((e: Error) => {
          throw new ProofError(
            "rpc-failed",
            `The archive RPC did not answer a balance read at block ${block}: ${String(e.message).split("\n")[0]!.slice(0, 160)}`,
          );
        });
      balances.set(who, p);
    }
    return p;
  };
  const trade = await findTrade({
    sender,
    txTo: tx.to ? lc(tx.to) : null,
    txValue: tx.value,
    decoded,
    ethDelta: async (who, isSender) => {
      const d = await rawDelta(who);
      return d === null ? null : d + (isSender ? fee + tx.value : 0n);
    },
  });
  if (!trade)
    throw new ProofError(
      "unreadable",
      "No single token-in → token-out swap for the sender, or for an address the Universal Router paid out to",
    );
  const { swap } = trade;
  if (trade.measuredFor === "router-recipient")
    notes.push(
      `Sent by ${getAddress(sender)}; measured for ${getAddress(trade.trader)}, the address the Universal Router paid out to.`,
    );
  if (trade.valueAsInput) notes.push("The ETH sent with the transaction is counted as the recipient's input.");
  if (swap.ethInInferred) notes.push("ETH paid is inferred from the trader's balance drop across the block.");
  if (swap.ethOutInferred) notes.push("ETH received is inferred from the trader's balance change across the block.");
  if (swap.multi) notes.push("More than one token moved for the trader; the largest outflow and inflow are compared.");

  const keys = await poolKeys(read, decoded.v4Pools);
  const venuesUsed: ProofOfExecution["venuesUsed"] = decoded.swapEvents.map(({ venue, pool }) => {
    if (venue === "v3") return { venue, pool, hooked: false, hook: null, key: null };
    const key = keys.get(pool as Hex) ?? null;
    return {
      venue,
      pool,
      hooked: key ? !isHookFree(key) : null,
      hook: key && !isHookFree(key) ? (getAddress(key.hooks) as Address) : null,
      key,
    };
  });
  if (!venuesUsed.length) notes.push("No Uniswap v3 or v4 Swap event in this transaction.");

  const [tIn, tOut, blk] = await Promise.all([
    tokenInfo(read, swap.tokenIn),
    tokenInfo(read, swap.tokenOut),
    either((c) => c.getBlock({ blockNumber: BigInt(block) })),
  ]);

  const touched = [...keys.values()].filter((k): k is PoolKey => !!k);
  const extra = (opts.extraPools ?? []).filter(isHookFree);
  if ((opts.extraPools ?? []).length > extra.length) notes.push("Hooked pools passed as extra pools were ignored.");
  const baselineBlock = block - 1;
  const ctx: QuoteContext = {
    client: archive,
    blockNumber: BigInt(baselineBlock),
    extraKeys: [...touched.filter(isHookFree), ...extra],
  };
  let baseline: ProofOfExecution["baseline"] = null;
  let best: bigint | null = null;
  try {
    const plans = await bestPlans(ctx, swap.tokenIn, swap.tokenOut, swap.amountIn);
    const p = plans[0];
    if (p) {
      best = p.out;
      baseline = {
        amountOut: formatUnits(p.out, tOut.decimals),
        amountOutRaw: p.out.toString(),
        kind: p.kind,
        legs: p.legs.map((l) => ({
          shareBps: Number((l.amountIn * 10_000n) / swap.amountIn),
          hops: l.cands.map((c) => c.label),
        })),
      };
    }
  } catch (e) {
    notes.push(
      `Baseline quote at block ${baselineBlock} failed: ${String((e as Error).message)
        .split("\n")[0]!
        .slice(0, 160)}`,
    );
  }
  if (!baseline) notes.push("No Uniswap-only route could be priced at the block before this trade.");

  let gap: ProofOfExecution["gap"] = null;
  if (best !== null) {
    const raw = swap.amountOut - best;
    const bps = gapBps(swap.amountOut, best);
    let price: NonNullable<ProofOfExecution["gap"]>["price"] = null;
    if (opts.usd !== false) {
      try {
        const priceBlock = opts.priceBlock ?? (await read.getBlockNumber());
        price = await usdPrice(
          { client: read, blockNumber: priceBlock, extraKeys: touched },
          swap.tokenOut,
          tOut.decimals,
        );
      } catch {
        price = null;
      }
      if (!price) notes.push(`No price for ${tOut.symbol} today, so the gap is not shown in USD.`);
    }
    const amount = formatUnits(raw, tOut.decimals);
    gap = { raw: raw.toString(), amount, bps, usd: price ? Number(amount) * price.usd : null, price };
  }

  return {
    spec: SPEC_VERSION,
    chainId: CHAIN_ID,
    tx: h,
    block,
    timestamp: Number(blk.timestamp),
    sender: getAddress(sender) as Address,
    trader: getAddress(trade.trader) as Address,
    measuredFor: trade.measuredFor,
    to: tx.to ? (getAddress(tx.to) as Address) : null,
    viaUniversalRouter: !!tx.to && lc(tx.to) === lc(RHC.universalRouter),
    tokenIn: tIn,
    tokenOut: tOut,
    amountIn: formatUnits(swap.amountIn, tIn.decimals),
    amountInRaw: swap.amountIn.toString(),
    received: formatUnits(swap.amountOut, tOut.decimals),
    receivedRaw: swap.amountOut.toString(),
    baseline,
    baselineBlock,
    gap,
    verdict: verdictFor(gap ? gap.bps : null),
    venuesUsed,
    poolList: { ...POOL_LIST },
    notes,
  };
}
