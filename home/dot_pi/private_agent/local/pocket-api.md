# Pi Pocket v0.11.0 HTTP map

Source inspected: `TannerMidd/pi-pocket`, tag `v0.11.0`, commit
`f93f2e4c772ff9fc8e615f167ea8390ad59ae948`. Inspected a shallow clone in a new `/tmp` directory, then deleted it. No request was made to aether or the real Pocket.

## Authentication and common responses

Every `/api` request requires a signed-in user: `Authorization: Bearer <user token>` works when no nonempty `pocket_auth` cookie is present. Every non-GET `/api` request also requires **`X-Pocket: 1`**, even with bearer authentication. Send JSON with `Content-Type: application/json`. Successes below are HTTP 200; HTTP errors are `{ "error": "readable message" }` (e.g. 401 unauthenticated, 403 disallowed, 400 invalid input, 404 missing resource).

Owners and unscoped guests can start/steer sessions; viewers cannot. A guest invited to just one session cannot create a session or use the folder picker. Steering/configuration can also be subject to conversation turn/driver permissions. Source: `src/server/auth.ts`, `http/api.ts`, `commands.ts`, `http.ts`.

## Folders and models

- **GET `/api/fs?path=<URL-encoded folder>&hidden=1`**: no body. `path` defaults to `~`; `hidden=1` is optional. Response:
  ```json
  { "path": "/home/jan/work", "parent": "/home/jan", "home": "/home/jan", "dirs": [{ "name": "home-ops", "path": "/home/jan/work/home-ops" }], "recent": ["/home/jan/scratch"] }
  ```
  Directories are sorted; at most 1000 per response, recent folders at most 8. Requires steering and all-session access. The folder must exist; this is not a catalog restricted to particular sessions. Pocket expands `~` and `~/…` **on its own host**, then resolves the path. Pass `~/work/home-ops` directly as `cwd`, not the laptop's expanded path. Source: `http/api.ts`, `workspace.ts`, `paths.ts`.
- **GET `/api/me`**: no body. Response `{ user, users, models, guard, server }`. `user` is `{ id, name, role, sessions?: number[] }`; `models` is an array of:
  ```json
  { "provider": "anthropic", "id": "claude-sonnet-5-5", "name": "Sonnet", "contextWindow": 200000, "reasoning": true, "images": true, "levels": ["off", "low", "medium", "high"] }
  ```
  Example capabilities above are illustrative, not verified for that model. These are available models with configured provider sign-in. `server` includes `home`, `defaultCwd`, `extensions`, `approvalRule` and other web-app capabilities. A conversation's `view.agent` gives its chosen `model: {provider, modelId} | null`, `thinkingLevel`, `cwd`, `available` and model capabilities (`levels`, etc.). No separate `/api/models` route. Source: `app.ts:hello`, `models.ts`.

## Create, configure, and submit

1. **POST `/api/sessions`** with `{ "cwd": "~/scratch", "title"?: "label", "worktree"?: true }` → `{ "id": 42 }`.
   It creates a conversation with Pocket's default/last-selected model. **Creation does not accept model or thinking**; those require the next call. `cwd` defaults to Pocket's default directory. The extension does not request a worktree or make folders.
2. **POST `/api/c/42/configure`** with:
   ```json
   { "model": { "provider": "anthropic", "modelId": "claude-sonnet-5-5" }, "thinkingLevel": "high" }
   ```
   → `{ "ok": true }`. All fields are optional; `cwd` is also accepted. `provider/id` must be split at the **first** slash, since model ids can contain slashes. Accepted thinking strings: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Pocket checks model existence and clamps thinking to that model's supported level. Omitting thinking retains the current level (also clamped for the new model).
3. **POST `/api/c/42/submit`** with:
   ```json
   { "text": "Do the task", "requestId": "a-client-generated-unique-id", "mode": "steer" }
   ```
   → `{ "submissionId": 99 }` immediately, **not** an answer. `text` and `requestId` are required strings. Optional `mode` is `steer` or `followUp`; omitted/non-steer queues a follow-up while busy. `steer` joins after the current tool round. The same route sends first and later messages. `attachments` (server-stored upload records) and `inlineFiles` are additional optional fields, unused by this extension. Pocket scopes request ids to the authenticated user to avoid duplicate submissions on retries.

Source: `http/api.ts`, `http/conversation-routes.ts`, `commands.ts`.

