// Minimal ABIs the web needs to sign a hire from the user's wallet.
import { parseAbi } from "viem";

export const usdcAbi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
]);

export const insuranceAbi = parseAbi([
  "function hire(uint256 agentId,string taskClass,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 agentFee) returns (uint256)",
  "event Hired(uint256 indexed policyId,address indexed holder,uint256 indexed agentId,uint256 protocolFee,uint256 premium,uint256 coverage,uint256 escrow)",
]);
