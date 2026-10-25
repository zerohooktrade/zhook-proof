import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Recording } from "../src/index.js";

export interface Vector {
  name: string;
  description: string;
  tx: string;
  priceBlock: number;
  expected: Record<string, unknown>;
  rpc: Recording;
}

const dir = join(import.meta.dirname, "..", "vectors");

export const vectors: Vector[] = readdirSync(dir)
  .filter((f) => f.endsWith(".json"))
  .sort()
  .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")) as Vector);

export const vector = (name: string) => {
  const v = vectors.find((x) => x.name === name);
  if (!v) throw new Error(`no vector ${name}`);
  return v;
};

/** Topic form of an address. */
export const topic = (a: string) => "0x" + a.slice(2).toLowerCase().padStart(64, "0");
export const word = (n: bigint) => "0x" + n.toString(16).padStart(64, "0");
