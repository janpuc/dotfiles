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
6. **Ask Jan to merge** with the `ask_jan` tool, giving him the pull request
   link. Jan merges every pull request to this repository himself; the agent
   never merges it and never asks for the right to merge it.
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
