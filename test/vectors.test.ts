import { describe, expect, it } from "vitest";
import { poolIdOf, ProofError, replayRpc, verifyExecution } from "../src/index.js";
import { vectors } from "./helpers.js";

describe("golden vectors (offline replay of real Robinhood Chain transactions)", () => {
  it("has the recorded set", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(8);
  });

  for (const v of vectors) {
    it(`${v.name}: ${v.description}`, async () => {
      const run = verifyExecution(v.tx, { request: replayRpc(v.rpc), priceBlock: BigInt(v.priceBlock) });
      if ("error" in v.expected) {
        await expect(run).rejects.toBeInstanceOf(ProofError);
        await expect(run).rejects.toMatchObject({ code: v.expected.error, message: v.expected.message });
        return;
      }
      const proof = await run;
      expect(JSON.parse(JSON.stringify(proof))).toEqual(v.expected);
    });
  }

  it("every resolved v4 venue key hashes to its pool id", () => {
    let checked = 0;
    for (const v of vectors) {
      const venues = (v.expected.venuesUsed ?? []) as {
        venue: string;
        pool: string;
        key: null | Parameters<typeof poolIdOf>[0];
      }[];
      for (const u of venues)
        if (u.venue === "v4" && u.key) {
          expect(poolIdOf(u.key)).toBe(u.pool);
          checked++;
        }
    }
    expect(checked).toBeGreaterThan(3);
  });

  it("matches the gap fields to the raw amounts", () => {
    for (const v of vectors) {
      const e = v.expected as {
        receivedRaw?: string;
        baseline?: { amountOutRaw: string } | null;
        gap?: { raw: string } | null;
      };
      if (!e.baseline || !e.gap || !e.receivedRaw) continue;
      expect(BigInt(e.gap.raw)).toBe(BigInt(e.receivedRaw) - BigInt(e.baseline.amountOutRaw));
    }
  });
});
