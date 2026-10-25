/**
 * Minimal Uniswap quoting at a block: v3 QuoterV2 and v4 V4Quoter through Multicall3, plus the three route shapes
 * the baseline allows (single pool, two-way split, two hops through a hub). See SPEC.md section 4.
 */
import { parseAbi, type PublicClient } from "viem";
import { isNative, lc, NATIVE, RHC, V3_FEES, V4_STANDARD_KEYS, type Address, type Hex } from "./chain.js";
import { feeLabel, isHookFree, listedPools, poolIdOf, sortCurrencies, type PoolKey } from "./pools.js";

const WETH = lc(RHC.weth);
const USDG = lc(RHC.usdg);

const v3QuoterAbi = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) view returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
]);
const v4QuoterAbi = parseAbi([
  "struct PoolKey { address currency0; address currency1; uint24 fee; int24 tickSpacing; address hooks; }",
  "struct QuoteExactSingleParams { PoolKey poolKey; bool zeroForOne; uint128 exactAmount; bytes hookData; }",
  "function quoteExactInputSingle(QuoteExactSingleParams params) view returns (uint256 amountOut, uint256 gasEstimate)",
]);
const factoryAbi = parseAbi(["function getPool(address, address, uint24) view returns (address)"]);
const stateViewAbi = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);

/** Where quotes are read: a client and, for the baseline, a past block. */
export interface QuoteContext {
  client: PublicClient;
  blockNumber: bigint;
  /** Pool keys added to the candidate set for every pair they match (hook-free for the baseline). */
  extraKeys?: PoolKey[];
}

export type Hop =
  | { venue: "v3"; pool: Address; tokenIn: Address; tokenOut: Address; fee: number }
  | { venue: "v4"; poolId: Hex; key: PoolKey; zeroForOne: boolean };

export interface Candidate {
  label: string;
  venue: "v3" | "v4";
  hooked: boolean;
  hop: Hop;
}

export interface Plan {
  kind: "single" | "split" | "multi-hop";
  out: bigint;
  legs: { amountIn: bigint; amountOut: bigint; cands: Candidate[] }[];
}

/** Hook-free v4 pools kept per pair after the liquidity read (deepest first). */
export const MAX_V4_PER_PAIR = 16;
/** Quotes per Multicall3 eth_call: a deep quote can use millions of gas and nodes cap eth_call gas. */
const CHUNK = 4;
/** Concurrent eth_calls per quote round. */
const PARALLEL = 3;

const hopIn = (h: Hop): Address => (h.venue === "v3" ? h.tokenIn : h.zeroForOne ? h.key.currency0 : h.key.currency1);

async function mapLimit<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const k = i++;
        out[k] = await fn(items[k]!);
      }
    }),
  );
  return out;
}

function v4Label(key: PoolKey) {
  const hooked = !isHookFree(key);
  return `Uniswap v4 · ${feeLabel(key.fee)}${hooked ? ` · hook ${key.hooks.slice(0, 6)}…${key.hooks.slice(-4)}` : ""}`;
}

/**
 * Every pool that can carry a → b in one hop at the context block (SPEC 3):
 *  - v3: the factory pool at each enabled fee tier (ETH is WETH in v3);
 *  - v4: bundled hook-free pools of the pair, the four standard hook-free keys, and ctx.extraKeys, in every
 *    currency form (ETH native and WETH), initialized with liquidity > 0 at the block, deepest 16 kept.
 */
