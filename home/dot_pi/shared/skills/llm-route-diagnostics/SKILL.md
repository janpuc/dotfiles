---
name: llm-route-diagnostics
description: Diagnose Jan's models and LiteLLM gateway. Use when a model is unavailable or returns empty output, tool calls break, the BC250 local model misbehaves, or a LiteLLM model or fallback is being added or changed.
---

# Model routes and LiteLLM

Two layers; find out which one is involved first.

## 1. Pi

- Pi uses native models only; there is no routing layer. The default is Opus
  (`claude-bridge/claude-opus-5-5`); `/model` picks another explicitly.
- In a session: `/profile`, `/usage` and the `usage_status` tool (pool usage, stale data).
- Subscriptions (Claude via the bridge, ChatGPT, OpenCode Go, MiniMax) are **native Pi
  providers**, not LiteLLM. Only the BC250 models (`litellm/bc250-local/…`, `litellm/bc250/…`)
  go through LiteLLM.
- A Claude usage refresh that keeps failing with "answer without usage windows" means
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` reached the probe; it is not Anthropic load.

## 2. LiteLLM (`https://litellm.janpuc.com`, cluster `litellm.ai.svc:4000`)

Config lives in home-ops (read-only; see the `home-ops-verify` skill):

- One `LiteLLMModel` CR per model: `kubernetes/apps/ai/litellm/app/models/*.yaml`, listed in
  `models/kustomization.yaml`. `spec.modelName` is the ID clients use.
- Fallbacks and retries: `kubernetes/apps/ai/litellm/app/litellmproxy.yaml` (`routerSettings`).

Rules:

- **Never invent a model ID.** Ask the gateway: `GET /v1/models` (with `LITELLM_API_KEY` from the
  environment; never print it). No CR means the model is not wired.
- `bc250-local/qwen3.6-35b-a3b` is local-only and must fail rather than leave the box;
  `bc250/qwen3.6-35b-a3b` falls back to MiniMax M3 when the BC250 is off (it often is: it's a
  gaming machine first). A working answer from `bc250/…` does not prove the BC250 answered.
- Context-window fallbacks fire only on context errors; "Endpoint is unavailable" is not one.

## Testing a route properly

- Use the **wire the consumer uses**: OpenAI chat completions, Responses, or Anthropic
  `/v1/messages` behave differently through LiteLLM (some models work on one wire only).
- A greeting proves nothing. Test a multi-turn tool exchange with **parallel** tool calls and
  returned results.
- MiniMax models reason before answering: below ~2000 output tokens they return empty `content`
  with `finish_reason=stop`. Treat empty content as a failure; check `reasoning_content` and usage.
- Cloudflare in front of `litellm.janpuc.com` rejects default Python-urllib user agents (403,
  error 1010); send an SDK-like `User-Agent` in ad-hoc probes.
- From aether, `*.janpuc.com` internal names resolve through `/etc/hosts` (see the
  `homelab-dns-diagnostics` skill); a name that fails there is a DNS problem, not a model one.
