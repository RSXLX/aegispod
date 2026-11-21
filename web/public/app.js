import { EscapePodStage } from "/pod3d.js";

/**
 * Lightweight Web Audio synthesizer for Shredline-inspired tactile clicks,
 * brake lock alert, 01..05 asset packing ticks, and plasma thruster whoosh.
 */
class TactileAudio {
  constructor() {
    this.enabled = true;
    this.ctx = null;
  }
  _ensure() {
    if (!this.enabled) return null;
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (AC) this.ctx = new AC();
    }
    if (this.ctx && this.ctx.state === "suspended") {
      this.ctx.resume().catch(() => {});
    }
    return this.ctx;
  }
  playBrake() {
    const ctx = this._ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    [520, 380].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.setValueAtTime(freq, now + i * 0.11);
      g.gain.setValueAtTime(0.14, now + i * 0.11);
      g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.11 + 0.18);
      osc.connect(g).connect(ctx.destination);
      osc.start(now + i * 0.11);
      osc.stop(now + i * 0.11 + 0.2);
    });
  }
  playPackTick(step) {
    const ctx = this._ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(420 + step * 95, now);
    g.gain.setValueAtTime(0.12, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
    osc.connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.1);
  }
  playLaunch() {
    const ctx = this._ensure();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(90, now);
    osc.frequency.exponentialRampToValueAtTime(440, now + 0.55);
    g.gain.setValueAtTime(0.1, now);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.65);
    osc.connect(g).connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.7);
  }
}

const $ = (id) => document.getElementById(id);
const audio = new TactileAudio();
let pod3d = null;
let state = null;
let busy = false;
let animatingEscape = false;

function shortAddr(addr) {
  if (!addr || addr.length < 12) return addr || "—";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmt(raw, maxDec = 2) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return String(raw ?? "—");
  return n.toLocaleString("en-US", {
    maximumFractionDigits: maxDec,
    minimumFractionDigits: n === 0 ? 0 : Math.min(2, maxDec),
  });
}

function showReceipt(text, explorerUrl) {
  const pill = $("receipt-pill");
  $("receipt-text").textContent = text;
  const link = $("receipt-link");
  if (explorerUrl) {
    link.href = explorerUrl;
    link.classList.remove("hidden");
  } else {
    link.classList.add("hidden");
  }
  pill.classList.remove("hidden");
}

function setBusy(isBusy) {
  busy = isBusy;
  ["btn-scam", "btn-escape-idle", "btn-escape-alert", "btn-reseed-main", "btn-reseed-top"].forEach(
    (id) => {
      const el = $(id);
      if (el) el.disabled = isBusy;
    }
  );
}

