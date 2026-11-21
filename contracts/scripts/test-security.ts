import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import assert from "node:assert/strict";
import { createPublicClient, defineChain, http, parseEther, type Address } from "viem";
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

async function assertReverts(label: string, fn: () => Promise<unknown>) {
  try {
    await fn();
    throw new Error(`Expected revert but succeeded: ${label}`);
  } catch (err: any) {
    if (err.message?.startsWith("Expected revert")) throw err;
    console.log(`  ✓ Blocked as expected: ${label} (${err.shortMessage || err.name})`);
  }
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../deployments.json"), "utf8"));
  const vaultArt = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../artifacts/contracts/AegisPodVault.sol/AegisPodVault.json"),
      "utf8"
    )
  );
  const owner = privateKeyToAccount(process.env.OWNER_PRIVATE_KEY as `0x${string}`);
  const guardian = privateKeyToAccount(process.env.GUARDIAN_PRIVATE_KEY as `0x${string}`);
  const client = createPublicClient({ chain: monadTestnet, transport: http(rpcUrl) });
  const vaultAddr = dep.contracts.AegisPodVault as Address;

  console.log("=== SECURITY INVARIANT TESTS (LIVE MONAD TESTNET) ===");

  // 1. Immutable role separation check
  const [onchainOwner, onchainGuardian, onchainEscape] = await Promise.all([
    client.readContract({ address: vaultAddr, abi: vaultArt.abi, functionName: "owner" }),
    client.readContract({ address: vaultAddr, abi: vaultArt.abi, functionName: "guardian" }),
    client.readContract({ address: vaultAddr, abi: vaultArt.abi, functionName: "escapePod" }),
  ]);
  assert.equal((onchainOwner as string).toLowerCase(), owner.address.toLowerCase());
  assert.equal((onchainGuardian as string).toLowerCase(), guardian.address.toLowerCase());
  assert.equal((onchainEscape as string).toLowerCase(), dep.roles.escapePod.toLowerCase());
  console.log("  ✓ Immutable roles (owner / guardian / escapePod) verified on-chain");

  // 2. Compromised owner CANNOT whitelist a scammer
  await assertReverts("Compromised owner tries to whitelist scammer", () =>
    client.simulateContract({
      account: owner.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "setWhitelistedRecipient",
      args: [dep.roles.scammer, true],
    })
  );

  // 3. Compromised owner CANNOT shorten cooldown
  await assertReverts("Compromised owner tries to shorten cooldown to 5s", () =>
    client.simulateContract({
      account: owner.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "increaseCooldown",
      args: [5n],
    })
  );

  // 4. Compromised owner CANNOT raise native threshold
  await assertReverts("Compromised owner tries to raise native threshold", () =>
    client.simulateContract({
      account: owner.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "lowerNativeThreshold",
      args: [parseEther("10")],
    })
  );

  // 5. Malicious guardian CANNOT transfer funds to self
  await assertReverts("Malicious guardian tries to steal native MON to self", () =>
    client.simulateContract({
      account: guardian.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "requestNativeTransfer",
      args: [guardian.address, parseEther("0.01"), "Steal"],
    })
  );

  // 6. Malicious guardian CANNOT steal ERC-20 to self
  await assertReverts("Malicious guardian tries to steal mUSDT to self", () =>
    client.simulateContract({
      account: guardian.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "requestERC20Transfer",
      args: [dep.contracts.MockUSDT, guardian.address, 1000n, "Steal ERC20"],
    })
  );

  // 7. Random stranger CANNOT trigger escape pod
  await assertReverts("Random scammer tries to trigger escape pod", () =>
    client.simulateContract({
      account: dep.roles.scammer as Address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "triggerEscapePod",
      args: [[], []],
    })
  );

  // 8. Cannot execute stale/non-existent queued transfer
  await assertReverts("Owner tries to execute stale/invalidated queued transfer #1", () =>
    client.simulateContract({
      account: owner.address,
      address: vaultAddr,
      abi: vaultArt.abi,
      functionName: "executeQueuedTransfer",
      args: [1n],
    })
  );

  console.log("\n✅ ALL 8 ON-CHAIN SECURITY INVARIANT TESTS PASSED!");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
