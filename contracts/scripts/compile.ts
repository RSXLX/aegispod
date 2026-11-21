import * as fs from "node:fs";
import * as path from "node:path";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const solc = require("solc");

const ROOT = path.resolve(__dirname, "..");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

function collectSources(): Record<string, { content: string }> {
  const sources: Record<string, { content: string }> = {};
  const files = fs.readdirSync(CONTRACTS_DIR).filter((f) => f.endsWith(".sol"));
  for (const file of files) {
    const rel = `contracts/${file}`;
    sources[rel] = { content: fs.readFileSync(path.join(CONTRACTS_DIR, file), "utf8") };
  }
  return sources;
}

function findImport(importPath: string): { contents: string } | { error: string } {
  const candidates = [
    path.join(ROOT, "node_modules", importPath),
    path.join(ROOT, importPath),
    path.join(CONTRACTS_DIR, importPath),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { contents: fs.readFileSync(c, "utf8") };
    }
  }
  return { error: `Import not found: ${importPath}` };
}

function resolveAllSources(entrySources: Record<string, { content: string }>) {
  const all: Record<string, { content: string }> = { ...entrySources };
  const queue = Object.keys(entrySources);
  const importRe = /import\s+(?:[^'"]+from\s+)?["']([^"']+)["'];/g;

  while (queue.length > 0) {
    const current = queue.shift()!;
    const content = all[current].content;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(content)) !== null) {
      let imp = match[1];
      if (imp.startsWith(".")) {
        imp = path.posix.normalize(path.posix.join(path.posix.dirname(current), imp));
      }
      if (!all[imp]) {
        const res = findImport(imp);
        if ("contents" in res) {
          all[imp] = { content: res.contents };
          queue.push(imp);
        }
      }
    }
  }
  return all;
}

function main() {
  const entrySources = collectSources();
  const allSources = resolveAllSources(entrySources);

  const standardInput = {
    language: "Solidity",
    sources: allSources,
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "prague",
      outputSelection: {
        "*": {
          "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
        },
      },
    },
  };

  console.log(`Compiling ${Object.keys(entrySources).length} contracts (${Object.keys(allSources).length} total sources) with solc ${solc.version()}...`);
  const output = JSON.parse(solc.compile(JSON.stringify(standardInput), { import: findImport }));

  if (output.errors) {
    let hasError = false;
    for (const err of output.errors) {
      if (err.severity === "error") {
        hasError = true;
        console.error(err.formattedMessage);
      } else {
        console.warn(err.formattedMessage);
      }
    }
    if (hasError) process.exit(1);
  }

  fs.mkdirSync(ARTIFACTS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "standard-input.json"),
    JSON.stringify(standardInput, null, 2)
  );
  fs.writeFileSync(
    path.join(ARTIFACTS_DIR, "compiler-version.txt"),
    `v${solc.version().replace(/\.Emscripten\.clang$/, "")}\n`
  );

  let count = 0;
  for (const [sourcePath, contracts] of Object.entries<any>(output.contracts)) {
    if (!sourcePath.startsWith("contracts/")) continue;
    for (const [contractName, artifact] of Object.entries<any>(contracts)) {
      const outDir = path.join(ARTIFACTS_DIR, sourcePath);
      fs.mkdirSync(outDir, { recursive: true });
      const data = {
        contractName,
        sourceName: sourcePath,
        abi: artifact.abi,
        bytecode: `0x${artifact.evm.bytecode.object}`,
        deployedBytecode: `0x${artifact.evm.deployedBytecode.object}`,
        metadata: artifact.metadata ? JSON.parse(artifact.metadata) : null,
      };
      fs.writeFileSync(path.join(outDir, `${contractName}.json`), JSON.stringify(data, null, 2));
      const sizeBytes = (artifact.evm.deployedBytecode.object.length || 0) / 2;
      console.log(`  ✓ ${sourcePath}:${contractName} (${sizeBytes} bytes deployed bytecode)`);
      count++;
    }
  }

  console.log(`Compiled ${count} contracts successfully.`);
}

main();