function render(d) {
  const nowSec = Math.floor(Date.now() / 1000);
  const frozen = Boolean(d.vault.frozen);
  const alerts = d.activeAlerts || [];
  const hasAlert = alerts.length > 0 && !frozen;
  const hasVaultAssets =
    Number(d.balances.vault.mon) > 0 ||
    Number(d.balances.vault.mUSDT) > 0 ||
    Number(d.balances.vault.mWETH) > 0 ||
    Number(d.balances.vault.mWBTC) > 0 ||
    d.balances.vault.nftCount > 0;

  // Top telemetry
  $("hdr-block").textContent = `Monad Testnet · #${d.network.blockNumber} · Epoch #${d.vault.epoch}`;
  const vaultLink = $("meta-vault-link");
  vaultLink.href = `${d.network.explorerBase}/address/${d.vault.address}`;
  $("meta-gas").textContent = `Monad gas_limit 紧缩优化：${Number(
    d.gasOptimization.recommendedGasLimit
  ).toLocaleString()} gas（省 ${d.gasOptimization.savingsPct}%）`;

  // Audit dialog metrics
  $("dlg-gas-tight").textContent = Number(d.gasOptimization.recommendedGasLimit).toLocaleString();
  $("dlg-gas-naive").textContent = Number(d.gasOptimization.naiveFixedGasLimit).toLocaleString();
  $("dlg-gas-save").textContent = `-${d.gasOptimization.savingsPct}%`;

  // Floating 5 Asset Cards values
  $("val-usdt").textContent = fmt(d.balances.vault.mUSDT, 0);
  $("val-weth").textContent = fmt(d.balances.vault.mWETH, 2);
  $("val-wbtc").textContent = fmt(d.balances.vault.mWBTC, 2);
  $("val-mon").textContent = fmt(d.balances.vault.mon, 4);
  $("val-nft").textContent = `${d.balances.vault.nftCount} 张`;

  // Cold Wallet destination values
  const coldLink = $("secured-cold-link");
  coldLink.href = `${d.network.explorerBase}/address/${d.roles.escapePod}`;
  coldLink.textContent = `${shortAddr(d.roles.escapePod)} ↗`;
  $("cold-mon").textContent = fmt(d.balances.escapePod.mon, 2);
  $("cold-usdt").textContent = fmt(d.balances.escapePod.mUSDT, 0);
  $("cold-weth").textContent = fmt(d.balances.escapePod.mWETH, 2);
  $("cold-wbtc").textContent = fmt(d.balances.escapePod.mWBTC, 2);
  $("cold-nft").textContent = String(d.balances.escapePod.nftCount);

  // Dual-confirmation unfreeze inside Audit dialog
  const unfreezeWrap = $("dlg-unfreeze");
  unfreezeWrap.classList.toggle("hidden", !frozen);
  if (frozen) {
    const bO = $("btn-unfreeze-owner");
    const bG = $("btn-unfreeze-guardian");
    bO.disabled = busy || d.vault.unfreezeByOwner;
    bG.disabled = busy || d.vault.unfreezeByGuardian;
    bO.textContent = d.vault.unfreezeByOwner ? "✓ Owner 已确认" : "1. Owner 确认解冻";
    bG.textContent = d.vault.unfreezeByGuardian ? "✓ Guardian 已确认" : "2. Guardian 确认解冻";
  }

  if (animatingEscape) return;

  const chip = $("state-chip");
  const hint = $("pod-hint");
  const allCards = ["card-usdt", "card-weth", "card-wbtc", "card-mon", "card-nft"].map($);

  if (frozen || !hasVaultAssets) {
    // STATE 3: SECURED IN COLD ESCAPE POD
    chip.className = "state-chip is-secured";
    chip.textContent = "✅ 逃生舱已完成撤离 · 原热钱包永久冻结";
    hint.textContent = "全部 5 项资产已在一笔 Monad 交易内原子转移至不可篡改冷钱包";
    allCards.forEach((c) => {
      c.classList.remove("is-braked");
      c.classList.add("is-vacuumed");
    });
    $("alert-toast").classList.add("hidden");
    $("secured-dock").classList.remove("hidden");
    $("dock-idle").classList.add("hidden");
    $("dock-alert").classList.add("hidden");
    $("dock-secured").classList.remove("hidden");
    pod3d?.setMode("secured", 5);
  } else if (hasAlert) {
    // STATE 2: RED ALERT BRAKE ENGAGED
    const alertTx = alerts[0];
    const remain = Math.max(0, alertTx.unlockTime - nowSec);
    chip.className = "state-chip is-alert";
    chip.textContent = `🚨 反诈刹车已锁死 50,000 mUSDT · 冷静期剩 ${remain}s`;
    hint.textContent = "逃生舱舱门已开启！直接点击 3D 逃生舱或下方红色按钮一键撤离全部资产";

    allCards.forEach((c) => c.classList.remove("is-vacuumed"));
    $("card-usdt").classList.add("is-braked");
    $("stamp-brake").classList.remove("hidden");
    $("stamp-void").classList.add("hidden");
    $("stamp-countdown").textContent = `${remain}s`;

    $("alert-timer").textContent = `剩 ${remain}s`;
    $("alert-scammer").textContent = shortAddr(alertTx.to);
    $("alert-toast").classList.remove("hidden");
    $("secured-dock").classList.add("hidden");

    $("dock-idle").classList.add("hidden");
    $("dock-alert").classList.remove("hidden");
    $("dock-secured").classList.add("hidden");
    $("dock-gas-hint").textContent = `紧缩 gasLimit ${Number(
      d.gasOptimization.recommendedGasLimit
    ).toLocaleString()}（省 ${d.gasOptimization.savingsPct}%）· 单笔扫空 MON + 3 ERC-20 + NFT`;
    pod3d?.setMode("alert", 0);
  } else {
    // STATE 1: ARMED IDLE
    chip.className = "state-chip";
    chip.textContent = `🛡️ 热钱包布防中 · ${d.vault.cooldownSeconds} 秒反诈冷静期`;
    hint.textContent = "点击「模拟诈骗」触发 60 秒冷静期刹车，或点击 3D 逃生舱体验一键打包撤离";

    allCards.forEach((c) => {
      c.classList.remove("is-vacuumed");
      c.classList.remove("is-braked");
    });
    $("stamp-brake").classList.add("hidden");
    $("stamp-void").classList.add("hidden");
    $("alert-toast").classList.add("hidden");
    $("secured-dock").classList.add("hidden");

    $("dock-idle").classList.remove("hidden");
    $("dock-alert").classList.add("hidden");
    $("dock-secured").classList.add("hidden");
    pod3d?.setMode("idle", 0);
  }
}

