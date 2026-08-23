/**
 * index.ts — @bridgenode/llm public exports.
 *
 * @module
 */

export {
  BRIDGENODE_BASE_URL,
  NETWORK,
  INITIAL_TIMEOUT_MS,
  RETRY_TIMEOUT_MS,
  BridgenodeError,
  LLMClient,
} from "./client.js";

export type { ChatOptions, LLMClientOptions } from "./client.js";
