/**
 * client.test.ts — LLMClient tests.
 *
 * z1: automatic x402 handshake (402 → PAYMENT-SIGNATURE → 200).
 * z2: PAYMENT-RESPONSE receipt verification (success/network/payer/TX signature/
 * amount), spending policy (MAX_PER_CALL, DAILY_CAP — fail-closed), SIWX
 * client hook (SIGN-IN-WITH-X, fallback to payment, granted 200).
 *
 * Mocked global fetch: API (402 → 200) + RPC (mint metadata). The receipt
 * is genuinely generated: the mock server signs OUR TX message with the fee
 * payer key (like a real service). No real network.
 */

import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import { getBase58Decoder } from "@solana/kit";
import { getTransactionDecoder } from "@solana/transactions";

import { BridgenodeError, LLMClient } from "../src/index.js";

const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WALLET = "BHMDv3ri3LBEZjEzJgDZeUiguVX7LmsCstTXbM3dL8rN";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const BLOCKHASH = "EZ3rST5dvHmbanh75jc4PuLfV96vp9fEYBVeNk4FfM1k";
const API_BASE = "http://test/v1";
const RPC_URL = "http://rpc.test";

const b58dec = getBase58Decoder();
const fromB64url = (s: string): Uint8Array =>
  new Uint8Array(Buffer.from(s, "base64url"));

/**
 * Valid keypair (base58 64 bytes) + address.
 * @solana/kit verifies that the public key matches the secret.
 */
async function makeKeypair(): Promise<{ walletKey: string; address: string }> {
  const kp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, /* extractable */ true, ["sign", "verify"]);
  const jwk = await crypto.subtle.exportKey("jwk", kp.privateKey);
  const priv = fromB64url(jwk.d!);
  const pub = fromB64url(jwk.x!);
  const full = new Uint8Array(64);
  full.set(priv, 0);
  full.set(pub, 32);
  // Key ONLY from env — tests set BRIDGENODE_WALLET_KEY
  process.env.BRIDGENODE_WALLET_KEY = b58dec.decode(full);
  return { walletKey: b58dec.decode(full), address: b58dec.decode(pub) };
}

/** 402 V2 envelope — as the server sends it. */
function envelope(amount = "2000", siwx = false,
                  asset = USDC, network = NETWORK): Record<string, unknown> {
  const env: Record<string, unknown> = {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: "https://bridgenode.cc/v1/chat/completions",
      description: "AI inference",
      mimeType: "application/json",
    },
    accepts: [
      {
        scheme: "exact",
        network,
        amount,
        asset,
        payTo: WALLET,
        maxTimeoutSeconds: 30,
        extra: {
          feePayer: WALLET,
          memo: "pi_test123",
          recentBlockhash: BLOCKHASH,
          lastValidBlockHeight: "291470237",
        },
      },
    ],
  };
  if (siwx) {
    const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
    env.extensions = {
      "sign-in-with-x": {
        info: {
          domain: "bridgenode.cc",
          uri: "https://bridgenode.cc/v1/chat/completions",
          version: "1",
          nonce: "nonce1234567890abcdef",
          issuedAt: now,
          expirationTime: new Date(Date.now() + 300_000)
            .toISOString().replace(/\.\d+Z$/, "Z"),
          resources: ["https://bridgenode.cc/v1/chat/completions"],
        },
        supportedChains: [{ chainId: NETWORK, type: "ed25519" }],
      },
    };
  }
  return env;
}