The browser opens a session at **`<base>/s/42`**, not `/c/42` or a token-bearing login link (`web/store.js:navigate`). Its browser must already be signed in or sign in separately.

## State and messages

There is no JSON `GET /api/c/:id` snapshot or durable top-level `failed` status route.

- **GET `/api/sessions`** → array of session metadata, including `{ id, cwd, title?, createdAt, updatedAt, createdBy?, busy, waiting, endedAt?, model?, ... }`. `waiting` includes approvals in subagents under the session. `busy` here describes the root conversation. Source: `app.ts:sessions`.
- **GET `/api/poll?c=42`** (no body, new poller) →
  ```json
  { "session": "poller-uuid", "events": [{ "seq": 1, "event": "hello", "data": {} }, { "seq": 2, "event": "sessions", "data": [] }, { "seq": 3, "event": "view", "data": {} }] }
  ```
  The `hello` event is `/api/me` data plus `connection`. The `sessions` event is the session array. Initial `view` has `full: true`, `conversation`, `entries`, `order: number[]`, `live`, `inbox`, `agent`, `approvals`, `subagents`, and collaboration fields. `order` defines transcript order. `live.busy` indicates work; `live.generation` can include streaming `message.blocks` and `retry: {at, error}`. Subagents carry `{ name, conversationId, busy }`. A nonexistent/inaccessible conversation yields a `missing` event with `{conversationId, message}`, potentially in an HTTP 200 response.
  Subsequent **GET `/api/poll?session=<poller>&ack=<last seq>`** returns events after the ack (up to a 25-second long poll); changes may be partial views. **GET `/api/poll?session=<poller>&close=1`** → `{ "ok": true }`, detaches the tab. The extension uses a fresh full poll per check and closes it in `finally`. Otherwise pollers expire after 60 seconds without polling. Source: `http/events.ts`, `app.ts:attach`, `room.ts:push`.
- **GET `/api/events?c=42`** offers the same events as SSE (`event: view`, JSON `data:`), with initial hello/sessions/full view. Not used by this extension.
- **GET `/api/c/42/history?before=<entry id>`** → oldest-first array of projected entries before that id; `before` defaults to `Number.MAX_SAFE_INTEGER`. Returns up to 400 recent visible entries, including history outside the active context. **GET `/api/c/42/entry/<entry id>`** → one full projected entry, 404 if absent. **GET `/api/c/42/export`** → the whole transcript as Markdown, with attachment filename. Source: `http/conversation-routes.ts`, `transcripts.ts`.

Projected assistant entries look like:
```json
{ "id": 123, "kind": "assistant", "blocks": [{ "type": "text", "text": "The answer" }, { "type": "thinking", "text": "…" }, { "type": "toolCall", "id": "call", "name": "bash", "args": {} }], "stopReason": "stop", "error": "optional provider error", "model": "model-id", "provider": "provider" }
```
Other kinds include `user` (`text`), `toolResult` (`text`, `isError`, `name`), and reset/compaction records. Source: `projection.ts`.

`pocket_check` derives state in this order: pending approval → `waiting for approval`; root or subagent busy → `working`; newest assistant has `error` or `stopReason: "error"` → `failed`; otherwise `idle`. This is a summary, **not a guaranteed durable job outcome**. An aborted/stopped or reset session may be idle without a successful answer. It returns the latest assistant entry with nonempty **text** blocks (no thinking/tool output), redacted then trimmed to 4000 characters; while busy that can be an earlier answer, not final results. If the active context has no assistant text, it checks recent history. It does not scan arbitrarily old pages or expose transient past `notice` errors: a failure without a persisted assistant error cannot reliably be classified retrospectively.

## Approvals

`view.approvals` contains pending requests for that exact conversation:
`{ id, conversationId, taskId, callId?, tool, subject, reason, score?, createdAt, requestedBy? }`.
`pocket_check` returns their id/tool/subject/reason; it never approves. Root `sessions[].waiting` also detects subagent approvals; when only a subagent is waiting, the tool directs Jan to the phone for details. Root `peek` events aggregate subagent approvals and **GET `/api/running`** reports `{id, title, busy, approvals: number, tasks: [...]}` for live sessions, but these additional surfaces are not used by the extension.

