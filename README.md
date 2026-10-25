# zhook-proof

Proof of Execution for swaps on Robinhood Chain. Give it a transaction hash and it tells you whether the trader got
more or less than the best route made only of Uniswap pools would have paid at the same block, in bps and in USD at
today's price.

It is the open verifier behind the proof page in the [Zerohook app](https://dapp.zerohook.trade/proof): the same rules,
written down in [SPEC.md](./SPEC.md), so anyone can recompute a number they see there.

- Reads only public RPCs. No API key, no indexer.
- Self-contained: its own minimal Uniswap v3 and v4 quoting at a past block, on [viem](https://viem.sh).
- Golden vectors from real Robinhood Chain transactions; the test suite runs offline.

## Install

```sh
pnpm add @zerohooktrade/proof
# or run the CLI without installing
pnpm dlx @zerohooktrade/proof verify <txHash>
```

Node 20 or newer.

## CLI

```sh
zhook-proof verify 0x9953bd1f2fc676ddf1671b80b1058238e6eb5be6e43ec1c13ceae3647811f4eb
```

```
Proof of Execution · zhook-proof/1
Beat the best Uniswap-only route · +14.24 bps

Transaction   0x9953bd1f2fc676ddf1671b80b1058238e6eb5be6e43ec1c13ceae3647811f4eb
Block         97,469,994 (2026-10-25T09:03:19.000Z)
Measured for  0x1CBe043703c0Aa3D3C5358bAa87912025B104E69
Paid          0.0035124244 ETH
Received      12,095.06 WOLFPACK
Baseline      12,077.85 WOLFPACK at block 97,469,993
              100% via Uniswap v3 · 0.01% → Uniswap v4 · 3.2%
Gap           +17.2105 WOLFPACK · ≈ +$0.0113 at today's price
```

| Option                  | Meaning                                                  |
| ----------------------- | -------------------------------------------------------- |
| `--json`                | print the full proof as JSON                             |
| `--rpc <url>`           | RPC for latest-block reads (repeatable)                  |
| `--archive-rpc <url>`   | RPC that serves state at past blocks (repeatable)        |
| `--pool <c0,c1,fee,ts>` | add a hook-free v4 pool to the baseline set (repeatable) |
| `--no-usd`              | skip today's USD price of the output token               |

Exit codes: `0` measured, `1` could not be measured (the reason is printed), `2` bad usage.

## Library

```ts
import { verifyExecution } from "@zerohooktrade/proof";

const proof = await verifyExecution("0x9953…f4eb");
proof.verdict; // "better" | "matched" | "worse" | "no-baseline"
proof.gap?.bps; // 14.24
proof.gap?.usd; // USD at today's price, or null
proof.baseline; // { amountOut, kind: "multi-hop", legs: [{ shareBps: 10000, hops: [...] }] }
```

Main exports:

| Export                                 | What it does                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| `verifyExecution(hash, opts?)`         | the whole spec: read the trade, rebuild the baseline, return a `ProofOfExecution` |
| `decodeLogs(logs)`, `findTrade(input)` | pure: net flows, router payouts, venues used, and who traded (SPEC 2)             |
| `candidates(ctx, a, b)`                | the pools that count for a pair at a block (SPEC 3)                               |
| `bestPlans(ctx, a, b, amountIn)`       | single, split and two-hop routes at a block, best first (SPEC 4)                  |
| `usdPrice(ctx, token, decimals)`       | today's USD price (SPEC 5)                                                        |
| `gapBps`, `verdictFor`                 | the gap and verdict rules (SPEC 6)                                                |
| `formatProof(proof)`                   | the CLI's text report                                                             |
| `httpRpc`, `makeClients`               | public-RPC transport with fallback and retry                                      |
| `recordRpc`, `replayRpc`               | capture a run and replay it offline (how the golden vectors work)                 |

`VerifyOptions`: `rpcUrls`, `archiveUrls`, `request` (your own JSON-RPC function), `clients`, `usd`, `priceBlock`,
`extraPools`.

### RPCs

Defaults are public endpoints that need no key: `https://robinhood-rpc.publicnode.com` and
`https://robinhood.drpc.org` for latest-block reads, `https://robinhood.drpc.org` for past blocks. The baseline needs
an RPC that answers `eth_call` and `eth_getBalance` at old blocks. A rate-limited public RPC is retried with backoff;
pass your own with `--rpc` / `--archive-rpc` if you hit limits.

## Limits

The full list is in [SPEC.md section 8](./SPEC.md#8-what-cannot-be-measured). In short:

- Only one-token-in, one-token-out trades can be measured. Batches, multi-output trades and bots that pay from their
  own balance are refused rather than guessed.
- Native ETH is inferred from balance changes across the block, because free RPCs have no trace API.
- The baseline is the state before the block, not right before the transaction.
- Hooked v4 pools and other protocols never count. v4 pools come from the bundled list (block 97,465,332), the
  standard keys, the pools the trade used and any `--pool` you add, so the baseline is a lower bound.
- The USD figure uses today's price.

## Development

```sh
pnpm install
pnpm test        # offline: golden vectors are replayed from vectors/*.json
pnpm lint && pnpm typecheck && pnpm build
RPC_URL=https://robinhood.drpc.org pnpm test:live   # optional: re-measures vectors from the chain
pnpm record <name> <txHash> "<description>"          # records a new golden vector
```

## Links

- Docs: https://docs.zerohook.trade
- App: https://dapp.zerohook.trade
- Website: https://zerohook.trade

## License

MIT © Zerohook
