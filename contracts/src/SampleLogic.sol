// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Trivial logic contract used as the implementation behind SampleProxy.
/// Gives the Proxy Inspector agent a real implementation address to surface.
contract SampleLogic {
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }

    function version() external pure returns (string memory) {
        return "SampleLogic v1";
    }
}