The web app approves/denies via **POST `/api/approvals/<approval id>`**, `{ "allow": true/false }` → `{ "ok": true }`, or 404 if no longer pending. Authentication, role/scope and approval-rule checks apply. Risk gating depends on Pocket's enabled `pocket-guard` extension and configured Lancet Guard; only `ask` verdicts wait for a human, `block` verdicts fail and `allow` proceeds. Approval policy (`anyone` / `others`) does not guarantee Jan is the sole approver. **The installed server's guard, policy and phone notifications were not verified.** The start message explicitly notes the guard prerequisite. Source: `host.ts`, `http/api.ts`, `app.ts:answerApproval`, `extensions/guard.ts`.

## Owner invites and guest tokens

1. As owner, **POST `/api/invite`** (bearer + `X-Pocket: 1`) with `{ "role": "guest", "minutes": 15 }`; optionally `"session": "42"` to limit access. Valid minutes are `15`, `60`, `1440`, `10080`; default 15. Response:
   ```json
   { "code": "invite-code", "expiresAt": 1234567890000, "minutes": 15, "grant": { "role": "guest" }, "url": "https://host/join/invite-code", "svg": "<svg>…</svg>", "alternatives": [], "local": false }
   ```
   `access` may additionally describe a launcher tunnel. Session-scoped grants include `session: "42"`. Guest is the default role; viewer and owner are also accepted. Owner invites always last 15 minutes and cannot be single-session. Unscoped guests may also invite guest/viewer users; only owners may issue owner invites. Viewers and session-scoped users cannot invite.
2. **GET `/join/<code>`** (outside `/api`, unauthenticated) → HTTP 200 HTML showing the grant and name form, or HTTP 410 HTML for an expired/used invite.
3. **POST `/join/<code>`**, `Content-Type: application/x-www-form-urlencoded`, body `name=Laptop+Pi` (not JSON). No bearer or `X-Pocket` required; cross-site browser submissions are rejected according to `Sec-Fetch-Site` (allowed `same-origin`, `none`, or absent). Success is **HTTP 303**, `Location: /`, and:
   ```text
   Set-Cookie: pocket_auth=<new user token>; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000; Secure
   ```
   `Secure` is present for HTTPS. Invalid/expired/used redemption is HTTP 410 HTML. To provision a non-browser bearer client, prevent automatic redirect, privately capture/decode the `pocket_auth` cookie value and store it as the user token; **there is no token JSON response**. Never log the cookie or token.

Redemption consumes the single-use invite and creates a named guest with a fresh UUID and random 24-byte base64url token. Only its SHA-256 token hash is stored in config. The name is whitespace-normalized, trimmed, capped at 40 characters, or defaults to `Guest`. Optional session restriction is stored on the user. The creator must still have invite rights. Owner redemption instead supplies the existing owner's token without creating a new user. **GET `/api/me`** with the redeemed token verifies the name/role. **POST `/api/me`** with `{ "name": "Laptop Pi" }` renames the user → `{ "ok": true }`. **POST `/api/invite/cancel`**, `{ "code": "invite-code" }` → `{ "ok": true }`, only cancels the caller's own invite. Source: `http/api.ts`, `http/sign-in.ts`, `auth.ts`, `config.ts`.

## Local validation and rollout boundary

`node --test home/dot_pi/private_agent/local/pocket.test.ts` uses installed Pi's `jiti` loader and real `@earendil-works/pi-ai` TypeBox export, a fake `registerTool`, and an ephemeral loopback HTTP server. Pi must be on PATH; the harness handles the Homebrew wrapper. No dependencies are installed and loader disk caching is disabled. Tests cover start ordering/model/thinking, all requested states, latest answer clipping/redaction, history fallback, steering, unique request ids, missing configuration, readable HTTP and malformed JSON errors, partial starts, poll cleanup, and a real 15-second request timeout. Every tool result is checked for token leakage.

This is an extension artifact only: settings were not edited, no ai-sync implementation/token provisioning was added, and nothing was applied, deployed or pushed. Real folders, default model availability, authentication, invitations, durable execution, guard behavior and phone access remain source-mapped but live-unverified. Starting a session is not atomic: a configure/submit failure can leave an empty or already-submitted session; the error returns its id/link and instructs checking before retrying. A poll-close failure is best-effort; server expiry cleans it up. Add `./local/pocket.ts` to laptop Pi's extension/package settings and supply the environment through the approved sync path only as a separately authorized rollout.
