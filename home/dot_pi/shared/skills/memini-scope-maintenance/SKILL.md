---
name: memini-scope-maintenance
description: Diagnose and maintain Jan's memini memory scoping. Use when recall misses facts it should have, a repo resolves to the wrong or a flat namespace, a pin is needed, or memories must be moved, merged or cleaned up between namespaces.
---

# memini scopes and maintenance

Server: `https://memini.janpuc.com` (`MEMINI_BASE_URL`). API reference:
https://github.com/eleboucher/memini/blob/main/docs/reference/rest-api.md — check it before calling
an endpoint; it changes.

## How a namespace is chosen

- `~/Development/...` → prefix `homelab`, so a repo becomes `homelab/<repo>`.
- `~/Work/...` → prefix `work` → `work/<repo>`. Work never inherits `homelab`.
- Not a repo → `homelab/scratch`.
- A **server-side pin beats derivation** (home-ops, dotfiles and others are pinned).
- `personal/jan` is the read-only home overlay merged into every recall (`MEMINI_HOME`).

The Pi launcher computes this itself from the canonical cwd and git common dir, then checks the
result with the handshake before Pi starts; the fish hook `__memini_namespace_prefix` does it for
shells. Source of truth: `home/dot_local/bin/executable_pi` in the dotfiles.

## Diagnose

1. `pi-profile` in the directory: profile, prefix/namespace it would send, and the handshake result
   (`ok: <ns> (<source>)`, `degraded`, `conflict`).
2. In a session: `memory_briefing` (its scope line shows the read set) and `memory_recall` with
   `scope: everywhere`; read each result's `namespace`/`from` to see where a fact actually lives.
3. "Which namespaces does this search?": `GET /v1/namespaces/readset`. Pins: `GET /v1/pins`.
4. Common causes: a client process without `MEMINI_BASE_URL`/`MEMINI_HOME`/`MEMINI_API_KEY` in its
   environment (T3 and GUI apps don't inherit the shell); a stale client that resolved its
   namespace before a change (restart it); a new repo outside `~/Development` with no pin.

## Change (each step needs Jan's go-ahead)

- **Pin a repo**: `PUT /v1/pins`. Prefer a pin over environment tricks.
- **Move a whole namespace**: `POST /v1/namespaces/move` with `dry_run: true` first, review, then apply.
- **Move individual memories** (no per-memory move API): tag each with
  `{"metadata":{"sort_target":"<dest>"}}` via `memory_update`, preview
  `POST /v1/namespaces/split` `{"by":["sort_target"],"dry_run":true}`, apply with `dry_run:false`,
  then clear the tag with `{"metadata":{"sort_target":null}}`. Untagged memories stay put.
- **Fix a fact**: `memory_update` (keeps history) rather than forget + re-remember. Copy the
  `namespace` exactly from the recall result when addressing inherited memories.
- After maintenance, recall again: background promotion can bring a deleted memory back.

## Never

- Store secrets, credentials or Work content in `homelab`/`personal`; Work facts go to `work/*`.
- Call the REST API with keys pasted into the conversation; the key is `MEMINI_API_KEY` from the
  ai-sync cache, used via env, never printed.
