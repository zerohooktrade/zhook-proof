/**
 * Pure decoding of a swap transaction's receipt (SPEC 2): net ERC-20 flows per address, who the Universal Router
 * paid out to, which Uniswap pools swapped, and the single token-in → token-out trade of one address.
 */
import { keccak256, toBytes } from "viem";
import { lc, NATIVE, RHC, type Address, type Hex } from "./chain.js";

export const TRANSFER_TOPIC = keccak256(toBytes("Transfer(address,address,uint256)"));
export const V4_SWAP_TOPIC = keccak256(toBytes("Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)"));
export const V3_SWAP_TOPIC = keccak256(toBytes("Swap(address,address,int256,int256,uint160,uint128,int24)"));

export interface LogLike {
  address: string;
  topics: readonly string[];
  data: string;
}

export interface DecodedLogs {
  /** address → token → net raw amount (received minus sent) over the whole transaction. */
  flows: Map<Address, Map<Address, bigint>>;
  /**
   * Recipients of Universal Router transfers, in log order, other than the PoolManager, the zero address and any
   * pool that emitted a Swap event in the same transaction (the next hop of a route, not a payout).
   */
  routerPaid: Address[];
  /** v4 PoolManager Swap events: pool ids in log order. */
  v4Pools: Hex[];
  /** v3 Swap events: pool addresses in log order. */
  v3Pools: Address[];
  /** Every Uniswap Swap event in log order. */
  swapEvents: { venue: "v3" | "v4"; pool: string }[];
}

const topicAddress = (t: string) => lc("0x" + t.slice(26));

export function decodeLogs(logs: readonly LogLike[]): DecodedLogs {
  const flows = new Map<Address, Map<Address, bigint>>();
  const add = (who: Address, tok: Address, v: bigint) => {
    let m = flows.get(who);
    if (!m) flows.set(who, (m = new Map()));
    m.set(tok, (m.get(tok) ?? 0n) + v);
  };
  const ur = lc(RHC.universalRouter);
  const pm = lc(RHC.v4.poolManager);
  const routerPaid: Address[] = [];
  const v4Pools: Hex[] = [];
  const v3Pools: Address[] = [];
  const swapEvents: DecodedLogs["swapEvents"] = [];
  for (const l of logs) {
    const topic = l.topics[0]?.toLowerCase();
    if (topic === TRANSFER_TOPIC && l.topics.length === 3) {
      const from = topicAddress(l.topics[1]!);
      const to = topicAddress(l.topics[2]!);
      const v = l.data === "0x" ? 0n : BigInt(l.data);
      const tok = lc(l.address);
      add(from, tok, -v);
      add(to, tok, v);
      if (from === ur && to !== pm && to !== NATIVE && !routerPaid.includes(to)) routerPaid.push(to);
    } else if (topic === V4_SWAP_TOPIC && lc(l.address) === pm) {
      v4Pools.push(l.topics[1]!.toLowerCase() as Hex);
      swapEvents.push({ venue: "v4", pool: l.topics[1]!.toLowerCase() });
    } else if (topic === V3_SWAP_TOPIC) {
      v3Pools.push(lc(l.address));
      swapEvents.push({ venue: "v3", pool: lc(l.address) });
    }
  }
  const pools = new Set<string>(v3Pools);
  return { flows, routerPaid: routerPaid.filter((a) => !pools.has(a)), v4Pools, v3Pools, swapEvents };
}

export interface SwapRead {
  tokenIn: Address;
  amountIn: bigint;
  tokenOut: Address;
  amountOut: bigint;
  /** More than one token left or arrived; the largest of each was used. */
  multi: boolean;
  /** Native ETH received was inferred from a balance change. */
  ethOutInferred: boolean;
  /** Native ETH paid was inferred from a balance drop (not from tx.value). */
  ethInInferred: boolean;
}

/**
 * One token in → one token out for `who`. Input: native ETH when `ethIn` > 0, else the largest net ERC-20 outflow.
 * Output: the largest net ERC-20 inflow of another token, else native ETH from `ethOut()` when the input is ERC-20.
 */
