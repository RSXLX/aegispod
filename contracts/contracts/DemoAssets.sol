// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";

/// @title MockERC20
/// @notice Open faucet ERC-20 token for AegisPod Monad Testnet multi-asset evacuation demos.
contract MockERC20 is ERC20 {
    uint8 private immutable _tokenDecimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _tokenDecimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _tokenDecimals;
    }

    /// @notice Testnet faucet helper to seed any vault or wallet for demo purposes.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @title MockNFT
/// @notice Open mint ERC-721 collectible to demonstrate atomic NFT rescue inside AegisPod.
contract MockNFT is ERC721 {
    uint256 public nextTokenId = 1;

    constructor(string memory name_, string memory symbol_) ERC721(name_, symbol_) {}

    function mint(address to) external returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
    }
}
