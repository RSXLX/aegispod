import * as fs from "node:fs";
import * as path from "node:path";
import {
  createPublicClient,
  defineChain,
  fallback,
  http,
  type Address,
  type Hash,
  type Hex,
  type PrivateKeyAccount,
} from "viem";

export const MONAD_RPC_URLS: string[] = Array.from(
  new Set(
    [
      process.env.MONAD_RPC_URL,
      "https://rpc.ankr.com/monad_testnet",
      "https://monad-testnet.drpc.org",
      "https://testnet-rpc.monad.xyz",
    ].filter((u): u is string => Boolean(u && u.trim()))
  )
);

// Prioritize Ankr/dRPC for heavy reads & Multicall, keep official testnet-rpc for eth_sendRawTransactionSync
export const READ_RPC_URLS: string[] = [
  "https://rpc.ankr.com/monad_testnet",
  "https://monad-testnet.drpc.org",
  "https://testnet-rpc.monad.xyz",
];

export const SYNC_RPC_URLS: string[] = [
  "https://testnet-rpc.monad.xyz",
  "https://rpc.ankr.com/monad_testnet",
  "https://monad-testnet.drpc.org",
];

export const MONAD_EXPLORER_BASE = "https://testnet.monadscan.com";

export const monadTestnet = defineChain({
  id: 10143,
  name: "Monad Testnet",
  nativeCurrency: { name: "MON", symbol: "MON", decimals: 18 },
  rpcUrls: {
    default: { http: READ_RPC_URLS },
  },
  blockExplorers: {
    default: { name: "Monadscan", url: MONAD_EXPLORER_BASE },
  },
  contracts: {
    multicall3: {
      address: "0xcA11bde05977b3631167028862bE2a173976CA11",
    },
  },
  testnet: true,
});

export interface DeploymentManifest {
  network: string;
  chainId: number;
  rpcUrl: string;
  deployedAt: string;
  contracts: {
    AegisPodVault: Address;
    MockUSDT: Address;
    MockWETH: Address;
    MockWBTC: Address;
    AegisGenesisNFT: Address;
  };
  roles: {
    owner: Address;
    guardian: Address;
    escapePod: Address;
    scammer: Address;
  };
  constructorParams: {
    cooldownSeconds: string;
    nativeThreshold: string;
  };
}

let cachedManifest: DeploymentManifest | null = null;

export function loadDeployment(): DeploymentManifest {
  if (cachedManifest) return cachedManifest;
  const candidates = [
    path.resolve(process.cwd(), "../contracts/deployments.json"),
    path.resolve(process.cwd(), "contracts/deployments.json"),
    path.resolve(process.cwd(), "deployments.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      cachedManifest = JSON.parse(fs.readFileSync(p, "utf8")) as DeploymentManifest;
      return cachedManifest;
    }
  }
  throw new Error(
    "contracts/deployments.json not found. Deploy contracts to Monad Testnet first."
  );
}

let sharedClient: ReturnType<typeof createPublicClient> | null = null;

export function getPublicClient() {
  if (sharedClient) return sharedClient;
  sharedClient = createPublicClient({
    chain: monadTestnet,
    batch: {
      multicall: {
        batchSize: 2048,
        wait: 16,
      },
    },
    transport: fallback(
      READ_RPC_URLS.map((url) =>
        http(url, {
          batch: { batchSize: 32, wait: 16 },
          retryCount: 1,
          timeout: 12_000,
        })
      ),
      { rank: false }
    ),
  });
  return sharedClient;
}

export interface SyncTxResult {
  hash: Hash;
  blockNumber: bigint;
  gasUsed: bigint;
  gasLimit: bigint;
  status: "success" | "reverted";
  latencyMs: number;
  usedSyncRpc: boolean;
  explorerUrl: string;
}

export async function estimateTightGas(params: {
  account: Address;
  to: Address;
  data?: Hex;
  value?: bigint;
  fallbackGas: bigint;
}): Promise<bigint> {
  const publicClient = getPublicClient();
  try {
    const est = await publicClient.estimateGas({
      account: params.account,
      to: params.to,
      data: params.data ?? "0x",
      value: params.value ?? 0n,
    });
    // Per Monad gas/SKILL.md: keep buffer tight (~12%) because Monad charges on gas_limit
    return est + (est * 12n) / 100n + 5_000n;
  } catch {
    return params.fallbackGas;
  }
}

