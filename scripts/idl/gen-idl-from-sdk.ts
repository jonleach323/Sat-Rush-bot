/**
 * Regenerate `satrush.json` (the Anchor IDL every layout in this client is
 * derived from) out of the official SDK's Codama-generated codecs.
 *
 * WHY. The V2 program shipped without a published IDL — not on-chain, not in
 * the SDK tarball — but the SDK's ESM build is generated FROM that IDL and
 * carries every struct as an explicit codec list with field widths, every enum
 * as a variant table, every account and instruction discriminator as bytes,
 * and every instruction's account table with its PDA seeds. This script reads
 * those back into the IDL shape the anchor coders consume, so the adapter,
 * ingest and orchestrator keep deriving layouts from a JSON file exactly as
 * the ground rule requires; the file just has a different provenance.
 *
 * SELF-CHECKS. Every account and instruction discriminator read from the SDK
 * is asserted equal to Anchor's convention (sha256 of "account:Name" /
 * "global:snake_name"); events use the same convention ("event:Name"), which
 * the V1 IDL confirmed byte-for-byte. `pnpm idl:verify` then decodes live
 * mainnet accounts and an emitted event through the result and compares them
 * to the public API.
 *
 *   pnpm idl:gen      → satrush.json + src/adapter/generated-types.ts
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const sdkDir = dirname(require.resolve("@satrush/client/package.json"));
const sdkVersion = (JSON.parse(readFileSync(join(sdkDir, "package.json"), "utf8")) as { version: string }).version;
const mjs = readFileSync(join(sdkDir, "dist", "index.mjs"), "utf8");
const dts = readFileSync(join(sdkDir, "dist", "index.d.ts"), "utf8");

// ── helpers ──────────────────────────────────────────────────────────────────
const snake = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase();
const screaming = (pascal: string): string => snake(pascal).toUpperCase();
const sha8 = (s: string): number[] => [...createHash("sha256").update(s).digest().subarray(0, 8)];
const fail = (msg: string): never => { throw new Error(`gen-idl: ${msg}`); };

type IdlType =
  | string
  | { option: IdlType }
  | { array: [IdlType, number] }
  | { vec: IdlType }
  | { defined: { name: string } };

// ── enums ────────────────────────────────────────────────────────────────────
const enums = new Map<string, string[]>();
for (const m of mjs.matchAll(/var (\w+) = \/\* @__PURE__ \*\/ \(\((\w+)\) => \{([\s\S]*?)return \2;/g)) {
  const name = m[1] as string;
  if (name === "SatrushAccount" || name === "SatrushInstruction") continue;
  const variants: [string, number][] = [];
  for (const v of (m[3] as string).matchAll(/\["(\w+)"\] = (\d+)\]/g)) variants.push([v[1] as string, Number(v[2])]);
  variants.sort((a, b) => a[1] - b[1]);
  variants.forEach(([, n], i) => { if (n !== i) fail(`enum ${name} is not dense`); });
  enums.set(name, variants.map(([v]) => v));
}

// ── codec expression parser ──────────────────────────────────────────────────
function parseCodec(src: string): IdlType {
  let i = 0;
  const peek = (): string => src[i] ?? "";
  const skipWs = (): void => { while (/\s/.test(peek())) i++; };
  const ident = (): string => { skipWs(); const s = i; while (/[\w$]/.test(peek())) i++; return src.slice(s, i); };
  const expect = (c: string): void => { skipWs(); if (peek() !== c) fail(`expected '${c}' at ${i} in ${src}`); i++; };
  const number = (): number => { skipWs(); const s = i; while (/\d/.test(peek())) i++; return Number(src.slice(s, i)); };
  const base = (name: string): string => name.replace(/(Decoder|Size|Prefix)\d+$/, "$1");
  function expr(): IdlType {
    const raw = ident();
    const name = base(raw);
    const prim: Record<string, string> = {
      getU8Decoder: "u8", getU16Decoder: "u16", getU32Decoder: "u32", getU64Decoder: "u64", getU128Decoder: "u128",
      getI8Decoder: "i8", getI16Decoder: "i16", getI32Decoder: "i32", getI64Decoder: "i64", getI128Decoder: "i128",
      getBooleanDecoder: "bool", getAddressDecoder: "pubkey",
    };
    if (prim[name]) { expect("("); expect(")"); return prim[name] as string; }
    if (name === "fixDecoderSize") {
      expect("("); const inner = ident(); expect("("); expect(")"); expect(","); const n = number(); expect(")");
      const innerBase = base(inner);
      if (innerBase === "getBytesDecoder") return { array: ["u8", n] };
      if (innerBase === "getUtf8Decoder") return { array: ["u8", n] };
      return fail(`fixDecoderSize over ${inner}`);
    }
    if (name === "addDecoderSizePrefix") {
      expect("("); const inner = ident(); expect("("); expect(")"); expect(","); ident(); expect("("); expect(")"); expect(")");
      const innerBase = base(inner);
      if (innerBase === "getBytesDecoder") return "bytes";
      if (innerBase === "getUtf8Decoder") return "string";
      return fail(`addDecoderSizePrefix over ${inner}`);
    }
    if (name === "getOptionDecoder") { expect("("); const t = expr(); expect(")"); return { option: t }; }
    if (name === "getArrayDecoder") {
      expect("("); const t = expr(); skipWs();
      if (peek() === ",") { i++; expect("{"); const key = ident(); if (key !== "size") fail(`array option ${key}`); expect(":"); const n = number(); expect("}"); expect(")"); return { array: [t, n] }; }
      expect(")"); return { vec: t };
    }
    const defined = /^get(\w+)Decoder$/.exec(raw);
    if (defined) { expect("("); expect(")"); return { defined: { name: defined[1] as string } }; }
    return fail(`unknown codec ${raw} in ${src}`);
  }
  const t = expr();
  skipWs();
  if (i !== src.length) fail(`trailing input in ${src}`);
  return t;
}

// ── struct decoders ──────────────────────────────────────────────────────────
interface Field { name: string; type: IdlType }
const structs = new Map<string, Field[]>();
/** Events are structs wrapped in a hidden 8-byte prefix — the event discriminator. */
const eventPrefix = new Map<string, number[]>();
const structRe = /function get(\w+)Decoder\(\) \{\s*return (?:getHiddenPrefixDecoder\d*\(\s*)?getStructDecoder\d*\(\[([\s\S]*?)\]\)(?:,\s*\[\s*getConstantDecoder\d*\(\s*(?:fixEncoderSize\d*\(\s*getBytesEncoder\d*\(\),\s*8\s*\)|getBytesEncoder\d*\(\))\.encode\(\s*new Uint8Array\(\[([\d\s,]+)\]\)\s*\)\s*\)\s*\]\s*\))?;\s*\}/g;
for (const m of mjs.matchAll(structRe)) {
  const name = m[1] as string;
  const body = m[2] as string;
  if (m[3]) eventPrefix.set(name, (m[3] as string).split(",").map((x) => Number(x.trim())));
  const fields: Field[] = [];
  // Entries are `["name", <codec>]`; split on the entry boundary, not on commas.
  for (const e of body.matchAll(/\[\s*"(\w+)",\s*([\s\S]*?)\s*\](?=\s*(?:,\s*\[|\s*$))/g)) {
    try {
      fields.push({ name: e[1] as string, type: parseCodec(e[2] as string) });
    } catch (err) {
      fail(`${name}.${e[1]}: ${String(err)}`);
    }
  }
  if (fields.length === 0) fail(`no fields parsed for ${name}`);
  structs.set(name, fields);
}

// ── discriminators ───────────────────────────────────────────────────────────
const discs = new Map<string, number[]>();
for (const m of mjs.matchAll(/var ([A-Z0-9_]+)_DISCRIMINATOR = new Uint8Array\(\s*\[([\d\s,]+)\]\s*\)/g)) {
  discs.set(m[1] as string, (m[2] as string).split(",").map((x) => Number(x.trim())));
}

// ── classify ─────────────────────────────────────────────────────────────────
const accountNames = [...mjs.matchAll(/SatrushAccount2\["(\w+)"\] = \d+/g)].map((m) => m[1] as string);
const instructionDataNames = [...structs.keys()].filter((n) => n.endsWith("InstructionData")).map((n) => n.slice(0, -"InstructionData".length));
const referenced = new Set<string>();
const walk = (t: IdlType): void => {
  if (typeof t === "string") return;
  if ("option" in t) return walk(t.option);
  if ("vec" in t) return walk(t.vec);
  if ("array" in t) return walk(t.array[0]);
  referenced.add(t.defined.name);
};
for (const [name, fields] of structs) if (!name.endsWith("InstructionData")) fields.forEach((f) => walk(f.type));
const eventNames = [...eventPrefix.keys()].sort();
for (const n of eventNames) if (accountNames.includes(n) || referenced.has(n)) fail(`event ${n} is also an account or a field type`);

// ── instruction account tables ───────────────────────────────────────────────
interface IxAccount { name: string; writable?: boolean; signer?: boolean; address?: string; pda?: { seeds: unknown[]; program?: unknown } }
const findPdaSeeds = new Map<string, number[]>();
for (const m of mjs.matchAll(/async function (find\w+Pda)\([^)]*\)[\s\S]*?seeds: \[([\s\S]*?)\]\s*\}\);/g)) {
  const b = /new Uint8Array\(\[([\d\s,]+)\]\)/.exec(m[2] as string);
  if (b) findPdaSeeds.set(m[1] as string, (b[1] as string).split(",").map((x) => Number(x.trim())));
}
function parseSeeds(block: string): { seeds: unknown[]; program?: unknown } | null {
  const seeds: unknown[] = [];
  const re = /getBytesEncoder\d*\(\)\.encode\(\s*new Uint8Array\(\[([\d\s,]+)\]\)\s*\)|getAddressEncoder\d*\(\)\.encode\(\s*(?:getAddressFromResolvedInstructionAccount\d*\(\s*"(\w+)"|expectAddress\d*\(accounts\.(\w+)\.value)|get(U8|U16|U32|U64)Encoder\d*\(\)\.encode\(\s*expectSome\d*\(args\.(\w+)\)\)/g;
  for (const m of block.matchAll(re)) {
    if (m[1]) seeds.push({ kind: "const", value: (m[1] as string).split(",").map((x) => Number(x.trim())) });
    else if (m[2] || m[3]) seeds.push({ kind: "account", path: snake((m[2] ?? m[3]) as string) });
    else if (m[5]) seeds.push({ kind: "arg", path: snake(m[5] as string) });
  }
  if (seeds.length === 0) return null;
  const prog = /programAddress: "([1-9A-HJ-NP-Za-km-z]+)"/.exec(block);
  return prog ? { seeds, program: { kind: "const", value: [...base58Decode(prog[1] as string)] } } : { seeds };
}
function base58Decode(s: string): Uint8Array {
  const A = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const c of s) n = n * 58n + BigInt(A.indexOf(c));
  const out: number[] = [];
  while (n > 0n) { out.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of s) { if (c !== "1") break; out.unshift(0); }
  return Uint8Array.from(out);
}
function instructionAccounts(pascal: string): IxAccount[] {
  // Every instruction has an async builder that resolves PDAs, except the
  // few with no derivable accounts, which only get the sync one.
  const fn = new RegExp(`async function get${pascal}InstructionAsync\\(input, config\\) \\{([\\s\\S]*?)\\n\\}`).exec(mjs)
    ?? new RegExp(`function get${pascal}Instruction\\(input, config\\) \\{([\\s\\S]*?)\\n\\}`).exec(mjs);
  if (!fn) return fail(`no builder for ${pascal}`);
  const body = fn[1] as string;
  const table = /const originalAccounts = \{([\s\S]*?)\n {2}\};/.exec(body);
  if (!table) return fail(`no account table for ${pascal}`);
  const inputType = new RegExp(`type ${pascal}(?:Async)?Input<[\\s\\S]*?> = \\{([\\s\\S]*?)\\n\\};`).exec(dts);
  const signers = new Set([...(inputType?.[1] ?? "").matchAll(/(\w+)\??: TransactionSigner</g)].map((m) => m[1] as string));
  const out: IxAccount[] = [];
  for (const m of (table[1] as string).matchAll(/(\w+): \{\s*value: input\.\w+ \?\? null,\s*isWritable: (true|false)\s*\}/g)) {
    const camel = m[1] as string;
    const acc: IxAccount = { name: snake(camel) };
    if (m[2] === "true") acc.writable = true;
    if (signers.has(camel)) acc.signer = true;
    // PDA default, if the builder resolves one.
    const def = new RegExp(`if \\(!accounts\\.${camel}\\.value\\) \\{([\\s\\S]*?)\\n  \\}`).exec(body);
    if (def) {
      const d = def[1] as string;
      // Fixed program/sysvar addresses the SDK fills in (token programs,
      // system program, rotors, sysvars) become Anchor `address` entries.
      const fixed = new RegExp(`accounts\\.${camel}\\.value = "([1-9A-HJ-NP-Za-km-z]{32,44})";`).exec(d);
      if (fixed) acc.address = fixed[1] as string;
      const viaFind = /await (find\w+Pda)\(/.exec(d);
      if (viaFind && findPdaSeeds.has(viaFind[1] as string)) {
        acc.pda = { seeds: [{ kind: "const", value: findPdaSeeds.get(viaFind[1] as string) }] };
      } else if (/getProgramDerivedAddress/.test(d)) {
        const parsed = parseSeeds(d);
        if (parsed) acc.pda = parsed;
      }
    }
    if (!acc.pda) {
      // Accounts the caller must pass (round, public_deployment, the vault
      // entries…) are derived by the SDK's hand-written helpers; read their
      // seeds so pdas.ts finds a const prefix for every account it derives.
      const helper = helperSeeds.get(acc.name);
      if (helper) acc.pda = { seeds: helper };
    }
    out.push(acc);
  }
  return out;
}
/** `get<Name>Address(...)` helpers: seeds are string literals and typed encoders of the params. */
const helperSeeds = new Map<string, unknown[]>();
for (const m of mjs.matchAll(/async function get(\w+)Address\(([^)]*)\) \{[\s\S]*?seeds: \[([\s\S]*?)\]\s*\}\);/g)) {
  const seeds: unknown[] = [];
  for (const sm of (m[3] as string).matchAll(/"(\w+)"|get(?:U8|U16|U32|U64|Address)Encoder\d*\(\)\.encode\((\w+)\)/g)) {
    if (sm[1]) seeds.push({ kind: "const", value: [...Buffer.from(sm[1] as string, "utf8")] });
    else if (sm[2]) seeds.push({ kind: "arg", path: snake(sm[2] as string) });
  }
  if (seeds.length > 0) helperSeeds.set(snake(m[1] as string), seeds);
}

// ── assemble ─────────────────────────────────────────────────────────────────
const programAddress = /SATRUSH_PROGRAM_ADDRESS = "([1-9A-HJ-NP-Za-km-z]+)"/.exec(mjs)?.[1] ?? fail("program address");
const typeDefs: unknown[] = [];
const fieldOut = (f: Field) => ({ name: snake(f.name), type: f.type });
for (const [name, fields] of structs) {
  if (name.endsWith("InstructionData")) continue;
  const body = accountNames.includes(name) ? fields.slice(1) : fields; // strip the discriminator field
  if (accountNames.includes(name) && fields[0]?.name !== "discriminator") fail(`account ${name} lacks a discriminator field`);
  typeDefs.push({ name, type: { kind: "struct", fields: body.map(fieldOut) } });
}
for (const [name, variants] of enums) typeDefs.push({ name, type: { kind: "enum", variants: variants.map((v) => ({ name: v })) } });
typeDefs.sort((a, b) => ((a as { name: string }).name < (b as { name: string }).name ? -1 : 1));

const accounts = accountNames.map((name) => {
  const disc = discs.get(screaming(name)) ?? fail(`no discriminator for account ${name}`);
  const expected = sha8(`account:${name}`);
  if (disc.join() !== expected.join()) fail(`account ${name} discriminator is not Anchor's convention`);
  return { name, discriminator: disc };
});
const instructions = instructionDataNames.map((pascal) => {
  const name = snake(pascal);
  const disc = discs.get(screaming(pascal)) ?? fail(`no discriminator for instruction ${pascal}`);
  if (disc.join() !== sha8(`global:${name}`).join()) fail(`instruction ${name} discriminator is not Anchor's convention`);
  const fields = structs.get(`${pascal}InstructionData`) ?? [];
  return { name, discriminator: disc, accounts: instructionAccounts(pascal), args: fields.slice(1).map(fieldOut) };
}).sort((a, b) => (a.name < b.name ? -1 : 1));
const events = eventNames.map((name) => {
  const disc = eventPrefix.get(name) as number[];
  if (disc.join() !== sha8(`event:${name}`).join()) fail(`event ${name} prefix is not Anchor's convention`);
  return { name, discriminator: disc };
});
const errors = [...dts.matchAll(/\/\*\* (\w+): ([^*]*?) \*\/\s*declare const SATRUSH_ERROR__(\w+) = (\d+);/g)]
  .map((m) => ({ code: Number(m[4]), name: m[1] as string, msg: (m[2] as string).trim() }))
  .sort((a, b) => a.code - b.code);

const idl = {
  address: programAddress,
  metadata: {
    name: "satrush",
    version: `0.2.0+sdk.${sdkVersion}`,
    spec: "0.1.0",
    description: `Generated from @satrush/client@${sdkVersion} codecs by scripts/idl/gen-idl-from-sdk.ts — the V2 program publishes no IDL`,
  },
  instructions,
  accounts,
  events,
  errors,
  types: typeDefs,
};
writeFileSync(join(repoRoot, "satrush.json"), JSON.stringify(idl, null, 1) + "\n");

// ── TypeScript interfaces, from the same parse ───────────────────────────────
function tsType(t: IdlType): string {
  if (typeof t === "string") {
    if (["u64", "u128", "i64", "i128"].includes(t)) return "BN";
    if (["u8", "u16", "u32", "i8", "i16", "i32"].includes(t)) return "number";
    if (t === "bool") return "boolean";
    if (t === "pubkey") return "PublicKey";
    if (t === "string") return "string";
    if (t === "bytes") return "Buffer";
    return fail(`ts type for ${t}`);
  }
  if ("option" in t) return `${tsType(t.option)} | null`;
  if ("vec" in t) return `${tsType(t.vec)}[]`;
  if ("array" in t) return t.array[0] === "u8" ? "number[]" : `${tsType(t.array[0])}[]`;
  return t.defined.name;
}
let ts = `/**
 * GENERATED by scripts/idl/gen-idl-from-sdk.ts from @satrush/client@${sdkVersion} — do not edit.
 *
 * Decoded shapes of every account, event and helper type in satrush.json, as
 * the anchor coders produce them: snake_case fields, u64/i64/u128 → BN,
 * smaller ints → number, pubkey → PublicKey, option<T> → T | null, byte arrays
 * → number[], enums → single-key variant objects.
 */
import type { PublicKey } from "@solana/web3.js";
import type { BN } from "./idl.js";

`;
for (const [name, variants] of [...enums].sort()) {
  ts += `export type ${name} =\n${variants.map((v) => `  | { ${v}: Record<string, never> }`).join("\n")};\n\n`;
}
for (const def of typeDefs as { name: string; type: { kind: string; fields?: { name: string; type: IdlType }[] } }[]) {
  if (def.type.kind !== "struct") continue;
  ts += `export interface ${def.name} {\n${(def.type.fields ?? []).map((f) => `  ${f.name}: ${tsType(f.type)};`).join("\n")}\n}\n\n`;
}
writeFileSync(join(repoRoot, "src", "adapter", "generated-types.ts"), ts);

console.log(`satrush.json: ${instructions.length} instructions, ${accounts.length} accounts, ${events.length} events, ${errors.length} errors, ${typeDefs.length} types (from @satrush/client@${sdkVersion})`);
console.log(`events: ${eventNames.join(", ")}`);
const dp = instructions.find((i) => i.name === "deploy_public")!;
console.log(`deploy_public accounts: ${dp.accounts.map((a) => `${a.name}${a.writable ? "*" : ""}${a.signer ? "!" : ""}${a.pda ? "~" : ""}`).join(" ")}`);
console.log(`deploy_public args: ${dp.args.map((a) => `${a.name}:${JSON.stringify(a.type)}`).join(" ")}`);