export async function candidates(ctx: QuoteContext, a: Address, b: Address): Promise<Candidate[]> {
  a = lc(a);
  b = lc(b);
  const out: Candidate[] = [];
  const va = isNative(a) ? WETH : a;
  const vb = isNative(b) ? WETH : b;
  if (va !== vb) {
    const pools = await ctx.client.multicall({
      contracts: V3_FEES.map((fee) => ({
        address: RHC.v3.factory,
        abi: factoryAbi,
        functionName: "getPool" as const,
        args: [va, vb, fee] as const,
      })),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });
    pools.forEach((r, i) => {
      const fee = V3_FEES[i]!;
      if (r.status === "success" && !/^0x0{40}$/i.test(r.result))
        out.push({
          label: `Uniswap v3 · ${fee / 10_000}%`,
          venue: "v3",
          hooked: false,
          hop: { venue: "v3", pool: lc(r.result), tokenIn: va, tokenOut: vb, fee },
        });
    });
  }

  const formsA = isNative(a) ? [NATIVE, WETH] : a === WETH ? [WETH, NATIVE] : [a];
  const formsB = isNative(b) ? [NATIVE, WETH] : b === WETH ? [WETH, NATIVE] : [b];
  const keys = new Map<string, { key: PoolKey; currencyIn: Address }>();
  for (const fa of formsA)
    for (const fb of formsB) {
      if (fa === fb) continue;
      const [c0, c1] = sortCurrencies(fa, fb);
      const std = V4_STANDARD_KEYS.map(([fee, tickSpacing]): PoolKey => ({
        currency0: c0,
        currency1: c1,
        fee,
        tickSpacing,
        hooks: NATIVE,
      }));
      const extra = (ctx.extraKeys ?? []).filter((k) => lc(k.currency0) === c0 && lc(k.currency1) === c1);
      for (const key of [...listedPools(c0, c1), ...std, ...extra]) {
        const norm = { ...key, currency0: lc(key.currency0), currency1: lc(key.currency1), hooks: lc(key.hooks) };
        const id = poolIdOf(norm);
        if (!keys.has(id)) keys.set(id, { key: norm, currencyIn: fa });
      }
    }
  if (keys.size) {
    const ids = [...keys.keys()] as Hex[];
    const reads = await ctx.client.multicall({
      contracts: ids.flatMap((id) => [
        { address: RHC.v4.stateView, abi: stateViewAbi, functionName: "getSlot0" as const, args: [id] as const },
        { address: RHC.v4.stateView, abi: stateViewAbi, functionName: "getLiquidity" as const, args: [id] as const },
      ]),
      allowFailure: true,
      blockNumber: ctx.blockNumber,
    });
    const live: { id: Hex; liquidity: bigint }[] = [];
    ids.forEach((id, i) => {
      const s = reads[i * 2];
      const l = reads[i * 2 + 1];
      if (s?.status !== "success" || l?.status !== "success") return;
      const sqrt = (s.result as readonly [bigint, number, number, number])[0];
      const liquidity = l.result as bigint;
      if (sqrt > 0n && liquidity > 0n) live.push({ id, liquidity });
    });
    live.sort((x, y) => (y.liquidity > x.liquidity ? 1 : y.liquidity < x.liquidity ? -1 : x.id < y.id ? -1 : 1));
    const hookFree = live.filter((p) => isHookFree(keys.get(p.id)!.key)).slice(0, MAX_V4_PER_PAIR);
    const hooked = live.filter((p) => !isHookFree(keys.get(p.id)!.key));
    for (const p of [...hookFree, ...hooked]) {
      const { key, currencyIn } = keys.get(p.id)!;
      out.push({
        label: v4Label(key),
        venue: "v4",
        hooked: !isHookFree(key),
        hop: { venue: "v4", poolId: p.id, key, zeroForOne: key.currency0 === currencyIn },
      });
    }
  }
  return out;
}

/** Quotes (hop, amountIn) pairs at the context block. null = reverted or no liquidity. */
export async function quoteMany(ctx: QuoteContext, reqs: { hop: Hop; amountIn: bigint }[]): Promise<(bigint | null)[]> {
  if (!reqs.length) return [];
  const contract = ({ hop, amountIn }: { hop: Hop; amountIn: bigint }) =>
    hop.venue === "v3"
      ? {
          address: RHC.v3.quoterV2,
          abi: v3QuoterAbi,
          functionName: "quoteExactInputSingle" as const,
          args: [
            { tokenIn: hop.tokenIn, tokenOut: hop.tokenOut, amountIn, fee: hop.fee, sqrtPriceLimitX96: 0n },
          ] as const,
        }
      : {
          address: RHC.v4.quoter,
          abi: v4QuoterAbi,
          functionName: "quoteExactInputSingle" as const,
          args: [
            { poolKey: hop.key, zeroForOne: hop.zeroForOne, exactAmount: amountIn, hookData: "0x" as Hex },
          ] as const,
        };
  const groups: { hop: Hop; amountIn: bigint }[][] = [];
  for (let i = 0; i < reqs.length; i += CHUNK) groups.push(reqs.slice(i, i + CHUNK));
  const res = await mapLimit(groups, PARALLEL, async (g) => {
    if (g.some((r) => r.amountIn <= 0n || r.amountIn >= 2n ** 128n)) return g.map(() => null);
    try {
      const r = await ctx.client.multicall({
        contracts: g.map(contract),
        allowFailure: true,
        blockNumber: ctx.blockNumber,
        batchSize: 0,
      });
      return r.map((x) => (x.status === "success" ? (x.result as readonly bigint[])[0]! : null));
    } catch {
      return g.map(() => null);
    }
  });
  return res.flat();
}

