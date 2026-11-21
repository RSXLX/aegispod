(() => {
  let state = null;
  let busy = false;
  let viewMode = "split";

  const $ = (id) => document.getElementById(id);

  function shortAddr(addr) {
    if (!addr || addr.length < 12) return addr || "—";
    return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
  }

  function fmt(raw, maxDec = 4) {
    const n = Number(raw);
    if (!Number.isFinite(n)) return String(raw ?? "—");
    return n.toLocaleString("en-US", {
      maximumFractionDigits: maxDec,
      minimumFractionDigits: n === 0 ? 0 : Math.min(2, maxDec),
    });
  }

  function escapeHtml(str) {
    return String(str ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function setStatus(msg, explorerUrl) {
    const banner = $("status-banner");
    const text = $("status-text");
    const link = $("status-explorer");
    text.textContent = msg;
    banner.classList.remove("hidden");
    if (explorerUrl) {
      link.href = explorerUrl;
      link.classList.remove("hidden");
    } else {
      link.classList.add("hidden");
    }
  }

  function setReceipt(label, tx) {
    const grid = $("receipt-grid");
    grid.classList.remove("hidden");
    $("rcpt-action").textContent = label;
    $("rcpt-latency").textContent = `${tx.latencyMs} ms (${
      tx.usedSyncRpc ? "eth_sendRawTransactionSync" : "standard"
    })`;
    $("rcpt-gas").textContent = `${Number(tx.gasUsed).toLocaleString()} / ${Number(
      tx.gasLimit
    ).toLocaleString()}`;
    const hashEl = $("rcpt-hash");
    hashEl.href = tx.explorerUrl;
    hashEl.textContent = `${shortAddr(tx.hash)} · #${tx.blockNumber}`;
  }

  function applyViewMode(mode) {
    viewMode = mode;
    const grid = $("console-grid");
    grid.className = `console-grid view-${mode}`;
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.view === mode);
    });
  }

  function setBusy(isBusy) {
    busy = isBusy;
    document.querySelectorAll("button").forEach((btn) => {
      if (btn.closest("dialog") && btn.type === "submit") return;
      if (btn.classList.contains("tab-btn") || btn.id === "btn-open-qr") return;
      btn.disabled = isBusy;
    });
    if (!isBusy && state) render(state);
  }

  function render(d) {
    const nowSec = Math.floor(Date.now() / 1000);
    const frozen = Boolean(d.vault.frozen);
    const activeAlerts = d.activeAlerts || [];
    const hasAlert = activeAlerts.length > 0 && !frozen;
    const hasVaultAssets =
      Number(d.balances.vault.mon) > 0 ||
      Number(d.balances.vault.mUSDT) > 0 ||
      Number(d.balances.vault.mWETH) > 0 ||
      Number(d.balances.vault.mWBTC) > 0 ||
      d.balances.vault.nftCount > 0;
    const hasRescued =
      Number(d.balances.escapePod.mUSDT) > 0 ||
      Number(d.balances.escapePod.mWETH) > 0 ||
      Number(d.balances.escapePod.mWBTC) > 0 ||
      d.balances.escapePod.nftCount > 0;

    // Header telemetry
    $("hdr-block").textContent = `区块 #${d.network.blockNumber}`;
    $("hdr-epoch").textContent = `Epoch #${d.vault.epoch}`;

    // Stepper state
    const activeStep = frozen ? 3 : hasAlert ? 2 : 1;
    [1, 2, 3].forEach((n) => {
      const card = $(`step-${n}`);
      const badge = $(`step-${n}-badge`);
      card.className = "step-card";
      if (n < activeStep) {
        card.classList.add("done");
        badge.textContent = "✓ 已完成";
      } else if (n === activeStep) {
        card.classList.add(n === 2 ? "current-red" : n === 3 ? "current-emerald" : "current-cyan");
        badge.textContent = "当前阶段";
      } else {
        badge.textContent = "待命";
      }
    });

    // Owner panel
    const ownerPanel = $("panel-owner");
    ownerPanel.classList.toggle("panel-brake-active", hasAlert);

    const vaultLink = $("vault-addr-link");
    vaultLink.href = `${d.network.explorerBase}/address/${d.vault.address}`;
    vaultLink.textContent = shortAddr(d.vault.address);

    const ownerPill = $("owner-status-pill");
    if (frozen) {
      ownerPill.className = "pill pill-red";
      ownerPill.textContent = "🔒 已冻结 · 资产已安全撤离";
    } else if (hasAlert) {
      ownerPill.className = "pill pill-amber";
      ownerPill.textContent = "⏳ 冷静期刹车生效中";
    } else {
      ownerPill.className = "pill pill-emerald";
      ownerPill.textContent = `🛡️ 守护布防中（${d.vault.cooldownSeconds}s 冷静期）`;
    }

    $("tracked-counts").textContent = `${d.vault.trackedTokens} ERC-20 + ${d.vault.trackedNfts} NFT`;
    $("v-mon").textContent = fmt(d.balances.vault.mon, 4);
    $("v-usdt").textContent = fmt(d.balances.vault.mUSDT, 0);
    $("v-weth").textContent = fmt(d.balances.vault.mWETH, 2);
    $("v-wbtc").textContent = fmt(d.balances.vault.mWBTC, 2);
    $("v-nft").textContent = `${d.balances.vault.nftCount} 张`;

    $("scammer-usdt").textContent = `${fmt(d.balances.scammer.mUSDT, 0)} mUSDT`;
    $("dlg-scammer-addr").textContent = shortAddr(d.roles.scammer);

    const toInput = $("input-to");
    if (!toInput.value) toInput.value = d.roles.scammer;

    $("btn-sim-scam").disabled = busy || frozen || !hasVaultAssets;
    const submitBtn = $("btn-submit-tx");
    submitBtn.disabled = busy || frozen;
    submitBtn.textContent = frozen
      ? "账户已冻结（无法发起转出）"
      : "发起转账（陌生地址自动进 60s 冷静期刹车）";

    // Cooldown queue list
    const listEl = $("transfer-list");
    if (!d.transfers || d.transfers.length === 0) {
      listEl.innerHTML = `<li class="tx-empty">暂无待放行转账。点击上方「📞 模拟诈骗来电」触发反诈刹车。</li>`;
    } else {
      listEl.innerHTML = d.transfers
        .slice(0, 3)
        .map((tx) => {
          const remain = Math.max(0, tx.unlockTime - nowSec);
          let cls = "tx-item";
          let badge = `<span class="pill pill-slate">已处理</span>`;
          if (tx.active) {
            cls += " tx-active";
            badge = `<span class="pill pill-amber mono">冷静期剩 ${remain}s</span>`;
          } else if (tx.invalidatedByEscape) {
            cls += " tx-voided";
            badge = `<span class="pill pill-emerald">✓ 已被逃生舱 O(1) 作废</span>`;
          } else if (tx.cancelled) {
            badge = `<span class="pill pill-slate">已撤销</span>`;
          }
          return `
            <li class="${cls}">
              <div class="tx-row">
                <strong>#${escapeHtml(tx.id)} · ${escapeHtml(fmt(tx.amountFormatted, 2))} ${escapeHtml(tx.symbol)} → <span class="mono text-amber">${escapeHtml(shortAddr(tx.to))}</span></strong>
                ${badge}
              </div>
              ${tx.memo ? `<div class="muted small" style="margin-top:4px">备注：${escapeHtml(tx.memo)}</div>` : ""}
            </li>`;
        })
        .join("");
    }

    // Guardian panel
    const gPanel = $("panel-guardian");
    gPanel.classList.toggle("panel-alert-active", hasAlert);
    gPanel.classList.toggle("panel-rescued", frozen);

    $("guardian-addr").textContent = shortAddr(d.roles.guardian);

    const gPill = $("guardian-status-pill");
    const gBox = $("guardian-alert-box");
    const escapeBtn = $("btn-escape-pod");
    escapeBtn.classList.toggle("escape-pulse", hasAlert);
    escapeBtn.disabled = busy || (!hasVaultAssets && frozen);

    if (hasAlert) {
      const a = activeAlerts[0];
      const remain = Math.max(0, a.unlockTime - nowSec);
      gPill.className = "pill pill-red";
      gPill.textContent = "🚨 高危警报触发";
      gBox.className = "guardian-state state-alert";
      gBox.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong>⚠️ 检测到陌生大额转出，已被冷静期刹停！</strong>
          <span class="pill pill-red mono">剩 ${remain}s</span>
        </div>
        <div class="alert-kv">
          <div><span class="muted">拦截金额</span><strong class="mono text-amber">${escapeHtml(fmt(a.amountFormatted, 2))} ${escapeHtml(a.symbol)}</strong></div>
          <div><span class="muted">可疑收款人</span><strong class="mono text-red">${escapeHtml(shortAddr(a.to))}</strong></div>
          <div><span class="muted">转账备注</span><span>${escapeHtml(a.memo)}</span></div>
        </div>`;
    } else if (frozen) {
      gPill.className = "pill pill-emerald";
      gPill.textContent = "✅ 逃生舱已完成撤离";
      gBox.className = "guardian-state state-safe";
      gBox.innerHTML = `
        <strong class="text-emerald">✅ 逃生舱已触发！全资产已在一笔交易内安全撤离至冷钱包</strong>
        <p>原热钱包已冻结且 Epoch 已自增，所有排队中的诈骗转账均已作废。骗子即使手握热钱包私钥也无法转走任何资产。</p>`;
    } else {
      gPill.className = "pill pill-slate";
      gPill.textContent = "🟢 实时监听链上事件";
      gBox.className = "guardian-state state-idle";
      gBox.innerHTML = `
        <strong>🛡️ 当前无异常大额转出</strong>
        <p>守护人权限由合约锁死：<strong>无法修改冷钱包地址、无法修改阈值、无法把资金转给自己</strong>；危急时刻可一键把全库资产扫往不可篡改逃生舱。</p>`;
    }

    // Gas optimization card
    $("gas-savings-pill").textContent = `省 ${d.gasOptimization.savingsPct}% Gas`;
    $("gas-tight").textContent = Number(d.gasOptimization.recommendedGasLimit).toLocaleString();
    $("gas-naive").textContent = Number(d.gasOptimization.naiveFixedGasLimit).toLocaleString();

    // Dual-confirmation unfreeze
    const unfreezeBox = $("unfreeze-box");
    unfreezeBox.classList.toggle("hidden", !frozen);
    if (frozen) {
      const btnO = $("btn-unfreeze-owner");
      const btnG = $("btn-unfreeze-guardian");
      btnO.disabled = busy || d.vault.unfreezeByOwner;
      btnG.disabled = busy || d.vault.unfreezeByGuardian;
      btnO.textContent = d.vault.unfreezeByOwner ? "✓ Owner 已确认" : "1. Owner 确认解冻";
      btnG.textContent = d.vault.unfreezeByGuardian ? "✓ Guardian 已确认" : "2. Guardian 确认解冻";
    }

    // Escape Pod Cold Wallet panel
    const podPanel = $("panel-escape-pod");
    podPanel.classList.toggle("panel-rescued", hasRescued);
    const podLink = $("escape-addr-link");
    podLink.href = `${d.network.explorerBase}/address/${d.roles.escapePod}`;
    podLink.textContent = d.roles.escapePod;
    $("pod-status-pill").textContent = hasRescued ? "🛡️ 已安全接收逃生资产" : "待命接收中";

    $("e-mon").textContent = fmt(d.balances.escapePod.mon, 4);
    $("e-usdt").textContent = fmt(d.balances.escapePod.mUSDT, 0);
    $("e-weth").textContent = fmt(d.balances.escapePod.mWETH, 2);
    $("e-wbtc").textContent = fmt(d.balances.escapePod.mWBTC, 2);
    $("e-nft").textContent = `${d.balances.escapePod.nftCount} 张`;
  }

  async function refreshState() {
    try {
      const res = await fetch("/api/state", { cache: "no-store" });
      const json = await res.json();
      if (json.ok) {
        state = json;
        render(state);
      } else {
        setStatus(`链上状态读取失败：${json.error}`);
      }
    } catch (err) {
      setStatus(`网络异常：${err.message || err}`);
    }
  }

  async function callAction(payload, label) {
    setBusy(true);
    setStatus(`正在向 Monad Testnet 提交：${label}...`);
    try {
      const res = await fetch("/api/action", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (!json.ok) {
        setStatus(`操作失败：${json.error || "未知错误"}`);
      } else {
        if (json.tx) {
          setReceipt(label, json.tx);
          setStatus(
            `${label} 已终局确认！耗时 ${json.tx.latencyMs} ms · 区块 #${json.tx.blockNumber}`,
            json.tx.explorerUrl
          );
        } else {
          setStatus(`${label} 已完成！`);
        }
        await refreshState();
      }
    } catch (err) {
      setStatus(`请求出错：${err.message || err}`);
    } finally {
      setBusy(false);
    }
  }

  // Fallback light-dismiss for browsers without `closedby` support (per modern-web-guidance `dialog` guide)
  function setupDialogFallbacks() {
    const dialogs = document.querySelectorAll("dialog");
    dialogs.forEach((dialog) => {
      dialog.addEventListener("close", () => {
        dialog.returnValue = "";
      });
    });

    if (!("closedBy" in HTMLDialogElement.prototype)) {
      const outside = (e, dialog) => {
        const r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      document.querySelectorAll('dialog[closedby="any"]').forEach((dialog) => {
        let pressedOutside = false;
        dialog.addEventListener("pointerdown", (e) => {
          pressedOutside = outside(e, dialog);
        });
        dialog.addEventListener("pointerup", (e) => {
          if (pressedOutside && outside(e, dialog)) dialog.close();
        });
      });
    }
  }

  function init() {
    setupDialogFallbacks();

    const params = new URLSearchParams(window.location.search);
    const roleParam = params.get("role");
    if (roleParam === "owner" || roleParam === "guardian") {
      applyViewMode(roleParam);
    }

    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => applyViewMode(btn.dataset.view));
    });

    // Radio default amounts
    document.querySelectorAll('input[name="asset"]').forEach((radio) => {
      radio.addEventListener("change", (e) => {
        const val = e.target.value;
        const map = { mUSDT: "50000", mWETH: "5", mWBTC: "0.5", MON: "0.02" };
        if (map[val]) $("input-amount").value = map[val];
      });
    });

    // Simulated Scam Call dialog
    const scamDialog = $("scam-dialog");
    $("btn-sim-scam").addEventListener("click", () => scamDialog.showModal());
    $("btn-confirm-scam").addEventListener("click", async () => {
      scamDialog.close("confirm");
      if (!state) return;
      await callAction(
        {
          action: "queueTransfer",
          asset: "mUSDT",
          to: state.roles.scammer,
          amount: "50000",
          memo: "模拟诈骗来电：所谓安全账户核验",
        },
        "模拟诈骗转账 50,000 mUSDT（触发冷静期刹车）"
      );
    });

    // Custom transfer form
    const form = $("transfer-form");
    const errEl = $("form-error");
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.classList.add("hidden");
      const toVal = $("input-to").value.trim();
      const amtVal = $("input-amount").value.trim();
      const memoVal = $("input-memo").value.trim();
      const chosenAsset = form.querySelector('input[name="asset"]:checked')?.value || "mUSDT";

      if (!/^0x[a-fA-F0-9]{40}$/.test(toVal)) {
        errEl.textContent = "请输入合法的 42 位 0x 钱包地址。";
        errEl.classList.remove("hidden");
        $("input-to").setAttribute("aria-invalid", "true");
        $("input-to").focus();
        return;
      }
      $("input-to").removeAttribute("aria-invalid");

      if (!amtVal || Number(amtVal) <= 0) {
        errEl.textContent = "请输入大于 0 的转账数量。";
        errEl.classList.remove("hidden");
        $("input-amount").setAttribute("aria-invalid", "true");
        $("input-amount").focus();
        return;
      }
      $("input-amount").removeAttribute("aria-invalid");

      await callAction(
        {
          action: "queueTransfer",
          asset: chosenAsset,
          to: toVal,
          amount: amtVal,
          memo: memoVal || "自定义陌生大额转账",
        },
        `发起 ${amtVal} ${chosenAsset} 转账（冷静期刹车）`
      );
    });

    // Escape Pod Hero Lever
    $("btn-escape-pod").addEventListener("click", async () => {
      $("escape-btn-title").textContent = "🚀 逃生舱发射中（Monad 同步终局）...";
      await callAction(
        { action: "triggerEscapePod", role: "guardian" },
        "启动一键多资产原子逃生舱"
      );
      $("escape-btn-title").textContent = "🚨 一键启动反诈逃生舱";
    });

    // Dual-confirmation unfreeze
    $("btn-unfreeze-owner").addEventListener("click", () =>
      callAction({ action: "approveUnfreeze", role: "owner" }, "Owner 确认解冻")
    );
    $("btn-unfreeze-guardian").addEventListener("click", () =>
      callAction({ action: "approveUnfreeze", role: "guardian" }, "Guardian 确认解冻")
    );

    // Reseed Demo
    $("btn-reseed").addEventListener("click", () =>
      callAction({ action: "reseedDemo" }, "重置演示并注入多资产组合")
    );

    // Dual-Phone QR dialog
    const qrDialog = $("qr-dialog");
    $("btn-open-qr").addEventListener("click", async () => {
      try {
        const res = await fetch("/api/qr", { cache: "no-store" });
        const json = await res.json();
        if (json.ok) {
          $("qr-owner-img").src = json.ownerQr;
          $("qr-guardian-img").src = json.guardianQr;
          $("qr-owner-url").textContent = json.ownerUrl;
          $("qr-guardian-url").textContent = json.guardianUrl;
          qrDialog.showModal();
        }
      } catch (err) {
        setStatus(`二维码生成失败：${err.message || err}`);
      }
    });

    // Security invariant live tests
    document.querySelectorAll(".sec-test-btn").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const testType = btn.dataset.test;
        const outEl = $(`sec-res-${testType}`);
        btn.disabled = true;
        btn.textContent = "链上验证中...";
        try {
          const txId = state?.transfers?.[0]?.id || "1";
          const res = await fetch("/api/action", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ action: "testSecurityInvariant", testType, txId }),
          });
          const json = await res.json();
          outEl.classList.remove("hidden");
          outEl.textContent = json.blocked
            ? `✓ 链上已 Revert 拦截：${json.revertReason}`
            : `✗ 意外通过：${json.revertReason}`;
        } catch (err) {
          outEl.classList.remove("hidden");
          outEl.textContent = `错误：${err.message || err}`;
        } finally {
          btn.disabled = false;
          btn.textContent = "实测链上拦截";
        }
      });
    });

    refreshState();
    setInterval(refreshState, 4000);
    setInterval(() => {
      if (state) render(state);
    }, 1000);
  }

  document.addEventListener("DOMContentLoaded", init);
})();
