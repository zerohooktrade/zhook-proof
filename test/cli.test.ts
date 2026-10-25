import { describe, expect, it } from "vitest";
import { replayRpc } from "../src/index.js";
import { run, USAGE, VERSION } from "../src/run.js";
import { vector } from "./helpers.js";

const io = () => {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) } };
};

describe("cli", () => {
  it("prints help and version", async () => {
    const a = io();
    expect(await run(["--help"], a.io)).toBe(0);
    expect(a.out[0]).toBe(USAGE);
    const b = io();
    expect(await run(["--version"], b.io)).toBe(0);
    expect(b.out[0]).toBe(VERSION);
    const c = io();
    expect(await run([], c.io)).toBe(2);
  });

  it("rejects bad usage with exit code 2", async () => {
    for (const argv of [
      ["measure"],
      ["verify"],
      ["verify", "0x1234"],
      ["verify", "0x" + "1".repeat(64), "--bogus"],
      ["verify", "0x" + "1".repeat(64), "--pool", "x"],
    ]) {
      const a = io();
      expect(await run(argv, a.io)).toBe(2);
      expect(a.err.join("\n")).toContain("Usage");
    }
  });

  it("prints the proof as JSON from a replayed vector", async () => {
    const v = vector("ur-eth-to-token-two-hop");
    const a = io();
    const code = await run(["verify", v.tx, "--json"], a.io, {
      request: replayRpc(v.rpc),
      priceBlock: BigInt(v.priceBlock),
    });
    expect(code).toBe(0);
    expect(JSON.parse(a.out[0]!)).toEqual(v.expected);
  });

  it("prints a readable report", async () => {
    const v = vector("ur-worse-than-baseline");
    const a = io();
    expect(await run(["verify", v.tx], a.io, { request: replayRpc(v.rpc), priceBlock: BigInt(v.priceBlock) })).toBe(0);
    const text = a.out[0]!;
    expect(text).toContain("Received less than the best Uniswap-only route");
    expect(text).toContain("bps");
    expect(text).toContain(v.tx);
  });

  it("exits 1 with the reason when a swap cannot be measured", async () => {
    const v = vector("unmeasurable-aggregator");
    const a = io();
    expect(
      await run(["verify", v.tx, "--json"], a.io, { request: replayRpc(v.rpc), priceBlock: BigInt(v.priceBlock) }),
    ).toBe(1);
    expect(JSON.parse(a.out[0]!)).toMatchObject({ error: "unreadable" });
  });
});
