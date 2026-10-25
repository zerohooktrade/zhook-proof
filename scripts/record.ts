/**
 * Records a golden vector: runs the verifier against the public RPCs, captures every JSON-RPC answer, and writes
 * vectors/<name>.json with the expected proof. Tests replay the capture offline.
 *
 *   pnpm record <name> <txHash> "<what this vector covers>"
 */
import { writeFileSync } from "node:fs";
import { makeClients, recordRpc, verifyExecution, type Recording } from "../src/index.js";

const [name, tx, ...about] = process.argv.slice(2);
if (!name || !tx || !/^[a-z0-9-]+$/.test(name)) {
  console.error('usage: pnpm record <name> <txHash> "<description>"');
  process.exit(2);
}
const rpc: Recording = {};
const clients = makeClients({ wrap: (r) => recordRpc(r, rpc) });
const priceBlock = await clients.read.getBlockNumber();
let expected: unknown;
try {
  expected = await verifyExecution(tx, { clients, priceBlock });
} catch (e) {
  expected = { error: (e as { code?: string }).code ?? "error", message: (e as Error).message };
}
const sorted = Object.fromEntries(Object.entries(rpc).sort(([a], [b]) => (a < b ? -1 : 1)));
const vector = { name, description: about.join(" "), tx, priceBlock: Number(priceBlock), expected, rpc: sorted };
const head = JSON.stringify({ ...vector, rpc: undefined }, null, 2).replace(/\n}$/, "");
const body = Object.entries(sorted)
  .map(([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`)
  .join(",\n");
writeFileSync(`vectors/${name}.json`, `${head},\n  "rpc": {\n${body}\n  }\n}\n`);
console.log(`vectors/${name}.json: ${Object.keys(rpc).length} calls`);
console.log(JSON.stringify(expected, null, 2).slice(0, 600));
