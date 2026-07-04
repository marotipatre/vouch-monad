# Technical Architecture

## 1. Overview

Vouch Monad is a trust-layer protocol for hiring autonomous AI agents, insuring task outcomes, and settling results on-chain. The system combines:

- Solidity smart contracts for escrow, settlement, bonds, and auditable outcomes
- A TypeScript agent backend for task execution and evidence generation
- A React frontend for wallet-connected hiring and policy management
- Deployment and operational scripts for contracts, funding, and seeding

The core idea is simple: a user hires an agent, the agent performs work, an auditor verifies the result, and the settlement contract atomically releases payments or refunds based on the verdict.

---

## 2. System Goals

The architecture is designed around five principles:

1. Trust minimization through on-chain settlement
2. Evidence-based verification with content-addressed artifacts
3. Modular task execution for different agent types
4. Wallet-native UX for signing hires and interacting with contracts
5. Extensibility for future multi-auditor and dispute systems

---

## 3. High-Level Architecture

```text
User / Wallet
   │
   ▼
React Web App (Vite + wagmi + RainbowKit)
   │
   │  sign hire / read contract state
   ▼
Smart Contracts (Monad testnet)
   - MockUSDC
   - AgentRegistry
   - Insurance
   - Resolver
   │
   │  emits state / settlement events
   ▼
Agent Backend (Express + TypeScript)
   - task routing
   - LLM execution
   - evidence collection
   - auditor settlement coordination
```

---

## 4. Repository Structure

```text
contracts/          Solidity contracts and Foundry tests
agents/             TypeScript backend service
web/                React frontend application
scripts/            Deployment, setup, funding, and demo utilities
deployments/        Contract deployment metadata and runtime artifacts
```

### Contracts Layer
- Solidity 0.8.x contracts compiled and deployed for Monad testnet
- Main contracts:
  - MockUSDC: demo ERC-20 stablecoin with faucet-style minting
  - AgentRegistry: agent registration and staking/bonding logic
  - Insurance: hire flow, escrow, reserve, and settlement entry points
  - Resolver: auditor-gated resolution logic and slashing behavior

### Backend Layer
- Express-based service for orchestration and task execution
- Responsibilities:
  - receiving hire requests
  - selecting the appropriate task handler
  - invoking the model or deterministic agent logic
  - generating evidence bundles
  - coordinating with the settlement flow

### Frontend Layer
- React application with wallet connectivity and contract interaction
- Users can:
  - connect a wallet
  - fund their wallet with mock USDC
  - browse available agents
  - hire an agent
  - inspect policy and resolution state

### Operations Layer
- Scripts handle setup, deployment, key management, funding, and demos
- This layer reduces manual deployment friction and supports testnet onboarding

---

## 5. Core Runtime Flow

### A. Registration
1. An agent registers with the protocol.
2. The agent stakes a bond through the registry contract.
3. The registry records the agent identity, bond amount, and reliability data.

### B. Hiring
1. A user connects a wallet and signs a hire transaction.
2. The Insurance contract receives the payment and splits it into:
   - protocol fee
   - premium reserve contribution (if insured)
   - agent escrow amount
3. A policy record is created for the task lifecycle.

### C. Execution
1. The backend receives the hire context.
2. The task router selects a worker implementation.
3. The worker executes the task using either:
   - a deterministic rule engine
   - an LLM-based workflow
4. The system gathers input, output, and supporting evidence.

### D. Audit and Settlement
1. An auditor re-derives or judges the result.
2. Evidence is stored in a content-addressed structure.
3. The resolver contract settles the outcome:
   - success releases escrow to the agent
   - failure refunds the user and may slash the bond

---

## 6. Component Responsibilities

### Smart Contracts

| Component | Responsibility |
|---|---|
| MockUSDC | Test stablecoin with faucet-like minting for demos |
| AgentRegistry | Agent registration, bonding, and reliability tracking |
| Insurance | Policy lifecycle, escrow, reserve handling, and hire settlement entry points |
| Resolver | Audited resolution, payout routing, and bond slashing |

### Backend Modules

| Module | Responsibility |
|---|---|
| server.ts | Main API entry point and request orchestration |
| tasks.ts | Task definitions and orchestration logic |
| llm.ts | Model integration and prompt execution |
| evidence.ts | Evidence packaging and hashing logic |
| chain.ts | Chain interaction and contract client setup |
| onchain.ts | Contract call wrappers and transaction helpers |
| abi.ts | Contract ABI definitions |
| types.ts | Shared TypeScript types and interfaces |

### Frontend Modules

| Module | Responsibility |
|---|---|
| App.tsx | Main UI shell and route composition |
| Landing.tsx | Primary user experience and agent hiring flow |
| api.ts | Backend API integration |
| contracts.ts | Contract interaction helpers |
| providers.tsx | Wallet and provider context setup |

---

## 7. Data Model

The system primarily uses two kinds of state:

1. On-chain state
   - agent registration data
   - policy and escrow balances
   - reserve balances
   - settlement outcomes and slashing events

2. Off-chain evidence state
   - task input hash
   - task output
   - verifier verdict
   - supporting metadata for auditability

This separation keeps the protocol trust-minimized while still allowing rich evidence and flexible task execution.

---

## 8. Security and Trust Model

The current MVP trust model is intentionally simple:

- a single auditor keypair acts as the settlement oracle
- contracts enforce payout and slash rules deterministically
- evidence is content-addressed to make results inspectable

This is appropriate for an MVP and a testnet deployment, but the design can evolve toward:

- multiple staked auditors
- disputes and appeals
- committee-based resolution
- stronger cryptographic proof of execution

---

## 9. Deployment Model

### Local Development
- frontend runs via Vite
- backend runs via tsx/Express
- contracts can be mocked or deployed locally depending on configuration

### Testnet Deployment
- contracts are deployed to Monad testnet
- deployment metadata is written to deployments/monadTestnet.json
- backend and frontend connect to the deployed contract addresses

### Production Deployment
- frontend can be deployed to Vercel
- backend can be deployed to Render
- deployment configuration is described through project-level config files

---

## 10. Extension Points

The current architecture is designed to support future growth in several ways:

- new task classes can be added in the backend task router
- new verifier strategies can be plugged into the audit phase
- additional contract modules can be added for disputes or staking upgrades
- additional chains or rollups can be supported by changing the chain config layer

---

## 11. Summary

This project uses a layered architecture:

- smart contracts provide the economic and settlement backbone
- a backend provides execution and evidence generation
- a web client makes the protocol usable for end users
- scripts and deployment configs reduce operational friction

That structure keeps the protocol modular, auditable, and suitable for iterative expansion from MVP to a more decentralized trust model.
