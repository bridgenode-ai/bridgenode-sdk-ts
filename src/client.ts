/**
 * client.ts — LLMClient: automatic x402 V2 handshake.
 *
 * Flow: POST /v1/chat/completions → 402 (PAYMENT-REQUIRED) → partial TX
 * (TransferChecked + Memo) via the official @x402/svm scheme →
 * PAYMENT-SIGNATURE → retry → 200.
 *
 * step 2 — Receipt verification + spending policy + SIWX (fail-closed):
 * - After 200, the `PAYMENT-RESPONSE` receipt is verified: success=true,
 *   network = Solana mainnet, payer = our wallet, transaction = fee payer
 *   signature over OUR TX message (Free-Riding protection), amount matches
 *   (if provided). Mismatch → BridgenodeError (error, not silence).
 * - Spending policy: `BRIDGENODE_MAX_PER_CALL` (0.05 USD) +
 *   `BRIDGENODE_DAILY_CAP` (1.0 USD) — checked BEFORE signing (402 amount);
 *   exceeded → blocked (no payment, error). Daily counter in-memory.
 * - SIWX: 402 with `extensions["sign-in-with-x"]` → official
 *   `createSIWxClientHook` signs CAIP-122 → retry with `SIGN-IN-WITH-X`;
 *   fallback to payment if auth fails; SIWX-granted 200 (no payment)
 *   supported (payload null → receipt verification skipped).
 *
 * Rules:
 * - Key from `.env` (`BRIDGENODE_WALLET_KEY`) — no arguments, no interactive
 *   prompts
 * - Endpoint: `https://bridgenode.cc/v1` (configurable via
 *   `BRIDGENODE_BASE_URL` or argument)
 * - Two separate timeouts: initial ≥ 30s (queue until 402),
 *   retry ≥ 113s (≤ 115s budget)
 * - Uses the official x402 client (x402Client + ExactSvmScheme +
 *   @x402/extensions SIWX hook) — no custom payment code
 *   (no custom payment code)
 */

import {
  createKeyPairSignerFromBytes,
  getBase58Decoder,
  getBase58Encoder,
  signatureBytes,
  verifySignature,
} from "@solana/kit";
import { getTransactionDecoder } from "@solana/kit";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { createSIWxClientHook, type SIWxSigner } from "@x402/extensions";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import * as dotenv from "dotenv";

/**
 * Default BridgeNode API base URL (`https://bridgenode.cc/v1`).
 */
export const BRIDGENODE_BASE_URL = "https://bridgenode.cc/v1";
/**
 * Solana mainnet network identifier (CAIP-2).
 */
export const NETWORK = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"; // Solana mainnet (CAIP-2)
/**
 * Solana mainnet USDC mint address.
 */
export const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"; // Solana mainnet USDC mint
/**
 * USDC decimals (6).
 */
export const USDC_DECIMALS = 6;

// The initial request waits in the queue until 402 (30s queue + 30s
// window); retry with PAYMENT-SIGNATURE — up to the 115s budget (settle 20 + provider 30×3)
/**
 * Timeout for the initial request — waits in the queue until the 402 response.
 */
export const INITIAL_TIMEOUT_MS = 60_000;
/**
 * Timeout for the retry with PAYMENT-SIGNATURE (settle + provider budget).
 */
export const RETRY_TIMEOUT_MS = 115_000;
// Total flow timeout ≥ sum of both (initial + retry ≈ 175s)
/**
 * Total flow timeout — initial + retry (≈ 175s).
 */
export const FLOW_TIMEOUT_MS = INITIAL_TIMEOUT_MS + RETRY_TIMEOUT_MS;

// Spending policy: fail-closed
/**
 * Default maximum spend per single call (USD).
 */
export const DEFAULT_MAX_PER_CALL_USD = 0.05;
/**
 * Default maximum spend per day (USD).
 */
export const DEFAULT_DAILY_CAP_USD = 1.0;

/**
 * Error thrown by the BridgeNode SDK for API, payment, and policy failures.
 */
export class BridgenodeError extends Error {
  readonly statusCode?: number;
  readonly code?: string;

