import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import QRCode from "qrcode";
import {
  encodeFunctionData,
  formatEther,
  formatUnits,
  isAddress,
  parseEther,
  parseUnits,
  zeroAddress,
  type Address,
} from "viem";
import { AEGIS_VAULT_ABI, MOCK_ERC20_ABI, MOCK_NFT_ABI } from "./lib/abi";
import {
  getPublicClient,
  loadDeployment,
  MONAD_EXPLORER_BASE,
  sendSignedTxSync,
} from "./lib/monad";
import { getDemoSigners } from "./lib/serverSigners";

const PORT = Number(process.env.PORT || 3000);
const PUBLIC_DIR = path.resolve(__dirname, "../public");
const THREE_BUILD_DIR = path.resolve(__dirname, "../node_modules/three/build");

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
};

function getLanIp(): string {
  const ifaces = os.networkInterfaces();
  for (const entries of Object.values(ifaces)) {
    if (!entries) continue;
    for (const info of entries) {
      if (info.family === "IPv4" && !info.internal) {
        return info.address;
      }
    }
  }
  return "127.0.0.1";
}

function sendJson(res: http.ServerResponse, status: number, payload: unknown) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJsonBody(req: http.IncomingMessage): Promise<Record<string, any>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim();
  return raw ? (JSON.parse(raw) as Record<string, any>) : {};
}

let stateCache: { payload: any; fetchedAt: number } | null = null;
let stateInFlight: Promise<any> | null = null;
const STATE_TTL_MS = 2500;

function invalidateStateCache() {
  stateCache = null;
}

