// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {AgentRegistry} from "./AgentRegistry.sol";
import {Insurance} from "./Insurance.sol";

/// Settlement entrypoint. Reads the auditor verdict + evidence URI and settles per-job
/// state atomically: policy payout / escrow release, bond slash, and the agent's
/// reliability update. Port of `vouch::resolver`.
///
/// Trust model (MVP, same as the Sui version): `resolve` asserts the caller is the
/// registered auditor operator (single-keypair oracle). The auditor agent must be
/// registered with `isAuditor = true`. Production would use multi-auditor staking.
contract Resolver {
    AgentRegistry public immutable registry;
    Insurance public immutable insurance;
    uint256 public immutable auditorAgentId;

    event Resolved(
        uint256 indexed agentId,
        uint256 indexed policyId,
        bool verdictPass,
        string evidenceUri,
        uint256 payout,
        uint256 slashed,
        uint256 newReliabilityBps
    );

    error NotAuditor();
    error TaskClassMismatch();

    constructor(AgentRegistry _registry, Insurance _insurance, uint256 _auditorAgentId) {
        registry = _registry;
        insurance = _insurance;
        auditorAgentId = _auditorAgentId;
    }

    /// Settle a job. `verdictPass` == the worker correctly completed the task.
    /// `newReliabilityBps` is the agent's updated performance reliability (recomputed by
    /// the agent service). Repeatable across many jobs.
    function resolve(
        uint256 policyId,
        uint256 agentId,
        bool verdictPass,
        string calldata evidenceUri,
        uint256 newReliabilityBps
    ) external {
        // caller must be the registered auditor operator
        if (!registry.isAuditor(auditorAgentId)) revert NotAuditor();
        if (msg.sender != registry.ownerOf(auditorAgentId)) revert NotAuditor();

        // worker agent and policy must refer to the same task-class
        if (
            keccak256(bytes(insurance.getPolicy(policyId).taskClass))
                != keccak256(bytes(registry.taskClassOf(agentId)))
        ) revert TaskClassMismatch();

        uint256 payout = 0;
        uint256 slashed = 0;

        if (verdictPass) {
            insurance.settlePass(policyId, registry.ownerOf(agentId));
        } else {
            uint256 coverage = insurance.getPolicy(policyId).coverage;
            (payout,) = insurance.settleFail(policyId);
            // slash the agent's bond (up to the coverage) into the reserve
            if (coverage > 0) {
                slashed = registry.slashBond(agentId, coverage, address(insurance));
                if (slashed > 0) insurance.fundReserve(slashed);
            }
        }

        registry.recordJob(agentId, !verdictPass, newReliabilityBps);

        emit Resolved(agentId, policyId, verdictPass, evidenceUri, payout, slashed, newReliabilityBps);
    }
}
