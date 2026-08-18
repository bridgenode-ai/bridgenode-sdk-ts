# BridgeNode Solana x402 Quickstart

Learn the x402 payment flow on Solana by making your first pay-per-request
LLM inference call — no API keys, no registration, no SOL required.

**What you'll learn:**
1. The x402 handshake: `402 Payment Required` → sign → `200`
2. The exact HTTP exchange (curl, so you see every step)
3. The automatic version (TypeScript / Python SDKs)

---

## How x402 works (the 30-second version)

x402 is HTTP-native payments: the first request to a paid endpoint is answered
with **`402 Payment Required`** plus a `PAYMENT-REQUIRED` header describing
what to pay (token, amount, recipient). The caller signs a USDC transfer
(Solana: a partial `TransferChecked + Memo` transaction), sends the signature
back, and gets the real response. On BridgeNode the fee payer is sponsored —
the agent only needs USDC, never SOL.

```
POST /v1/chat/completions
        │
        ▼
402 Payment Required  ← "pay X USDC to this address"
        │
        ▼
sign partial TX (TransferChecked + Memo) — no SOL needed
        │
        ▼
retry with PAYMENT-SIGNATURE
        │
        ▼
200 OK (your LLM response)
```

## Step 1 — Trigger the 402

```bash
curl -sS https://bridgenode.cc/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":16}'
```

You get `402 Payment Required` with a `PAYMENT-REQUIRED` header containing the
payment requirements (USDC on Solana mainnet, exact amount in micro-USDC,
`pay_to` address, `expires_at`). The amount is the price for this exact
request — you know the cost **before** paying.

## Step 2 — Sign the payment

Using the official [`@x402/svm`](https://www.npmjs.com/package/@x402/svm)
scheme, build a partial transaction that transfers the exact USDC amount to
the facilitator and adds a memo with the request hash. Sign only with your USDC
wallet keypair — **no SOL needed** (fee payer is sponsored by BridgeNode).

```ts
import { ExactSvmScheme } from "@x402/svm/exact/client";

const scheme = new ExactSvmScheme({ payer: myUsdcKeypair });
const { partialTx } = await scheme.sign(requirements, requestHash);
// partialTx → serialized, unsigned fee-payer TX
```

## Step 3 — Retry with PAYMENT-SIGNATURE

Retry the same request with your signature in the `PAYMENT-SIGNATURE` header:

```bash
curl -sS https://bridgenode.cc/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "PAYMENT-SIGNATURE: <base64-signed-partial-tx>" \
  -d '{"model":"deepseek-v4-flash","messages":[{"role":"user","content":"Say hello in one word"}],"max_tokens":16}'
```

The server settles the transfer on-chain and returns **`200 OK`** with the LLM
response. The response includes a `PAYMENT-RESPONSE` receipt you can verify
(amount, payer, transaction signature).

**Done — you've made your first x402 payment on Solana.** 🎉

---

## The automatic version (what agents actually use)

You never have to handle the handshake yourself. The SDKs do it for you:
trigger 402 → sign → retry → verify receipt, with spending caps and timeouts.

### TypeScript

```bash
npm install @bridgenode/llm
```

```ts
import { LLMClient } from "@bridgenode/llm";

const client = new LLMClient(); // BRIDGENODE_WALLET_KEY from .env
const resp = await client.chat("deepseek-v4-flash", [
  { role: "user", content: "Hello!" }]);
console.log(resp.choices[0].message.content);
```

### Python

```bash
pip install bridgenode-llm
```

```python
from bridgenode_llm import LLMClient

client = LLMClient()  # BRIDGENODE_WALLET_KEY from .env
resp = client.chat("deepseek-v4-flash", [{"role": "user", "content": "Hello!"}])
print(resp.choices[0].message.content)
```

### Plain curl with a signing tool

For non-SDK callers, the full manual flow is documented in the
[BridgeNode API docs](https://bridgenode.cc) — same three steps, any
language with Ed25519 signing.

---

## Pricing & limits

- Prices are listed live on [`GET /v1/models`](https://bridgenode.cc/v1/models)
  — always check before paying.
- Minimum charge: $0.002 per call; reasoning models require `max_tokens >= 200`.
- No API keys, no accounts, no subscriptions. Refunds are automatic if the
  provider fails after payment.

## Where to go next

- [MCP server](https://github.com/applefanaimail-blip/bridgenode-mcp) —
  `npx -y @bridgenode/mcp` (Claude, Cursor, any MCP client)
- [CLI](https://pypi.org/project/bridgenode-cli/) — `pip install bridgenode-cli`
- [Agent skill](https://github.com/applefanaimail-blip/bridgenode-skill) —
  for OpenClaw / Claude Code agents
- [Full x402 spec](https://docs.x402.org) — the protocol itself
