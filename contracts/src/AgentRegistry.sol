// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// On-chain identity + staked bond for every agent (workers and the auditor).
///
/// Port of `vouch::agent_registry` from the Sui version. Differences for Monad/EVM:
///   - `Agent` is a struct in a mapping instead of a shared Move object.
///   - Bonds are held as USDC (an ERC20) inside THIS contract, tracked per agent.
///   - Move's `public(package)` mutations (slash / recordJob) become calls gated to the
///     authorized `resolver` contract (set once by the admin), which is what keeps
///     settlement trustworthy.
///
/// Trust anchor: anyone may `registerAgent` (a worker, with a bond). Only the `admin`
/// may `registerAuditor` — that is what makes `isAuditor` meaningful, since the Resolver
/// gates settlement on the auditor.
contract AgentRegistry {
    /// Minimum bond: 1 USDC (6 decimals).
    uint256 public constant MIN_BOND = 1_000_000;

    struct Agent {
        address owner;
        string name;
        string taskClass; // e.g. "erc20-safety"; the auditor uses "*"
        bool isAuditor;
        uint256 bond;
        uint256 reliabilityBps; // performance-based (no market in the Monad port)
        uint256 jobsTotal;
        uint256 jobsFailed;
        bool exists;
    }

    IERC20 public immutable usdc;
    address public admin;
    address public resolver; // authorized to slash bonds + record jobs

    uint256 public agentCount;
    mapping(uint256 => Agent) private agents;

    event AgentRegistered(
        uint256 indexed agentId,
        address indexed owner,
        string taskClass,
        bool isAuditor,
        uint256 bond,
        uint256 reliabilityBps
    );
    event BondSlashed(uint256 indexed agentId, uint256 amount, uint256 remaining);
    event JobRecorded(uint256 indexed agentId, bool failed, uint256 newReliabilityBps);
    event ResolverSet(address resolver);

    error BondTooLow();
    error NotOwner();
    error NotAdmin();
    error NotResolver();
    error NoAgent();

    constructor(IERC20 _usdc) {
        usdc = _usdc;
        admin = msg.sender;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    /// One-time wiring: the admin points the registry at the Resolver contract.
    function setResolver(address _resolver) external onlyAdmin {
        resolver = _resolver;
        emit ResolverSet(_resolver);
    }

    /// Register a worker agent, staking `bond` USDC (must be pre-approved). Owner = caller.
    function registerAgent(string calldata name, string calldata taskClass, uint256 bond)
        external
        returns (uint256 agentId)
    {
        return _newAgent(msg.sender, name, taskClass, false, bond, 9000);
    }

    /// Register the auditor (the on-chain resolution oracle). Admin-gated; the auditor
    /// agent is owned by `operator` — the dedicated keypair that will sign `resolve`.
    function registerAuditor(string calldata name, address operator, uint256 bond)
        external
        onlyAdmin
        returns (uint256 agentId)
    {
        return _newAgent(operator, name, "*", true, bond, 10_000);
    }

    /// Owner adds more bond.
    function topUpBond(uint256 agentId, uint256 more) external {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        if (msg.sender != a.owner) revert NotOwner();
        require(usdc.transferFrom(msg.sender, address(this), more), "bond transfer failed");
        a.bond += more;
    }

    function _newAgent(
        address owner,
        string calldata name,
        string memory taskClass,
        bool auditorFlag,
        uint256 bond,
        uint256 reliabilityBps
    ) internal returns (uint256 agentId) {
        if (bond < MIN_BOND) revert BondTooLow();
        require(usdc.transferFrom(msg.sender, address(this), bond), "bond transfer failed");
        agentId = ++agentCount;
        agents[agentId] = Agent({
            owner: owner,
            name: name,
            taskClass: taskClass,
            isAuditor: auditorFlag,
            bond: bond,
            reliabilityBps: reliabilityBps,
            jobsTotal: 0,
            jobsFailed: 0,
            exists: true
        });
        emit AgentRegistered(agentId, owner, taskClass, auditorFlag, bond, reliabilityBps);
    }

    // ---- resolver-gated mutations (called by Resolver during settlement) ----

    /// Slash up to `amount` from the bond and send it to `to` (the reserve).
    function slashBond(uint256 agentId, uint256 amount, address to)
        external
        onlyResolver
        returns (uint256 taken)
    {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        taken = amount > a.bond ? a.bond : amount;
        a.bond -= taken;
        if (taken > 0) require(usdc.transfer(to, taken), "slash transfer failed");
        emit BondSlashed(agentId, taken, a.bond);
    }

    /// Record a completed job and refresh cached reliability.
    function recordJob(uint256 agentId, bool failed, uint256 newReliabilityBps) external onlyResolver {
        Agent storage a = agents[agentId];
        if (!a.exists) revert NoAgent();
        a.jobsTotal += 1;
        if (failed) a.jobsFailed += 1;
        a.reliabilityBps = newReliabilityBps;
        emit JobRecorded(agentId, failed, newReliabilityBps);
    }

    // ---- read accessors ----

    function getAgent(uint256 agentId) external view returns (Agent memory) {
        return agents[agentId];
    }

    function isAuditor(uint256 agentId) external view returns (bool) {
        return agents[agentId].isAuditor;
    }

    function ownerOf(uint256 agentId) external view returns (address) {
        return agents[agentId].owner;
    }

    function taskClassOf(uint256 agentId) external view returns (string memory) {
        return agents[agentId].taskClass;
    }

    function bondOf(uint256 agentId) external view returns (uint256) {
        return agents[agentId].bond;
    }
}