async function refreshState() {
  try {
    const res = await fetch("/api/state", { cache: "no-store" });
    const json = await res.json();
    if (json.ok) {
      state = json;
      render(state);
    }
  } catch {
    // Keep last rendered state gracefully
  }
}

async function triggerScamBrake() {
  if (busy || !state) return;
  setBusy(true);
  showReceipt("正在向 Monad Testnet 发起 50,000 mUSDT 陌生转账（触发冷静期刹车）...");
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "queueTransfer",
        asset: "mUSDT",
        to: state.roles.scammer,
        amount: "50000",
        memo: "模拟诈骗来电：安全账户核验",
      }),
    });
    const json = await res.json();
    if (!json.ok) {
      showReceipt(`操作失败：${json.error || "未知错误"}`);
    } else {
      audio.playBrake();
      showReceipt(
        `⛔ 刹车已锁死！50,000 mUSDT 未离库 · ${json.tx.latencyMs} ms (${
          json.tx.usedSyncRpc ? "eth_sendRawTransactionSync" : "standard"
        }) · #${json.tx.blockNumber}`,
        json.tx.explorerUrl
      );
      await refreshState();
    }
  } catch (err) {
    showReceipt(`网络错误：${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

async function triggerEscapePodLaunch() {
  if (busy || animatingEscape || !state) return;
  if (state.vault.frozen) return;

  setBusy(true);
  animatingEscape = true;
  showReceipt("🚀 正在向 Monad Testnet 发送单笔原子逃生舱交易（600ms 终局）...");

  // Start the vacuum animation smoothly on all 5 paper cards + 3D Escape Pod!
  const cardIds = ["card-usdt", "card-weth", "card-wbtc", "card-mon", "card-nft"];
  cardIds.forEach((id, idx) => {
    setTimeout(() => {
      const el = $(id);
      if (el) el.classList.add("is-vacuumed");
    }, idx * 120);
  });

  $("alert-toast").classList.add("hidden");
  $("pod-hint").textContent = "🚀 正在打包 5 项多资产并粉碎骗子队列...";

  const animPromise = new Promise((resolve) => {
    pod3d?.playEscapeSequence(
      (step) => audio.playPackTick(step),
      () => audio.playLaunch(),
      () => resolve()
    );
    if (!pod3d) setTimeout(resolve, 900);
  });

  try {
    const [res] = await Promise.all([
      fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "triggerEscapePod", role: "guardian" }),
      }),
      animPromise,
    ]);
    const json = await res.json();
    if (!json.ok) {
      showReceipt(`逃生舱执行失败：${json.error || "未知错误"}`);
    } else {
      showReceipt(
        `🛡️ 5/5 资产逃生成功！耗时 ${json.tx.latencyMs} ms (${
          json.tx.usedSyncRpc ? "eth_sendRawTransactionSync" : "standard"
        }) · Gas ${Number(json.tx.gasUsed).toLocaleString()} · #${json.tx.blockNumber}`,
        json.tx.explorerUrl
      );
    }
  } catch (err) {
    showReceipt(`请求异常：${err.message || err}`);
  } finally {
    animatingEscape = false;
    await refreshState();
    setBusy(false);
  }
}

async function triggerReseed() {
  if (busy) return;
  setBusy(true);
  showReceipt("🔄 正在双签解冻并重新注入 5 项多资产到热钱包...");
  try {
    const res = await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "reseedDemo" }),
    });
    const json = await res.json();
    if (!json.ok) {
      showReceipt(`重置失败：${json.error || "未知错误"}`);
    } else {
      audio.playPackTick(3);
      showReceipt(`✅ 演示已重置，5 项资产已重新装填就绪！`);
      await refreshState();
    }
  } catch (err) {
    showReceipt(`重置出错：${err.message || err}`);
  } finally {
    setBusy(false);
  }
}