export async function readSwap(
  flows: DecodedLogs["flows"],
  who: Address,
  ethIn: bigint,
  ethOut: () => Promise<bigint | null>,
  ethInInferred = false,
): Promise<SwapRead | null> {
  const net = flows.get(lc(who)) ?? new Map<Address, bigint>();
  const sent = [...net.entries()].filter(([, v]) => v < 0n).sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const got = [...net.entries()].filter(([, v]) => v > 0n).sort((a, b) => (a[1] > b[1] ? -1 : a[1] < b[1] ? 1 : 0));
  let tokenIn: Address | null = null;
  let amountIn = 0n;
  if (ethIn > 0n) {
    tokenIn = NATIVE;
    amountIn = ethIn;
  } else if (sent[0]) {
    tokenIn = sent[0][0];
    amountIn = -sent[0][1];
  }
  let tokenOut: Address | null = null;
  let amountOut = 0n;
  let ethOutInferred = false;
  if (got[0] && got[0][0] !== tokenIn) {
    tokenOut = got[0][0];
    amountOut = got[0][1];
  } else if (tokenIn && tokenIn !== NATIVE) {
    const e = await ethOut();
    if (e && e > 0n) {
      tokenOut = NATIVE;
      amountOut = e;
      ethOutInferred = true;
    }
  }
  if (!tokenIn || !tokenOut || amountIn === 0n || amountOut === 0n) return null;
  return {
    tokenIn,
    amountIn,
    tokenOut,
    amountOut,
    multi: sent.length > 1 || got.length > 1,
    ethOutInferred,
    ethInInferred: ethIn > 0n && ethInInferred,
  };
}

export interface TradeInput {
  sender: Address;
  txTo: Address | null;
  txValue: bigint;
  decoded: DecodedLogs;
  /**
   * Native ETH balance change of `who` across the block, with the sender's gas fee and tx.value added back.
   * Positive = received, negative = paid. null when the archive read failed.
   */
  ethDelta: (who: Address, isSender: boolean) => Promise<bigint | null>;
}

export interface Trade {
  trader: Address;
  measuredFor: "sender" | "router-recipient";
  /** The transaction's ETH value was counted as the router recipient's input. */
  valueAsInput: boolean;
  swap: SwapRead;
}

/**
 * Who traded (SPEC 2.3): the sender first; otherwise each address the Universal Router paid out to, in log order,
 * with its input taken from its own ERC-20 outflow, the transaction's ETH value (when the transaction called the
 * router), or its own ETH balance drop.
 */
export async function findTrade(t: TradeInput): Promise<Trade | null> {
  const positive = (who: Address, isSender: boolean) => async () => {
    const d = await t.ethDelta(who, isSender);
    return d !== null && d > 0n ? d : null;
  };
  const own = await readSwap(t.decoded.flows, t.sender, t.txValue, positive(t.sender, true));
  if (own) return { trader: t.sender, measuredFor: "sender", valueAsInput: false, swap: own };
  const calledRouter = t.txTo !== null && lc(t.txTo) === lc(RHC.universalRouter);
  for (const who of t.decoded.routerPaid) {
    if (who === lc(t.sender)) continue;
    const plain = await readSwap(t.decoded.flows, who, 0n, positive(who, false));
    if (plain) return { trader: who, measuredFor: "router-recipient", valueAsInput: false, swap: plain };
    if (calledRouter && t.txValue > 0n) {
      const byValue = await readSwap(t.decoded.flows, who, t.txValue, positive(who, false));
      if (byValue) return { trader: who, measuredFor: "router-recipient", valueAsInput: true, swap: byValue };
    }
    const d = await t.ethDelta(who, false);
    if (d !== null && d < 0n) {
      const byDrop = await readSwap(t.decoded.flows, who, -d, async () => null, true);
      if (byDrop) return { trader: who, measuredFor: "router-recipient", valueAsInput: false, swap: byDrop };
    }
  }
  return null;
}
