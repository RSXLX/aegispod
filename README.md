# 🛡️ AegisPod — 反诈冷静期刹车 & 一键多资产逃生舱

> Built for **Monad Blitz@广州 (Event #18)** on **Monad Testnet (`chainId: 10143`)**.

## 解决什么问题？

当你或你的家人/合伙人在电话诈骗、钓鱼网站或热钱包私钥泄露的慌乱状态下签出一笔大额转账时：
1. **传统钱包没有刹车**：一旦签名广播即永久不可逆；
2. **传统 Safe Delay Module 只拖住单笔**：就算拖住或取消了第一笔可疑转账，骗子或盗币脚本下一秒仍能继续转走钱包里剩余的多种 ERC-20 代币与 NFT。

**AegisPod** 给热钱包装上一套「**强制冷静期刹车 + 守护人一键多资产原子逃生舱**」：
- 陌生地址或超阈值转账自动锁进不可跳过的冷静期；
- 守护人（家人 / 合伙人 / 第二签名人）手机端实时弹出高危警报；
- 守护人一键拉下 **Escape Pod 逃生拉杆**：在**单笔 Monad 交易**中原子完成 **冻结热钱包 + O(1) 作废全部待发诈骗队列 + 扫空 Native MON + 全部已登记/补充 ERC-20 + ERC-721 NFT 至不可篡改冷钱包**！

---

## 三大安全铁律（合约写死，可现场实时验真）

1. **热钱包私钥泄露后，攻击者还能干什么？**
   - `guardian` 与 `escapePod`（冷钱包地址）为合约 `immutable`，**无法被修改**；
   - Owner **无法缩短冷静期**、**无法调高阈值**、**无法把骗子地址加入白名单**（白名单仅 Guardian 可授权）；
   - 任何发往陌生地址的大额转账都强制落入冷静期。
2. **守护人（Guardian）能不能监守自盗？**
   - **绝对不能**。守护人无法调用普通转账，无法修改逃生舱地址与阈值，唯一资产动作是触发 `triggerEscapePod`，资金**只能**进入预设的 `immutable escapePod` 冷钱包。
3. **触发逃生舱冻结后，谁来解冻？**
   - 必须由 **Owner + Guardian 双签确认（`approveUnfreeze`）** 才可解冻，任何一方单独操作均无法解冻。

---

## 为什么选择 Monad？

- **600ms 确定性终局 + `eth_sendRawTransactionSync`**：守护人按下逃生拉杆后，单次 RPC 往返即可在 **< 1 秒内**拿到不可逆链上回执，无需在慢链上赌下一个区块会不会被盗币脚本抢跑。
- **针对 Monad「按 `gas_limit` 扣费」的动态紧缩估算**：由于 Monad 异步执行按 `gas_limit` 而非 `gas_used` 收费，合约提供资产清单登记（解决 EVM 无法枚举 ERC-20 余额的问题）与 `recommendedEscapeGasLimit()`，前端按实际待扫资产数动态设定紧缩 `gasLimit`（相比写死 `1,500,000` 上限节省约 **74% Gas 成本**）。

---

## 目录结构

```text
monad/
├── .monskills                # monskills 元数据 (chain=monad-testnet)
├── contracts/                # Hardhat + Solidity 0.8.28 + OpenZeppelin
│   ├── contracts/
│   │   ├── AegisPodVault.sol # 核心反诈刹车 & 一键原子逃生舱合约
│   │   └── DemoAssets.sol    # 测试网演示多资产 (mUSDT / mWETH / mWBTC / Genesis NFT)
│   ├── test/                 # 完整安全边界与原子扫空单元测试
│   └── scripts/              # 钱包创建领水、测试网部署、三浏览器一键验证、实链 E2E 测试
└── web/                      # Next.js 15 + TypeScript + Tailwind + viem
    └── src/
        ├── app/api/          # 实时链上状态聚合 + eth_sendRawTransactionSync 执行接口
        └── components/       # 双手机分屏总控台 & 二维码双机联动界面
```

---

## 快速启动

```bash
# 1. 编译并运行合约单元测试
cd contracts
pnpm compile
pnpm test

# 2. 创建演示钱包并领取 Monad Testnet 测试 MON
pnpm setup:wallets

# 3. 部署至 Monad Testnet (10143) 并验证合约
pnpm deploy:testnet
pnpm verify:testnet

# 4. 运行实链端到端冒烟测试
pnpm demo:smoke

# 5. 启动双手机演示前端 (http://localhost:3000)
cd ../web
pnpm dev
```
