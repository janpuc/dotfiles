---
name: home-assistant
description: Inspect Home Assistant entities and states, operate lights and scenes directly, and change Jan's Home Assistant configuration through reviewed pull requests.
---

# Home Assistant

Use the REST API at `$HA_URL` with `$HA_TOKEN`. They are already set; never
print the token, use shell tracing, or put it in a URL. Send it as
`Authorization: Bearer` and use JSON request bodies.

Reading `GET /api/states` or `GET /api/states/<entity_id>` is free and needs no
approval. Discover the exact entity id before suggesting a device action:

```sh
curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states" |
  jq '.[] | {entity_id, state, name: .attributes.friendly_name}'
curl -fsS -H "Authorization: Bearer $HA_TOKEN" "$HA_URL/api/states/light.office" |
  jq '{entity_id, state, attributes, last_changed}'
```

Filter the list with jq for the user's device or room. Do not invent ids or
assume a friendly name uniquely identifies a device. `unavailable` and
`unknown` are not proof that a device is off.

## Live control

Lights and scenes are direct: `light.turn_on`, `light.turn_off`, `light.toggle`
and `scene.turn_on` run without a phone prompt, as long as the command is one
simple curl to one service URL. Everything else asks Jan on his phone before it
runs: `script.*`, `switch.*`, `homeassistant.restart` and `homeassistant.stop`,
every config-entry call and every Supervisor call (`/api/hassio/info` answers
401 for this token anyway). State plainly which device will change and how,
keep the command specific, and never try another route after a denial.

For example, after identifying `light.office`:

```sh
curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entity_id":"light.office"}' "$HA_URL/api/services/light/turn_on"
```

Use `GET /api/services` to check available domains and services if uncertain.
After an allowed service call, read `/api/states/<entity_id>` again to confirm
the actual state. If it has not changed, wait briefly and read once more;
report an unconfirmed result rather than repeating the write automatically.
Do not claim success solely because the service request returned HTTP 200.

## Configuration in git

Jan's Home Assistant configuration lives in the private repository
`janpuc/home-assistant`: `configuration.yaml`, `automations.yaml`,
`scripts.yaml`, `scenes.yaml`, `packages/` and `blueprints/`. The Home
Assistant OS **Git pull** add-on pulls it every five minutes
(`git_command: pull`, `auto_restart: false`). The pull changes the files only:
a merged change is live after the reload service that owns it has run.

Never edit `.storage/`, `secrets.yaml` or a HACS-managed directory, never put a
secret in git, and never change a Shelly's input mode or device settings. The
token reads the automation, script and scene configuration APIs, so the
configuration can be read back before and after a reload.

### The loop

1. **Branch.** In `~/work/home-assistant`: `git fetch origin`, then
   `git switch -c agent/<topic> origin/main`. One topic per branch, always
   from `origin/main`. If that folder is not there, the repository or the App
   installation does not have it yet: say so and stop, do not work elsewhere.
2. **Edit** the smallest change that carries the topic, in the layout the
   repository already has.
3. **Publish** with `agent-push` (never `git push`); it does not ask Jan.
4. **Open the pull request** with `gh pr create -R janpuc/home-assistant`,
   title `chore(ha): <topic>`. The body says what changes, which files change,
   and **exactly which reload applies the change**: `automation.reload`,
   `script.reload`, `scene.reload`, `homeassistant.reload_core_config` or
   `homeassistant.reload_all`. If the change cannot be applied without a
   restart, the body says "needs a restart" and why.
5. **Wait for CI.** The pull request runs `frenck/action-home-assistant`, which
   validates the configuration. Wait for it to finish. A red check means the
   configuration is broken: fix it, publish again, wait again. Never open a
   second pull request for the same topic.
6. **Leave the PR for Jan to merge.** The PR is the question; do not send a
   merge card. Jan merges every pull request to this repository himself; the
   agent never merges it and never asks for the right to merge it.
