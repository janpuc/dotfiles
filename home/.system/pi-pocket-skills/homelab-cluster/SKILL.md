---
name: homelab-cluster
description: Investigate Talos and Flux homelab workloads, failing deployments and firing alerts; propose GitOps changes in janpuc/home-ops.
---

# Homelab cluster

The Talos cluster is managed by Flux from `janpuc/home-ops` on GitHub.
Apps live under `kubernetes/apps/<namespace>/<app>`; inspect Flux Kustomizations
and HelmReleases as well as pods. Ingress uses Gateway API (Gateways and
HTTPRoutes). External Secrets reads credentials from 1Password.

`KUBECONFIG` is already set. Access has the read-only `view` role, without
Secrets. Do not request or print secrets, or try to acquire broader access.
Use `kubectl get`, `describe`, `logs`, events and `flux get` for investigation:

```sh
flux get all -A
kubectl get kustomizations,helmreleases -A
kubectl get pods -A
kubectl -n <namespace> describe pod <pod>
kubectl -n <namespace> logs <pod> -c <container> --tail=100
kubectl -n <namespace> get events --sort-by=.metadata.creationTimestamp
kubectl get gateways,httproutes -A
kubectl get externalsecrets -A
```

## Firing alert triage

The `view` role cannot exec into pods; use the internal HTTP endpoints instead.

1. Firing alerts: `curl -s https://alertmanager.janpuc.com/api/v2/alerts?active=true | jq '.[] | {alertname: .labels.alertname, severity: .labels.severity, namespace: .labels.namespace, summary: .annotations.summary, startsAt}'`.
   Note each alert's labels, namespace, workload and start time; never silence one.
2. Inspect that workload's events, pod description and recent logs. Check its
   HelmRelease and Kustomization conditions and `flux get all -A`.
3. Metrics: `curl -s 'https://prometheus.janpuc.com/api/v1/query' --data-urlencode 'query=<PromQL>' -G | jq`
   (keep `-G`: it makes this a GET). Use the alert's own expression for a specific query.
4. Explain the evidence, likely cause and smallest fix; distinguish facts from guesses.

## Changes

Never use `kubectl apply` or other direct cluster mutations for a fix.
Changes are commits or PRs to `janpuc/home-ops`; read the relevant app manifests
and repository instructions first. Local edits and commits do not deploy.
Publish feature branches with `agent-push`, which does not ask Jan; open a PR
with the recommendation and deployment impact. Use pr-shepherd for eligible
home-ops A/B broker merges; leave C for Jan. Never work around a denial.

## Asking Jan and memory

Use `ask_jan` ONLY for:
- choosing a time for cluster or node maintenance (Talos/Kubernetes upgrades, reboots);
- a Home Assistant restart;
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