const lastNonceByAddr = new Map<string, number>();

/**
 * Sends a signed EIP-1559 transaction on Monad Testnet using `eth_sendRawTransactionSync`
 * across available Monad RPCs (returning the receipt in a single round-trip for ~600ms finality UX),
 * with automatic fallback to standard `sendRawTransaction` + receipt polling.
 */
export async function sendSignedTxSync(params: {
  account: PrivateKeyAccount;
  to: Address;
  data?: Hex;
  value?: bigint;
  gasLimit?: bigint;
  fallbackGas?: bigint;
}): Promise<SyncTxResult> {
  const publicClient = getPublicClient();
  const [rpcNonce, fees, gasLimit] = await Promise.all([
    publicClient.getTransactionCount({
      address: params.account.address,
      blockTag: "pending",
    }),
    publicClient.estimateFeesPerGas(),
    params.gasLimit
      ? Promise.resolve(params.gasLimit)
      : estimateTightGas({
          account: params.account.address,
          to: params.to,
          data: params.data,
          value: params.value,
          fallbackGas: params.fallbackGas ?? 350_000n,
        }),
  ]);

  const addrKey = params.account.address.toLowerCase();
  const prev = lastNonceByAddr.get(addrKey);
  const nonce = prev !== undefined && rpcNonce <= prev ? prev + 1 : rpcNonce;
  lastNonceByAddr.set(addrKey, nonce);

  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas ?? 2_000_000_000n;
  const maxFeePerGas =
    fees.maxFeePerGas && fees.maxFeePerGas > maxPriorityFeePerGas
      ? fees.maxFeePerGas
      : 120_000_000_000n;

  const serializedTx = await params.account.signTransaction({
    chainId: monadTestnet.id,
    type: "eip1559",
    nonce,
    to: params.to,
    data: params.data ?? "0x",
    value: params.value ?? 0n,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
  });

  const t0 = Date.now();
  let usedSyncRpc = false;

  for (const rpcUrl of SYNC_RPC_URLS) {
    try {
      const rpcRes = await fetch(rpcUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "eth_sendRawTransactionSync",
          params: [serializedTx],
        }),
      });
      if (!rpcRes.ok) continue;
      const json = (await rpcRes.json()) as any;
      if (json?.result?.transactionHash) {
        usedSyncRpc = true;
        const r = json.result;
        const latencyMs = Date.now() - t0;
        const hash = r.transactionHash as Hash;
        const status = r.status === "0x1" || r.status === 1 ? "success" : "reverted";
        if (status === "reverted") {
          throw new Error(`Transaction reverted on-chain (tx: ${hash})`);
        }
        return {
          hash,
          blockNumber: BigInt(r.blockNumber ?? "0x0"),
          gasUsed: BigInt(r.gasUsed ?? "0x0"),
          gasLimit,
          status,
          latencyMs,
          usedSyncRpc,
          explorerUrl: `${MONAD_EXPLORER_BASE}/tx/${hash}`,
        };
      }
    } catch (e: any) {
      if (e?.message?.startsWith("Transaction reverted")) throw e;
      // Try next RPC
    }
  }

  const hash = await publicClient.sendRawTransaction({
    serializedTransaction: serializedTx,
  });
  const receipt = await publicClient.waitForTransactionReceipt({
    hash,
    pollingInterval: 300,
  });
  const latencyMs = Date.now() - t0;
  if (receipt.status === "reverted") {
    throw new Error(`Transaction reverted on-chain (tx: ${hash})`);
  }

  return {
    hash,
    blockNumber: receipt.blockNumber,
    gasUsed: receipt.gasUsed,
    gasLimit,
    status: receipt.status,
    latencyMs,
    usedSyncRpc,
    explorerUrl: `${MONAD_EXPLORER_BASE}/tx/${hash}`,
  };
}