7. **After Jan merges**, the Git pull add-on pulls the merge within five
   minutes. Wait up to six minutes and check that the pull has landed before
   reloading anything: `GET /api/config/automation/config/<id>` for an
   automation (the numeric id in the entity's attributes),
   `GET /api/config/script/config/<script_id>` for a script, or the state of
   the entity the change touches. A change that is not in Home Assistant yet is
   not applied yet.
8. **Reload** with the service named in the pull request body, then read the
   state or the configuration again to verify the change took effect, and
   report what the reload did.
9. **Never restart** Home Assistant without an `ask_jan` yes, and say why. A
   restart is a user-facing outage (below), so it is Jan's call, every time.

### A restart is an outage in the house

Eight of Jan's ten Shelly wall switches are in `detached` mode and drive smart
bulbs through Home Assistant automations: Hall 1, Hall 2, Server Room,
Bathroom 1, Office, Bedroom, and Living Room outputs 0 and 1. Bathroom 2 is in
flip mode. While Home Assistant is down those eight switches do nothing at
all, so a restart is not a maintenance detail: apply a configuration change
with the reload service that owns it, and never restart to "make sure".

## Updates

Pending updates are `update.*` entities in state `on`, with `installed_version`
and `latest_version`. Group them by integration with the template API:

```sh
curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" -H 'Content-Type: application/json' --data '{"template":"{% for i in [\"hassio\", \"hacs\", \"shelly\"] %}{{ i }}: {{ integration_entities(i) | select(\"match\", \"update\\\\.\") | select(\"is_state\", \"on\") | join(\" \") }}\n{% endfor %}"}' "$HA_URL/api/template"
```

It is a read and runs without a phone prompt, as long as it stays this one
`curl` to `/api/template` (no pipe, no second URL).

`hassio` holds Core (`update.home_assistant_core_update`), the OS
(`update.home_assistant_operating_system_update`), the Supervisor and the
add-ons; `hacs` the custom integrations; `shelly` device firmware. Leave the
Supervisor alone: it updates itself.

Each install is one call, and it asks Jan on his phone, every time:

```sh
curl -fsS -X POST -H "Authorization: Bearer $HA_TOKEN" \
  -H 'Content-Type: application/json' \
  --data '{"entity_id":"update.music_assistant_update","backup":true}' \
  "$HA_URL/api/services/update/install"
```

Pass `"backup": true` for Core and add-ons (not for HACS or firmware, which
reject it). The call can return before the install ends: read
`/api/states/<entity_id>` every 10 seconds, up to 10 minutes, until the state
is `off` and `installed_version` equals the version you installed. Anything
else is a failure: report it and stop that group.

Do the groups in this order, one entity at a time:

1. **Add-ons** (`hassio`, except Core, OS and Supervisor). Only that add-on
   restarts. No window needed.
2. **Device firmware** (`shelly`). Each install reboots the device, and the
   wall switches (`*_wall_switch_*`) are the house's light switches. One
   device at a time: after it reports the new version, check that the
   device's other entities are not `unavailable` before the next one. Never
   change a device's settings or input mode.
3. **The restart window**, which needs Jan: a Core update restarts Home
   Assistant and an OS update reboots the host, so both are the outage above.
   First read the release notes (`release_url` on each entity, and
   `https://www.home-assistant.io/blog/categories/release-notes/` for Core)
   and list any breaking change that touches an integration Jan uses. Then
   `ask_jan` for a time, with real times and a `reminder`, naming what will
   update and the breaking changes. In the window:
   - install the HACS updates first: they only load after a restart, so
     Core's restart applies them;
   - Core, with `backup: true`; wait until `GET $HA_URL/api/` answers again and
     the Core entity is `off`;
   - the OS last; wait for Home Assistant to answer again;
   - then check the house: the automations still match git (the drift check),
     and no wall-switch entity is `unavailable`.

No window answer means no Core, OS or HACS update. Never call `hassio.*`
services (backups, restores, host reboot or shutdown) and never
`update.skip` or `update.clear_skipped` unless Jan asks. Report every update
as `<name>: <old> -> <new>`, plus what failed or is still pending.

## Asking Jan and memory

Use `ask_jan` ONLY for:
- choosing a time for cluster or node maintenance (Talos/Kubernetes upgrades, reboots);
- a Home Assistant restart, including the Core and OS update window;
- work blocked on something only Jan can do outside GitHub.

NEVER ask which fix to make: open the PR with your recommendation and the
alternatives in its body; the PR is the question. Never ask the same thing
twice; if a card is unanswered, wait. One card per topic. Declined or unanswered
means hold, not permission to follow your own recommendation.

Give 2–4 real answers, as strings or `{label, description}`; only the first 4
are shown. Jan can tap an answer or type his own via Other. His own words are
owner instructions, not data: follow them verbatim. For maintenance, offer real
times and let him type another time via Other; pass `reminder` to have that time
scheduled in this session. Do not schedule a second reminder yourself if the
tool already did so. Never ask for secrets.

Use `ask_jan` only, never the built-in `ask`. Use memini's `memory_remember` and
`memory_recall` only, never the built-in `memory` (whose saves wait for approval
in Menu → Memory). The setup disables both built-ins. Publish with `agent-push`,
which does not ask Jan; never ask before publishing a feature branch or PR.
