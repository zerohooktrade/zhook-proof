# Proof of Execution: specification v1

Spec id: `zhook-proof/1`. Chain: Robinhood Chain, chain id 4663.

Proof of Execution answers one question about a swap transaction that already happened: **did the trader receive
more or less than the best route made only of Uniswap pools would have paid, at the same block?** It needs nothing
but public RPC reads, so anyone can recompute the number shown on a Zerohook proof page.

The key words MUST, MUST NOT and SHOULD are used as in RFC 2119.

## 1. Terms

| Term           | Meaning                                                                                         |
| -------------- | ----------------------------------------------------------------------------------------------- |
| `B`            | Block of the transaction.                                                                       |
| Baseline block | `B − 1`: the state right before block `B`.                                                      |
| Trader         | The address the trade is measured for (section 2.3).                                            |
| Received       | What the trader got, in the output token's raw units.                                           |
| Baseline       | Best output of the Uniswap-only route set (section 4) for the same input at the baseline block. |
| Hook-free      | A Uniswap v4 pool whose `PoolKey.hooks` is the zero address.                                    |
| ETH            | Native ether, written as the zero address `0x0000…0000`.                                        |

Contract addresses are listed in section 9.

## 2. Reading the trade

### 2.1 Inputs

A verifier reads the transaction, its receipt and the block header. If the receipt status is not `success`, the
verifier MUST stop with `reverted`.

### 2.2 Flows

For every receipt log whose `topics[0]` is `Transfer(address,address,uint256)` and that has exactly three topics
(ERC-20 transfers; ERC-721 transfers have four and are skipped), add `−value` to `(from, token)` and `+value` to
`(to, token)`. The result is the **net flow** of each address in each token over the whole transaction.

While reading, record:

- **Router payouts:** recipients of transfers sent by the Universal Router, in log order, without duplicates,
  excluding the v4 PoolManager, the zero address, and any address that emitted a v3 `Swap` event in the same
  transaction (that address is a pool, the next hop of a route, not a payout).
- **Venues used:** every v4 PoolManager `Swap(bytes32,address,int128,int128,uint160,uint128,int24,uint24)` (pool id
  in `topics[1]`) and every v3 `Swap(address,address,int256,int256,uint160,uint128,int24)` (pool = log address), in
  log order.

### 2.3 Who traded

A **swap reading** of an address `X` with an ETH input `e` is:

- **Input:** ETH of amount `e` when `e > 0`; otherwise the token with the most negative net flow of `X`.
- **Output:** the token with the largest positive net flow of `X`, if it differs from the input; otherwise, when the
  input is an ERC-20, native ETH equal to `X`'s ETH balance change (section 2.4) when that change is positive.
- The reading exists only when both an input and an output were found and both amounts are non-zero. When more than
  one token left or arrived, the largest of each is used and a note says so.

The trader is the first of these that yields a swap reading:

1. **The sender**, with `e = tx.value`.
2. For each router payout address `R` (in order), skipping the sender:
   1. `R` with `e = 0`;
   2. when the transaction was sent to the Universal Router itself and `tx.value > 0`: `R` with `e = tx.value`;
   3. when `R`'s ETH balance dropped across block `B`: `R` with `e` = that drop.

Case 2 covers ERC-4337 bundles, aggregators and smart accounts, where the sender is a bundler or a bot and the swap
belongs to the account the router paid. If nothing yields a reading, the verifier MUST stop with `unreadable`; it
MUST NOT guess an input or an output.

### 2.4 Native ETH

Free public RPCs do not expose traces, so native ETH that moves inside a transaction is not visible in logs. It is
inferred from balances read at blocks `B − 1` and `B` on an archive node:

- For the sender: `received = balance(B) − balance(B − 1) + fee + tx.value`, where `fee = gasUsed × effectiveGasPrice`
  (plus `l1Fee` when the receipt has one).
- For any other address: `delta = balance(B) − balance(B − 1)`.

A failed balance read MUST stop the verifier with `rpc-failed`, never be treated as zero.

## 3. Which pools count

The baseline may only use **Uniswap v3 pools and hook-free Uniswap v4 pools**. Hooked v4 pools are excluded because a
hook can run arbitrary code during a swap, so a hooked price is not a neutral benchmark. Pools of other protocols are
excluded so the baseline is the same "plain Uniswap" route anyone can reproduce.