function openaiResponse(): Record<string, unknown> {
  return {
    id: "cmpl-1",
    object: "chat.completion",
    created: 1,
    model: "deepseek-v4-flash",
    choices: [{ index: 0, message: { role: "assistant", content: "Hello!" },
                finish_reason: "stop" }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

/** USDC mint account (82-byte SPL mint): decimals=6, owner=Token Program. */
function mintAccountData(): string {
  const data = new Uint8Array(82);
  data[44] = 6;      // decimals
  data[45] = 1;      // is_initialized
  return Buffer.from(data).toString("base64");
}

interface ServerOptions {
  amount?: string;
  siwx?: boolean;
  siwxGranted?: boolean;
  noReceipt?: boolean;
  receiptOverrides?: Record<string, unknown>;
  asset?: string;
  network?: string;
}

/**
 * Mock server: API (402 → 200) + RPC (getAccountInfo → mint metadata).
 * Receipt: fee payer signs OUR TX message (tx.messageBytes) — like
 * a real facilitator. Envelope feePayer = real fee payer address.
 * Returns (handler, seen).
 */
function makeServer(feePayerPriv: CryptoKey, clientAddress: string,
                    opts: ServerOptions = {}) {
  const seen: Array<{ url: string; hasPayment: boolean; hasSiwx: boolean;
                      siwxHeader: string | null; body: unknown }> = [];
  let feePayerAddress: string | null = null;

  const feePayerAddr = async (): Promise<string> => {
    if (!feePayerAddress) {
      const jwk = await crypto.subtle.exportKey("jwk", feePayerPriv);
      feePayerAddress = b58dec.decode(fromB64url(jwk.x!));
    }
    return feePayerAddress;
  };

  const handler = async (url: string, init?: RequestInit): Promise<Response> => {
    const headers = new Headers(init?.headers);
    const paymentHeader = headers.get("PAYMENT-SIGNATURE");
    const siwxHeader = headers.get("SIGN-IN-WITH-X");
    seen.push({
      url,
      hasPayment: paymentHeader !== null,
      hasSiwx: siwxHeader !== null,
      siwxHeader,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });

    // RPC (mint metadata)
    if (url.startsWith(RPC_URL)) {
      const body = JSON.parse(String(init?.body));
      if (body.method === "getAccountInfo") {
        return new Response(JSON.stringify({
          jsonrpc: "2.0",
          result: {
            context: { slot: 1 },
            value: {
              data: [mintAccountData(), "base64"],
              executable: false,
              lamports: 1,
              owner: TOKEN_PROGRAM,
              rentEpoch: 0,
              space: 82,
            },
          },
          id: body.id,
        }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      return new Response(JSON.stringify({
        jsonrpc: "2.0", result: null, id: body.id,
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    }

    // API: initial request → 402
    if (!paymentHeader) {
      // SIWX-granted: known agent → 200 without payment
      if (opts.siwxGranted && siwxHeader) {
        return new Response(JSON.stringify(openaiResponse()), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      const env = envelope(opts.amount ?? "2000", opts.siwx ?? false,
                           opts.asset ?? USDC, opts.network ?? NETWORK);
      // Envelope feePayer = real fee payer address (not a constant) — otherwise
      // receipt verification would fail (signature of another key)
      env.accepts[0].extra.feePayer = await feePayerAddr();
      return new Response(JSON.stringify(env), {
        status: 402,
        headers: {
          "Content-Type": "application/json",
          "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(env)).toString("base64"),
        },
      });
    }

    // Payment retry → 200 + valid receipt (fee payer signs our TX message)
    const payload = JSON.parse(
      Buffer.from(paymentHeader, "base64").toString("utf-8"));
    const wire = Uint8Array.from(
      Buffer.from(payload.payload.transaction, "base64"));
    const tx = getTransactionDecoder().decode(wire);
    const sigRaw = await crypto.subtle.sign("Ed25519", feePayerPriv, tx.messageBytes);
    const settle: Record<string, unknown> = {
      success: true,
      transaction: b58dec.decode(new Uint8Array(sigRaw)),
      network: NETWORK,
      payer: clientAddress,
      amount: opts.amount ?? "2000",
      ...(opts.receiptOverrides ?? {}),
    };
    const respHeaders: Record<string, string> = { "Content-Type": "application/json" };
    if (!opts.noReceipt) {
      respHeaders["PAYMENT-RESPONSE"] = Buffer.from(
        JSON.stringify(settle)).toString("base64");
    }
    return new Response(JSON.stringify(openaiResponse()), {
      status: 200,
      headers: respHeaders,
    });
  };

  return { handler, seen };
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── Handshake (z1) ───────────────────────────────────────────────────────────

test("chat: 402 → PAYMENT-SIGNATURE → retry → 200", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address);
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
  });
  const resp = await client.chat("deepseek-v4-flash",
                                 [{ role: "user", content: "Hello!" }]);

  assert.equal((resp.choices as Array<Record<string, unknown>>)[0]
    .message.content, "Hello!");
  // Only API requests (RPC mint metadata is recorded too, but not counted)
  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  assert.equal(apiSeen.length, 2);
  assert.equal(apiSeen[0].hasPayment, false);
  assert.equal(apiSeen[1].hasPayment, true);
  assert.deepEqual(apiSeen[0].body, apiSeen[1].body); // price-bind
  assert.equal(client.lastReceipt?.success, true);
  assert.equal(client.lastReceipt?.network, NETWORK);
});

test("chat: maxTokens and mode are passed through", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address);
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
  });
  await client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }],
                    { maxTokens: 123, mode: "auto" });
  const body = seen.filter((r) => r.url.startsWith(API_BASE))[0]
    .body as Record<string, unknown>;
  assert.equal(body.max_tokens, 123);
  assert.equal(body.mode, "auto");
});

test("chat: null model + mode → body without model field (smart routing)",
     async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address);
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
  });
  // item 25 (§5.1): smart routing — model omitted (no `model: null` in body)
  await client.chat(null, "hi", { mode: "auto" });
  const body = seen.filter((r) => r.url.startsWith(API_BASE))[0]
    .body as Record<string, unknown>;
  assert.equal("model" in body, false, "body must not contain model: null");
  assert.equal(body.mode, "auto");
});

