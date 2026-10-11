# @bridgenode/llm

[![npm version](https://img.shields.io/npm/v/@bridgenode/llm.svg)](https://www.npmjs.com/package/@bridgenode/llm)
[![JSR](https://jsr.io/badges/@bridgenode/llm)](https://jsr.io/@bridgenode/llm)
[![JSR Score](https://jsr.io/badges/@bridgenode/llm/score)](https://jsr.io/@bridgenode/llm)
[![npm downloads](https://img.shields.io/npm/dm/@bridgenode/llm.svg)](https://www.npmjs.com/package/@bridgenode/llm)
[![License: MIT-0](https://img.shields.io/badge/License-MIT--0-yellow.svg)](https://opensource.org/license/mit-0/)
[![CI](https://img.shields.io/github/actions/workflow/status/bridgenode-ai/bridgenode-sdk-ts/ci.yml)](https://github.com/bridgenode-ai/bridgenode-sdk-ts/actions)
[![Website](https://img.shields.io/badge/Website-bridgenode.cc-blue)](https://bridgenode.cc)
[![BridgeNode on x402-list](https://x402-list.com/badge/bridgenode.svg)](https://x402-list.com/services/bridgenode?utm_source=badge&utm_medium=referral&utm_campaign=embed)
[![GitHub Stars](https://img.shields.io/github/stars/bridgenode-ai/bridgenode-sdk-ts?style=social)](https://github.com/bridgenode-ai/bridgenode-sdk-ts)

**Built for AI agents** — no API keys, no registration, pay-as-you-go with Solana USDC via x402. Start free: free models and 2 free calls on paid models per client, no wallet required.

BridgeNode TypeScript SDK — AI inference for AI agents, no API keys. Payment: **Solana USDC via x402** (automatic handshake, fee sponsorship — no SOL needed for the agent).

## Installation

```bash
npm install @bridgenode/llm
```

## Usage

```ts
import { LLMClient } from "@bridgenode/llm";

const client = new LLMClient(); // wallet key from .env — OPTIONAL (free path needs none)
const resp = await client.chat("deepseek-flash", [
  { role: "user", content: "Hello!" }]);
console.log(resp.choices[0].message.content);
```

Everything is handled automatically: `402 → partial TX → PAYMENT-SIGNATURE → 200`. No API key required.

### Free path — no wallet needed

Free models (`"free": true` in `GET /v1/models`) run without payment, and a
client that has never called BridgeNode gets **2 free calls on PAID models**
(free trials) — real inference before any wallet exists. `BRIDGENODE_WALLET_KEY`
is read lazily: it is needed only when a request actually reaches the payment
wall, and then the SDK throws one actionable error instead of a broken
handshake. The remaining trial count is exposed after every call:

```ts
const client = new LLMClient();     // no wallet required for the free path
await client.chat("gpt-oss-120b", [{ role: "user", content: "hi" }]);
console.log(client.lastTrialsRemaining);   // null for free models, 1 → 0 for trials
```

### Tool calling

Send your own tool definitions (OpenAI format) and run the agent loop
yourself — `tools`/`toolChoice` travel in every request of the handshake and the
provider answer is returned untouched:

```ts
const tools = [{
  type: "function",
  function: {
    name: "get_weather",
    description: "Current weather for a city",
    parameters: { type: "object",
                  properties: { city: { type: "string" } },
                  required: ["city"] },
  },
}];

const messages: Array<Record<string, unknown>> = [
  { role: "user", content: "What is the weather in Vilnius?" }];
for (;;) {
  const resp = await client.chat("gpt-oss-120b", messages, { tools }) as Record<string, any>;
  const message = resp.choices[0].message;
  messages.push(message);
  if (!message.tool_calls) {
    console.log(message.content);
    break;
  }
  for (const call of message.tool_calls) {
    // run your own tool here (call.function.arguments is a JSON string)
    messages.push({ role: "tool", tool_call_id: call.id,
                    content: '{"temp_c": 7}' });
  }
}
```

Notes:
- The tool-calling answer has `content: null`, `finish_reason: "tool_calls"`
  and `message.tool_calls` — that is normal, not an error.
- **Every round is its own paid request** (one x402 payment per call).
- The tool schema counts as **input tokens**: it raises the price, and large
  tool sets do not fit the free trial budget (8 000 tokens on the free models).
- Only models marked `"tools": true` in `GET /v1/models` support this.

## .env

```bash
# Optional — your Solana wallet private key (base58).
# Needed only for PAID requests: free models and the 2 free trials work without it.
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
client.chat(model, messages, { maxTokens?, mode?, tools?, toolChoice? });
// mode: "auto" | "eco" | "premium"
```

## Requirements

- Node ≥ 20
- Solana wallet with USDC ATA (rent — agent's responsibility) — only for PAID
  requests; free models and the free trials need no wallet

## Python SDK

Prefer Python? The same BridgeNode toolkit is on PyPI:

- **Python SDK:** `pip install bridgenode-llm` → https://pypi.org/project/bridgenode-llm
- **CLI:** `pip install bridgenode-cli` → https://pypi.org/project/bridgenode-cli
- **Full toolkit (SDK + CLI):** `pip install bridgenode` → https://pypi.org/project/bridgenode

## Links

- Website: https://bridgenode.cc
- Protocol: x402 V2 (docs.x402.org)

## Community

- Moltbook agent profile: https://moltbook.com/u/bridgenode_eli
- Discord: https://discord.gg/HUpVKxJxhG
- X (Twitter): https://x.com/eliBNx

⭐ **Star this repo** — it helps AI agents discover BridgeNode.
