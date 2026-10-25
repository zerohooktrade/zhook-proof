import { createPublicClient, custom, defineChain, keccak256, stringToHex, type Chain, type PublicClient } from "viem";
import { CHAIN_ID, DEFAULT_RPCS, RHC } from "./chain.js";

/** One JSON-RPC call. Every network read in this package goes through a function of this shape. */
export type RpcRequest = (method: string, params: unknown[]) => Promise<unknown>;

/** Error carrying the JSON-RPC error code, so viem can tell a revert from a transport failure. */
export class RpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcError";
  }
}

export interface HttpRpcOptions {
  timeoutMs?: number;
  /** Extra attempts per URL on HTTP 429 / 5xx / network errors (default 2). */
  retries?: number;
  fetch?: typeof fetch;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Plain JSON-RPC over fetch. URLs are tried in order; rate limits and network errors are retried with a short
 * backoff. A revert is final. Any other JSON-RPC error (a node that refuses old blocks, an unsupported method) moves
 * on to the next URL, and the last one is thrown.
 */
export function httpRpc(urls: readonly string[], opts: HttpRpcOptions = {}): RpcRequest {
  if (!urls.length) throw new Error("at least one RPC URL is required");
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const retries = opts.retries ?? 2;
  const doFetch = opts.fetch ?? fetch;
  let id = 0;
  return async (method, params) => {
    const errors: string[] = [];
    for (const url of urls) {
      for (let attempt = 0; attempt <= retries; attempt++) {
        let res: Response;
        try {
          res = await doFetch(url, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }),
            signal: AbortSignal.timeout(timeoutMs),
          });
        } catch (e) {
          errors.push(`${host(url)}: ${(e as Error).message}`);
          if (attempt < retries) await sleep(300 * 2 ** attempt + Math.random() * 200);
          continue;
        }
        const text = await res.text();
        if (res.status === 429 || res.status >= 500) {
          errors.push(`${host(url)}: HTTP ${res.status}`);
          if (attempt < retries) await sleep(400 * 2 ** attempt + Math.random() * 300);
          continue;
        }
        let body: { result?: unknown; error?: { code?: number; message?: string; data?: unknown } };
        try {
          body = JSON.parse(text);
        } catch {
          errors.push(`${host(url)}: HTTP ${res.status} ${text.slice(0, 80)}`);
          break;
        }
        if (body.error) {
          const msg = body.error.message ?? "rpc error";
          // Some public nodes report rate limits as JSON-RPC errors.
          if (/rate|limit|too many/i.test(msg) && attempt < retries) {
            errors.push(`${host(url)}: ${msg}`);
            await sleep(400 * 2 ** attempt + Math.random() * 300);
            continue;
          }
          const err = new RpcError(msg, body.error.code ?? -32000, body.error.data);
          if (err.code === 3 || /revert/i.test(msg) || url === urls[urls.length - 1]) throw err;
          errors.push(`${host(url)}: ${msg}`);
          break;
        }
        return body.result;
      }
    }
    throw new Error(`${method} failed on every RPC: ${errors.join(" | ").slice(0, 400)}`);
  };
}

function host(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return "rpc";
  }
}

/** A recorded call: the result, or the JSON-RPC error it returned. */
export type RecordedCall = { result: unknown } | { error: { message: string; code: number; data?: unknown } };
export type Recording = Record<string, RecordedCall>;

/** Stable key of a call: the method plus keccak256 of its JSON parameters. */
export const callKey = (method: string, params: unknown[]) =>
  `${method} ${keccak256(stringToHex(JSON.stringify(params))).slice(2, 34)}`;

/** Wraps a requester and writes every answer into `store`, so a run can be replayed offline. */
export function recordRpc(inner: RpcRequest, store: Recording): RpcRequest {
  return async (method, params) => {
    const key = callKey(method, params);
    try {
      const result = await inner(method, params);
      store[key] = { result };
      return result;
    } catch (e) {
      if (e instanceof RpcError) store[key] = { error: { message: e.message, code: e.code, data: e.data } };
      throw e;
    }
  };
}

/** Answers calls from a recording only. A call that was not recorded throws, so a replay never touches the network. */
export function replayRpc(store: Recording): RpcRequest {
  return async (method, params) => {
    const key = callKey(method, params);
    const hit = store[key];
    if (!hit) throw new Error(`not in the recording: ${method} ${JSON.stringify(params).slice(0, 160)}`);
    if ("error" in hit) throw new RpcError(hit.error.message, hit.error.code, hit.error.data);
    return structuredClone(hit.result);
  };
}

export const robinhoodChain: Chain = defineChain({
  id: CHAIN_ID,
  name: RHC.name,
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [...DEFAULT_RPCS.read] } },
  blockExplorers: { default: { name: "Blockscout", url: RHC.explorer } },
  contracts: { multicall3: { address: RHC.multicall3 } },
});

/** A viem client whose every request goes through `request`. */
export function clientFrom(request: RpcRequest): PublicClient {
  return createPublicClient({
    chain: robinhoodChain,
    transport: custom(
      { request: ({ method, params }) => request(method, (params ?? []) as unknown[]) },
      { retryCount: 0 },
    ),
    cacheTime: 0,
  }) as PublicClient;
}

/** The two clients the verifier reads through. */
export interface Clients {
  /** Latest-block reads (transaction, receipt, token metadata, today's price). */
  read: PublicClient;
  /** Reads at past blocks (balances and quotes at the baseline block). */
  archive: PublicClient;
}

export interface RpcOptions {
  /** RPC URLs for latest-block reads. Default: public Robinhood Chain RPCs. */
  rpcUrls?: readonly string[];
  /** RPC URLs that serve state at past blocks. Default: a public archive RPC. */
  archiveUrls?: readonly string[];
  /** Replaces both transports (tests, offline replay). */
  request?: RpcRequest;
  /** Wraps each HTTP transport, e.g. with recordRpc to capture a run. */
  wrap?: (request: RpcRequest) => RpcRequest;
}

export function makeClients(opts: RpcOptions = {}): Clients {
  if (opts.request) {
    const c = clientFrom(opts.request);
    return { read: c, archive: c };
  }
  const wrap = opts.wrap ?? ((r: RpcRequest) => r);
  return {
    read: clientFrom(wrap(httpRpc(opts.rpcUrls ?? DEFAULT_RPCS.read))),
    archive: clientFrom(wrap(httpRpc(opts.archiveUrls ?? DEFAULT_RPCS.archive))),
  };
}
