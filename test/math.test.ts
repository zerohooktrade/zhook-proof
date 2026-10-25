import { describe, expect, it } from "vitest";
import {
  gapBps,
  hubsFor,
  listedPoolById,
  listedPools,
  MATCH_BAND_BPS,
  NATIVE,
  poolIdOf,
  POOL_LIST,
  RHC,
  sortCurrencies,
  verdictFor,
  type Address,
} from "../src/index.js";

const USDG = RHC.usdg as Address;
const WETH = RHC.weth as Address;
const TOKEN = "0x5199ea953d71d6a5413be1b2efecd26aacab0000" as Address;

describe("gap and verdict", () => {
  it("expresses the gap in bps, truncated to 2 decimals", () => {
    expect(gapBps(1_0142n, 1_0000n)).toBe(142);
    expect(gapBps(100_001_42n, 100_000_00n)).toBe(0.14);
    expect(gapBps(9_995_555n, 10_000_000n)).toBe(-4.44);
    expect(gapBps(99_995_55n, 100_000_00n)).toBe(-0.44);
    expect(gapBps(5n, 5n)).toBe(0);
    expect(() => gapBps(1n, 0n)).toThrow();
  });

  it("treats ±1 bps as matched", () => {
    expect(MATCH_BAND_BPS).toBe(1);
    expect(verdictFor(1)).toBe("matched");
    expect(verdictFor(-1)).toBe("matched");
    expect(verdictFor(1.01)).toBe("better");
    expect(verdictFor(-1.01)).toBe("worse");
    expect(verdictFor(null)).toBe("no-baseline");
  });
});

describe("pool set", () => {
  it("hashes pool keys like v4-core", () => {
    const key = {
      currency0: NATIVE,
      currency1: USDG.toLowerCase() as Address,
      fee: 500,
      tickSpacing: 10,
      hooks: NATIVE,
    };
    expect(poolIdOf(key)).toMatch(/^0x[0-9a-f]{64}$/);
    expect(poolIdOf(key)).toBe(poolIdOf({ ...key }));
  });

  it("sorts currencies numerically", () => {
    expect(sortCurrencies(USDG, NATIVE)).toEqual([NATIVE, USDG.toLowerCase()]);
    expect(sortCurrencies(WETH, USDG)).toEqual([WETH, USDG.toLowerCase()]);
  });

  it("ships a hook-free pool list, looked up in either order and by id", () => {
    expect(POOL_LIST.pools).toBeGreaterThan(1000);
    const a = listedPools(NATIVE, USDG);
    expect(a.length).toBeGreaterThan(0);
    expect(listedPools(USDG, NATIVE)).toEqual(a);
    for (const k of a) expect(k.hooks).toBe(NATIVE);
    expect(listedPoolById(poolIdOf(a[0]!))).toEqual(a[0]);
    expect(listedPoolById("0x" + "00".repeat(32))).toBeNull();
  });

  it("routes two hops through USDG and ETH, never through an endpoint", () => {
    expect(hubsFor(TOKEN, WETH)).toEqual([USDG.toLowerCase()]);
    expect(hubsFor(NATIVE, TOKEN)).toEqual([USDG.toLowerCase()]);
    expect(hubsFor(USDG.toLowerCase() as Address, TOKEN)).toEqual([NATIVE]);
    expect(hubsFor(TOKEN, "0x00000000000000000000000000000000000000b2")).toEqual([USDG.toLowerCase(), NATIVE]);
  });
});