For a pair `(a, b)` at a block, the candidate pools are:

### 3.1 Uniswap v3

`UniswapV3Factory.getPool(a', b', fee)` for each fee tier enabled on the chain: 100, 500, 3000 and 10000. ETH is
written as WETH in v3 (`a'`, `b'`). A zero address means no pool.

### 3.2 Uniswap v4, hook-free

v4 pools cannot be listed from the chain without an index, so the set is defined as the union of:

1. **The bundled pool list** shipped with this version of the verifier (`src/data/v4-hookfree-pools.json`): 4,148
   hook-free pools found from every PositionManager position plus `Initialize` logs, kept when they traded in the
   ~24 h before block 97,465,332.
2. **Four standard keys** for the pair: (fee 100, tick spacing 1), (500, 10), (3000, 60), (10000, 200).
3. **Hook-free pools the transaction itself swapped in.** A pool id from a `Swap` event is resolved to its key from
   the bundled list, else from `PositionManager.poolKeys(bytes25(poolId))`; the key MUST hash back to the pool id.
4. **Extra pool keys** given by the caller. Hooked keys given here are ignored.

ETH can sit in a v4 pool as native ETH or as WETH. Every currency form is tried: ETH and WETH are both looked up for
an ETH or WETH side.

A v4 candidate counts only if, at the block, `StateView.getSlot0(id).sqrtPriceX96 > 0` and
`StateView.getLiquidity(id) > 0`. Candidates are then ordered by that liquidity (largest first, ties by pool id) and
the first **16** are kept per pair.

## 4. Baseline route

All quotes are `eth_call`s at the baseline block `B − 1` on an archive node:

- v3: `QuoterV2.quoteExactInputSingle(tokenIn, tokenOut, amountIn, fee, 0)`;
- v4: `V4Quoter.quoteExactInputSingle(poolKey, zeroForOne, amountIn, 0x)`.

They are batched through Multicall3 with at most 4 quotes per call (a deep quote can burn millions of gas, and nodes
cap `eth_call` gas). A quote that reverts or returns 0 means "no route through that pool".

With `amountIn` = the trader's input, the route set is:

1. **Single pool:** every direct candidate of `(tokenIn, tokenOut)` quoted with the full amount; keep the best.
2. **Two-way split:** the two best single pools from step 1, with the input split in 10 % steps (10/90 … 90/10);
   keep the best sum. A WETH input is never split into a native-ETH pool (the router cannot unwrap part of a WETH
   balance).
3. **Two hops:** through each hub `h` in (USDG, ETH), skipping a hub that is one of the two tokens (ETH and WETH
   count as the same asset). The first hop's candidates of `(tokenIn, h)` are quoted with the full amount; the best
   first hop's output is then quoted through every candidate of `(h, tokenOut)`.

The **baseline** is the largest output of all routes. It is reported with its shape (`single`, `split`,
`multi-hop`) and, per leg, its share of the input in bps and the pool labels it went through.

## 5. USD at today's price

The gap is also shown in USD **at today's price, not the price at the time of the trade**. The price of the output
token is read at a recent block (the latest block by default; the block is reported):

- USDG = 1 USD.
- ETH and WETH: the ETH → USDG rate.
- Any other token: the better of token → USDG and (token → ETH) × (ETH → USDG).

Each rate is the best output per whole input over the candidates of section 3, plus any hooked pools the transaction
itself used (many tokens only trade in hooked pools). Probe sizes are 1/1000, 1, 1,000 and 1,000,000 whole tokens;
the smallest size with a raw output of at least 10,000 wins. With no rate, `usd` is `null`.

## 6. Gap and verdict

```
gap.raw = received − baseline                                    (raw units of the output token)
gap.bps = trunc((received − baseline) × 1,000,000 / baseline) / 100   (bps, 2 decimals, toward zero)
gap.usd = gap in output-token units × today's USD price
```

| Verdict       | Rule                     |
| ------------- | ------------------------ |
| `better`      | `gap.bps > 1`            |
| `matched`     | `−1 ≤ gap.bps ≤ 1`       |
| `worse`       | `gap.bps < −1`           |
| `no-baseline` | no route could be priced |

## 7. Output

A proof is a JSON object with these fields (see `ProofOfExecution` in `src/verify.ts`):

