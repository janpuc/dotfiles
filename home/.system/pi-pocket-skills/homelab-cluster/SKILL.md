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
Pushing and merging ask Jan on his phone: explain the exact change and expected
impact before running the command, and never work around a denial.