/** Hubs for two-hop routes: USDG and ETH, unless the pair already contains them (SPEC 4.3). */
export const hubsFor = (a: Address, b: Address): Address[] =>
  [USDG, NATIVE].filter(
    (h) =>
      h !== a &&
      h !== b &&
      !(h === NATIVE && (a === WETH || b === WETH)) &&
      !(isNative(h) && (isNative(a) || isNative(b))),
  );

const byOut = (x: { out: bigint | null }, y: { out: bigint | null }) => ((y.out ?? -1n) > (x.out ?? -1n) ? 1 : -1);

/**
 * Best plans for amountIn of a → b at the context block, best first: the best single pool, the best 10 %-step split
 * between the two best single pools, and two-hop routes through each hub (SPEC 4).
 */
export async function bestPlans(ctx: QuoteContext, a: Address, b: Address, amountIn: bigint): Promise<Plan[]> {
  a = lc(a);
  b = lc(b);
  const direct = await candidates(ctx, a, b);
  const directOut = await quoteMany(
    ctx,
    direct.map((c) => ({ hop: c.hop, amountIn })),
  );
  const ok = direct
    .map((c, i) => ({ c, out: directOut[i] ?? null }))
    .filter((p): p is { c: Candidate; out: bigint } => p.out !== null && p.out > 0n)
    .sort(byOut);
  const plans: Plan[] = [];
  if (ok[0])
    plans.push({ kind: "single", out: ok[0].out, legs: [{ amountIn, amountOut: ok[0].out, cands: [ok[0].c] }] });

  // The router cannot unwrap part of a WETH balance, so WETH input never splits into a native-ETH pool.
  const splittable = ok.filter((p) => !(a === WETH && isNative(hopIn(p.c.hop))));
  const [x, y] = splittable;
  if (x && y) {
    const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const reqs = steps.flatMap((s) => {
      const a1 = (amountIn * BigInt(s)) / 10n;
      return [
        { hop: x.c.hop, amountIn: a1 },
        { hop: y.c.hop, amountIn: amountIn - a1 },
      ];
    });
    const outs = await quoteMany(ctx, reqs);
    let best: Plan | null = null;
    steps.forEach((_s, si) => {
      const o1 = outs[si * 2];
      const o2 = outs[si * 2 + 1];
      if (!o1 || !o2) return;
      const a1 = reqs[si * 2]!.amountIn;
      const plan: Plan = {
        kind: "split",
        out: o1 + o2,
        legs: [
          { amountIn: a1, amountOut: o1, cands: [x.c] },
          { amountIn: amountIn - a1, amountOut: o2, cands: [y.c] },
        ],
      };
      if (!best || plan.out > best.out) best = plan;
    });
    if (best) plans.push(best);
  }

  for (const h of hubsFor(a, b)) {
    const [c1, c2] = await Promise.all([candidates(ctx, a, h), candidates(ctx, h, b)]);
    if (!c1.length || !c2.length) continue;
    const o1 = await quoteMany(
      ctx,
      c1.map((c) => ({ hop: c.hop, amountIn })),
    );
    const first = c1
      .map((c, i) => ({ c, out: o1[i] ?? null }))
      .filter((p) => p.out && p.out > 0n)
      .sort(byOut)[0];
    if (!first) continue;
    const o2 = await quoteMany(
      ctx,
      c2.map((c) => ({ hop: c.hop, amountIn: first.out! })),
    );
    c2.forEach((c, i) => {
      const out = o2[i];
      if (out && out > 0n)
        plans.push({ kind: "multi-hop", out, legs: [{ amountIn, amountOut: out, cands: [first.c, c] }] });
    });
  }
  return plans.sort((p, q) => (q.out > p.out ? 1 : q.out < p.out ? -1 : 0));
}