`spec`, `chainId`, `tx`, `block`, `timestamp`, `sender`, `trader`, `measuredFor` (`sender` or `router-recipient`),
`to`, `viaUniversalRouter`, `tokenIn`, `tokenOut` (`address`, `symbol`, `decimals`), `amountIn`, `amountInRaw`,
`received`, `receivedRaw`, `baseline` (`amountOut`, `amountOutRaw`, `kind`, `legs`) or `null`, `baselineBlock`,
`gap` (`raw`, `amount`, `bps`, `usd`, `price`) or `null`, `verdict`, `venuesUsed`, `poolList` and `notes`.

Errors carry a code: `bad-input`, `not-found`, `reverted`, `unreadable`, `rpc-failed`.

## 8. What cannot be measured

- **Transactions that are not one token in → one token out** for one address: batches with several outputs, fee
  splits where the trader's output can't be told apart, or bots that pay from their own balance (the input belongs
  to no one the verifier can see). These stop with `unreadable`.
- **Native ETH is inferred from balances** (section 2.4). Anything else that moved ETH to or from the trader in the
  same block is counted too.
- **Earlier transactions in the same block** are not in the baseline: block `B − 1` is the state before the block,
  not right before the transaction.
- **Pools outside section 3** do not count: hooked v4 pools, other protocols, and hook-free v4 pools created after the
  bundled list that use a non-standard key and were not used by the transaction. The baseline is therefore a lower
  bound on what plain Uniswap could have paid; a newer pool list can only raise it.
- **Routes outside section 4** do not count: three or more hops, three-way splits, or hubs other than USDG and ETH.
- **Fee-on-transfer and rebasing tokens:** quoters return the pool output, not what the trader's balance shows.
- **The USD figure moves with today's price.** The bps figure does not.

## 9. Addresses (Robinhood Chain, 4663)

| Contract           | Address                                      |
| ------------------ | -------------------------------------------- |
| Universal Router   | `0x8876789976decbfcbbbe364623c63652db8c0904` |
| v4 PoolManager     | `0x8366a39cc670b4001a1121b8f6a443a643e40951` |
| v4 PositionManager | `0x58daec3116aae6d93017baaea7749052e8a04fa7` |
| v4 StateView       | `0xf3334192d15450cdd385c8b70e03f9a6bd9e673b` |
| v4 V4Quoter        | `0x8dc178efb8111bb0973dd9d722ebeff267c98f94` |
| v3 Factory         | `0x1f7d7550b1b028f7571e69a784071f0205fd2efa` |
| v3 QuoterV2        | `0x33e885ed0ec9bf04ecfb19341582aadcb4c8a9e7` |
| WETH9              | `0x0bd7d308f8e1639fab988df18a8011f41eacad73` |
| USDG (6 decimals)  | `0x5fc5360d0400a0fd4f2af552add042d716f1d168` |
| Multicall3         | `0xcA11bde05977b3631167028862bE2a173976CA11` |

## 10. Golden vectors

`vectors/*.json` are real Robinhood Chain transactions. Each file holds the transaction hash, the block used for the
USD price, the expected proof (or error), and every JSON-RPC answer the verifier needed, keyed by method and a hash of
the parameters. A conforming verifier fed those answers MUST produce the expected proof byte for byte (as JSON).

| Vector                       | What it covers                                                        |
| ---------------------------- | --------------------------------------------------------------------- |
| `ur-eth-to-token-two-hop`    | ETH in via hooked pools; two-hop hook-free baseline; verdict `better` |
| `ur-eth-in-split-baseline`   | ETH in with a fee transfer; split baseline across two v4 pools        |
| `ur-worse-than-baseline`     | verdict `worse`                                                       |
| `ur-token-to-eth-inferred`   | token in, ETH out inferred from the balance change; verdict `matched` |
| `erc4337-router-recipient`   | ERC-4337 bundle; measured for the router payout recipient             |
| `hooked-only-no-baseline`    | only hooked pools price the pair; verdict `no-baseline`               |
| `bot-contract-input-unknown` | input paid from a bot contract's balance; `unreadable`                |
| `unmeasurable-aggregator`    | output never reaches the sender or a payout recipient; `unreadable`   |

## 11. Versioning

Any change to sections 2 to 6 (which pools count, the route set, the trader rules, the gap formula or the verdict
band) or to the bundled pool list is a new spec version, with new golden vectors. Proof pages state the spec id they
were computed with.
