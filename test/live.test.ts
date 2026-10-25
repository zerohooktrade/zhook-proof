/**
 * Live checks against a real RPC. Skipped unless RPC_URL is set, e.g.
 *   RPC_URL=https://robinhood.drpc.org pnpm test:live
 * The URL must serve state at past blocks (archive). State at a past block never changes, so the baseline must
 * equal the recorded vector exactly.
 */
import { describe, expect, it } from "vitest";
import { DEFAULT_RPCS, verifyExecution } from "../src/index.js";
import { vector } from "./helpers.js";

const url = process.env.RPC_URL;

describe.skipIf(!url)("live (RPC_URL)", () => {
  for (const name of ["ur-eth-to-token-two-hop", "ur-token-to-eth-inferred"]) {
    it(`re-measures ${name} from the chain`, { timeout: 180_000 }, async () => {
      const v = vector(name);
      const proof = await verifyExecution(v.tx, {
        rpcUrls: [url!, ...DEFAULT_RPCS.read],
        archiveUrls: [url!, ...DEFAULT_RPCS.archive],
        usd: false,
      });
      const e = v.expected as { receivedRaw: string; baseline: unknown; trader: string; verdict: string };
      expect(proof.receivedRaw).toBe(e.receivedRaw);
      expect(proof.trader).toBe(e.trader);
      expect(proof.baseline).toEqual(e.baseline);
      expect(proof.verdict).toBe(e.verdict);
    });
  }
});
