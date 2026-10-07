---
name: homelab-dns-diagnostics
description: Trace why an internal *.janpuc.com name does not resolve or resolves wrong, across the UniFi gateway, Tailscale, the cluster's Gateway API and aether's /etc/hosts sync. Use when a homelab service works by IP but not by name, or a new internal hostname does not appear.
---

# Internal DNS

## How names are served

- **Public names** (external gateway, `envoy-external`): Cloudflare, via the `cloudflare-dns`
  external-dns instance in home-ops. Resolve from anywhere.
- **Internal names** (`envoy-internal`): the `unifi-dns` external-dns instance writes records to
  the UniFi gateway (`unifi.internal`), as CNAMEs to `internal.janpuc.com`, the internal gateway's
  load-balancer address. LAN clients resolve them through UniFi.
- **The tailnet cannot ask UniFi**: UniFi does not answer DNS queries that arrive through the
  Tailscale subnet router (TCP connects and closes, UDP times out). So tailnet-only machines
  don't get internal names from DNS.
- **aether** works around that: `aether-hosts-sync` (hourly systemd timer) derives the internal
  names from home-ops on GitHub and writes them into a managed block in `/etc/hosts`.
  Source in the dotfiles: `home/.system/aether-hosts-sync` (+ `.service`, `.timer`).

## Diagnose

1. Which kind of name is it? Find its route in home-ops: `parentRefs` → `envoy-internal` or
   `envoy-external`, and its `hostnames`. Services can also carry the external-dns hostname
   annotation with an `lbipam.cilium.io/ips` address.
2. Compare resolvers:
   - DNS: `dig +short <name>`; against UniFi directly from the LAN: `dig @<gateway> <name>`
     (and `+tcp`).
   - What the OS uses: `getent hosts <name>` on Linux, `dscacheutil -q host -a name <name>` on macOS.
3. On aether:
   - `grep -A3 'BEGIN aether-hosts-sync' /etc/hosts` — the `# source:` line names the home-ops
     commit the block came from.
   - `systemctl status aether-hosts-sync.timer` and `journalctl -u aether-hosts-sync -n 20`.
     "mirror update failed … using cached" means it served stale data.
   - A name missing from the block: check the annotations the script reads
     (`external-dns.kubernetes.io/…` and the legacy `external-dns.alpha.kubernetes.io/…`) and the
     internal gateway's `parentRefs`.
4. Test parser changes against a scratch copy, never the live file:
   `HOSTS_FILE=/tmp/hosts.test HOME_OPS_MIRROR=/tmp/mirror.git /usr/bin/python3 home/.system/aether-hosts-sync`
   (`/usr/bin/python3` matches the service's PyYAML).

## Don't

- Change UniFi DNS settings, Tailscale split DNS or the cluster's external-dns config without
  Jan; they affect every device.
- Put public names into `/etc/hosts`; they resolve publicly and pinning them hides real outages.
