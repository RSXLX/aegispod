// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {IERC721Receiver} from "@openzeppelin/contracts/token/ERC721/IERC721Receiver.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AegisPodVault
/// @notice Anti-scam cooldown brake + single-transaction atomic multi-asset Escape Pod on Monad.
/// @dev Security invariants:
///  1. `guardian` and `escapePod` are IMMUTABLE: a compromised owner key cannot redirect escape funds or remove guardian.
///  2. `guardian` can NEVER transfer funds to themselves or arbitrary targets — ONLY to `escapePod`.
///  3. `cooldownSeconds` can only be increased by `owner`, never shortened by an attacker.
///  4. `triggerEscapePod` freezes the vault, invalidates all pending transfers in O(1) via `epoch++`,
///     and atomically sweeps Native MON + all registered/extra ERC-20s + all registered/extra ERC-721s to `escapePod`.
///  5. Unfreezing requires dual confirmation from BOTH `owner` and `guardian`.
contract AegisPodVault is ReentrancyGuard, IERC721Receiver {
    using SafeERC20 for IERC20;

    struct NftAsset {
        address nft;
        uint256 tokenId;
    }

    struct QueuedTransfer {
        uint256 id;
        uint256 epoch;
        address token; // address(0) for native MON
        address to;
        uint256 amount;
        uint64 queuedAt;
        uint64 unlockTime;
        bool executed;
        bool cancelled;
        string memo;
    }

    // ---- Immutable Security Anchors ----
    address public immutable owner;
    address public immutable guardian;
    address public immutable escapePod;

    // ---- Configurable Guardrails (attacker cannot weaken cooldown) ----
    uint64 public cooldownSeconds;
    uint256 public nativeThreshold;
    mapping(address => uint256) public tokenThresholds;
    mapping(address => bool) public whitelistedRecipients;

    // ---- Vault State ----
    bool public frozen;
    uint256 public epoch;
    uint256 public nextTxId;

    // Dual-confirmation unfreeze state
    bool public unfreezeApprovedByOwner;
    bool public unfreezeApprovedByGuardian;

    // ---- Tracked Asset Registry (Solves EVM ERC-20 enumeration limitation) ----
    address[] private _registeredTokens;
    mapping(address => bool) public isTokenRegistered;

    NftAsset[] private _registeredNfts;
    mapping(address => mapping(uint256 => bool)) public isNftRegistered;

    // ---- Queued Transfers ----
    mapping(uint256 => QueuedTransfer) public queuedTransfers;

    // ---- Events ----
    event NativeDeposited(address indexed from, uint256 amount);
    event TokenRegistered(address indexed token, uint256 threshold);
    event NftRegistered(address indexed nft, uint256 indexed tokenId);
    event RecipientWhitelistUpdated(address indexed recipient, bool allowed);
    event CooldownIncreased(uint64 oldCooldown, uint64 newCooldown);
    event NativeThresholdLowered(uint256 oldThreshold, uint256 newThreshold);

    event ImmediateTransferExecuted(
        address indexed token,
        address indexed to,
        uint256 amount,
        string memo
    );

    event TransferQueued(
        uint256 indexed txId,
        uint256 indexed epoch,
        address indexed to,
        address token,
        uint256 amount,
        uint64 unlockTime,
        string memo
    );

    event TransferExecuted(
        uint256 indexed txId,
        address indexed to,
        address token,
        uint256 amount
    );

    event TransferCancelled(uint256 indexed txId, address indexed cancelledBy);

    event EscapePodTriggered(
        address indexed triggeredBy,
        address indexed escapePod,
        uint256 nativeSwept,
        uint256 erc20SweptCount,
        uint256 nftSweptCount,
        uint256 newEpoch,
        uint256 blockNumber,
        uint256 timestamp
    );

    event UnfreezeApproved(address indexed approver, bool ownerApproved, bool guardianApproved);
    event VaultUnfrozen(uint256 timestamp);

    // ---- Errors ----
    error OnlyOwner();
    error OnlyOwnerOrGuardian();
    error ZeroAddress();
    error InvalidRoleSeparation();
    error VaultIsFrozen();
    error VaultNotFrozen();
    error InvalidCooldown();
    error CannotIncreaseThreshold();
    error InvalidAmount();
    error InsufficientBalance();
    error TransferNotFound();
    error TransferStaleOrClosed();
    error CooldownNotElapsed(uint64 unlockTime, uint64 currentTime);
    error NativeTransferFailed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert OnlyOwner();
        _;
    }

    modifier onlyOwnerOrGuardian() {
        if (msg.sender != owner && msg.sender != guardian) revert OnlyOwnerOrGuardian();
        _;
    }

    modifier whenNotFrozen() {
        if (frozen) revert VaultIsFrozen();
        _;
    }

    constructor(
        address owner_,
        address guardian_,
        address escapePod_,
        uint64 cooldownSeconds_,
        uint256 nativeThreshold_
    ) {
        if (owner_ == address(0) || guardian_ == address(0) || escapePod_ == address(0)) {
            revert ZeroAddress();
        }
        if (owner_ == guardian_ || escapePod_ == owner_) {
            revert InvalidRoleSeparation();
        }
        if (cooldownSeconds_ < 10 || cooldownSeconds_ > 7 days) {
            revert InvalidCooldown();
        }

        owner = owner_;
        guardian = guardian_;
        escapePod = escapePod_;
        cooldownSeconds = cooldownSeconds_;
        nativeThreshold = nativeThreshold_;
        epoch = 1;
        nextTxId = 1;
    }

    receive() external payable {
        emit NativeDeposited(msg.sender, msg.value);
    }

    // =========================================================================
    // Asset Registry & Deposit Helpers
    // =========================================================================

    /// @notice Register an ERC-20 token so `triggerEscapePod` always sweeps it atomically.
    function registerToken(address token, uint256 threshold) external onlyOwnerOrGuardian {
        if (token == address(0)) revert ZeroAddress();
        if (!isTokenRegistered[token]) {
            isTokenRegistered[token] = true;
            _registeredTokens.push(token);
        }
        // Only owner sets threshold at registration, or if threshold == 0 stays strictest (always brake)
        if (msg.sender == owner && tokenThresholds[token] == 0 && threshold > 0) {
            tokenThresholds[token] = threshold;
        }
        emit TokenRegistered(token, tokenThresholds[token]);
    }

    /// @notice Deposit ERC-20 and automatically register it in the sweep manifest.
    function depositERC20(address token, uint256 amount) external nonReentrant {
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (!isTokenRegistered[token]) {
            isTokenRegistered[token] = true;
            _registeredTokens.push(token);
            emit TokenRegistered(token, tokenThresholds[token]);
        }
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Register an ERC-721 NFT held by this vault so `triggerEscapePod` always rescues it.
    function registerNFT(address nft, uint256 tokenId) external onlyOwnerOrGuardian {
        if (nft == address(0)) revert ZeroAddress();
        if (!isNftRegistered[nft][tokenId]) {
            isNftRegistered[nft][tokenId] = true;
            _registeredNfts.push(NftAsset({nft: nft, tokenId: tokenId}));
            emit NftRegistered(nft, tokenId);
        }
    }

    /// @notice Automatically registers incoming safe-transferred ERC-721 NFTs!
    function onERC721Received(
        address,
        address,
        uint256 tokenId,
        bytes calldata
    ) external override returns (bytes4) {
        if (!isNftRegistered[msg.sender][tokenId]) {
            isNftRegistered[msg.sender][tokenId] = true;
            _registeredNfts.push(NftAsset({nft: msg.sender, tokenId: tokenId}));
            emit NftRegistered(msg.sender, tokenId);
        }
        return IERC721Receiver.onERC721Received.selector;
    }

    // =========================================================================
    // Hardening Controls (Attacker can NEVER weaken security)
    // =========================================================================

    /// @notice Owner can tighten (increase) cooldown, never shorten it.
    function increaseCooldown(uint64 newCooldown) external onlyOwner {
        if (newCooldown <= cooldownSeconds || newCooldown > 7 days) revert InvalidCooldown();
        uint64 old = cooldownSeconds;
        cooldownSeconds = newCooldown;
        emit CooldownIncreased(old, newCooldown);
    }

    /// @notice Owner can tighten (lower) native threshold, never raise it.
    function lowerNativeThreshold(uint256 newThreshold) external onlyOwner {
        if (newThreshold >= nativeThreshold) revert CannotIncreaseThreshold();
        uint256 old = nativeThreshold;
        nativeThreshold = newThreshold;
        emit NativeThresholdLowered(old, newThreshold);
    }

    /// @notice Only guardian can approve whitelisted recipients so a compromised owner cannot whitelist a scammer.
    function setWhitelistedRecipient(address recipient, bool allowed) external {
        if (msg.sender != guardian) revert OnlyOwnerOrGuardian();
        if (recipient == address(0)) revert ZeroAddress();
        whitelistedRecipients[recipient] = allowed;
        emit RecipientWhitelistUpdated(recipient, allowed);
    }

    // =========================================================================
    // Anti-Scam Brake: Transfer Requests & Cooldown Execution
    // =========================================================================

    /// @notice Request a native MON transfer. Small transfers to guardian-whitelisted addresses pass immediately;
    ///         transfers to unknown addresses or above threshold engage the mandatory cooldown brake.
    function requestNativeTransfer(
        address to,
        uint256 amount,
        string calldata memo
    ) external onlyOwner whenNotFrozen nonReentrant returns (uint256 txId, bool queued) {
        if (to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (address(this).balance < amount) revert InsufficientBalance();

        if (whitelistedRecipients[to] && amount <= nativeThreshold) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
            emit ImmediateTransferExecuted(address(0), to, amount, memo);
            return (0, false);
        }

        txId = _queueTransfer(address(0), to, amount, memo);
        return (txId, true);
    }

    /// @notice Request an ERC-20 transfer. Unwhitelisted recipients or amounts above token threshold engage the brake.
    function requestERC20Transfer(
        address token,
        address to,
        uint256 amount,
        string calldata memo
    ) external onlyOwner whenNotFrozen nonReentrant returns (uint256 txId, bool queued) {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (amount == 0) revert InvalidAmount();
        if (IERC20(token).balanceOf(address(this)) < amount) revert InsufficientBalance();

        uint256 limit = tokenThresholds[token];
        if (whitelistedRecipients[to] && limit > 0 && amount <= limit) {
            IERC20(token).safeTransfer(to, amount);
            emit ImmediateTransferExecuted(token, to, amount, memo);
            return (0, false);
        }

        txId = _queueTransfer(token, to, amount, memo);
        return (txId, true);
    }

    function _queueTransfer(
        address token,
        address to,
        uint256 amount,
        string calldata memo
    ) internal returns (uint256 txId) {
        txId = nextTxId++;
        uint64 nowTs = uint64(block.timestamp);
        uint64 unlockTs = nowTs + cooldownSeconds;

        queuedTransfers[txId] = QueuedTransfer({
            id: txId,
            epoch: epoch,
            token: token,
            to: to,
            amount: amount,
            queuedAt: nowTs,
            unlockTime: unlockTs,
            executed: false,
            cancelled: false,
            memo: memo
        });

        emit TransferQueued(txId, epoch, to, token, amount, unlockTs, memo);
    }

    /// @notice Execute a queued transfer after its mandatory cooldown elapses (if vault was not frozen/escaped).
    function executeQueuedTransfer(uint256 txId) external onlyOwner whenNotFrozen nonReentrant {
        QueuedTransfer storage q = queuedTransfers[txId];
        if (q.id == 0) revert TransferNotFound();
        if (q.epoch != epoch || q.executed || q.cancelled) revert TransferStaleOrClosed();
        if (block.timestamp < q.unlockTime) {
            revert CooldownNotElapsed(q.unlockTime, uint64(block.timestamp));
        }

        q.executed = true;

        if (q.token == address(0)) {
            if (address(this).balance < q.amount) revert InsufficientBalance();
            (bool ok, ) = q.to.call{value: q.amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(q.token).safeTransfer(q.to, q.amount);
        }

        emit TransferExecuted(txId, q.to, q.token, q.amount);
    }

    /// @notice Optional single transfer cancellation by guardian or owner without freezing vault.
    function cancelQueuedTransfer(uint256 txId) external onlyOwnerOrGuardian {
        QueuedTransfer storage q = queuedTransfers[txId];
        if (q.id == 0) revert TransferNotFound();
        if (q.epoch != epoch || q.executed || q.cancelled) revert TransferStaleOrClosed();

        q.cancelled = true;
        emit TransferCancelled(txId, msg.sender);
    }

    // =========================================================================
    // KILLER FEATURE: Single-Tx Atomic Multi-Asset Escape Pod
    // =========================================================================

    /// @notice Freeze vault, invalidate ALL queued transfers in O(1), and atomically sweep
    ///         Native MON + all registered/extra ERC-20 tokens + all registered/extra ERC-721 NFTs
    ///         to the immutable `escapePod` cold wallet in one transaction.
    function triggerEscapePod(
        address[] calldata extraTokens,
        NftAsset[] calldata extraNfts
    )
        external
        onlyOwnerOrGuardian
        nonReentrant
        returns (uint256 nativeSwept, uint256 erc20SweptCount, uint256 nftSweptCount)
    {
        // 1. Lock down vault & invalidate every queued transfer in O(1)
        frozen = true;
        epoch += 1;
        unfreezeApprovedByOwner = false;
        unfreezeApprovedByGuardian = false;

        // 2. Sweep all Native MON
        nativeSwept = address(this).balance;
        if (nativeSwept > 0) {
            (bool ok, ) = escapePod.call{value: nativeSwept}("");
            if (!ok) revert NativeTransferFailed();
        }

        // 3. Sweep all registered ERC-20 tokens
        uint256 regTokenLen = _registeredTokens.length;
        for (uint256 i = 0; i < regTokenLen; i++) {
            if (_trySweepERC20(_registeredTokens[i])) {
                erc20SweptCount++;
            }
        }

        // 4. Sweep any guardian-supplied extra ERC-20 tokens (guarantees clean sweep even for untracked airdrops)
        for (uint256 i = 0; i < extraTokens.length; i++) {
            address t = extraTokens[i];
            if (t != address(0) && !isTokenRegistered[t]) {
                if (_trySweepERC20(t)) {
                    erc20SweptCount++;
                }
            }
        }

        // 5. Sweep all registered ERC-721 NFTs
        uint256 regNftLen = _registeredNfts.length;
        for (uint256 i = 0; i < regNftLen; i++) {
            NftAsset memory a = _registeredNfts[i];
            if (_trySweepNFT(a.nft, a.tokenId)) {
                nftSweptCount++;
            }
        }

        // 6. Sweep any extra ERC-721 NFTs
        for (uint256 i = 0; i < extraNfts.length; i++) {
            NftAsset memory a = extraNfts[i];
            if (a.nft != address(0) && !isNftRegistered[a.nft][a.tokenId]) {
                if (_trySweepNFT(a.nft, a.tokenId)) {
                    nftSweptCount++;
                }
            }
        }

        emit EscapePodTriggered(
            msg.sender,
            escapePod,
            nativeSwept,
            erc20SweptCount,
            nftSweptCount,
            epoch,
            block.number,
            block.timestamp
        );
    }

    function _trySweepERC20(address token) internal returns (bool swept) {
        try IERC20(token).balanceOf(address(this)) returns (uint256 bal) {
            if (bal > 0) {
                (bool ok, bytes memory ret) = token.call(
                    abi.encodeWithSelector(IERC20.transfer.selector, escapePod, bal)
                );
                if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) {
                    return true;
                }
            }
        } catch {}
        return false;
    }

    function _trySweepNFT(address nft, uint256 tokenId) internal returns (bool swept) {
        try IERC721(nft).ownerOf(tokenId) returns (address currentOwner) {
            if (currentOwner == address(this)) {
                try IERC721(nft).transferFrom(address(this), escapePod, tokenId) {
                    return true;
                } catch {}
            }
        } catch {}
        return false;
    }

    // =========================================================================
    // Dual-Confirmation Unfreeze (Neither party can unfreeze alone)
    // =========================================================================

    function approveUnfreeze() external onlyOwnerOrGuardian {
        if (!frozen) revert VaultNotFrozen();

        if (msg.sender == owner) {
            unfreezeApprovedByOwner = true;
        } else {
            unfreezeApprovedByGuardian = true;
        }

        emit UnfreezeApproved(msg.sender, unfreezeApprovedByOwner, unfreezeApprovedByGuardian);

        if (unfreezeApprovedByOwner && unfreezeApprovedByGuardian) {
            frozen = false;
            unfreezeApprovedByOwner = false;
            unfreezeApprovedByGuardian = false;
            emit VaultUnfrozen(block.timestamp);
        }
    }

    // =========================================================================
    // View Helpers (For Tight Monad GasLimit Calculation & Dashboard UI)
    // =========================================================================

    function getRegisteredTokens() external view returns (address[] memory) {
        return _registeredTokens;
    }

    function getRegisteredNfts() external view returns (NftAsset[] memory) {
        return _registeredNfts;
    }

    function getTrackedAssetCounts() external view returns (uint256 tokenCount, uint256 nftCount) {
        return (_registeredTokens.length, _registeredNfts.length);
    }

    /// @notice Recommended tight gasLimit for `triggerEscapePod` tailored for Monad's gas-limit charging model.
    function recommendedEscapeGasLimit(
        uint256 extraTokenCount,
        uint256 extraNftCount
    ) external view returns (uint256) {
        uint256 totalTokens = _registeredTokens.length + extraTokenCount;
        uint256 totalNfts = _registeredNfts.length + extraNftCount;
        return 110_000 + (totalTokens * 65_000) + (totalNfts * 85_000);
    }

    function getPendingTransfers(uint256 maxCount) external view returns (QueuedTransfer[] memory) {
        uint256 total = nextTxId - 1;
        if (total == 0 || maxCount == 0) {
            return new QueuedTransfer[](0);
        }
        uint256 start = total > maxCount ? total - maxCount + 1 : 1;
        uint256 len = total - start + 1;
        QueuedTransfer[] memory result = new QueuedTransfer[](len);
        for (uint256 i = 0; i < len; i++) {
            result[i] = queuedTransfers[start + i];
        }
        return result;
    }
}
