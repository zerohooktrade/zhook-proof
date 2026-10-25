import { encodeAbiParameters, keccak256, parseAbiParameters } from "viem";
import list from "./data/v4-hookfree-pools.json" with { type: "json" };
import { lc, NATIVE, type Address, type Hex } from "./chain.js";

/** Uniswap v4 PoolKey. */
export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

/** PoolId = keccak256(abi.encode(PoolKey)), as in v4-core PoolIdLibrary. */
export function poolIdOf(key: PoolKey): Hex {
  return keccak256(
    encodeAbiParameters(parseAbiParameters("address, address, uint24, int24, address"), [
      key.currency0,
      key.currency1,
      key.fee,
      key.tickSpacing,
      key.hooks,
    ]),
  );
}

export const isHookFree = (key: PoolKey) => lc(key.hooks) === NATIVE;

/** Sorts two currencies into v4 order (currency0 < currency1). */
export function sortCurrencies(a: Address, b: Address): [Address, Address] {
  const x = lc(a);
  const y = lc(b);
  return BigInt(x) < BigInt(y) ? [x, y] : [y, x];
}

const data = list as { block: number; tokens: string[]; pools: [number, number, number, number][] };

/**
 * The bundled pool list: hook-free Uniswap v4 pools on Robinhood Chain, taken from every PositionManager position
 * plus Initialize logs, kept when they traded in the ~24 h before block `POOL_LIST.block`. Ordered by swap count.
 */
export const POOL_LIST = { version: 1, block: data.block, pools: data.pools.length } as const;

let byPair: Map<string, PoolKey[]> | null = null;
let byId: Map<string, PoolKey> | null = null;

function index() {
  if (byPair && byId) return { byPair, byId };
  byPair = new Map();
  byId = new Map();
  for (const [i0, i1, fee, tickSpacing] of data.pools) {
    const key: PoolKey = {
      currency0: data.tokens[i0] as Address,
      currency1: data.tokens[i1] as Address,
      fee,
      tickSpacing,
      hooks: NATIVE,
    };
    const k = `${key.currency0}|${key.currency1}`;
    const arr = byPair.get(k) ?? [];
    arr.push(key);
    byPair.set(k, arr);
  }
  return { byPair, byId };
}

/** Hook-free pools of the bundled list for a pair (either order), most-traded first. */
export function listedPools(a: Address, b: Address): PoolKey[] {
  const [c0, c1] = sortCurrencies(a, b);
  return [...(index().byPair.get(`${c0}|${c1}`) ?? [])];
}

/** Looks a pool id up in the bundled list. */
export function listedPoolById(id: string): PoolKey | null {
  const ix = index();
  if (!ix.byId.size) for (const keys of ix.byPair.values()) for (const k of keys) ix.byId.set(poolIdOf(k), k);
  return ix.byId.get(id.toLowerCase()) ?? null;
}

export function feeLabel(fee: number) {
  if (fee === 0x800000) return "dynamic";
  return `${+(fee / 10_000).toFixed(4)}%`;
}
