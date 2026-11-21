import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import assert from "node:assert/strict";
import {
  createPublicClient,
  defineChain,
  encodeFunctionData,
  formatEther,
  formatUnits,
  http,
  parseEther,
  parseUnits,
  type Address,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";

dotenv.config({ path: path.resolve(__dirname, "../.env") });

const rpcUrl = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";
const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
});

function loadArtifact(solFile: string, contractName: string) {
  return JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, `../artifacts/contracts/${solFile}/${contractName}.json`),
      "utf8"
    )
  );
}

async function sendSync(
  publicClient: ReturnType<typeof createPublicClient>,
  account: ReturnType<typeof privateKeyToAccount>,
  to: Address,
  data: `0x${string}`,
  gasLimit: bigint,
  value: bigint = 0n
) {
  const [nonce, fees] = await Promise.all([
    publicClient.getTransactionCount({ address: account.address, blockTag: "pending" }),
    publicClient.estimateFeesPerGas(),
  ]);
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxFeePerGas =
    fees.maxFeePerGas && fees.maxFeePerGas > maxPriorityFeePerGas
      ? fees.maxFeePerGas
      : 120_000_000_000n;

  const serialized = await account.signTransaction({
    chainId: 10143,
    type: "eip1559",
    nonce,
    to,
    data,
    value,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const t0 = Date.now();
  try {
    const res = await fetch(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_sendRawTransactionSync",
        params: [serialized],
      }),
    });
    const json = (await res.json()) as any;
    if (json?.result?.transactionHash) {
      return {
        hash: json.result.transactionHash as `0x${string}`,
        blockNumber: BigInt(json.result.blockNumber ?? "0x0"),
        gasUsed: BigInt(json.result.gasUsed ?? "0x0"),
        latencyMs: Date.now() - t0,
        usedSyncRpc: true,
      };
    }
  } catch {}

  const hash = await publicClient.sendRawTransaction({ serializedTransaction: serialized });
  const receipt = await publicClient.waitForTransactionReceipt({ hash, pollingInterval: 250 });
  return {
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    latencyMs: Date.now() - t0,
    usedSyncRpc: false,
  };
}

