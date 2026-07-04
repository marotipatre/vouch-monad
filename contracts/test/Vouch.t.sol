// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDC} from "../src/MockUSDC.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";
import {Insurance} from "../src/Insurance.sol";
import {Resolver} from "../src/Resolver.sol";

/// End-to-end settlement tests: hire -> resolve (PASS releases the fee; FAIL refunds the
/// hirer, pays the insurance coverage, and slashes the agent bond). Mirrors the Sui
/// `settlement_tests.move`.
///
/// Requires forge-std: `forge install foundry-rs/forge-std`.
contract VouchTest is Test {
    MockUSDC usdc;
    AgentRegistry registry;
    Insurance insurance;
    Resolver resolver;

    address admin = address(this);
    address treasury = address(0xBEEF);
    address auditorOp = address(0xA0D1);
    address agentOwner = address(0xA6E7);
    address hirer = address(0xB1DDE7);

    uint256 constant ONE = 1_000_000; // 1 USDC
    string constant TASK = "erc20-safety";

    uint256 agentId;
    uint256 auditorId;

    function setUp() public {
        usdc = new MockUSDC();
        registry = new AgentRegistry(usdc);
        insurance = new Insurance(usdc, treasury);

        // fund + register the auditor (admin-gated), operated by auditorOp
        usdc.faucet(admin, 100 * ONE);
        usdc.approve(address(registry), type(uint256).max);
        auditorId = registry.registerAuditor("Auditor", auditorOp, 10 * ONE);

        // wire the resolver
        resolver = new Resolver(registry, insurance, auditorId);
        registry.setResolver(address(resolver));
        insurance.setResolver(address(resolver));

        // seed the reserve
        insurance.deposit(50 * ONE);

        // register a worker agent (owned by agentOwner) with a 5 USDC bond
        usdc.faucet(agentOwner, 5 * ONE);
        vm.startPrank(agentOwner);
        usdc.approve(address(registry), type(uint256).max);
        agentId = registry.registerAgent("MyAgent", TASK, 5 * ONE);
        vm.stopPrank();

        // give the hirer some USDC
        usdc.faucet(hirer, 100 * ONE);
        vm.prank(hirer);
        usdc.approve(address(insurance), type(uint256).max);
    }

    function _hire(uint256 fee, uint256 premium, uint256 coverage) internal returns (uint256 policyId) {
        uint256 protocolFee = fee / 10;
        uint256 agentFee = fee - protocolFee;
        vm.prank(hirer);
        policyId = insurance.hire(agentId, TASK, protocolFee, premium, coverage, agentFee);
    }

    function testHirePassReleasesFee() public {
        uint256 fee = 10 * ONE;
        uint256 policyId = _hire(fee, 1 * ONE, 5 * ONE);

        uint256 ownerBefore = usdc.balanceOf(agentOwner);
        vm.prank(auditorOp);
        resolver.resolve(policyId, agentId, true, "ipfs://evidence", 9500);

        // agent owner receives the escrowed fee (fee - protocolFee)
        assertEq(usdc.balanceOf(agentOwner), ownerBefore + (fee - fee / 10));
        // bond untouched
        assertEq(registry.bondOf(agentId), 5 * ONE);
    }

    function testHireFailRefundsAndSlashes() public {
        uint256 fee = 10 * ONE;
        uint256 premium = 1 * ONE;
        uint256 coverage = 5 * ONE;
        uint256 hirerBefore = usdc.balanceOf(hirer);
        uint256 policyId = _hire(fee, premium, coverage);

        vm.prank(auditorOp);
        resolver.resolve(policyId, agentId, false, "ipfs://evidence", 4000);

        // hirer pays (protocolFee + premium), gets the escrowed fee refunded and the
        // insurance coverage paid out — net change = coverage - protocolFee - premium.
        uint256 protocolFee = fee / 10;
        assertEq(usdc.balanceOf(hirer), hirerBefore - protocolFee - premium + coverage);
        // bond slashed by coverage
        assertEq(registry.bondOf(agentId), 5 * ONE - coverage);
    }

    function testOnlyAuditorResolves() public {
        uint256 policyId = _hire(10 * ONE, 1 * ONE, 5 * ONE);
        vm.expectRevert(Resolver.NotAuditor.selector);
        resolver.resolve(policyId, agentId, true, "ipfs://x", 9000);
    }
}
