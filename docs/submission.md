# MOJO 参赛材料

名称：AegisPod — 反诈冷静期与多资产逃生舱

AegisPod 是基于 Monad 测试网的资产保护金库。面对诈骗诱导、误签转账或 Owner 密钥泄露，陌生地址或超阈值转出先进入链上冷静期，为守护人争取响应时间。发现风险后，Owner 或 Guardian 可在一次调用中冻结金库、通过 epoch 换代作废旧队列，并将 MON、已登记 ERC-20、ERC-721 及补充清单资产转往固定冷钱包。解冻需要 Owner 与 Guardian 分别确认。

技术实现：Solidity 0.8.28 + OpenZeppelin；Node.js / TypeScript / viem 服务端；Three.js 交互演示台。读取使用 Multicall，交易优先同步 RPC，回退广播与回执轮询；Gas 采用动态估算加缓冲，资产清单估算兜底。线上演示覆盖冷静期拦截、守护人逃生、五类资产核验与回执追踪，提供双手机角色二维码和 2 分 35 秒中文配音视频。

保护范围是金库内资产。队列失效为 O(1)，资产转移仍逐项执行；异常代币可能跳过，必须核对实际余额。当前版本为服务端测试账户代签的演示原型，未完成正式钱包授权接入或独立安全审计。

体验：https://monad.sxlx.tech
仓库：https://github.com/RSXLX/aegispod
演示视频：https://github.com/RSXLX/aegispod/releases/download/v1.0.0/AegisPod-demo-zh-CN.mp4
