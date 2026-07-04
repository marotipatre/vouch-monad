// Minimal human-readable ABIs (viem parses these) for the Vouch contracts on Monad.
export const usdcAbi = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function faucet(address,uint256)",
  "function decimals() view returns (uint8)",
] as const;

export const registryAbi = [
  "function agentCount() view returns (uint256)",
  "function registerAgent(string name,string taskClass,uint256 bond) returns (uint256)",
  "function registerAuditor(string name,address operator,uint256 bond) returns (uint256)",
  "function topUpBond(uint256 agentId,uint256 more)",
  "function setResolver(address)",
  "function getAgent(uint256) view returns ((address owner,string name,string taskClass,bool isAuditor,uint256 bond,uint256 reliabilityBps,uint256 jobsTotal,uint256 jobsFailed,bool exists))",
  "function isAuditor(uint256) view returns (bool)",
  "function ownerOf(uint256) view returns (address)",
  "function bondOf(uint256) view returns (uint256)",
  "event AgentRegistered(uint256 indexed agentId,address indexed owner,string taskClass,bool isAuditor,uint256 bond,uint256 reliabilityBps)",
] as const;

export const insuranceAbi = [
  "function reserve() view returns (uint256)",
  "function deposit(uint256 amount)",
  "function setResolver(address)",
  "function hire(uint256 agentId,string taskClass,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 agentFee) returns (uint256)",
  "function getPolicy(uint256) view returns ((address holder,uint256 agentId,string taskClass,uint256 coverage,uint256 premiumPaid,uint256 escrow,uint8 status,bool exists))",
  "event Hired(uint256 indexed policyId,address indexed holder,uint256 indexed agentId,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 escrow)",
] as const;

export const resolverAbi = [
  "function resolve(uint256 policyId,uint256 agentId,bool verdictPass,string evidenceUri,uint256 newReliabilityBps)",
  "event Resolved(uint256 indexed agentId,uint256 indexed policyId,bool verdictPass,string evidenceUri,uint256 payout,uint256 slashed,uint256 newReliabilityBps)",
] as const;
