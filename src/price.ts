/**
 * Today's USD price of a token (SPEC 5): the best rate for a small probe of the token into USDG, either directly
 * or through ETH. USDG counts as 1 USD. Prices are read at one block and never modelled.
 */
import { formatUnits } from "viem";
import { isNative, lc, NATIVE, RHC, type Address } from "./chain.js";
import { candidates, quoteMany, type QuoteContext } from "./quote.js";

const USDG = lc(RHC.usdg);
const WETH = lc(RHC.weth);

export interface UsdPrice {
  /** USD per whole token. */
  usd: number;
  via: "par" | "usdg" | "eth";
  venue: string;
  block: number;
}

/**
 * Best output per whole input token on one hop a → b. Probe sizes go from 1/1000 of a token up to 1M tokens; the
 * smallest size whose output has at least 5 significant digits (raw output ≥ 10,000) wins, so price impact stays
 * negligible and a cheap token is not rounded to dust.
 */
export async function directRate(
  ctx: QuoteContext,
  a: Address,
  b: Address,
  decIn: number,
  decOut: number,
): Promise<{ rate: number; venue: string } | null> {
  const cands = await candidates(ctx, a, b);
  if (!cands.length) return null;
  const unit = 10n ** BigInt(decIn);
  const sizes = [decIn >= 3 ? unit / 1000n : 1n, unit, unit * 1000n, unit * 1_000_000n];
  const outs = await quoteMany(
    ctx,
    cands.flatMap((c) => sizes.map((amountIn) => ({ hop: c.hop, amountIn }))),
  );
  let fallback: { rate: number; venue: string } | null = null;
  for (let s = 0; s < sizes.length; s++) {
    let best: { rate: number; venue: string } | null = null;
    for (let i = 0; i < cands.length; i++) {
      const o = outs[i * sizes.length + s];
      if (!o || o <= 0n) continue;
      const rate = Number(formatUnits(o, decOut)) / Number(formatUnits(sizes[s]!, decIn));
      if (o >= 10_000n && (!best || rate > best.rate)) best = { rate, venue: cands[i]!.label };
      if (!fallback) fallback = { rate, venue: cands[i]!.label };
    }
    if (best) return best;
  }
  return fallback;
}

/** USD per whole token at ctx.blockNumber, or null when no pool in the candidate set prices it. */
export async function usdPrice(ctx: QuoteContext, token: Address, decimals: number): Promise<UsdPrice | null> {
  const a = lc(token);
  const block = Number(ctx.blockNumber);
  if (a === USDG) return { usd: 1, via: "par", venue: "USDG = 1 USD", block };
  const eth = await directRate(ctx, NATIVE, USDG, 18, 6);
  if (isNative(a) || a === WETH) return eth ? { usd: eth.rate, via: "usdg", venue: eth.venue, block } : null;
  const [d, e] = await Promise.all([
    directRate(ctx, a, USDG, decimals, 6).catch(() => null),
    directRate(ctx, a, NATIVE, decimals, 18).catch(() => null),
  ]);
  const viaEth = e && eth ? { rate: e.rate * eth.rate, venue: e.venue } : null;
  if (d && (!viaEth || d.rate >= viaEth.rate)) return { usd: d.rate, via: "usdg", venue: d.venue, block };
  if (viaEth) return { usd: viaEth.rate, via: "eth", venue: viaEth.venue, block };
  return null;
}
