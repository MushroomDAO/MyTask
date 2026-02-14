// SPDX-License-Identifier: MIT
pragma solidity ^0.8.23;

contract MySBT {
    address public owner;
    mapping(uint256 => address) private _ownerOf;
    mapping(uint256 => uint8) private _rolesOf;
    mapping(uint256 => bool) private _revoked;

    uint8 public constant ROLE_TASKOR = 1;
    uint8 public constant ROLE_SUPPLIER = 2;
    uint8 public constant ROLE_JUROR = 4;
    uint8 public constant ROLE_VALIDATION_REQUESTER = 8;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event Minted(uint256 indexed tokenId, address indexed to, uint8 roles);
    event RolesUpdated(uint256 indexed tokenId, uint8 roles);
    event Revoked(uint256 indexed tokenId, bool revoked);
    event Reassigned(uint256 indexed tokenId, address indexed from, address indexed to);
    event Burned(uint256 indexed tokenId, address indexed from);

    constructor() {
        owner = msg.sender;
        emit OwnershipTransferred(address(0), msg.sender);
    }

    modifier onlyOwner() {
        require(msg.sender == owner, "Not owner");
        _;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "Invalid owner");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function mint(address to, uint256 tokenId) external onlyOwner {
        mintWithRoles(to, tokenId, 0);
    }

    function mintWithRoles(address to, uint256 tokenId, uint8 roles) public onlyOwner {
        require(to != address(0), "Invalid recipient");
        require(_ownerOf[tokenId] == address(0), "Already minted");
        _ownerOf[tokenId] = to;
        _rolesOf[tokenId] = roles;
        _revoked[tokenId] = false;
        emit Minted(tokenId, to, roles);
    }

    function ownerOf(uint256 tokenId) external view returns (address) {
        address tokenOwner = _ownerOf[tokenId];
        require(tokenOwner != address(0), "Not minted");
        return tokenOwner;
    }

    function isRevoked(uint256 tokenId) external view returns (bool) {
        require(_ownerOf[tokenId] != address(0), "Not minted");
        return _revoked[tokenId];
    }

    function rolesOf(uint256 tokenId) external view returns (uint8) {
        require(_ownerOf[tokenId] != address(0), "Not minted");
        return _rolesOf[tokenId];
    }

    function hasRole(uint256 tokenId, uint8 role) external view returns (bool) {
        require(_ownerOf[tokenId] != address(0), "Not minted");
        return (_rolesOf[tokenId] & role) != 0;
    }

    function setRoles(uint256 tokenId, uint8 roles) external onlyOwner {
        require(_ownerOf[tokenId] != address(0), "Not minted");
        _rolesOf[tokenId] = roles;
        emit RolesUpdated(tokenId, roles);
    }

    function setRevoked(uint256 tokenId, bool revoked) external onlyOwner {
        require(_ownerOf[tokenId] != address(0), "Not minted");
        _revoked[tokenId] = revoked;
        emit Revoked(tokenId, revoked);
    }

    function reassign(uint256 tokenId, address to) external onlyOwner {
        require(to != address(0), "Invalid recipient");
        address from = _ownerOf[tokenId];
        require(from != address(0), "Not minted");
        require(!_revoked[tokenId], "Revoked");
        _ownerOf[tokenId] = to;
        emit Reassigned(tokenId, from, to);
    }

    function burn(uint256 tokenId) external onlyOwner {
        address from = _ownerOf[tokenId];
        require(from != address(0), "Not minted");
        delete _ownerOf[tokenId];
        delete _rolesOf[tokenId];
        delete _revoked[tokenId];
        emit Burned(tokenId, from);
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
