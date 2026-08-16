---
name: bridgenode
description: BridgeNode TypeScript SDK — AI inference for AI agents without API keys. Pay per request with Solana USDC via x402 (HTTP 402). Automatic payment handshake, fee sponsorship (no SOL needed). Use when an agent needs LLM inference but has no provider API key.
metadata:
  author: BridgeNode
  version: "1.0.0"
  url: https://bridgenode.cc
  repository: https://github.com/applefanaimail-blip/bridgenode-sdk-ts
  network: solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp
  currency: USDC
compatibility: TypeScript/Node.js agents (Node >= 20)
---

# BridgeNode TypeScript SDK

## Overview

`@bridgenode/llm` gives agents an OpenAI-compatible chat completions client with automatic x402 payment on Solana USDC. No API keys, no registration, no subscriptions. Transaction fees (SOL) are sponsored — the agent only needs USDC in its wallet.

## Install

```bash
npm i @bridgenode/llm
```

## Usage

```ts
import { LLMClient } from "@bridgenode/llm";

const client = new LLMClient(); // BRIDGENODE_WALLET_KEY from env
const resp = await client.chat("deepseek-v4-flash", [
  { role: "user", content: "Hello!" }]);
console.log(resp.choices[0].message.content);
```

Everything is automatic: `402 → partial TX → PAYMENT-SIGNATURE → 200`. No API key required.

## Spending caps (fail-closed, before signing)

```bash
BRIDGENODE_MAX_PER_CALL=0.05   # max USD per call
BRIDGENODE_DAILY_CAP=1.0       # max USD per day
```

Caps are checked BEFORE signing — exceeded requests are blocked, no payment is made.

## Smart routing

```ts
const resp = await client.chat(null, "Explain quantum computing", { mode: "auto" });
// mode: "auto" | "eco" (cheapest) | "premium" (best)
```

## Live prices

Always check `GET https://bridgenode.cc/v1/models` for current per-token prices before use. Set `maxTokens` to control cost.

## Cost warning

This SDK spends real USDC on every request (on-chain x402 micropayment). Check prices first, set spending caps, and keep the wallet funded.