async function fetchLiveStatePayload() {
  const dep = loadDeployment();
  const client = getPublicClient();
  const vaultAddr = dep.contracts.AegisPodVault;
  const escapeAddr = dep.roles.escapePod;
  const scammerAddr = dep.roles.scammer;

  // All readContract calls automatically collapse into ONE Multicall3.aggregate3 call!
  const [
    blockNumber,
    gasPrice,
    vaultMon,
    escapeMon,
    ownerMon,
    guardianMon,
    frozen,
    epoch,
    cooldownSeconds,
    nativeThreshold,
    unfreezeByOwner,
    unfreezeByGuardian,
    trackedCounts,
    recommendedGas,
    recentTransfers,
    vaultUsdt,
    escapeUsdt,
    scammerUsdt,
    vaultWeth,
    escapeWeth,
    vaultWbtc,
    escapeWbtc,
    vaultNftBal,
    escapeNftBal,
  ] = await Promise.all([
    client.getBlockNumber(),
    client.getGasPrice(),
    client.getBalance({ address: vaultAddr }),
    client.getBalance({ address: escapeAddr }),
    client.getBalance({ address: dep.roles.owner }),
    client.getBalance({ address: dep.roles.guardian }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "frozen" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "epoch" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "cooldownSeconds" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "nativeThreshold" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "unfreezeApprovedByOwner" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "unfreezeApprovedByGuardian" }),
    client.readContract({ address: vaultAddr, abi: AEGIS_VAULT_ABI, functionName: "getTrackedAssetCounts" }),
    client.readContract({
      address: vaultAddr,
      abi: AEGIS_VAULT_ABI,
      functionName: "recommendedEscapeGasLimit",
      args: [0n, 0n],
    }),
    client.readContract({
      address: vaultAddr,
      abi: AEGIS_VAULT_ABI,
      functionName: "getPendingTransfers",
      args: [8n],
    }),
    client.readContract({ address: dep.contracts.MockUSDT, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
    client.readContract({ address: dep.contracts.MockUSDT, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [escapeAddr] }),
    client.readContract({ address: dep.contracts.MockUSDT, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [scammerAddr] }),
    client.readContract({ address: dep.contracts.MockWETH, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
    client.readContract({ address: dep.contracts.MockWETH, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [escapeAddr] }),
    client.readContract({ address: dep.contracts.MockWBTC, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
    client.readContract({ address: dep.contracts.MockWBTC, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [escapeAddr] }),
    client.readContract({ address: dep.contracts.AegisGenesisNFT, abi: MOCK_NFT_ABI, functionName: "balanceOf", args: [vaultAddr] }),
    client.readContract({ address: dep.contracts.AegisGenesisNFT, abi: MOCK_NFT_ABI, functionName: "balanceOf", args: [escapeAddr] }),
  ]);

  const tokenMetaByAddr: Record<string, { symbol: string; decimals: number }> = {
    [zeroAddress]: { symbol: "MON", decimals: 18 },
    [dep.contracts.MockUSDT.toLowerCase()]: { symbol: "mUSDT", decimals: 6 },
    [dep.contracts.MockWETH.toLowerCase()]: { symbol: "mWETH", decimals: 18 },
    [dep.contracts.MockWBTC.toLowerCase()]: { symbol: "mWBTC", decimals: 8 },
  };

  const nowSec = Math.floor(Date.now() / 1000);
  const transfers = recentTransfers
    .map((q) => {
      const meta = tokenMetaByAddr[q.token.toLowerCase()] ?? { symbol: "TOKEN", decimals: 18 };
      const isCurrentEpoch = q.epoch === epoch;
      const active = isCurrentEpoch && !q.executed && !q.cancelled && !frozen;
      const invalidatedByEscape = !isCurrentEpoch && !q.executed && !q.cancelled;
      return {
        id: q.id.toString(),
        epoch: q.epoch.toString(),
        token: q.token,
        symbol: meta.symbol,
        to: q.to,
        amountRaw: q.amount.toString(),
        amountFormatted: formatUnits(q.amount, meta.decimals),
        queuedAt: Number(q.queuedAt),
        unlockTime: Number(q.unlockTime),
        secondsRemaining: Math.max(0, Number(q.unlockTime) - nowSec),
        executed: q.executed,
        cancelled: q.cancelled,
        active,
        invalidatedByEscape,
        memo: q.memo,
      };
    })
    .reverse();

  const activeAlerts = transfers.filter((t) => t.active);
  const naiveFixedGas = 1_500_000n;
  const tightGasCostWei = recommendedGas * gasPrice;
  const naiveGasCostWei = naiveFixedGas * gasPrice;
  const savingsPct =
    naiveFixedGas > recommendedGas
      ? Math.round(Number(((naiveFixedGas - recommendedGas) * 100n) / naiveFixedGas))
      : 0;

  return {
    ok: true,
    network: {
      name: "Monad Testnet",
      chainId: dep.chainId,
      blockNumber: blockNumber.toString(),
      gasPriceGwei: formatUnits(gasPrice, 9),
      explorerBase: MONAD_EXPLORER_BASE,
      serverTime: nowSec,
    },
    contracts: dep.contracts,
    roles: dep.roles,
    vault: {
      address: vaultAddr,
      frozen,
      epoch: epoch.toString(),
      cooldownSeconds: Number(cooldownSeconds),
      nativeThresholdMon: formatEther(nativeThreshold),
      unfreezeByOwner,
      unfreezeByGuardian,
      trackedTokens: Number(trackedCounts[0]),
      trackedNfts: Number(trackedCounts[1]),
    },
    balances: {
      vault: {
        mon: formatEther(vaultMon),
        mUSDT: formatUnits(vaultUsdt, 6),
        mWETH: formatUnits(vaultWeth, 18),
        mWBTC: formatUnits(vaultWbtc, 8),
        nftCount: Number(vaultNftBal),
      },
      escapePod: {
        mon: formatEther(escapeMon),
        mUSDT: formatUnits(escapeUsdt, 6),
        mWETH: formatUnits(escapeWeth, 18),
        mWBTC: formatUnits(escapeWbtc, 8),
        nftCount: Number(escapeNftBal),
      },
      scammer: {
        mUSDT: formatUnits(scammerUsdt, 6),
      },
      signers: {
        ownerMon: formatEther(ownerMon),
        guardianMon: formatEther(guardianMon),
      },
    },
    transfers,
    activeAlerts,
    gasOptimization: {
      recommendedGasLimit: recommendedGas.toString(),
      naiveFixedGasLimit: naiveFixedGas.toString(),
      tightCostMon: formatEther(tightGasCostWei),
      naiveCostMon: formatEther(naiveGasCostWei),
      savingsPct,
    },
  };
}

async function handleGetState(res: http.ServerResponse) {
  const now = Date.now();
  if (stateCache && now - stateCache.fetchedAt < STATE_TTL_MS) {
    return sendJson(res, 200, stateCache.payload);
  }

  try {
    if (!stateInFlight) {
      stateInFlight = fetchLiveStatePayload().finally(() => {
        stateInFlight = null;
      });
    }
    const payload = await stateInFlight;
    stateCache = { payload, fetchedAt: Date.now() };
    return sendJson(res, 200, payload);
  } catch (err: any) {
    if (stateCache) {
      return sendJson(res, 200, { ...stateCache.payload, stale: true });
    }
    return sendJson(res, 500, {
      ok: false,
      error: err?.message || "Failed to load Monad Testnet state",
    });
  }
}

async function handleAction(req: http.IncomingMessage, res: http.ServerResponse) {
  invalidateStateCache();
  try {
    const body = await readJsonBody(req);
    const action = String(body.action || "");
    const dep = loadDeployment();
    const { owner, guardian, escapePod } = getDemoSigners();
    const publicClient = getPublicClient();
    const vaultAddr = dep.contracts.AegisPodVault;

    if (action === "queueTransfer") {
      const asset = String(body.asset || "mUSDT");
      const toRaw = String(body.to || dep.roles.scammer).trim();
      if (!isAddress(toRaw)) {
        return sendJson(res, 400, { ok: false, error: "Invalid recipient address" });
      }
      const to = toRaw as Address;
      const amountStr = String(body.amount || "50000").trim();
      const memo = String(body.memo || "Suspicious Transfer").slice(0, 100);

      let data: `0x${string}`;

      if (asset === "MON") {
        const amt = parseEther(amountStr);
        data = encodeFunctionData({
          abi: AEGIS_VAULT_ABI,
          functionName: "requestNativeTransfer",
          args: [to, amt, memo],
        });
      } else {
        const tokenMap: Record<string, { addr: Address; decimals: number }> = {
          mUSDT: { addr: dep.contracts.MockUSDT, decimals: 6 },
          mWETH: { addr: dep.contracts.MockWETH, decimals: 18 },
          mWBTC: { addr: dep.contracts.MockWBTC, decimals: 8 },
        };
        const chosen = tokenMap[asset];
        if (!chosen) {
          return sendJson(res, 400, { ok: false, error: `Unsupported asset: ${asset}` });
        }
        const amt = parseUnits(amountStr, chosen.decimals);
        data = encodeFunctionData({
          abi: AEGIS_VAULT_ABI,
          functionName: "requestERC20Transfer",
          args: [chosen.addr, to, amt, memo],
        });
      }

      // Pre-check call to never waste Monad gas_limit on reverts
      await publicClient.call({ account: owner.address, to: vaultAddr, data });

      const tx = await sendSignedTxSync({
        account: owner,
        to: vaultAddr,
        data,
        fallbackGas: 350_000n,
      });

      return sendJson(res, 200, {
        ok: true,
        action,
        tx: {
          ...tx,
          blockNumber: tx.blockNumber.toString(),
          gasUsed: tx.gasUsed.toString(),
          gasLimit: tx.gasLimit.toString(),
        },
      });
    }

    if (action === "triggerEscapePod") {
      const callerRole = body.role === "owner" ? "owner" : "guardian";
      const signer = callerRole === "owner" ? owner : guardian;

      const recommendedGas = await publicClient.readContract({
        address: vaultAddr,
        abi: AEGIS_VAULT_ABI,
        functionName: "recommendedEscapeGasLimit",
        args: [0n, 0n],
      });

      const data = encodeFunctionData({
        abi: AEGIS_VAULT_ABI,
        functionName: "triggerEscapePod",
        args: [[], []],
      });

      const tx = await sendSignedTxSync({
        account: signer,
        to: vaultAddr,
        data,
        fallbackGas: recommendedGas + 80_000n,
      });

      return sendJson(res, 200, {
        ok: true,
        action,
        triggeredBy: callerRole,
        tx: {
          ...tx,
          blockNumber: tx.blockNumber.toString(),
          gasUsed: tx.gasUsed.toString(),
          gasLimit: tx.gasLimit.toString(),
        },
      });
    }

    if (action === "approveUnfreeze") {
      const role = body.role === "guardian" ? "guardian" : "owner";
      const signer = role === "guardian" ? guardian : owner;
      const data = encodeFunctionData({
        abi: AEGIS_VAULT_ABI,
        functionName: "approveUnfreeze",
        args: [],
      });
      await publicClient.call({ account: signer.address, to: vaultAddr, data });

      const tx = await sendSignedTxSync({
        account: signer,
        to: vaultAddr,
        data,
        fallbackGas: 120_000n,
      });

      return sendJson(res, 200, {
        ok: true,
        action,
        role,
        tx: {
          ...tx,
          blockNumber: tx.blockNumber.toString(),
          gasUsed: tx.gasUsed.toString(),
          gasLimit: tx.gasLimit.toString(),
        },
      });
    }

    if (action === "reseedDemo") {
      // Auto-recycle swept MON from EscapePod back to Owner if Owner gas is running low
      const [ownerBal, escapeBal] = await Promise.all([
        publicClient.getBalance({ address: owner.address }),
        publicClient.getBalance({ address: escapePod.address }),
      ]);
      if (ownerBal < parseEther("0.12") && escapeBal > parseEther("0.06")) {
        const recycleAmt = escapeBal - parseEther("0.02");
        await sendSignedTxSync({
          account: escapePod,
          to: owner.address,
          value: recycleAmt,
          gasLimit: 21_000n,
        });
      }

      const isFrozen = await publicClient.readContract({
        address: vaultAddr,
        abi: AEGIS_VAULT_ABI,
        functionName: "frozen",
      });
      const hashes: string[] = [];

      if (isFrozen) {
        const [ownerOk, guardOk] = await Promise.all([
          publicClient.readContract({
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "unfreezeApprovedByOwner",
          }),
          publicClient.readContract({
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "unfreezeApprovedByGuardian",
          }),
        ]);
        const unfreezeData = encodeFunctionData({
          abi: AEGIS_VAULT_ABI,
          functionName: "approveUnfreeze",
          args: [],
        });
        if (!ownerOk) {
          const r = await sendSignedTxSync({
            account: owner,
            to: vaultAddr,
            data: unfreezeData,
            fallbackGas: 120_000n,
          });
          hashes.push(r.hash);
        }
        if (!guardOk) {
          const r = await sendSignedTxSync({
            account: guardian,
            to: vaultAddr,
            data: unfreezeData,
            fallbackGas: 120_000n,
          });
          hashes.push(r.hash);
        }
      }

      // Idempotently top up only missing demo assets to save gas on repeated resets
      const [curUsdt, curWeth, curWbtc, curNft, curMon] = await Promise.all([
        publicClient.readContract({ address: dep.contracts.MockUSDT, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
        publicClient.readContract({ address: dep.contracts.MockWETH, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
        publicClient.readContract({ address: dep.contracts.MockWBTC, abi: MOCK_ERC20_ABI, functionName: "balanceOf", args: [vaultAddr] }),
        publicClient.readContract({ address: dep.contracts.AegisGenesisNFT, abi: MOCK_NFT_ABI, functionName: "balanceOf", args: [vaultAddr] }),
        publicClient.getBalance({ address: vaultAddr }),
      ]);

      const mintSteps: Array<{ to: Address; data: `0x${string}`; fallbackGas: bigint }> = [];
      if (curUsdt < parseUnits("50000", 6)) {
        mintSteps.push({
          to: dep.contracts.MockUSDT,
          data: encodeFunctionData({
            abi: MOCK_ERC20_ABI,
            functionName: "mint",
            args: [vaultAddr, parseUnits("50000", 6) - curUsdt],
          }),
          fallbackGas: 130_000n,
        });
      }
      if (curWeth < parseUnits("12.5", 18)) {
        mintSteps.push({
          to: dep.contracts.MockWETH,
          data: encodeFunctionData({
            abi: MOCK_ERC20_ABI,
            functionName: "mint",
            args: [vaultAddr, parseUnits("12.5", 18) - curWeth],
          }),
          fallbackGas: 130_000n,
        });
      }
      if (curWbtc < parseUnits("0.85", 8)) {
        mintSteps.push({
          to: dep.contracts.MockWBTC,
          data: encodeFunctionData({
            abi: MOCK_ERC20_ABI,
            functionName: "mint",
            args: [vaultAddr, parseUnits("0.85", 8) - curWbtc],
          }),
          fallbackGas: 130_000n,
        });
      }
      if (curNft < 1n) {
        mintSteps.push({
          to: dep.contracts.AegisGenesisNFT,
          data: encodeFunctionData({
            abi: MOCK_NFT_ABI,
            functionName: "mint",
            args: [vaultAddr],
          }),
          fallbackGas: 320_000n,
        });
      }

      for (const step of mintSteps) {
        const r = await sendSignedTxSync({
          account: owner,
          to: step.to,
          data: step.data,
          fallbackGas: step.fallbackGas,
        });
        hashes.push(r.hash);
      }

      if (curMon < parseEther("0.01")) {
        const r = await sendSignedTxSync({
          account: owner,
          to: vaultAddr,
          value: parseEther("0.01"),
          fallbackGas: 60_000n,
        });
        hashes.push(r.hash);
      }

      return sendJson(res, 200, {
        ok: true,
        action,
        txCount: hashes.length,
        lastHash: hashes[hashes.length - 1] || null,
      });
    }

    if (action === "testSecurityInvariant") {
      const testType = String(body.testType || "ownerWhitelistScammer");
      try {
        if (testType === "ownerWhitelistScammer") {
          await publicClient.simulateContract({
            account: owner.address,
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "setWhitelistedRecipient",
            args: [dep.roles.scammer, true],
          });
        } else if (testType === "ownerShortenCooldown") {
          await publicClient.simulateContract({
            account: owner.address,
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "increaseCooldown",
            args: [5n],
          });
        } else if (testType === "guardianSteal") {
          await publicClient.simulateContract({
            account: guardian.address,
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "requestNativeTransfer",
            args: [guardian.address, parseEther("0.01"), "Steal attempt"],
          });
        } else if (testType === "bypassCooldown") {
          const txId = BigInt(body.txId || 1);
          await publicClient.simulateContract({
            account: owner.address,
            address: vaultAddr,
            abi: AEGIS_VAULT_ABI,
            functionName: "executeQueuedTransfer",
            args: [txId],
          });
        }
        return sendJson(res, 200, {
          ok: true,
          blocked: false,
          revertReason: "Unexpectedly succeeded",
        });
      } catch (simErr: any) {
        return sendJson(res, 200, {
          ok: true,
          blocked: true,
          testType,
          revertReason: simErr?.shortMessage || simErr?.message || "Reverted on-chain",
        });
      }
    }

    return sendJson(res, 400, { ok: false, error: `Unknown action: ${action}` });
  } catch (err: any) {
    return sendJson(res, 500, {
      ok: false,
      error: err?.shortMessage || err?.message || "Transaction failed",
    });
  } finally {
    invalidateStateCache();
  }
}

async function handleQr(req: http.IncomingMessage, res: http.ServerResponse) {
  try {
    const reqHost = req.headers.host || `localhost:${PORT}`;
    const isLocal = reqHost.startsWith("localhost") || reqHost.startsWith("127.0.0.1");
    const lanHost = isLocal ? `${getLanIp()}:${PORT}` : reqHost;
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const ownerUrl = `${proto}://${lanHost}/?role=owner`;
    const guardianUrl = `${proto}://${lanHost}/?role=guardian`;

    const [ownerQr, guardianQr] = await Promise.all([
      QRCode.toDataURL(ownerUrl, { width: 220, margin: 1 }),
      QRCode.toDataURL(guardianUrl, { width: 220, margin: 1 }),
    ]);

    return sendJson(res, 200, {
      ok: true,
      ownerUrl,
      guardianUrl,
      ownerQr,
      guardianQr,
    });
  } catch (err: any) {
    return sendJson(res, 500, { ok: false, error: err?.message || "QR generation failed" });
  }
}

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const pathname = urlObj.pathname;

  if (pathname === "/api/state" && req.method === "GET") {
    return handleGetState(res);
  }
  if (pathname === "/api/action" && req.method === "POST") {
    return handleAction(req, res);
  }
  if (pathname === "/api/qr" && req.method === "GET") {
    return handleQr(req, res);
  }

  if (pathname.startsWith("/vendor/three/")) {
    const sub = path.basename(pathname);
    const filePath = path.join(THREE_BUILD_DIR, sub);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      res.writeHead(200, {
        "Content-Type": "application/javascript; charset=utf-8",
        "Cache-Control": "public, max-age=86400",
      });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
  }

  // Static assets from web/public/
  const relPath = pathname === "/" ? "/index.html" : pathname;
  const safePath = path.normalize(relPath).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
    const ext = path.extname(filePath);
    res.writeHead(200, { "Content-Type": MIME_TYPES[ext] || "application/octet-stream" });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Not Found");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`🛡️  AegisPod running at:`);
  console.log(`   Local : http://localhost:${PORT}`);
  console.log(`   LAN   : http://${getLanIp()}:${PORT} (scan QR on phones!)`);
});
