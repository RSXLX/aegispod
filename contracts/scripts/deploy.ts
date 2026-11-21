import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseEther,
  parseUnits,
  defineChain,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: [process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz"] },
  },
  blockExplorers: {
    default: { name: "Monadscan", url: "https://testnet.monadscan.com" },
  },
  testnet: true,
});

function loadArtifact(solFile: string, contractName: string) {
  const artifactPath = path.resolve(
    __dirname,
    `../artifacts/contracts/${solFile}/${contractName}.json`
  );
  return JSON.parse(fs.readFileSync(artifactPath, "utf8"));
}

async function main() {
  const ownerKey = process.env.OWNER_PRIVATE_KEY as `0x${string}`;
  const guardianKey = process.env.GUARDIAN_PRIVATE_KEY as `0x${string}`;
  const escapePodAddress = process.env.ESCAPE_POD_ADDRESS as `0x${string}`;
  const scammerAddress = process.env.SCAMMER_ADDRESS as `0x${string}`;

  if (!ownerKey || !guardianKey || !escapePodAddress || !scammerAddress) {
    throw new Error("Missing wallet env vars in contracts/.env");
  }

  const ownerAccount = privateKeyToAccount(ownerKey);
  const guardianAccount = privateKeyToAccount(guardianKey);

  const rpcUrl = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });
  const ownerWallet = createWalletClient({
    account: ownerAccount,
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const ownerBal = await publicClient.getBalance({ address: ownerAccount.address });
  const guardianBal = await publicClient.getBalance({ address: guardianAccount.address });
  console.log(`Owner    (${ownerAccount.address}): ${formatEther(ownerBal)} MON`);
  console.log(`Guardian (${guardianAccount.address}): ${formatEther(guardianBal)} MON`);

  if (ownerBal < parseEther("0.15")) {
    throw new Error(
      `Owner wallet needs at least 0.15 MON on Monad Testnet (current: ${formatEther(ownerBal)} MON).`
    );
  }

  const mockErc20Art = loadArtifact("DemoAssets.sol", "MockERC20");
  const mockNftArt = loadArtifact("DemoAssets.sol", "MockNFT");
  const vaultArt = loadArtifact("AegisPodVault.sol", "AegisPodVault");

  async function deployOne(name: string, art: any, args: any[]) {
    console.log(`\nDeploying ${name}...`);
    const hash = await ownerWallet.deployContract({
      abi: art.abi,
      bytecode: art.bytecode as `0x${string}`,
      args,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`Failed deploying ${name}`);
    console.log(`  ✓ ${name}: ${receipt.contractAddress} (tx: ${hash}, gasUsed: ${receipt.gasUsed})`);
    return receipt.contractAddress;
  }

  const mUsdt = await deployOne("MockUSDT (mUSDT)", mockErc20Art, ["Mock Tether USD", "mUSDT", 6]);
  const mWeth = await deployOne("MockWETH (mWETH)", mockErc20Art, ["Mock Wrapped Ether", "mWETH", 18]);
  const mWbtc = await deployOne("MockWBTC (mWBTC)", mockErc20Art, ["Mock Wrapped BTC", "mWBTC", 8]);
  const aegisNft = await deployOne("AegisGenesisNFT", mockNftArt, ["Aegis Genesis Pass", "AEGIS"]);

  const cooldownSeconds = 60n;
  const nativeThreshold = parseEther("0.05");

  const vault = await deployOne("AegisPodVault", vaultArt, [
    ownerAccount.address,
    guardianAccount.address,
    escapePodAddress,
    cooldownSeconds,
    nativeThreshold,
  ]);

  // Seed vault with 3 ERC-20s + 1 NFT + Native MON!
  console.log("\nRegistering assets and seeding AegisPodVault...");
  const setupTxs: Array<{ label: string; to: `0x${string}`; abi?: any; fn?: string; args?: any[]; value?: bigint }> = [
    { label: "register mUSDT", to: vault, abi: vaultArt.abi, fn: "registerToken", args: [mUsdt, parseUnits("1000", 6)] },
    { label: "register mWETH", to: vault, abi: vaultArt.abi, fn: "registerToken", args: [mWeth, parseUnits("0.5", 18)] },
    { label: "register mWBTC", to: vault, abi: vaultArt.abi, fn: "registerToken", args: [mWbtc, parseUnits("0.05", 8)] },
    { label: "mint 50,000 mUSDT to vault", to: mUsdt, abi: mockErc20Art.abi, fn: "mint", args: [vault, parseUnits("50000", 6)] },
    { label: "mint 12.5 mWETH to vault", to: mWeth, abi: mockErc20Art.abi, fn: "mint", args: [vault, parseUnits("12.5", 18)] },
    { label: "mint 0.85 mWBTC to vault", to: mWbtc, abi: mockErc20Art.abi, fn: "mint", args: [vault, parseUnits("0.85", 8)] },
    { label: "mint Genesis NFT #1 to vault", to: aegisNft, abi: mockNftArt.abi, fn: "mint", args: [vault] },
  ];

  for (const step of setupTxs) {
    const hash = await ownerWallet.writeContract({
      address: step.to,
      abi: step.abi,
      functionName: step.fn!,
      args: step.args!,
    });
    await publicClient.waitForTransactionReceipt({ hash });
    console.log(`  ✓ ${step.label} (${hash})`);
  }

  // Send 0.05 MON to vault as native demo balance (using exact 21,000+ buffer for contract receive())
  const fundVaultHash = await ownerWallet.sendTransaction({
    to: vault,
    value: parseEther("0.05"),
    gas: 45_000n,
  });
  await publicClient.waitForTransactionReceipt({ hash: fundVaultHash });
  console.log(`  ✓ Funded vault with 0.05 MON (${fundVaultHash})`);

  // Ensure guardian has gas MON to press Escape Pod
  if (guardianBal < parseEther("0.05")) {
    const fundGuardianHash = await ownerWallet.sendTransaction({
      to: guardianAccount.address,
      value: parseEther("0.08"),
      gas: 21_000n,
    });
    await publicClient.waitForTransactionReceipt({ hash: fundGuardianHash });
    console.log(`  ✓ Funded guardian with 0.08 MON (${fundGuardianHash})`);
  }

  const deployment = {
    network: "monad-testnet",
    chainId: 10143,
    rpcUrl,
    deployedAt: new Date().toISOString(),
    contracts: {
      AegisPodVault: vault,
      MockUSDT: mUsdt,
      MockWETH: mWeth,
      MockWBTC: mWbtc,
      AegisGenesisNFT: aegisNft,
    },
    roles: {
      owner: ownerAccount.address,
      guardian: guardianAccount.address,
      escapePod: escapePodAddress,
      scammer: scammerAddress,
    },
    constructorParams: {
      cooldownSeconds: cooldownSeconds.toString(),
      nativeThreshold: nativeThreshold.toString(),
    },
  };

  const outPath = path.resolve(__dirname, "../deployments.json");
  fs.writeFileSync(outPath, JSON.stringify(deployment, null, 2) + "\n");
  console.log(`\nSaved deployment manifest to ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
