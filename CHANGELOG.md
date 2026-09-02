# Changelog

## [1.1.0](https://github.com/bridgenode-ai/bridgenode-llm/compare/llm-v1.0.6...llm-v1.1.0) (2026-09-01)


### Features

* **sdk-ts:** retry 503/429 with backoff + Retry-After before payment (fix.md 4.1) ([e205121](https://github.com/bridgenode-ai/bridgenode-llm/commit/e20512110b58051c865102fc519aae8bbbba0a66))


### Bug Fixes

* **sdk-ts:** don't cut long SSE streams with the flow timeout (B3) ([3b21837](https://github.com/bridgenode-ai/bridgenode-llm/commit/3b21837abaadb121f61fcec5614b45e4300cdf11))
* **sdk-ts:** fail-closed malformed 402 amount validation (B2) ([a52dc6e](https://github.com/bridgenode-ai/bridgenode-llm/commit/a52dc6ef6f1e5959dce1f7cd0f0664b50a4cdd53))
* **sdk-ts:** SIWX hook failure falls back to payment (B4) ([4a4bd61](https://github.com/bridgenode-ai/bridgenode-llm/commit/4a4bd61ef41bb8b5e0b15431af1c43b9fa7cd14c))
* **sdk:** map network read errors to BridgenodeError (B7) ([da3e028](https://github.com/bridgenode-ai/bridgenode-llm/commit/da3e028a86d0d0995977bc3838f4d3bb66c67fef))

## [1.0.6](https://github.com/bridgenode-ai/bridgenode-llm/compare/llm-v1.0.5...llm-v1.0.6) (2026-08-31)


### Bug Fixes

* **npm:** esbuild override ^0.28.1 — close GHSA (low, dev dep) ([b210e18](https://github.com/bridgenode-ai/bridgenode-llm/commit/b210e18845d827c00dc7645504a0af2136a5bf09))
