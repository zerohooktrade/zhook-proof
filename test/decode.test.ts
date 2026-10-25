import { describe, expect, it } from "vitest";
import {
  decodeLogs,
  findTrade,
  NATIVE,
  readSwap,
  RHC,
  TRANSFER_TOPIC,
  V3_SWAP_TOPIC,
  V4_SWAP_TOPIC,
  type Address,
  type LogLike,
} from "../src/index.js";
import { topic, word } from "./helpers.js";

const UR = RHC.universalRouter as Address;
const PM = RHC.v4.poolManager as Address;
const A = "0x00000000000000000000000000000000000000a1" as Address;
const B = "0x00000000000000000000000000000000000000b2" as Address;
const SENDER = "0x1111111111111111111111111111111111111111" as Address;
const ACCOUNT = "0x2222222222222222222222222222222222222222" as Address;
const POOL = "0x3333333333333333333333333333333333333333" as Address;

const transfer = (token: Address, from: Address, to: Address, v: bigint): LogLike => ({
  address: token,
  topics: [TRANSFER_TOPIC, topic(from), topic(to)],
  data: word(v),
});
const v4Swap = (id: string): LogLike => ({ address: PM, topics: [V4_SWAP_TOPIC, id, topic(UR)], data: "0x" });
const v3Swap = (pool: Address): LogLike => ({
  address: pool,
  topics: [V3_SWAP_TOPIC, topic(UR), topic(UR)],
  data: "0x",
});
const none = async () => null;

describe("decodeLogs", () => {
  it("nets flows per address and token", () => {
    const d = decodeLogs([
      transfer(A, SENDER, UR, 100n),
      transfer(A, UR, PM, 100n),
      transfer(B, PM, UR, 7n),
      transfer(B, UR, SENDER, 7n),
    ]);
    expect(d.flows.get(SENDER)?.get(A)).toBe(-100n);
    expect(d.flows.get(SENDER)?.get(B)).toBe(7n);
    expect(d.flows.get(UR as Address)?.get(A)).toBe(0n);
  });

  it("lists router payouts but not the PoolManager, the zero address or a swapping pool", () => {
    const d = decodeLogs([
      transfer(A, UR, PM, 1n),
      transfer(A, UR, NATIVE, 1n),
      transfer(A, UR, POOL, 1n),
      v3Swap(POOL),
      transfer(B, UR, ACCOUNT, 1n),
      transfer(B, UR, ACCOUNT, 1n),
    ]);
    expect(d.routerPaid).toEqual([ACCOUNT]);
  });

  it("keeps swap events in log order", () => {
    const id = "0x" + "ab".repeat(32);
    const d = decodeLogs([v3Swap(POOL), v4Swap(id), v3Swap(POOL)]);
    expect(d.swapEvents).toEqual([
      { venue: "v3", pool: POOL },
      { venue: "v4", pool: id },
      { venue: "v3", pool: POOL },
    ]);
    expect(d.v4Pools).toEqual([id]);
  });

  it("ignores Swap events that do not come from the PoolManager and 4-topic transfers", () => {
    const d = decodeLogs([
      { address: POOL, topics: [V4_SWAP_TOPIC, "0x" + "cd".repeat(32)], data: "0x" },
      { address: A, topics: [TRANSFER_TOPIC, topic(SENDER), topic(UR), word(5n)], data: "0x" },
    ]);
    expect(d.v4Pools).toEqual([]);
    expect(d.flows.size).toBe(0);
  });
});

describe("readSwap", () => {
  it("takes the largest outflow and inflow", async () => {
    const d = decodeLogs([transfer(A, SENDER, UR, 100n), transfer(B, UR, SENDER, 40n), transfer(B, UR, SENDER, 2n)]);
    const s = await readSwap(d.flows, SENDER, 0n, none);
    expect(s).toMatchObject({ tokenIn: A, amountIn: 100n, tokenOut: B, amountOut: 42n, multi: false });
  });

  it("uses ETH input from value and flags multi-token moves", async () => {
    const d = decodeLogs([transfer(A, UR, SENDER, 5n), transfer(B, UR, SENDER, 9n)]);
    const s = await readSwap(d.flows, SENDER, 3n, none);
    expect(s).toMatchObject({ tokenIn: NATIVE, amountIn: 3n, tokenOut: B, amountOut: 9n, multi: true });
  });

  it("infers ETH output only for an ERC-20 input", async () => {
    const d = decodeLogs([transfer(A, SENDER, UR, 100n)]);
    expect(await readSwap(d.flows, SENDER, 0n, async () => 50n)).toMatchObject({
      tokenOut: NATIVE,
      amountOut: 50n,
      ethOutInferred: true,
    });
    expect(await readSwap(d.flows, SENDER, 0n, async () => 0n)).toBeNull();
    expect(await readSwap(d.flows, SENDER, 0n, none)).toBeNull();
  });

  it("returns null when nothing was paid", async () => {
    const d = decodeLogs([transfer(B, UR, SENDER, 9n)]);
    expect(await readSwap(d.flows, SENDER, 0n, none)).toBeNull();
  });
});

describe("findTrade", () => {
  it("prefers the sender", async () => {
    const decoded = decodeLogs([transfer(A, SENDER, UR, 100n), transfer(B, UR, SENDER, 7n)]);
    const t = await findTrade({ sender: SENDER, txTo: UR, txValue: 0n, decoded, ethDelta: none });
    expect(t).toMatchObject({ trader: SENDER, measuredFor: "sender" });
  });

  it("falls back to the router payout recipient (smart accounts, aggregators)", async () => {
    const decoded = decodeLogs([transfer(A, ACCOUNT, UR, 100n), transfer(B, UR, ACCOUNT, 7n)]);
    const t = await findTrade({
      sender: SENDER,
      txTo: "0x0000000071727de22e5e9d8baf0edac6f37da032",
      txValue: 0n,
      decoded,
      ethDelta: none,
    });
    expect(t).toMatchObject({ trader: ACCOUNT, measuredFor: "router-recipient", valueAsInput: false });
    expect(t?.swap).toMatchObject({ tokenIn: A, tokenOut: B });
  });

  it("counts tx.value as the recipient's input only when the transaction called the router", async () => {
    const decoded = decodeLogs([transfer(B, UR, ACCOUNT, 7n)]);
    const viaRouter = await findTrade({ sender: SENDER, txTo: UR, txValue: 10n, decoded, ethDelta: async () => 0n });
    expect(viaRouter).toMatchObject({ trader: ACCOUNT, valueAsInput: true, swap: { tokenIn: NATIVE, amountIn: 10n } });
    const elsewhere = await findTrade({ sender: SENDER, txTo: POOL, txValue: 10n, decoded, ethDelta: async () => 0n });
    expect(elsewhere).toBeNull();
  });

  it("uses the recipient's own ETH balance drop as its input", async () => {
    const decoded = decodeLogs([transfer(B, UR, ACCOUNT, 7n)]);
    const t = await findTrade({
      sender: SENDER,
      txTo: POOL,
      txValue: 0n,
      decoded,
      ethDelta: async (who) => (who === ACCOUNT ? -25n : 0n),
    });
    expect(t).toMatchObject({ trader: ACCOUNT, swap: { tokenIn: NATIVE, amountIn: 25n, ethInInferred: true } });
  });

  it("returns null when no address paid one token for another", async () => {
    const decoded = decodeLogs([transfer(A, UR, PM, 1n)]);
    expect(await findTrade({ sender: SENDER, txTo: UR, txValue: 0n, decoded, ethDelta: none })).toBeNull();
  });
});
