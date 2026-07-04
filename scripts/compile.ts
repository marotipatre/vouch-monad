// Compile the Solidity contracts with solc-js (no Foundry required) and emit artifacts
// in the same layout the deploy script reads: contracts/out/<File>.sol/<Name>.json
// with { abi, bytecode: { object } }.  Run:  pnpm build:contracts
import solc from "solc";
import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC = join(__dirname, "..", "contracts", "src");
const OUT = join(__dirname, "..", "contracts", "out");

const sources: Record<string, { content: string }> = {};
for (const f of readdirSync(SRC).filter((f) => f.endsWith(".sol"))) {
  sources[f] = { content: readFileSync(join(SRC, f), "utf8") };
}

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "cancun",
    viaIR: true,
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

// Resolve local imports like "./IERC20.sol".
function findImports(path: string) {
  const base = path.replace(/^\.\//, "");
  if (sources[base]) return { contents: sources[base].content };
  try { return { contents: readFileSync(join(SRC, base), "utf8") }; }
  catch { return { error: "File not found: " + path }; }
}

console.log(`solc ${solc.version()}`);
const output = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));

const errors = (output.errors || []).filter((e: any) => e.severity === "error");
if (errors.length) {
  errors.forEach((e: any) => console.error(e.formattedMessage));
  process.exit(1);
}
(output.errors || []).forEach((e: any) => console.warn(e.formattedMessage));

let count = 0;
for (const [file, contracts] of Object.entries<any>(output.contracts)) {
  for (const [name, c] of Object.entries<any>(contracts)) {
    const dir = join(OUT, file);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${name}.json`), JSON.stringify({ abi: c.abi, bytecode: { object: "0x" + c.evm.bytecode.object } }, null, 2));
    count++;
  }
}
console.log(`compiled ${count} contract(s) → contracts/out ✓`);
