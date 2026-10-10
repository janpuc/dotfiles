---
name: home-assistant
description: Inspect Home Assistant entities and states, or operate devices through approved REST service calls.
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

Calling `POST /api/services/<domain>/<service>` changes the home and asks Jan
on his phone before it runs. First state plainly which device will change and
how. Keep the command specific; never try another route after a denial.
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
