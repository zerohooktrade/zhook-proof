/**
 * Robinhood Chain (chain id 4663) constants used by the verifier. Every address was read on-chain with
 * eth_getCode; the v3 factory and WETH9 come from QuoterV2.factory() / QuoterV2.WETH9().
 */
export type Address = `0x${string}`;
export type Hex = `0x${string}`;

export const CHAIN_ID = 4663;

/** Native ETH, as written in Uniswap v4 pool keys. */
export const NATIVE: Address = "0x0000000000000000000000000000000000000000";

export const RHC = {
  id: CHAIN_ID,
  name: "Robinhood Chain",
  explorer: "https://robinhoodchain.blockscout.com",
  v4: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    positionManager: "0x58daec3116aae6d93017baaea7749052e8a04fa7",
    stateView: "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b",
    quoter: "0x8dc178efb8111bb0973dd9d722ebeff267c98f94",
  },
  v3: {
    factory: "0x1f7d7550b1b028f7571e69a784071f0205fd2efa",
    quoterV2: "0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7",
  },
  universalRouter: "0x8876789976decbfcbbbe364623c63652db8c0904",
  weth: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
  multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11",
} as const satisfies Record<string, unknown>;

/** v3 fee tiers enabled on the Robinhood Chain v3 factory. */
export const V3_FEES = [100, 500, 3000, 10000] as const;

/** Hook-free v4 (fee, tickSpacing) pairs probed for every pair, on top of the bundled pool list. */
export const V4_STANDARD_KEYS: readonly (readonly [number, number])[] = [
  [100, 1],
  [500, 10],
  [3000, 60],
  [10000, 200],
];

/**
 * Public RPC defaults. `read` answers calls at the latest block, `archive` answers calls at past blocks.
 * No key is needed for any of them; pass your own with `rpc` options or `--rpc`.
 */
export const DEFAULT_RPCS = {
  read: ["https://robinhood-rpc.publicnode.com", "https://robinhood.drpc.org"],
  archive: ["https://robinhood.drpc.org"],
} as const;

export const explorerTx = (hash: string) => `${RHC.explorer}/tx/${hash}`;
export const explorerAddress = (address: string) => `${RHC.explorer}/address/${address}`;

export const lc = (a: string) => a.toLowerCase() as Address;
export const isNative = (a: string) => lc(a) === NATIVE;
