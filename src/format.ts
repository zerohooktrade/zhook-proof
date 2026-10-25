import { explorerTx } from "./chain.js";
import type { ProofOfExecution } from "./verify.js";

const VERDICT: Record<ProofOfExecution["verdict"], string> = {
  better: "Beat the best Uniswap-only route",
  matched: "Matched the best Uniswap-only route",
  worse: "Received less than the best Uniswap-only route",
  "no-baseline": "No baseline could be priced",
};

const num = (s: string, digits = 8) => {
  const n = Number(s);
  if (!Number.isFinite(n)) return s;
  return n.toLocaleString("en-US", { maximumSignificantDigits: digits });
};

/** Plain-text report of a proof, as printed by the CLI. */
export function formatProof(p: ProofOfExecution): string {
  const lines: string[] = [];
  const sign = (n: number) => (n >= 0 ? "+" : "−");
  lines.push(`Proof of Execution · ${p.spec}`);
  lines.push(`${VERDICT[p.verdict]}${p.gap ? ` · ${sign(p.gap.bps)}${Math.abs(p.gap.bps).toFixed(2)} bps` : ""}`);
  lines.push("");
  lines.push(`Transaction   ${p.tx}`);
  lines.push(`Block         ${p.block.toLocaleString("en-US")} (${new Date(p.timestamp * 1000).toISOString()})`);
  lines.push(`Measured for  ${p.trader}${p.measuredFor === "router-recipient" ? " (router payout recipient)" : ""}`);
  lines.push(`Paid          ${num(p.amountIn)} ${p.tokenIn.symbol}`);
  lines.push(`Received      ${num(p.received)} ${p.tokenOut.symbol}`);
  if (p.baseline) {
    lines.push(
      `Baseline      ${num(p.baseline.amountOut)} ${p.tokenOut.symbol} at block ${p.baselineBlock.toLocaleString("en-US")}`,
    );
    for (const l of p.baseline.legs)
      lines.push(`              ${(l.shareBps / 100).toFixed(0)}% via ${l.hops.join(" → ")}`);
  } else {
    lines.push(`Baseline      none at block ${p.baselineBlock.toLocaleString("en-US")}`);
  }
  if (p.gap) {
    const usd =
      p.gap.usd === null
        ? ""
        : ` · ≈ ${sign(p.gap.usd)}$${Math.abs(p.gap.usd).toLocaleString("en-US", { maximumSignificantDigits: 4 })} at today's price`;
    const amt = Number(p.gap.amount);
    lines.push(`Gap           ${sign(amt)}${num(String(Math.abs(amt)), 6)} ${p.tokenOut.symbol}${usd}`);
  }
  if (p.venuesUsed.length) {
    lines.push("");
    lines.push("Pools the trade touched");
    for (const v of p.venuesUsed.slice(0, 12))
      lines.push(
        `  ${v.venue}  ${v.pool}${v.hooked ? `  hook ${v.hook}` : v.hooked === null ? "  (key unknown)" : ""}`,
      );
  }
  if (p.notes.length) {
    lines.push("");
    for (const n of p.notes) lines.push(`· ${n}`);
  }
  lines.push("");
  lines.push(explorerTx(p.tx));
  return lines.join("\n");
}