async function main() {
  const dep = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../deployments.json"), "utf8")
  );
  const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);
  const guardian = privateKeyToAccount(process.env.GUARDIAN_PRIVATE_KEY as `0x${string}`);
  const publicClient = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });

  const vaultArt = loadArtifact("AegisPodVault.sol", "AegisPodVault");
  const erc20Art = loadArtifact("DemoAssets.sol", "MockERC20");
  const nftArt = loadArtifact("DemoAssets.sol", "MockNFT");

  const vaultAddr = dep.contracts.AegisPodVault as Address;
  const escapeAddr = dep.roles.escapePod as Address;
  const scammerAddr = dep.roles.scammer as Address;

  console.log("=== LIVE MONAD TESTNET E2E SMOKE TEST ===");

  // 1. Simulate Scam Transfer -> Brake Engaged
  console.log("\n[1/4] Owner queues suspicious 50,000 mUSDT transfer to scammer...");
  const queueData = encodeFunctionData({
    abi: vaultArt.abi,
    functionName: "requestERC20Transfer",
    args: [dep.contracts.MockUSDT, scammerAddr, parseUnits("50000", 6), "Live Smoke Test Scam"],
  });
  const qRes = await sendSync(publicClient, owner, vaultAddr, queueData, 240_000n);
  console.log(
    `  ✓ Queued! hash=${qRes.hash} block=${qRes.blockNumber} latency=${qRes.latencyMs}ms syncRPC=${qRes.usedSyncRpc} gasUsed=${qRes.gasUsed}`
  );

  const scammerBal = (await publicClient.readContract({
    address: dep.contracts.MockUSDT,
    abi: erc20Art.abi,
    functionName: "balanceOf",
    args: [scammerAddr],
  })) as bigint;
  assert.equal(scammerBal, 0n, "Scammer must receive 0 while in cooldown");

  // 2. Guardian pulls Escape Pod lever with tight dynamic gasLimit!
  console.log("\n[2/4] Guardian pulls Escape Pod lever (atomic sweep of MON + 3 ERC-20 + NFT)...");
  const recGas = (await publicClient.readContract({
    address: vaultAddr,
    abi: vaultArt.abi,
    functionName: "recommendedEscapeGasLimit",
    args: [0n, 0n],
  })) as bigint;
  const escapeData = encodeFunctionData({
    abi: vaultArt.abi,
    functionName: "triggerEscapePod",
    args: [[], []],
  });
  const eRes = await sendSync(publicClient, guardian, vaultAddr, escapeData, recGas);
  console.log(
    `  ✓ ESCAPE POD LANDED! hash=${eRes.hash} block=${eRes.blockNumber} latency=${eRes.latencyMs}ms syncRPC=${eRes.usedSyncRpc} gasUsed=${eRes.gasUsed} / limit=${recGas}`
  );

  // Verify ALL assets arrived at Escape Pod and Vault is frozen + empty
  const [vaultFrozen, vaultMonAfter, vaultUsdtAfter, escapeUsdtAfter, escapeWethAfter, escapeWbtcAfter, escapeNftBal] =
    await Promise.all([
      publicClient.readContract({ address: vaultAddr, abi: vaultArt.abi, functionName: "frozen" }),
      publicClient.getBalance({ address: vaultAddr }),
      publicClient.readContract({ address: dep.contracts.MockUSDT, abi: erc20Art.abi, functionName: "balanceOf", args: [vaultAddr] }),
      publicClient.readContract({ address: dep.contracts.MockUSDT, abi: erc20Art.abi, functionName: "balanceOf", args: [escapeAddr] }),
      publicClient.readContract({ address: dep.contracts.MockWETH, abi: erc20Art.abi, functionName: "balanceOf", args: [escapeAddr] }),
      publicClient.readContract({ address: dep.contracts.MockWBTC, abi: erc20Art.abi, functionName: "balanceOf", args: [escapeAddr] }),
      publicClient.readContract({ address: dep.contracts.AegisGenesisNFT, abi: nftArt.abi, functionName: "balanceOf", args: [escapeAddr] }),
    ]);

  assert.equal(vaultFrozen, true, "Vault must be frozen after Escape Pod");
  assert.equal(vaultMonAfter, 0n, "Vault native MON must be 0");
  assert.equal(vaultUsdtAfter, 0n, "Vault mUSDT must be 0");
  assert.ok((escapeUsdtAfter as bigint) >= parseUnits("50000", 6), "EscapePod must hold rescued mUSDT");
  assert.ok((escapeWethAfter as bigint) >= parseUnits("12.5", 18), "EscapePod must hold rescued mWETH");
  assert.ok((escapeWbtcAfter as bigint) >= parseUnits("0.85", 8), "EscapePod must hold rescued mWBTC");
  assert.ok((escapeNftBal as bigint) >= 1n, "EscapePod must hold rescued NFT");

  console.log(
    `  ✓ Verified EscapePod balances: mUSDT=${formatUnits(escapeUsdtAfter as bigint, 6)}, mWETH=${formatUnits(escapeWethAfter as bigint, 18)}, mWBTC=${formatUnits(escapeWbtcAfter as bigint, 8)}, NFT=${escapeNftBal}`
  );

  // 3. Test Dual-Confirmation Unfreeze
  console.log("\n[3/4] Testing Dual-Confirmation Unfreeze (Owner + Guardian)...");
  const unfreezeData = encodeFunctionData({
    abi: vaultArt.abi,
    functionName: "approveUnfreeze",
    args: [],
  });
  await sendSync(publicClient, owner, vaultAddr, unfreezeData, 85_000n);
  const stillFrozen = await publicClient.readContract({
    address: vaultAddr,
    abi: vaultArt.abi,
    functionName: "frozen",
  });
  assert.equal(stillFrozen, true, "Single owner approval must NOT unfreeze vault");

  await sendSync(publicClient, guardian, vaultAddr, unfreezeData, 85_000n);
  const nowFrozen = await publicClient.readContract({
    address: vaultAddr,
    abi: vaultArt.abi,
    functionName: "frozen",
  });
  assert.equal(nowFrozen, false, "Dual Owner+Guardian approval must unfreeze vault");
  console.log("  ✓ Dual-confirmation unfreeze verified!");

  // 4. Re-seed vault so it is freshly armed and ready for live user/judge demo!
  console.log("\n[4/4] Re-seeding vault with fresh multi-asset portfolio for live demo...");
  await sendSync(
    publicClient,
    owner,
    dep.contracts.MockUSDT,
    encodeFunctionData({ abi: erc20Art.abi, functionName: "mint", args: [vaultAddr, parseUnits("50000", 6)] }),
    90_000n
  );
  await sendSync(
    publicClient,
    owner,
    dep.contracts.MockWETH,
    encodeFunctionData({ abi: erc20Art.abi, functionName: "mint", args: [vaultAddr, parseUnits("12.5", 18)] }),
    90_000n
  );
  await sendSync(
    publicClient,
    owner,
    dep.contracts.MockWBTC,
    encodeFunctionData({ abi: erc20Art.abi, functionName: "mint", args: [vaultAddr, parseUnits("0.85", 8)] }),
    90_000n
  );
  await sendSync(
    publicClient,
    owner,
    dep.contracts.AegisGenesisNFT,
    encodeFunctionData({ abi: nftArt.abi, functionName: "mint", args: [vaultAddr] }),
    180_000n
  );
  await sendSync(publicClient, owner, vaultAddr, "0x", 45_000n, parseEther("0.02"));

  const ownerRem = await publicClient.getBalance({ address: owner.address });
  const guardRem = await publicClient.getBalance({ address: guardian.address });
  console.log(
    `\n✅ ALL LIVE MONAD TESTNET TESTS PASSED! Vault is armed & ready.\nRemaining balances — Owner: ${formatEther(ownerRem)} MON | Guardian: ${formatEther(guardRem)} MON`
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
