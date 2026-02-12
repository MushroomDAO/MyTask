# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**MyTask** is an AI-powered, decentralized task management application built on the x402 protocol. It implements a four-player economic model:
- **Task Publisher (Community)**: Creates and funds tasks
- **Taskor**: Executes the task
- **Target Item Supplier**: Provides resources needed by the Taskor
- **Jury**: Audits and validates task completion

The project is permissionless, open-source (MIT), and designed to work with any ERC-20 token implementing the OpenPNTs protocol.

**Reference**: Built as an evolution of the [payload-exchange](https://github.com/microchipgnu/payload-exchange) project, inspired by [PayloadExchange at ETHGlobal](https://ethglobal.com/showcase/payloadexchange-x07pi).

## Architecture Overview

### Technology Stack
- **Package Manager**: pnpm (use `pnpm` instead of npm)
- **Smart Contracts**: EVM-compatible blockchain for x402 protocol integration
- **Token Integration**: OpenPNTs protocol (ERC-20 compatible)

### High-Level Architecture Pattern
This is a multi-chain, permissionless marketplace where:
1. **Smart Contracts Layer**: Manages x402 protocol compliance, escrow, and token handling
2. **Application Layer**: AI-driven task management and matching
3. **Audit Layer**: Jury verification and dispute resolution

### Key Design Principles
- **Permissionless**: No centralized gatekeeping; anyone can participate
- **Protocol-first**: Designed around x402 standards from the start
- **AI Integration**: Intelligently match Taskors with opportunities and automate validation
- **Economic Alignment**: Token-based incentive structure for all four player types

## Development Setup

```bash
# Install dependencies
pnpm install

# Development environment
pnpm dev

# Testing
pnpm test
pnpm test:watch

# Linting and formatting
pnpm lint
pnpm format

# Build
pnpm build
```

## Code Organization

When the project grows, follow this structure:
- `/src/contracts/` - Smart contracts
- `/src/app/` - Application logic and AI components
- `/src/protocol/` - x402 protocol implementations
- `/src/types/` - TypeScript type definitions
- `/tests/` - Test files
- `/docs/` - Documentation

## Key Implementation Areas

### Smart Contracts
- x402 protocol compliance
- Token escrow and distribution
- Role management (Community, Taskor, Supplier, Jury)
- Dispute resolution mechanics

### Application Logic
- AI-driven task matching algorithm
- Jury selection and validation system
- Task status tracking and completion verification
- Multi-token support via OpenPNTs standard

## Important Notes

- Use TypeScript for type safety
- Follow SOLID principles to keep code maintainable as the system grows
- All economic mechanisms (task pricing, jury rewards, supplier margins) should be parameterized
- Consider gas optimization for contract interactions
- Implement comprehensive logging for multi-party transactions
