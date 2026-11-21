import * as fs from "node:fs";
import * as path from "node:path";
import { encodeAbiParameters, parseAbiParameters } from "viem";

const ROOT = path.resolve(__dirname, "..");
const ARTIFACTS_DIR = path.join(ROOT, "artifacts");

async function verifyContract(params: {
  chainId: number;
  contractAddress: string;
  contractName: string;
  constructorArgs?: string;
}) {
  const [sourcePath, name] = params.contractName.split(":");
  const standardJsonInput = JSON.parse(
    fs.readFileSync(path.join(ARTIFACTS_DIR, "standard-input.json"), "utf8")
  );
  const compilerVersion = fs
    .readFileSync(path.join(ARTIFACTS_DIR, "compiler-version.txt"), "utf8")
    .trim();
  const artifact = JSON.parse(
    fs.readFileSync(path.join(ARTIFACTS_DIR, sourcePath, `${name}.json`), "utf8")
  );

  const payload: Record<string, any> = {
    chainId: params.chainId,
    contractAddress: params.contractAddress,
    contractName: params.contractName,
    compilerVersion,
    standardJsonInput,
    foundryMetadata: artifact.metadata,
  };
  if (params.constructorArgs) {
    payload.constructorArgs = params.constructorArgs.replace(/^0x/, "");
  }

  console.log(
    `Verifying ${params.contractName} @ ${params.contractAddress} (${compilerVersion})...`
  );
  const res = await fetch("https://agents.devnads.com/v1/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await res.text();
  console.log(`  HTTP ${res.status}: ${text}`);
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.join(ROOT, "deployments.json"), "utf8"));

  const vaultArgs = encodeAbiParameters(
    parseAbiParameters("address,address,address,uint64,uint256"),
    [
      dep.roles.owner,
      dep.roles.guardian,
      dep.roles.escapePod,
      BigInt(dep.constructorParams.cooldownSeconds),
      BigInt(dep.constructorParams.nativeThreshold),
    ]
  );

  await verifyContract({
    chainId: dep.chainId,
    contractAddress: dep.contracts.AegisPodVault,
    contractName: "contracts/AegisPodVault.sol:AegisPodVault",
    constructorArgs: vaultArgs,
  });

  const usdtArgs = encodeAbiParameters(parseAbiParameters("string,string,uint8"), [
    "Mock Tether USD",
    "mUSDT",
    6,
  ]);
  await verifyContract({
    chainId: dep.chainId,
    contractAddress: dep.contracts.MockUSDT,
    contractName: "contracts/DemoAssets.sol:MockERC20",
    constructorArgs: usdtArgs,
  });

  const nftArgs = encodeAbiParameters(parseAbiParameters("string,string"), [
    "Aegis Genesis Pass",
    "AEGIS",
  ]);
  await verifyContract({
    chainId: dep.chainId,
    contractAddress: dep.contracts.AegisGenesisNFT,
    contractName: "contracts/DemoAssets.sol:MockNFT",
    constructorArgs: nftArgs,
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
