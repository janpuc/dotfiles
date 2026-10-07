---
name: home-ops-verify
description: Review, render and verify changes to Jan's home-ops repository (Talos, Flux, Kubernetes). Use when reading or reviewing a home-ops change or PR, checking whether a merged change reached the cluster, or diagnosing a failed Flux reconciliation.
---

# Verifying home-ops changes

`home-ops` is the public GitOps repo for the home Talos cluster; Flux applies `main` to the live
cluster. Laptop checkout: `~/Development/home-ops`. Tools and env come from its `.mise/config.toml`
(`flate`, `kubectl`, `talosctl`, `kustomize`, `yq`, `KUBECONFIG`, `TALOSCONFIG`, `FLATE_PATH`).

## Boundaries

- **Read-only unless Jan asks for that exact change.** `git pull --ff-only` first; never commit,
  push, reset or discard changes in it unprompted. Pushing to `main` deploys.
- Never mutate the cluster without approval: `kubectl apply/delete/patch/annotate`, `flux
  reconcile/suspend/resume`, `talosctl` upgrades/reboots/resets, and the `just kube …`,
  `just talos …` and `just bootstrap …` recipes. The Personal tool policy asks first; a merge,
  green CI or an alert is not approval.
- **Never print secrets.** `just talos render-config` pipes through `op inject` and prints real
  secrets; `just kube view-secret` and `kubectl get secret -o yaml` print them too. Do not run
  them to "look"; inspect `ExternalSecret` objects and the templates instead.

## Find the names first

An app lives at `kubernetes/apps/<namespace>/<app>/`: the directory is the namespace (LiteLLM is
`ai`, not `litellm`). Its Flux Kustomization is in that app's `ks.yaml` (`metadata.name`); read the
name there instead of guessing.

## Render before claiming correctness

```sh
flate build ks --namespace <ns> --output yaml <ks>   # what Flux would apply for one Kustomization
flate test ks --namespace <ns>                        # Kustomization + HelmRelease validation
flate diff ks --base origin/main                      # changed-only diff against main
```

`flate test` is the validator here; kubeconform is not part of this repo's toolchain. Run commands
from the repo root so mise loads its tools and `FLATE_PATH`.

Check both template layers in the rendered output:

- **Flux post-build substitution is strict** over the whole rendered manifest, comments and
  ConfigMap data included. A literal `${NAME}` that is not a postBuild variable fails the entire
  Kustomization (`variable not set (strict mode)`). Write `$${NAME}` when the runtime needs the
  placeholder; a bare `$NAME` is left alone.
- **bjw-s app-template runs Helm `tpl` over every container env value.** A literal `{{PORT}}`
  breaks rendering; escape it as `{{ "{{PORT}}" }}`.

## Verify it reached the cluster

Report these separately; each needs its own evidence:

1. **Rendered**: `flate` output and validation above.
2. **Merged**: the commit is on `origin/main`.
3. **Reconciled**: `kubectl -n <ns> get kustomization <app>` is `Ready=True` at that revision
   (not `BuildFailed`); `kubectl -n <ns> get helmrelease <app>`; events if not.
4. **Working**: pods ready, logs clean, and the app actually does the thing (hit its endpoint,
   check its behaviour). "Ready" alone is not "working".

## Talos

Intended versions and config are in `talos/` (`cluster.yaml.j2`, `controlplane.yaml.j2`,
`nodes/<role>/<node>.yaml.j2`, `schematic.yaml.j2`); `talos/README.md` explains the layering. Live
state: `talosctl get version`, `kubectl get nodes -o wide`. Compare the two; don't apply.