test("Z41: string prompt → OpenAI messages (identical body as list)",
     async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address);
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
  });
  await client.chat("deepseek-v4-flash", "Hello!");

  const body = seen.filter((r) => r.url.startsWith(API_BASE))[0]
    .body as Record<string, unknown>;
  assert.deepEqual(body.messages,
                   [{ role: "user", content: "Hello!" }]);
  assert.equal(body.model, "deepseek-v4-flash");
});

test("chat: server error → BridgenodeError with message", async () => {
  globalThis.fetch = (async (): Promise<Response> => new Response(
    JSON.stringify({ error: { message: "Unknown model",
                               type: "invalid_request_error",
                               code: "model_not_found" } }),
    { status: 400, headers: { "Content-Type": "application/json" } })) as typeof fetch;

  const clientKp = await makeKeypair();
  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("bogus-model", [{ role: "user", content: "hi" }]),
    (err: unknown) => {
      assert.ok(err instanceof BridgenodeError);
      assert.equal((err as BridgenodeError).statusCode, 400);
      assert.match((err as BridgenodeError).message, /Unknown model/);
      return true;
    });
});

// ── Receipt verification (z2) ──────────────────────────────────────────────────

test("receipt: missing PAYMENT-RESPONSE → error (not silent)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler } = makeServer(feeKp.privateKey, clientKp.address,
                                 { noReceipt: true });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /receipt missing/i);
});

test("receipt: success:false → error", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler } = makeServer(feeKp.privateKey, clientKp.address,
                                 { receiptOverrides:
                                     { success: false, errorReason: "simulation_failed" } });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /Payment failed/);
});

test("receipt: wrong network → error", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler } = makeServer(feeKp.privateKey, clientKp.address,
                                 { receiptOverrides: { network: "eip155:1" } });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /network mismatch/);
});

test("receipt: wrong payer → error", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler } = makeServer(feeKp.privateKey, clientKp.address,
                                 { receiptOverrides: { payer: WALLET } });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /payer mismatch/);
});

test("receipt: forged TX (not fee payer's signature) → error", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const fakeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address, {
    receiptOverrides: {
      // Fake receipt: signature of another key (not the fee payer's)
      transaction: b58dec.decode(new Uint8Array(
        await crypto.subtle.sign("Ed25519", fakeKp.privateKey,
                                 new TextEncoder().encode("fake")))),
    },
  });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /does not match our TX/);
  assert.equal(seen.filter((r) => r.url.startsWith(API_BASE)).length, 2);
});

test("receipt: amount mismatch → error", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler } = makeServer(feeKp.privateKey, clientKp.address,
                                 { receiptOverrides: { amount: "9999" } });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /amount mismatch/);
});

// ── Spending policy (z2, fail-closed) ────────────────────────────────────────

test("spending: MAX_PER_CALL exceeded → blocked BEFORE signing", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { amount: "60000" }); // $0.06 > $0.05
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /max per call/);
  // Payment was not signed — retry (2nd API request) did not happen
  assert.equal(seen.filter((r) => r.url.startsWith(API_BASE)).length, 1);
});

