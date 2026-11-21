import * as fs from "node:fs";
import * as path from "node:path";
import * as dotenv from "dotenv";
import { createPublicClient, formatEther, http, defineChain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const envPath = path.resolve(__dirname, "../.env");
const rpcUrl = process.env.MONAD_RPC_URL || "https://testnet-rpc.monad.xyz";

const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  testnet: true,
});

async function dripFaucet(label: string, address: string) {
  try {
    const res = await fetch("https://agents.devnads.com/v1/faucet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chainId: 10143, address }),
    });
    const text = await res.text();
    console.log(`[Faucet ${label}] HTTP ${res.status}: ${text}`);
  } catch (err: any) {
    console.log(`[Faucet ${label}] Error: ${err?.message || err}`);
  }
}

async function main() {
  let envVars: Record<string, string> = {};
  if (fs.existsSync(envPath)) {
    envVars = dotenv.parse(fs.readFileSync(envPath, "utf8"));
  }

  if (!envVars.OWNER_PRIVATE_KEY) {
    const ownerKey = generatePrivateKey();
    const guardianKey = generatePrivateKey();
    const escapePodKey = generatePrivateKey();
    const scammerKey = generatePrivateKey();

    const ownerAcc = privateKeyToAccount(ownerKey);
    const guardianAcc = privateKeyToAccount(guardianKey);
    const escapePodAcc = privateKeyToAccount(escapePodKey);
    const scammerAcc = privateKeyToAccount(scammerKey);

    const content = [
      `MONAD_RPC_URL=${rpcUrl}`,
      `OWNER_PRIVATE_KEY=${ownerKey}`,
      `OWNER_ADDRESS=${ownerAcc.address}`,
      `GUARDIAN_PRIVATE_KEY=${guardianKey}`,
      `GUARDIAN_ADDRESS=${guardianAcc.address}`,
      `ESCAPE_POD_PRIVATE_KEY=${escapePodKey}`,
      `ESCAPE_POD_ADDRESS=${escapePodAcc.address}`,
      `SCAMMER_ADDRESS=${scammerAcc.address}`,
      "",
    ].join("\n");

    fs.writeFileSync(envPath, content, { mode: 0o600 });
    envVars = dotenv.parse(content);
    console.log("Generated fresh demo wallets in contracts/.env (gitignored, 0600).");
  } else {
    console.log("Loaded existing demo wallets from contracts/.env.");
  }

  const ownerAddr = envVars.OWNER_ADDRESS as `0x${string}`;
  const guardianAddr = envVars.GUARDIAN_ADDRESS as `0x${string}`;
  const escapePodAddr = envVars.ESCAPE_POD_ADDRESS as `0x${string}`;
  const scammerAddr = envVars.SCAMMER_ADDRESS as `0x${string}`;

  console.log("\n=== AegisPod Monad Testnet Wallets (Public Addresses) ===");
  console.log(`Owner (Deployer) : ${ownerAddr}`);
  console.log(`Guardian         : ${guardianAddr}`);
  console.log(`Escape Pod (Cold): ${escapePodAddr}`);
  console.log(`Scammer (Demo)   : ${scammerAddr}`);

  const publicClient = createPublicClient({
    chain: monadTestnet,
    transport: http(rpcUrl),
  });

  const beforeOwner = await publicClient.getBalance({ address: ownerAddr });
  const beforeGuardian = await publicClient.getBalance({ address: guardianAddr });

  if (beforeOwner === 0n) {
    console.log("\nRequesting Monad Testnet faucet drip via agents.devnads.com/v1/faucet...");
    await dripFaucet("Owner", ownerAddr);
  }
  if (beforeGuardian === 0n) {
    await dripFaucet("Guardian", guardianAddr);
  }

  // Wait 3s for Monad 600ms finality
  await new Promise((r) => setTimeout(r, 3000));

  const afterOwner = await publicClient.getBalance({ address: ownerAddr });
  const afterGuardian = await publicClient.getBalance({ address: guardianAddr });
  const afterEscape = await publicClient.getBalance({ address: escapePodAddr });

  console.log("\n=== Current Monad Testnet Balances ===");
  console.log(`Owner      : ${formatEther(afterOwner)} MON`);
  console.log(`Guardian   : ${formatEther(afterGuardian)} MON`);
  console.log(`Escape Pod : ${formatEther(afterEscape)} MON`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
