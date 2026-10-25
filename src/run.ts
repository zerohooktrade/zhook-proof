import pkg from "../package.json" with { type: "json" };
import { lc, type Address } from "./chain.js";
import { formatProof } from "./format.js";
import type { PoolKey } from "./pools.js";
import { ProofError, verifyExecution, type VerifyOptions } from "./verify.js";

export const VERSION: string = pkg.version;

export const USAGE = `zhook-proof ${VERSION}: Proof of Execution for Robinhood Chain swaps

Usage
  zhook-proof verify <txHash> [options]

Options
  --json                 print the proof as JSON
  --rpc <url>            RPC for latest-block reads (repeatable; default: public RPCs)
  --archive-rpc <url>    RPC that serves past blocks (repeatable; default: a public archive RPC)
  --pool <c0,c1,fee,ts>  add a hook-free v4 pool to the baseline set (repeatable)
  --no-usd               skip today's USD price of the output token
  -v, --version          print the version
  -h, --help             print this help

Exit codes: 0 = measured, 1 = could not measure, 2 = bad usage.
Spec: SPEC.md · Docs: https://docs.zerohook.trade`;

export interface Io {
  out: (s: string) => void;
  err: (s: string) => void;
}

function parsePool(s: string): PoolKey {
  const [c0, c1, fee, ts] = s.split(",");
  const isAddr = (a?: string) => !!a && /^0x[0-9a-fA-F]{40}$/.test(a);
  if (!isAddr(c0) || !isAddr(c1) || !/^\d+$/.test(fee ?? "") || !/^-?\d+$/.test(ts ?? ""))
    throw new Error(`--pool expects currency0,currency1,fee,tickSpacing; got ${s}`);
  return {
    currency0: lc(c0!),
    currency1: lc(c1!),
    fee: Number(fee),
    tickSpacing: Number(ts),
    hooks: "0x0000000000000000000000000000000000000000" as Address,
  };
}

/** The CLI without process globals. Returns the exit code. */
export async function run(argv: string[], io: Io, base: VerifyOptions = {}): Promise<number> {
  const args = [...argv];
  if (!args.length || args.includes("-h") || args.includes("--help")) {
    io.out(USAGE);
    return args.length ? 0 : 2;
  }
  if (args.includes("-v") || args.includes("--version")) {
    io.out(VERSION);
    return 0;
  }
  const cmd = args.shift();
  if (cmd !== "verify") {
    io.err(`Unknown command: ${cmd}\n\n${USAGE}`);
    return 2;
  }
  let hash: string | null = null;
  let json = false;
  const opts: VerifyOptions = { ...base };
  const rpcUrls: string[] = [];
  const archiveUrls: string[] = [];
  const pools: PoolKey[] = [];
  try {
    while (args.length) {
      const a = args.shift()!;
      const val = () => {
        const v = args.shift();
        if (!v) throw new Error(`${a} needs a value`);
        return v;
      };
      if (a === "--json") json = true;
      else if (a === "--no-usd") opts.usd = false;
      else if (a === "--rpc") rpcUrls.push(val());
      else if (a === "--archive-rpc") archiveUrls.push(val());
      else if (a === "--pool") pools.push(parsePool(val()));
      else if (a.startsWith("-")) throw new Error(`Unknown option: ${a}`);
      else if (!hash) hash = a;
      else throw new Error(`Unexpected argument: ${a}`);
    }
    if (!hash) throw new Error("verify needs a transaction hash");
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new Error(`Not a transaction hash: ${hash}`);
  } catch (e) {
    io.err(`${(e as Error).message}\n\n${USAGE}`);
    return 2;
  }
  if (rpcUrls.length) opts.rpcUrls = rpcUrls;
  if (archiveUrls.length) opts.archiveUrls = archiveUrls;
  if (pools.length) opts.extraPools = pools;
  try {
    const proof = await verifyExecution(hash, opts);
    io.out(json ? JSON.stringify(proof, null, 2) : formatProof(proof));
    return 0;
  } catch (e) {
    const code = e instanceof ProofError ? e.code : "error";
    if (json) io.out(JSON.stringify({ error: code, message: (e as Error).message }, null, 2));
    else io.err(`Could not measure ${hash}: ${(e as Error).message}`);
    return 1;
  }
}