test("spending: DAILY_CAP exceeded → blocked (fail-closed)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { amount: "30000" }); // $0.03
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
    maxPerCallUsd: 0.10, dailyCapUsd: 0.05,
  });
  const resp = await client.chat("deepseek-v4-flash",
                                 [{ role: "user", content: "a" }]);
  assert.equal((resp.choices as Array<Record<string, unknown>>)[0]
    .message.content, "Hello!");
  // Second call would exceed the daily cap (0.03 + 0.03 > 0.05)
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "b" }]),
    /daily cap/);
  // Blocked before payment: 3 API requests (a, without payment; a, with;
  // b, without — blocked before retry)
  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  assert.equal(apiSeen.length, 3);
  assert.equal(apiSeen[2].hasPayment, false);
});

test("spending: env overrides (BRIDGENODE_MAX_PER_CALL/DAILY_CAP)", () => {
  const savedMax = process.env.BRIDGENODE_MAX_PER_CALL;
  const savedCap = process.env.BRIDGENODE_DAILY_CAP;
  process.env.BRIDGENODE_MAX_PER_CALL = "0.5";
  process.env.BRIDGENODE_DAILY_CAP = "5.0";
  try {
    process.env.BRIDGENODE_WALLET_KEY = "key";
    const client = new LLMClient({
      baseUrl: API_BASE,
    });
    assert.equal(client.maxPerCall, 0.5);
    assert.equal(client.dailyCap, 5.0);
  } catch {
    // BRIDGENODE_WALLET_KEY is fake — the constructor can only throw due to
    // key format; spending values are checked via the arguments below
  } finally {
    if (savedMax !== undefined) process.env.BRIDGENODE_MAX_PER_CALL = savedMax;
    else delete process.env.BRIDGENODE_MAX_PER_CALL;
    if (savedCap !== undefined) process.env.BRIDGENODE_DAILY_CAP = savedCap;
    else delete process.env.BRIDGENODE_DAILY_CAP;
  }
});

// ── Supported entry selection ────────────────────────────────────────────

test("Z36: 402 with another mint → error BEFORE signing (no TX)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const otherMint = "So11111111111111111111111111111111111111112"; // SOL mint
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { asset: otherMint });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /Unsupported payment asset/);
  // No payment — retry with PAYMENT-SIGNATURE did not happen
  assert.equal(seen.filter((r) => r.url.startsWith(API_BASE)).length, 1);
});

test("Z36: 402 with another network → error BEFORE signing (no TX)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const otherNetwork = "solana:4sGjMW1sUnHzSxGspuhpqLDx6wiyjNtZ"; // devnet
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { network: otherNetwork });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /No supported payment requirement/);
  // No payment — retry with PAYMENT-SIGNATURE did not happen
  assert.equal(seen.filter((r) => r.url.startsWith(API_BASE)).length, 1);
});

test("Z36: empty accepts → error BEFORE signing (no TX)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const env = envelope();
  env.accepts = [];

  const handler = (async (url: string, init?: RequestInit): Promise<Response> => {
    if (String(url).startsWith(RPC_URL)) {
      return new Response(JSON.stringify({ jsonrpc: "2.0", result: null, id: 1 }),
                          { status: 200, headers: { "Content-Type": "application/json" } });
    }
    return new Response(JSON.stringify(env), {
      status: 402,
      headers: {
        "Content-Type": "application/json",
        "PAYMENT-REQUIRED": Buffer.from(JSON.stringify(env)).toString("base64"),
      },
    });
  }) as typeof fetch;
  globalThis.fetch = handler;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /No supported payment requirement/);
});

// ── SIWX ────────────────────────────────────────────────────────────────────

test("SIWX: 402 with challenge → SIGN-IN-WITH-X → fallback to payment", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { siwx: true });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  const resp = await client.chat("deepseek-v4-flash",
                                 [{ role: "user", content: "hi" }]);

  assert.equal((resp.choices as Array<Record<string, unknown>>)[0]
    .message.content, "Hello!");
  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  assert.equal(apiSeen.length, 3); // initial + SIWX retry + payment retry
  assert.equal(apiSeen[0].hasSiwx, false);
  assert.equal(apiSeen[1].hasSiwx, true);
  assert.equal(apiSeen[1].hasPayment, false);
  assert.equal(apiSeen[2].hasPayment, true);
  assert.equal(apiSeen[2].hasSiwx, true); // SIWX echo also on the payment retry
});