function setupDialogs() {
  document.querySelectorAll("dialog").forEach((dialog) => {
    dialog.addEventListener("close", () => {
      dialog.returnValue = "";
    });
  });
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    const outside = (e, d) => {
      const r = d.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
      let downOut = false;
      dialog.addEventListener("pointerdown", (e) => {
        downOut = outside(e, dialog);
      });
      dialog.addEventListener("pointerup", (e) => {
        if (downOut && outside(e, dialog)) dialog.close();
      });
    });
  }
}

function init() {
  setupDialogs();

  const params = new URLSearchParams(window.location.search);
  if (params.get("role") === "guardian") {
    document.body.classList.add("role-guardian");
  }

  // Mount Three.js 3D Escape Pod
  try {
    pod3d = new EscapePodStage($("pod-canvas"), () => {
      if (!busy && state && !state.vault.frozen) {
        triggerEscapePodLaunch();
      }
    });
  } catch (err) {
    console.warn("WebGL unavailable, using clean 2D fallback:", err);
  }

  // Sound toggle
  $("btn-sound").addEventListener("click", (e) => {
    audio.enabled = !audio.enabled;
    e.currentTarget.setAttribute("aria-pressed", String(audio.enabled));
    e.currentTarget.textContent = audio.enabled ? "🔊 音效" : "🔇 静音";
  });

  // Primary simple controls
  $("btn-scam").addEventListener("click", triggerScamBrake);
  $("btn-escape-idle").addEventListener("click", triggerEscapePodLaunch);
  $("btn-escape-alert").addEventListener("click", triggerEscapePodLaunch);
  $("btn-reseed-top").addEventListener("click", triggerReseed);
  $("btn-reseed-main").addEventListener("click", triggerReseed);

  // Audit & Security Invariants dialog
  const auditDialog = $("audit-dialog");
  $("btn-open-audit").addEventListener("click", () => auditDialog.showModal());
  $("btn-audit-from-dock").addEventListener("click", () => auditDialog.showModal());

  document.querySelectorAll(".sec-btn").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const testType = btn.dataset.test;
      const out = $(`out-${testType}`);
      btn.disabled = true;
      btn.textContent = "验真中...";
      try {
        const txId = state?.transfers?.[0]?.id || "1";
        const res = await fetch("/api/action", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: "testSecurityInvariant", testType, txId }),
        });
        const json = await res.json();
        out.classList.remove("hidden");
        out.textContent = json.blocked
          ? `✓ Monad 链上已 Revert 拦截：${json.revertReason}`
          : `✗ 未拦截：${json.revertReason}`;
      } catch (err) {
        out.classList.remove("hidden");
        out.textContent = `错误：${err.message || err}`;
      } finally {
        btn.disabled = false;
        btn.textContent = "实测拦截";
      }
    });
  });

  // Dual-confirmation unfreeze inside audit dialog
  $("btn-unfreeze-owner").addEventListener("click", async () => {
    setBusy(true);
    await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approveUnfreeze", role: "owner" }),
    });
    await refreshState();
    setBusy(false);
  });

  $("btn-unfreeze-guardian").addEventListener("click", async () => {
    setBusy(true);
    await fetch("/api/action", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "approveUnfreeze", role: "guardian" }),
    });
    await refreshState();
    setBusy(false);
  });

  // QR Pairing dialog
  const qrDialog = $("qr-dialog");
  $("btn-open-qr").addEventListener("click", async () => {
    const res = await fetch("/api/qr", { cache: "no-store" });
    const json = await res.json();
    if (json.ok) {
      $("qr-owner-img").src = json.ownerQr;
      $("qr-guardian-img").src = json.guardianQr;
      $("qr-owner-url").textContent = json.ownerUrl;
      $("qr-guardian-url").textContent = json.guardianUrl;
      qrDialog.showModal();
    }
  });

  refreshState();
  setInterval(refreshState, 4000);
  setInterval(() => {
    if (state && !animatingEscape) render(state);
  }, 1000);
}

document.addEventListener("DOMContentLoaded", init);
