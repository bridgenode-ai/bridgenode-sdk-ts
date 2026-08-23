# @bridgenode/llm

[![npm version](https://img.shields.io/npm/v/@bridgenode/llm.svg)](https://www.npmjs.com/package/@bridgenode/llm)
[![npm downloads](https://img.shields.io/npm/dm/@bridgenode/llm.svg)](https://www.npmjs.com/package/@bridgenode/llm)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](https://opensource.org/license/mit-0/)
[![CI](https://img.shields.io/github/actions/workflow/status/bridgenode-ai/bridgenode-sdk-ts/ci.yml)](https://github.com/bridgenode-ai/bridgenode-sdk-ts/actions)
[![Website](https://img.shields.io/badge/Website-bridgenode.cc-blue)](https://bridgenode.cc)
[![BridgeNode on x402-list](https://x402-list.com/badge/bridgenode.svg)](https://x402-list.com/services/bridgenode?utm_source=badge&utm_medium=referral&utm_campaign=embed)

**Built for AI agents** — no API keys, no registration, pay-as-you-go with Solana USDC via x402.

BridgeNode TypeScript SDK — AI inference for AI agents, no API keys. Payment: **Solana USDC via x402** (automatic handshake, fee sponsorship — no SOL needed for the agent).

## Installation

```bash
npm install @bridgenode/llm
```

## Usage

```ts
import { LLMClient } from "@bridgenode/llm";

const client = new LLMClient(); // key from .env (BRIDGENODE_WALLET_KEY)
const resp = await client.chat("deepseek-v4-flash", [
  { role: "user", content: "Hello!" }]);
console.log(resp.choices[0].message.content);
```

Everything is handled automatically: `402 → partial TX → PAYMENT-SIGNATURE → 200`. No API key required.

## .env

```bash
# Required — your Solana wallet private key (base58)
BRIDGENODE_WALLET_KEY=***
# Optional:
# BRIDGENODE_BASE_URL=https://bridgenode.cc/v1
# BRIDGENODE_MAX_PER_CALL=0.05   # spending policy: max USD per call (fail-closed)
# BRIDGENODE_DAILY_CAP=1.0       # spending policy: max USD per day
```

## Security

- **Receipt verification (Free-Riding protection):** after 200, `PAYMENT-RESPONSE` is verified — success, network, payer, fee payer Ed25519 signature over our TX message, amount. Invalid receipt → `BridgenodeError`.
- **Spending policy (fail-closed):** `BRIDGENODE_MAX_PER_CALL` + `BRIDGENODE_DAILY_CAP` — checked BEFORE signing; exceeded → blocked, no payment.
- **SIWX:** automatic known-agent identification — falls back to payment if auth fails.

## API

```ts
client.chat(model, messages, { maxTokens?, mode? });  // mode: "auto" | "eco" | "premium"
```

## Requirements

- Node ≥ 20
- Solana wallet with USDC ATA (rent — agent's responsibility)

## Python SDK

Prefer Python? The same BridgeNode toolkit is on PyPI:

- **Python SDK:** `pip install bridgenode-llm` → https://pypi.org/project/bridgenode-llm
- **CLI:** `pip install bridgenode-cli` → https://pypi.org/project/bridgenode-cli
- **Full toolkit (SDK + CLI):** `pip install bridgenode` → https://pypi.org/project/bridgenode

## Links

- Website: https://bridgenode.cc
- Protocol: x402 V2 (docs.x402.org)
