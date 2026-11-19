# Work wipe

A wipe needs Jan's separate yes and a reviewed dry run on both hermes and sisyphus.
It is not agent archive or task close. Stop Work sessions, the sisyphus backup and
its watchdog first. Keep them stopped throughout the wipe. Never wipe during migration
or before a retention decision. A backup is sensitive Work data too, not an exception.

Run work-wipe or work-wipe --dry-run to print every local path. Review the output,
then work-wipe --really deletes that inventory. No default invocation deletes data.
A symlink ancestor fails closed, a symlink leaf is unlinked without traversal.
Pi session headers must confirm Work cwd, since encoded folder names are ambiguous.
Unverifiable session candidates are retained with a warning and need Jan's review.

On both hosts the inventory is ~/Work, Work Pi sessions, agent-history/work,
~/.aws, ~/.granted, ~/.saml2aws, ~/.aws-sso, ~/.local/state/ai/projects/work.env and
other registry project env files referencing op://Work, and sisyphus-work.env if
present. Under ~/.kube it deletes everything except config and cache, including
clusters, inventory.json, role-preferences.json, frecency.json and legacy direct
work kubeconfig files. ~/.kube/config is the personal homelab config and is retained.

Sisyphus also deletes ~/.local/state/agents, ~/.local/state/sisyphus-backup,
~/.cache/restic, ~/.config/sisyphus-backup, ~/.config/restic/sisyphus.password,
~/.ssh/sisyphus-backup and its public key, and ~/.ssh/work-inbox and its public key.
The backup enabled marker lives in the deleted config directory. The Work service
account token is ~/.config/op/sisyphus-work.env, never managed or backed up.

Never list or delete ~/Development, ~/.talos, personal Pi sessions, the shared AI
credential cache or the Kubernetes service account token. The dotfiles source is
on GitHub and outside the work backup and wipe. Managed scripts and launch plists
remain, but the missing backup marker makes future runs exit disabled.

Host deletion is only one part. Complete and verify these off-host steps with Jan:

1. Delete memini work and its old work/* namespaces using the admin key. Work's own
   key is not an admin key. Verify recall returns no work entries and no inherited
   personal namespace is configured. Remove the sisyphus key through kubernetes.
2. Ask bigmouth and Jan to destroy Vault/Backups/sisyphus with
   zfs destroy Vault/Backups/sisyphus after reviewing snapshots, clones and retention.
   Confirm all snapshots and replicas containing Work are addressed, not just the
   live restic repo. Verify the dataset is absent and restic cannot open the repo.
3. Delete the Work vault service account and review the Work vault with Jan. Revoke
   or rotate Work GitHub, cloud and cluster credentials as required. Confirm the
   deleted account cannot authenticate and retained items match the retention choice.

Also remove the restricted work inbox authorized_keys line from aether and its
remote-inbox/work queue after Jan reviews any pending replies. The public key is
managed in dotfiles workInbox.publicKey. Remove the agents-work-inbox line on aether
in a separately reviewed edit while preserving operator keys, then clear the configured
public key. Empty or invalid public keys leave existing authorized_keys untouched.

Verify the printed local paths are absent, Work session folders are gone and the
preserved personal paths remain. Repeat the dry run for newly discovered Work
artifacts. Record local and off-host verification without storing credentials.