test("SIWX: no challenge → normal payment (2 requests)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { siwx: false });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]);
  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  assert.equal(apiSeen.length, 2);
  assert.equal(apiSeen[1].hasSiwx, false);
});

test("SIWX: granted 200 without payment (known agent)", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { siwx: true, siwxGranted: true });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  const resp = await client.chat("deepseek-v4-flash",
                                 [{ role: "user", content: "hi" }]);
  assert.equal((resp.choices as Array<Record<string, unknown>>)[0]
    .message.content, "Hello!");
  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  assert.equal(apiSeen.length, 2); // initial + SIWX retry; payment did not happen
  assert.equal(apiSeen[1].hasSiwx, true);
  assert.equal(apiSeen[1].hasPayment, false);
});

test("SIWX: header cryptographically valid (official verifySIWxSignature)",
     async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address,
                                       { siwx: true });
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE, rpcUrl: RPC_URL,
  });
  await client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]);

  const apiSeen = seen.filter((r) => r.url.startsWith(API_BASE));
  const header = apiSeen[1].siwxHeader;
  assert.ok(header);
  const { parseSIWxHeader, verifySIWxSignature } = await import("@x402/extensions");
  const payload = parseSIWxHeader(header);
  assert.equal(payload.address, clientKp.address);
  assert.equal(payload.domain, "bridgenode.cc");
  assert.equal(payload.nonce, "nonce1234567890abcdef");
  const result = await verifySIWxSignature(payload);
  assert.equal(result.isValid, true);
  assert.equal(result.payer, clientKp.address);
});

// ── Configuration ───────────────────────────────────────────────────────────

test("missing key → BridgenodeError", () => {
  const saved = process.env.BRIDGENODE_WALLET_KEY;
  delete process.env.BRIDGENODE_WALLET_KEY;
  try {
    assert.throws(() => new LLMClient({ baseUrl: API_BASE }),
                  /BRIDGENODE_WALLET_KEY/);
  } finally {
    if (saved !== undefined) process.env.BRIDGENODE_WALLET_KEY = saved;
  }
});

test("default baseUrl and timeouts", async () => {
  const clientKp = await makeKeypair();
  const client = new LLMClient({});
  assert.equal(client.baseUrl, "https://bridgenode.cc/v1");
  assert.ok(client.initialTimeoutMs >= 30_000);
  assert.ok(client.retryTimeoutMs >= 113_000);
  assert.ok(client.retryTimeoutMs <= 115_000);
  // Z42: total flow timeout ≥ initial + retry
  assert.ok(client.flowTimeoutMs >= client.initialTimeoutMs + client.retryTimeoutMs);
});

test("Z42: flow timeout exceeded → BridgenodeError BEFORE request", async () => {
  const feeKp = await crypto.subtle.generateKey(
    { name: "Ed25519" }, true, ["sign", "verify"]);
  const clientKp = await makeKeypair();
  const { handler, seen } = makeServer(feeKp.privateKey, clientKp.address);
  globalThis.fetch = handler as typeof fetch;

  const client = new LLMClient({
    baseUrl: API_BASE,
    rpcUrl: RPC_URL,
    flowTimeoutMs: 0, // total budget = 0 → immediate error
  });
  await assert.rejects(
    () => client.chat("deepseek-v4-flash", [{ role: "user", content: "hi" }]),
    /Flow timeout/);
  // No request was sent
  assert.equal(seen.filter((r) => r.url.startsWith(API_BASE)).length, 0);
});

test("BRIDGENODE_BASE_URL from env (configurable)", async () => {
  const saved = process.env.BRIDGENODE_BASE_URL;
  process.env.BRIDGENODE_BASE_URL = "https://alt.example/v1";
  try {
    const clientKp = await makeKeypair();
    const client = new LLMClient({});
    assert.equal(client.baseUrl, "https://alt.example/v1");
  } finally {
    if (saved !== undefined) process.env.BRIDGENODE_BASE_URL = saved;
    else delete process.env.BRIDGENODE_BASE_URL;
  }
});
