// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MySBT {
    address public owner;
    mapping(uint256 => address) private _ownerOf;

    constructor() {
        owner = msg.sender;
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        owner = newOwner;
    }

    function mint(address to, uint256 tokenId) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(_ownerOf[tokenId] == address(0), "Already minted");
        _ownerOf[tokenId] = to;
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "Not minted");
        return tokenOwner;
    }

    function transferFrom(address, address, uint256) external pure {
        revert("Soulbound");
    }

    function safeTransferFrom(address, address, uint256) external pure {
        revert("Soulbound");
    }

    function safeTransferFrom(address, address, uint256, bytes calldata) external pure {
        revert("Soulbound");
    }
}
