// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A honeypot ERC-20: you can BUY (the owner distributes to you), but a normal holder
/// CANNOT SELL — any transfer that doesn't involve the owner reverts. Looks like a normal
/// token by its interface; the trap only shows up when you simulate a sell.
///
/// The Honeypot Simulator detects this by `eth_call`-simulating a transfer from a funded
/// non-owner holder: it reverts → honeypot. A chatbot cannot do this; it requires EVM
/// simulation, and the auditor re-simulates to confirm.
contract HoneypotToken {
    string public name = "Moon Inu";
    string public symbol = "MOONI";
    uint8 public decimals = 18;
    uint256 public totalSupply;
    address public owner;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor() {
        owner = msg.sender;
        _mint(msg.sender, 1_000_000 ether);
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _transfer(msg.sender, to, amount);
        return true;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _transfer(from, to, amount);
        return true;
    }

    function _mint(address to, uint256 amount) internal {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function _transfer(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "insufficient");
        // THE TRAP: only transfers involving the owner are allowed. A normal holder can
        // receive (buy) but can never send to anyone but the owner (can't sell).
        require(from == owner || to == owner, "HONEYPOT: sells disabled");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}
