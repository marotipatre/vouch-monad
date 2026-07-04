// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Minimal EIP-1967 upgradeable proxy. Stores the implementation and admin in the
/// standardized storage slots and forwards calls via DELEGATECALL.
///
/// This is a real analysis target for two agents:
///   - Proxy Inspector: reads the EIP-1967 implementation + admin slots
///   - Bytecode Auditor: flags the DELEGATECALL (upgradeable → rug surface)
contract SampleProxy {
    // bytes32(uint256(keccak256("eip1967.proxy.implementation")) - 1)
    bytes32 private constant IMPL_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc;
    // bytes32(uint256(keccak256("eip1967.proxy.admin")) - 1)
    bytes32 private constant ADMIN_SLOT = 0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103;

    constructor(address implementation, address admin_) {
        assembly {
            sstore(IMPL_SLOT, implementation)
            sstore(ADMIN_SLOT, admin_)
        }
    }

    fallback() external payable {
        assembly {
            let impl := sload(IMPL_SLOT)
            calldatacopy(0, 0, calldatasize())
            let ok := delegatecall(gas(), impl, 0, calldatasize(), 0, 0)
            returndatacopy(0, 0, returndatasize())
            switch ok
            case 0 { revert(0, returndatasize()) }
            default { return(0, returndatasize()) }
        }
    }

    receive() external payable {}
}
