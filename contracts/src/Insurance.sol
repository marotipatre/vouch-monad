// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "./IERC20.sol";

/// Parametric completion-guarantee policies + the shared reserve pool that pays them,
/// plus fee escrow. Port of `vouch::insurance` for Monad/EVM.
///
/// Money model (unchanged from the Sui version): the premium is PRICED off-chain
/// (premium = f(1 - reliability) * coverage) and passed into `hire`; a reserve pool
/// FUNDS payouts. Premiums flow into the reserve; slashed bonds top it up; on PASS the
/// premium is retained.
///
/// Escrow: the Sui version transferred the agent fee to a backend "escrow" address at
/// hire time. On EVM we instead hold that fee inside THIS contract, keyed by policyId,
/// until the verdict — so a single audited contract custodies the in-flight fee.
///
/// Settlement functions are gated to the authorized `resolver`.
contract Insurance {
    IERC20 public immutable usdc;
    address public admin;
    address public resolver;
    address public treasury; // protocol fee sink

    uint256 public reserve; // pooled funds backing all payouts

    enum Status {
        Active,
        PaidOut,
        Expired
    }

    struct Policy {
        address holder;
        uint256 agentId;
        string taskClass;
        uint256 coverage;
        uint256 premiumPaid;
        uint256 escrow; // agent fee held until resolve
        Status status;
        bool exists;
    }

    uint256 public policyCount;
    mapping(uint256 => Policy) private policies;

    event ReserveDeposit(address indexed from, uint256 amount, uint256 reserve);
    event Hired(
        uint256 indexed policyId,
        address indexed holder,
        uint256 indexed agentId,
        uint256 protocolFee,
        uint256 premium,
        uint256 coverage,
        uint256 escrow
    );
    event PolicyPaidOut(uint256 indexed policyId, address indexed holder, uint256 amount);
    event PolicyExpired(uint256 indexed policyId);
    event EscrowReleased(uint256 indexed policyId, address indexed to, uint256 amount);
    event EscrowRefunded(uint256 indexed policyId, address indexed to, uint256 amount);
    event ResolverSet(address resolver);

    error NotAdmin();
    error NotResolver();
    error NotActive();
    error ReserveInsufficient();
    error NoPolicy();

    constructor(IERC20 _usdc, address _treasury) {
        usdc = _usdc;
        admin = msg.sender;
        treasury = _treasury;
    }

    modifier onlyAdmin() {
        if (msg.sender != admin) revert NotAdmin();
        _;
    }

    modifier onlyResolver() {
        if (msg.sender != resolver) revert NotResolver();
        _;
    }

    function setResolver(address _resolver) external onlyAdmin {
        resolver = _resolver;
        emit ResolverSet(_resolver);
    }

    function setTreasury(address _treasury) external onlyAdmin {
        treasury = _treasury;
    }

    /// Seed / donate funds into the reserve for initial solvency (used by the seed script).
    function deposit(uint256 amount) external {
        require(usdc.transferFrom(msg.sender, address(this), amount), "deposit failed");
        reserve += amount;
        emit ReserveDeposit(msg.sender, amount, reserve);
    }

    /// Single-call hire (the USER signs this): pull `protocolFee + premium + agentFee`
    /// USDC in one `transferFrom`, then split — protocol fee → treasury, premium →
    /// reserve, agent fee → escrow (held until the verdict). Creates an Active Policy
    /// with `holder = caller`, so refunds return to them.
    ///
    /// If `coverage == 0` the hire is uninsured: no premium, nothing paid out on FAIL
    /// beyond the fee refund.
    function hire(
        uint256 agentId,
        string calldata taskClass,
        uint256 protocolFee,
        uint256 premium,
        uint256 coverage,
        uint256 agentFee
    ) external returns (uint256 policyId) {
        uint256 total = protocolFee + premium + agentFee;
        require(usdc.transferFrom(msg.sender, address(this), total), "payment failed");

        if (protocolFee > 0) {
            require(usdc.transfer(treasury, protocolFee), "fee transfer failed");
        }
        reserve += premium;

        policyId = ++policyCount;
        policies[policyId] = Policy({
            holder: msg.sender,
            agentId: agentId,
            taskClass: taskClass,
            coverage: coverage,
            premiumPaid: premium,
            escrow: agentFee,
            status: Status.Active,
            exists: true
        });
        emit Hired(policyId, msg.sender, agentId, protocolFee, premium, coverage, agentFee);
    }

    // ---- resolver-gated settlement (called by Resolver) ----

    /// PASS branch: release the escrowed fee to the agent owner and expire the policy
    /// (premium stays in the reserve).
    function settlePass(uint256 policyId, address agentOwner) external onlyResolver {
        Policy storage p = policies[policyId];
        if (!p.exists) revert NoPolicy();
        if (p.status != Status.Active) revert NotActive();
        p.status = Status.Expired;
        uint256 esc = p.escrow;
        p.escrow = 0;
        if (esc > 0) {
            require(usdc.transfer(agentOwner, esc), "escrow release failed");
            emit EscrowReleased(policyId, agentOwner, esc);
        }
        emit PolicyExpired(policyId);
    }

    /// FAIL branch: refund the escrowed fee to the holder, and if the policy is insured,
    /// pay `coverage` from the reserve to the holder. Returns coverage paid so the
    /// Resolver can slash the agent bond to refill the reserve.
    function settleFail(uint256 policyId) external onlyResolver returns (uint256 payout, address holder) {
        Policy storage p = policies[policyId];
        if (!p.exists) revert NoPolicy();
        if (p.status != Status.Active) revert NotActive();
        holder = p.holder;

        // refund the escrowed fee
        uint256 esc = p.escrow;
        p.escrow = 0;
        if (esc > 0) {
            require(usdc.transfer(holder, esc), "escrow refund failed");
            emit EscrowRefunded(policyId, holder, esc);
        }

        // insurance payout from the reserve
        payout = p.coverage;
        if (payout > 0) {
            if (reserve < payout) revert ReserveInsufficient();
            reserve -= payout;
            p.status = Status.PaidOut;
            require(usdc.transfer(holder, payout), "payout failed");
            emit PolicyPaidOut(policyId, holder, payout);
        } else {
            p.status = Status.Expired;
            emit PolicyExpired(policyId);
        }
    }

    /// Top the reserve up with slashed-bond funds already transferred into this contract.
    function fundReserve(uint256 amount) external onlyResolver {
        reserve += amount;
        emit ReserveDeposit(msg.sender, amount, reserve);
    }

    // ---- read accessors ----

    function getPolicy(uint256 policyId) external view returns (Policy memory) {
        return policies[policyId];
    }

    function reserveBalance() external view returns (uint256) {
        return reserve;
    }
}