  constructor(message: string, statusCode?: number, code?: string) {
    super(message);
    this.name = "BridgenodeError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

/**
 * Options for a chat request.
 */
export interface ChatOptions {
  maxTokens?: number;
  mode?: "auto" | "eco" | "premium";
  stream?: boolean;  // SSE stream — returns AsyncGenerator of chunks
}

/**
 * Options for configuring an {@link LLMClient}.
 */
export interface LLMClientOptions {
  baseUrl?: string;
  rpcUrl?: string;
  initialTimeoutMs?: number;
  retryTimeoutMs?: number;
  flowTimeoutMs?: number;
  maxPerCallUsd?: number;
  dailyCapUsd?: number;
  envPath?: string;
}

interface ServerErrorBody {
  error?: { message?: string; type?: string; code?: string };
}

/** Shape of an accepts[] entry (PaymentRequirements from @x402/core, simplified) */
interface PaymentRequirementShape {
  scheme: string;
  network: string;
  asset: string;
  amount: string;
}

interface SettleResponseShape {
  success: boolean;
  errorReason?: string | null;
  payer?: string | null;
  transaction: string;
  network: string;
  amount?: string | null;
}

/** PaymentPayload from @x402/core (simplified view for verification) */
interface PaymentPayloadShape {
  payload: { transaction: string };
  accepted: { amount: string; extra: Record<string, unknown> };
}

/**
 * BridgeNode LLM client — AI inference for AI agents with x402 payment on
 * Solana USDC. No API keys, no registration.
 */
export class LLMClient {
  readonly baseUrl: string;
  readonly initialTimeoutMs: number;
  readonly retryTimeoutMs: number;
  readonly flowTimeoutMs: number;
  readonly walletAddress: string;
  readonly maxPerCall: number;
  readonly dailyCap: number;

  /** Last verified receipt (PAYMENT-RESPONSE) — for introspection */
  lastReceipt: Record<string, unknown> | null = null;

  private readonly walletKey: string;
  private readonly rpcUrl?: string;
  private readonly secretKey: Uint8Array;
  private x402: x402Client | null = null;
  private httpHelper: x402HTTPClient | null = null;
  private dailySpend: Record<string, number> = {};

  /**
   * Spending policy as a lifecycle hook (official practice).
   *
   * Registered as ``onBeforePaymentCreation`` — runs BEFORE payment payload
   * creation, next to the payment client (docs.x402.org lifecycle-hooks).
   * Returns ``{ abort: true, reason }`` if the 402 amount exceeds MAX_PER_CALL
   * or DAILY_CAP — no TX (fail-closed).
   *
   * Arrow function (class field) — keeps ``this`` bound to LLMClient when the
   * hook is invoked by the x402 client.
   */
  private _spendingPolicyHook = async (context: {
    selectedRequirements?: { amount?: string };
  }): Promise<{ abort: true; reason: string } | void> => {
    const amountAtomic = Number(context.selectedRequirements?.amount);
    if (!Number.isFinite(amountAtomic)) {
      return { abort: true, reason: "Spending policy: invalid amount" };
    }
    const amountUsd = amountAtomic / (10 ** USDC_DECIMALS);
    try {
      this._checkSpending(amountUsd);
    } catch (err) {
      if (err instanceof BridgenodeError) {
        return { abort: true, reason: err.message };
      }
      throw err;
    }
    return undefined;
  };

  constructor(options: LLMClientOptions = {}) {
    if (options.envPath) {
      dotenv.config({ path: options.envPath });
    } else {
      dotenv.config();
    }

    this.walletKey = process.env.BRIDGENODE_WALLET_KEY ?? "";
    if (!this.walletKey) {
      throw new BridgenodeError(
        "BRIDGENODE_WALLET_KEY missing — set it in .env (your Solana wallet private key, base58)");
    }

    this.baseUrl = (options.baseUrl ?? process.env.BRIDGENODE_BASE_URL ?? BRIDGENODE_BASE_URL)
      .replace(/\/+$/, "");
    this.initialTimeoutMs = options.initialTimeoutMs ?? INITIAL_TIMEOUT_MS;
    this.retryTimeoutMs = options.retryTimeoutMs ?? RETRY_TIMEOUT_MS;
    this.flowTimeoutMs = options.flowTimeoutMs ?? FLOW_TIMEOUT_MS;
    this.rpcUrl = options.rpcUrl ?? process.env.BRIDGENODE_RPC_URL;

    // Spending policy (step 2): argument > env > default
    this.maxPerCall = options.maxPerCallUsd ?? parseFloat(
      process.env.BRIDGENODE_MAX_PER_CALL ?? String(DEFAULT_MAX_PER_CALL_USD));
    this.dailyCap = options.dailyCapUsd ?? parseFloat(
      process.env.BRIDGENODE_DAILY_CAP ?? String(DEFAULT_DAILY_CAP_USD));

    // Wallet address — from the private key (base58 → 64 bytes → keypair signer)
    this.secretKey = new Uint8Array(getBase58Encoder().encode(this.walletKey));
    this.walletAddress = ""; // filled in _ensureInit() (signer creation is async)
  }

  // ── API ────────────────────────────────────────────────────────────────

  /**
   * Send a chat completion request. Returns the full response object, or an
   * `AsyncGenerator` of chunks when `stream` is enabled.
   */
  async chat(model: string | null, messages: string | Array<Record<string, unknown>>,
             options: ChatOptions = {}): Promise<Record<string, unknown> | AsyncGenerator<Record<string, unknown>, void, unknown>> {
    await this._ensureInit();
    // string prompt → OpenAI messages format
    // (client side; the server still receives an OpenAI body)
    const normalizedMessages: Array<Record<string, unknown>> =
      typeof messages === "string"
        ? [{ role: "user", content: messages }]
        : messages;
    const url = `${this.baseUrl}/chat/completions`;
    // `model` omitted when null — body without `model: null`
    // (when sending only `mode` for smart routing, the server would get
    // JSON null → possible 400; Python SDK does the same)
    const body: Record<string, unknown> = { messages: normalizedMessages };
    if (model !== null && model !== undefined) body["model"] = model;
    if (options.maxTokens !== undefined) body["max_tokens"] = options.maxTokens;
    if (options.mode !== undefined) body["mode"] = options.mode;
    if (options.stream) body["stream"] = true;  // SSE stream
    const json = JSON.stringify(body);

    // Total flow timeout — the whole handshake (initial + SIWX +
    // payment retry) must fit within the budget; exceeded → BridgenodeError
    const flowDeadline = Date.now() + this.flowTimeoutMs;
    const flowTimeout = (callMs: number): number => {
      const remaining = flowDeadline - Date.now();
      if (remaining <= 0) {
        throw new BridgenodeError(
          `Flow timeout exceeded (${this.flowTimeoutMs}ms)`);
      }
      return Math.min(callMs, remaining);
    };

    // 1) Initial request (no payment): queue until 402.
    // Client-side retry (503 queue full / wait timeout) and 429 (per-agent
    // queue cap / 402 rate limit) are retried with backoff — BEFORE any
    // payment (nothing was charged, retry is free). Retry-After header is
    // honoured when present. Same behaviour as the Python SDK (fix.md 4.1).
    // After payment: NO retry (single retry with PAYMENT-SIGNATURE only).
    let resp = await this._fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: json,
      signal: AbortSignal.timeout(flowTimeout(this.initialTimeoutMs)),
    });
    const retries = 3;
    const backoffMs = 1000;
    for (let attempt = 0;
         (resp.status === 503 || resp.status === 429) && attempt < retries;
         attempt += 1) {
      let waitMs = backoffMs * (2 ** attempt);
      const retryAfter = resp.headers.get("Retry-After");
      if (retryAfter) {
        const ra = Number(retryAfter);
        if (Number.isFinite(ra) && ra >= 0) waitMs = ra * 1000;
      }
      // Cap at 15s (Python SDK) and never sleep past the flow deadline —
      // the next fetch would throw the flow timeout anyway.
      waitMs = Math.min(waitMs, 15_000,
                        Math.max(flowDeadline - Date.now(), 0));
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs));
      resp = await this._fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: json,
        signal: AbortSignal.timeout(flowTimeout(this.initialTimeoutMs)),
      });
    }

    // 2) 402 → SIWX first, then spending policy + payment
    let paymentPayload: PaymentPayloadShape | null = null;
    let siwxHeaders: Record<string, string> | null = null;
    // Spend recorded ONLY after a successful 200 (like the
    // Python SDK) — retry failure (5xx) → the server refunds; a pessimistic
    // cap is unnecessary. Held here until 200 confirms the payment.
    let paymentAmountUsd: number | null = null;

    if (resp.status === 402) {
      const helper = this.httpHelper!;
      const getHeader = (name: string): string | null => resp.headers.get(name);
      const paymentRequired = helper.getPaymentRequiredResponse(
        getHeader, await resp.json().catch(() => undefined));

      // SIWX: official hook — 402 with challenge → SIGN-IN-WITH-X header
      // requires requestUrl (final URL after redirects).
      // Use resp.url ONLY if it shares the request origin (a mocked/new Response
      // may have a bogus url like "about:blank" — would fail-closed on domain check)
      const finalUrl = (resp.url && url &&
        resp.url.startsWith(new URL(url).origin)) ? resp.url : url;
      // B4 (fix.md): SIWX failure must NOT break chat() — fall back to
      // payment, like the Python SDK (client.py:423-428 wraps the hook call
      // in try/except → None). A mismatched challenge or signer error would
      // otherwise kill the whole request even though payment would work.
      try {
        siwxHeaders = await helper.handlePaymentRequired(
          paymentRequired, finalUrl);
      } catch {
        siwxHeaders = null;  // fallback to payment
      }
      if (siwxHeaders) {
        resp = await this._fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...siwxHeaders },
          body: json,
          signal: AbortSignal.timeout(flowTimeout(this.initialTimeoutMs)),
        });
      }

      if (resp.status === 402) {
        // Fallback to payment: spending policy BEFORE signing (fail-closed)
        const getHeader2 = (name: string): string | null => resp.headers.get(name);
        const paymentRequired2 = helper.getPaymentRequiredResponse(
          getHeader2, await resp.json().catch(() => undefined));
        // fail-closed — pick a supported accepts entry
        // (exact + Solana mainnet + USDC); the SDK does not check the
        // asset — verified here, BEFORE signing (no TX for other mint/network)
        const selected = this._selectPaymentRequirement(paymentRequired2);
        // B2 (fix.md): malformed server amount (decimal/garbage/negative)
        // must surface as BridgenodeError, not a silent spend check — same
        // fail-closed contract as the Python SDK (client.py int() + >0).
        const amountAtomicNum = Number(selected.amount);
        if (!Number.isInteger(amountAtomicNum) || amountAtomicNum <= 0) {
          throw new BridgenodeError(
            `Malformed payment amount ${JSON.stringify(selected.amount)} ` +
            `in 402 response — no payment made`);
        }
        const amountAtomic = amountAtomicNum;
        const amountUsd = amountAtomic / (10 ** USDC_DECIMALS);
        this._checkSpending(amountUsd);

        const payload = await helper.createPaymentPayload(paymentRequired2);
        paymentPayload = payload as unknown as PaymentPayloadShape;
        paymentAmountUsd = amountUsd;  // spend recorded AFTER 200
        const payHeaders = helper.encodePaymentSignatureHeader(payload);
        const retryHeaders = { "Content-Type": "application/json", ...payHeaders };
        if (siwxHeaders) Object.assign(retryHeaders, siwxHeaders);
        // B3 (fix.md): for SSE the flow timeout must bound only the HEAD
        // (until 200 headers) — AbortSignal.timeout() would stay armed while
        // reading the body and cut long generations mid-stream. Python SDK:
        // per-read timeout, no total cap. Non-stream: keep the total cap
        // (body is a small JSON, matches Python _post total timeout).
        if (options.stream) {
          const controller = new AbortController();
          const timer = setTimeout(
            () => controller.abort(), flowTimeout(this.retryTimeoutMs));
          try {
            resp = await this._fetch(url, {
              method: "POST",
              headers: retryHeaders,
              body: json,
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timer);  // headers received — body read unbounded
          }
        } else {
          resp = await this._fetch(url, {
            method: "POST",
            headers: retryHeaders,
            body: json,
            signal: AbortSignal.timeout(flowTimeout(this.retryTimeoutMs)),
          });
        }
      }
    }

    if (resp.status !== 200) {
      let message = `HTTP ${resp.status}`;
      let code: string | undefined;
      try {
        const data = (await resp.json()) as ServerErrorBody;
        if (data.error?.message) message = data.error.message;
        code = data.error?.code;
      } catch { /* body not JSON */ }
      throw new BridgenodeError(message, resp.status, code);
    }

    // step 2: receipt verification after 200 (error, not silence — Free-Riding
    // protection); spend recorded ONLY after a successful 200 (like the
    // Python SDK); SIWX-granted 200 (no payment, paymentPayload null) —
    // nothing to verify; verify BEFORE recording spend (forged
    // receipt → spend NOT recorded, daily cap intact)
    if (paymentPayload) {
      await this._verifyReceipt(paymentPayload, resp);
      if (paymentAmountUsd !== null) this._recordSpend(paymentAmountUsd);
    }
    // stream → SSE iterator; receipt verified and spend
    // recorded BEFORE the first chunk (billing boundary).
    if (options.stream) {
      return this._iterSse(resp);
    }
    return (await resp.json()) as Record<string, unknown>;
  }

  /**
   * OpenAI SSE iterator — `data:` lines until `[DONE]`.
   * Like the Python SDK `_iter_sse`: keep-alive comments are skipped,
   * partial lines are buffered.
   */
  private async *_iterSse(
    resp: Response,
  ): AsyncGenerator<Record<string, unknown>, void, unknown> {
    const reader = resp.body?.getReader();
    if (!reader) {
      throw new BridgenodeError("Streaming not supported by this runtime");
    }
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const data = trimmed.slice(5).trim();
          if (data === "[DONE]") return;
          try {
            yield JSON.parse(data) as Record<string, unknown>;
          } catch {
            // keep-alive comment or partial line — skip
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }

  // ── Spending policy (step 2, fail-closed) ──────────────────────────────────

  /**
   * Fail-closed — supported accepts entry (exact + Solana mainnet + USDC).
   *
   * The SDK picks the FIRST entry whose scheme/network it supports (exact SVM,
   * Solana mainnet) — it does not check the asset. So we verify here BEFORE
   * signing: the first SDK-supported entry MUST be USDC; otherwise (different
   * mint, different network, or empty accepts) → BridgenodeError — no TX
   * (the SDK automatically selects a supported entry).
   */
  private _selectPaymentRequirement(paymentRequired: {
    accepts?: PaymentRequirementShape[];
  }): PaymentRequirementShape {
    for (const req of paymentRequired.accepts ?? []) {
      if (req.scheme !== "exact") continue;
      if (req.network !== NETWORK) continue;
      if (req.asset !== USDC) {
        throw new BridgenodeError(
          `Unsupported payment asset ${req.asset} — expected USDC ` +
          `(${USDC}); no payment made`);
      }
      return req;
    }
    throw new BridgenodeError(
      "No supported payment requirement (exact + Solana mainnet + USDC) " +
      "— no payment made");
  }

  private _checkSpending(amountUsd: number): void {
    if (amountUsd > this.maxPerCall) {
      throw new BridgenodeError(
        `Spending policy: $${amountUsd.toFixed(4)} exceeds max per call ` +
        `$${this.maxPerCall.toFixed(2)} — blocked (no payment made)`);
    }
    const today = new Date().toISOString().slice(0, 10); // UTC date
    const spent = this.dailySpend[today] ?? 0;
    if (spent + amountUsd > this.dailyCap) {
      throw new BridgenodeError(
        `Spending policy: daily cap $${this.dailyCap.toFixed(2)} exceeded ` +
        `(spent $${spent.toFixed(4)} + $${amountUsd.toFixed(4)}) — blocked (no payment made)`);
    }
  }

  private _recordSpend(amountUsd: number): void {
    const today = new Date().toISOString().slice(0, 10);
    this.dailySpend[today] = (this.dailySpend[today] ?? 0) + amountUsd;
  }

  /**
   * B7 (fix.md): fetch rejects with a raw TypeError on network-level failures
   * (DNS/TCP/reset) and DOMException AbortError on flow-timeout aborts — the
   * agent expects BridgenodeError everywhere (Python SDK maps httpx
   * ConnectError/ReadError/TimeoutException the same way).
   */
  private async _fetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (err) {
      if (err instanceof BridgenodeError) throw err;
      const name = (err as Error)?.name;
      if (name === "AbortError") {
        throw new BridgenodeError("Request timed out");
      }
      throw new BridgenodeError(
        `Connection failed: ${(err as Error)?.message ?? String(err)}`);
    }
  }

  // ── Receipt verification (step 2) ──────────────────────────────────────────

  private async _verifyReceipt(
    paymentPayload: PaymentPayloadShape,
    resp: Response,
  ): Promise<void> {
    const helper = this.httpHelper!;
    const getHeader = (name: string): string | null => resp.headers.get(name);
    let settle: SettleResponseShape;
    try {
      settle = helper.getPaymentSettleResponse(
        getHeader) as unknown as SettleResponseShape;
    } catch (err) {
      throw new BridgenodeError(
        `PAYMENT-RESPONSE receipt missing: ${(err as Error).message}`);
    }

    if (!settle.success) {
      throw new BridgenodeError(
        `Payment failed: ${settle.errorReason ?? "unknown"}`);
    }
    if (settle.network !== NETWORK) {
      throw new BridgenodeError(
        `Receipt network mismatch: ${settle.network} != ${NETWORK}`);
    }
    if (settle.payer !== this.walletAddress) {
      throw new BridgenodeError(
        `Receipt payer mismatch: ${settle.payer} != ${this.walletAddress}`);
    }

    // transaction = fee payer signature over OUR TX message (Free-Riding:
    // the server must prove it settled EXACTLY our TX)
    try {
      const wireBytes = Uint8Array.from(
        Buffer.from(paymentPayload.payload.transaction, "base64"));
      const tx = getTransactionDecoder().decode(wireBytes);
      const feePayer = paymentPayload.accepted.extra.feePayer;
      if (typeof feePayer !== "string" || !feePayer) {
        throw new BridgenodeError("Receipt verification: fee payer missing");
      }
      // verifySignature(CryptoKey, SignatureBytes, message) — positional
      const pubKey = await crypto.subtle.importKey(
        "raw",
        new Uint8Array(getBase58Encoder().encode(feePayer)),
        { name: "Ed25519" },
        /* extractable */ false,
        ["verify"],
      );
      const sigBytes = signatureBytes(new Uint8Array(
        getBase58Encoder().encode(settle.transaction)));
      const ok = await verifySignature(pubKey, sigBytes, tx.messageBytes);
      if (!ok) {
        throw new BridgenodeError(
          "Receipt transaction does not match our TX — possible fraud");
      }
    } catch (err) {
      if (err instanceof BridgenodeError) throw err;
      throw new BridgenodeError(
        `Receipt verification failed: ${(err as Error).message}`);
    }

    const expectedAmount = paymentPayload.accepted.amount;
    if (settle.amount != null && settle.amount !== undefined
        && Number(settle.amount) !== Number(expectedAmount)) {
      throw new BridgenodeError(
        `Receipt amount mismatch: ${settle.amount} != ${expectedAmount}`);
    }

    this.lastReceipt = {
      success: settle.success,
      transaction: settle.transaction,
      network: settle.network,
      payer: settle.payer,
      amount: settle.amount,
    };
  }

  // ── Setup (lazy, async — createKeyPairSignerFromBytes) ─────────────────

  private async _ensureInit(): Promise<void> {
    if (this.x402) return;
    const signer = await createKeyPairSignerFromBytes(this.secretKey);
    (this as { walletAddress: string }).walletAddress = signer.address;
    const scheme = new ExactSvmScheme(signer, this.rpcUrl ? { rpcUrl: this.rpcUrl } : undefined);
    this.x402 = new x402Client().register(NETWORK, scheme);
    // Official practice (docs.x402.org lifecycle-hooks): spending policy
    // enforced IN CODE, next to the payment client — protection remains even
    // if env vars are missing; the hook runs BEFORE payload creation
    this.x402.onBeforePaymentCreation(this._spendingPolicyHook);
    // SIWX client hook: official — automatically signs the
    // CAIP-122 challenge from the 402 extensions["sign-in-with-x"].
    // Cast: @solana/kit KeyPairSigner type is stricter than SIWxSigner
    // (signMessages); runtime-compatible — the official hook calls the signer
    this.httpHelper = new x402HTTPClient(this.x402)
      .onPaymentRequired(
        createSIWxClientHook(signer as unknown as SIWxSigner));
  }
}
