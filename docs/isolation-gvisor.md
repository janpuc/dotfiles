# Per-workspace isolation with gVisor (deferred design)

Status: not built. On 2026-11-18 Jan chose no isolation layer (option C: all project agents run
as `ubuntu`, guarded only by agent-guard-ask) and asked to keep this design for a later switch.

Options weighed that day:

- A. This design: one gVisor `runsc` sandbox per workspace with its own Rex server, Pi, memini
  store and credentials. Protects against a deliberately malicious agent.
- B. A Unix user per project with systemd sandboxing and no docker group. Protects against
  accidental cross-project access and host damage. memini, Claude and GitHub stay shared.
- C. One user, as today. Chosen.

Facts measured on aether that constrain any future choice: no `/dev/kvm` (aether is an Oracle
KVM guest, no nested virtualization, so Firecracker, Kata and Cloud Hypervisor are out),
`kernel.apparmor_restrict_unprivileged_userns=1` (bubblewrap and rootless Podman fail without an
AppArmor profile), and membership of the `docker` group is root-equivalent. memini keys are
identity, not isolation: any valid key reads every namespace.

The design below is the advisor's (Astra, 2026-11-18), kept as written. It assumes the platform
architecture in docs/projects.md.

---

## Inherited decisions

Keep the earlier design’s local Git workspaces, submodules, central standards, project-owned knowledge, generation rotation, pinned tools and encrypted BigMouth backups.

Keep Rex and the existing models. Agents may edit, test and commit locally. Publishing and shared-system changes still require Jan’s approval.

Requirement 7 supersedes three assumptions from that design:

- Projects cannot share `ubuntu`’s execution environment.
- Shared memini credentials and namespace selection are not sufficient.
- Preserving the existing host Rex session is less important than placing every project process inside the boundary.

This was read-only. No files or remote configuration were changed.

## Diagnosis

Two findings materially change the design.

**First, gVisor is a credible fit for this machine.** I confirmed aether is ARM64, running under KVM without `/dev/kvm`, with the AppArmor user-namespace restriction enabled. Docker currently has only runc runtimes. gVisor documents ARM64 support and its no-KVM `systrap` platform. It is not installed or compatibility-tested on aether yet. [1]

**Second, memini keys do not provide namespace isolation.** Its upstream documentation explicitly says:

> Any valid key […] can read any namespace.

Named keys, `home` bindings and `default_namespace` are identity and routing features, not access controls. Separate keys on the existing shared instance would therefore fail requirement 7. This is documented upstream behavior, not a verified audit of the deployed server revision. [2]

The existing files also establish the current escape paths:

- `executable_agent-run` launches all agents as the current user and inherits its environment.
- `ai-sync.fish.tmpl` distributes the shared memini key, Claude token and model keys.
- `rex-accounts.jsonc` grants Jan access to host `ubuntu`.
- `rex-inspector.ts` and the runner use Rex client remote control.
- `docs/projects.md` correctly acknowledges that Docker membership is root-equivalent and the approval guard is not a sandbox.

## Drift / contradiction check

The following are explicitly retired:

1. **“Sandbox only the Pi runner.”** Rex shells, children and project tools must be inside the same boundary. An outside Rex server capable of launching arbitrary host commands would defeat it.
2. **“Set `MEMINI_NAMESPACE` and issue different keys.”** Neither prevents another namespace being requested.
3. **“Mount the Docker socket for HA checks.”** That hands the project control of the host.
4. **“Separate Claude directories mean separate credentials.”** They separate local state, not the authority of the shared Claude login.
5. **“Systemd limits on the Docker launcher constrain the containers.”** Docker-created workloads need their own explicit resource limits and cgroup placement.

# Recommendation

## A. Changed architecture

### Decision

**Use one gVisor `runsc` sandbox per workspace, running the project’s Rex server, Pi, children and shell. Use separate memini instances and stores per project. Keep privileged lifecycle management outside all workspaces.**

Use rootful Docker as the host’s OCI manager, with a dedicated, pinned `runsc-systrap` runtime. Do not give agents Docker access.

**Trade-off:** More operational machinery than Unix accounts, and possible syscall compatibility or performance costs, in exchange for a stronger boundary against arbitrary project code without KVM. Rex becomes one remote host per workspace rather than one host server containing every project.

### Threat model

The boundary assumes an agent can execute arbitrary code, including malicious repository scripts, change its environment and disregard its instructions.

It must prevent that code from:

- Reading or modifying another workspace, credential directory, Pi session tree or memory store.
- Using host Rex, Docker, SSH agents, 1Password credentials or backup credentials.
- Writing outside its explicitly mounted project state.
- Reaching host administration services, other project services or cloud metadata.
- Exhausting host disk or memory without a bounded project limit.

It does **not** promise:

- Protection against a gVisor, container-runtime or host-kernel escape.
- Protection from Jan, host root or the trusted provisioning and backup services.
- Protection of a project against its own agent.
- Hardware-VM-grade isolation or elimination of side channels.
- Prevention of exfiltration of data the project legitimately possesses over permitted Internet access.
- Secure enforcement of approval policy for APIs whose write credentials are already available to the agent.
- Isolation of Claude account authority or subscription quota while one login is shared.

Parent and child agents remain one workspace security domain. The child approval guard is policy enforcement, not a separate security boundary.

### Why this option, not the alternatives

| Option | Judgment |
|---|---|
| **Unix user per project plus systemd sandboxing** | Viable for accidental cross-project access with carefully private homes, mounts, resource limits and networking. Lower runtime overhead and ordinary per-project Rex accounts. However, sandboxing only `agent-run` leaves Rex shells and children outside it. Sandboxing the entire account execution environment is more substantial than a runner unit, and arbitrary native code still attacks the host kernel directly. Separate Pi state, caches and credentials remain necessary. Rejected as the primary hostile-code boundary. |
| **Rootful Docker or Podman with runc** | Good filesystem, PID and network separation with narrow mounts, no capabilities and no daemon socket. Rex can live inside. Images and directory backups are straightforward. It still exposes substantially more of the host kernel to arbitrary code than gVisor. Rejected as the default and forbidden as an automatic compatibility fallback. |
| **systemd-nspawn** | Useful full-system containers with separate homes, services and networking. Rex would fit naturally inside each container, but each becomes another small OS to patch. It shares the host kernel and does not solve Docker or credential authority automatically. More maintenance without the selected syscall boundary. |
| **Landlock launcher** | Useful additional filesystem restrictions, depending on kernel ABI. Not a complete PID, network, resource and service-credential boundary. Every entry path would need confinement, and inherited descriptors require care. Rejected as the platform foundation. |
| **File permissions only** | Separate UIDs can protect private files. Same-UID `0600` project files cannot. Neither approach alone provides the required host-damage, network or resource controls. |
| **MicroVMs / software emulation** | Firecracker, Kata and Cloud Hypervisor are unavailable in the measured configuration. Full-system QEMU with TCG is a credible no-KVM alternative, but software CPU emulation and guest-OS maintenance are poor defaults for interactive development. No claim that all no-KVM VMs are impossible. |
| **gVisor** | Selected. Container-like deployment and backups, a userspace kernel reducing host syscall exposure, and no nested virtualization requirement. Compatibility and measured performance are launch gates. |

Every serious option needs credential separation. None makes an all-namespace memini key or all-repository GitHub PAT safe merely by hiding neighboring directories.

### Concrete execution boundary

Provision these root-owned host components:

- `agent-workspace@.service`: starts and stops a fixed project sandbox specification.
- `agent-memory@.service`: starts that project’s separate memini service.
- A credential materializer replacing the project-distribution part of `ai-sync`.
- A narrowly scoped HA validation service.
- The previously planned backup services.

The project specification is generated from a root-owned registry. A workspace cannot supply container arguments, mounts, runtime names or host commands.

For each project:

- Allocate a stable host UID/GID with no login shell and no `sudo`, `docker`, `lxd` or shared data groups.
- Run Rex and development processes as that non-root UID inside the sandbox.
- Keep `/home/ubuntu` as the **in-sandbox** home path. The username and home path need not imply the host’s UID or privileges.
- Use a read-only base image and only project-specific writable mounts.
- Drop capabilities, enable no-new-privileges, retain runtime seccomp protections and provide no host devices.
- Do not mount host `/home`, `/run`, `/proc`, Docker sockets, Tailscale sockets or SSH-agent sockets.
- Use gVisor’s isolated network stack, not its host-network mode.
- Apply Docker workload CPU, memory and process limits, bounded temporary filesystems and bounded logs.
- Enforce storage quotas across persistent project data and caches. Quota support on the existing ext4 mount must be verified before launch. Disk limits cannot be merely an alert.
- Reserve host capacity explicitly, including the existing keepalive allocation. Reject project starts that exceed the admitted budget.

Rootful Docker and the provisioner remain trusted infrastructure. The project never receives a general-purpose control socket or passwordless lifecycle command.

**Fail closed:** missing runsc, failed isolation setup or an unsupported workload stops startup. Never silently switch to runc, host networking or privileged mode.

### Rex attachment

Run the **personal Rex server inside each project sandbox**, including its Unix socket and persistent layout state.

Use Rex’s documented built-in Tailscale support:

- One tagged node per project, for example `rex-aether-home`.
- Jan adds `https://rex-aether-home.<tailnet>.ts.net` as a remote host in the Mac app.
- Use one-time enrollment credentials and persist only that node’s state.
- Explicit tailnet ACLs admit Jan’s approved client devices and deny project nodes access to each other, host `ubuntu` Rex, SSH and unrelated subnet services.
- Do not enroll these nodes as ordinary Jan-owned devices under broad existing user grants.
- Use `--tailscale-allow-tailnet-members` for tagged devices only with the restrictive ACLs already in place.

Rex documents this transport without needing the host’s `tailscaled` socket. Its actual operation under gVisor remains an integration test. [3]

**Host Rex accounts remain unchanged.** `home/.system/rex-accounts.jsonc` continues to authorize only operator `ubuntu`. No project account is exposed through the host login server.

All project tabs, including `shell` and children, are created by the in-sandbox Rex server. Local Rex commands therefore cannot launch host processes.

Disable **Client Remote Control** for untrusted project servers. If Rex cannot scope that setting by server, disable it on the connected app. The existing automatic `rex -C … session.select` behavior must be removed or degrade gracefully. Jan selects the project and tabs manually. This avoids treating the Mac’s multiplexer control interface as a harmless sandbox capability.

### Network policy

Use a separate project network with externally enforced rules, covering both IPv4 and IPv6:

- Deny other project networks.
- Deny host administration, link-local metadata and unrelated private or tailnet addresses.
- Allow only the project’s memory service and approved internal service destinations.
- Permit the public access needed for models, GitHub, packages and research.
- Give `home` an explicit HA destination exception, not general access to the home LAN.

Apply equivalent restrictions to the embedded Tailscale identity. Otherwise its encrypted overlay could bypass the host bridge’s private-address rules.

Provide a reachable DNS resolver explicitly. gVisor documents a compatibility issue with Docker’s `127.0.0.11` embedded resolver on user-defined bridges. Do not “fix” DNS by enabling host networking. [1]

### Pi login, packages, caches and credentials

**Claude**

Keep one subscription login for now, but create a separate `CLAUDE_CONFIG_DIR` in each sandbox. Seed only the required credential, not a copy of `ubuntu`’s entire Claude directory.

This isolates local Claude configuration and conversations. The OAuth credential remains shared authority and shared quota. Separate setup tokens or copied configs must not be described as independent accounts. Genuine account isolation requires separate provider accounts or a separately designed credential-holding model gateway.

**Pi and mise**

- Build pinned Pi, Node, extensions and common tools into an immutable platform image.
- Fetch private Pi packages during the trusted image build with temporary build credentials. Those credentials must not survive in layers, caches or logs.
- Give each project its own Pi sessions, trust state, mutable settings and package-manager state.
- Keep platform standards and managed extension sources read-only.
- Use project-private mise installs and caches for agent-added tools.
- Share immutable artifacts, never writable caches.
- Do not run a project’s `mise`, Git hooks or package scripts on the host.

**GitHub**

Issue fine-grained PATs per project and repository-owner set, limited to the project’s authorized repositories and required permissions. A project spanning organizations may need multiple tokens.

Do not distribute the current all-`janpuc` PAT or the private-platform-package build credential. Do not forward the operator’s SSH authentication or signing agent. Provision a project-specific signing key if signed commits remain required.

These PATs constrain repository reach. A write-capable PAT still does not enforce “ask before push”.

**Secret distribution**

The operator-side materializer reads 1Password and produces only the selected project’s credentials. Project sandboxes receive neither `OP_SERVICE_ACCOUNT_TOKEN` nor the host’s shared `credentials.fish`.

Use a separate read-only credential directory mounted into each sandbox. Generate `credentials.fish` from an explicit allowlist and expose only that project’s dotenv file. Rotate directories safely and restart the sandbox when necessary so bind mounts cannot retain stale file inodes.

### Memini: separate stores, not pretend-scoped keys

Run one additional **gVisor memini service per project on aether**, with:

- Its own SQLite database and persistent directory.
- Its own bootstrap/admin credential, retained by the operator.
- Its own non-admin agent key.
- Network reachability only from its project and the operator.
- Separately budgeted embedding and consolidation credentials.

SQLite is a documented memini backend, so this does not require a new PostgreSQL cluster per project. Feature parity, migration support and performance must be tested against the pinned version. [4]

Preserve namespace names such as `homelab/home` within the isolated store.

Do not give project agents credentials to `memini.janpuc.com`. Do not automatically inherit the existing `homelab` or `personal/jan` contents. Export the project’s own namespace and descendants, then import only explicitly reviewed shared facts. Centrally maintained shared standards remain available through the platform image.

This deliberately changes the earlier assumption of one shared live memory service. It is preferable to building a security-critical proxy that must understand every REST, MCP, search, history, inheritance and future endpoint.

### Docker for the HA check

**Provide the HA check, not Docker administration.**

Add `agent-check ha`, backed by a fixed host-managed validation profile:

1. Accept a bounded snapshot of the intended HA configuration.
2. Stage and unpack it inside a sandbox, not through a privileged host archive extractor.
3. Launch a one-shot gVisor container using an approved ARM64 Home Assistant image digest.
4. Run the fixed config-check entry point with no network, host secrets, Docker socket or host mounts beyond the dedicated staging area.
5. Return bounded output and the exit status.

The request cannot specify an image, mount path, Docker flags or arbitrary host command. Apply size, concurrency and execution-time limits.

This is a small, privileged interface that needs adversarial tests. It is not a generic Docker API proxy.

Do not use Docker-in-Docker for this requirement. gVisor supports it, but current Docker versions need extra raw-packet permissions and networking or storage accommodations. That is unnecessary expansion for one validation task. [5]

If the actual HA checker cannot run under gVisor, report incompatibility and stop. An operator-run external check can be the temporary workflow. Do not weaken every workspace’s boundary.

## C. Changed layout and backup scope

The workspace’s internal Git layout from the earlier design stays unchanged.

```text
Host, never mounted wholesale into a project

/etc/agent-platform/
    projects.json
    profiles/
    runtime-policy/

/var/lib/agent-platform/
    initialization/
    image-inventory/
    lifecycle/

/run/agent-platform/credentials/<project>/
    credentials.fish
    projects/<project>.env
    other explicitly provisioned credentials

/srv/agents/<project>/
    home/
        Development/<project>/           Existing workspace layout
        .pi/agent/
            sessions/
            claude/                      Project-local Claude state
            other project-local Pi state
        .local/share/agent-history/<project>/
        .local/state/rex/
        .local/share/mise/
        .cache/
    memory/
        memini.db                        Visible only to memory service
        associated persistent DB files
```

Inside `home`’s sandbox:

```text
/home/ubuntu/Development/home
/home/ubuntu/.pi/agent/sessions
/home/ubuntu/.pi/agent/claude
/home/ubuntu/.local/state/ai/projects/home.env
```

Those familiar paths exist only in that sandbox’s view. Keeping them avoids unnecessary Pi session-directory and linked-worktree path migration.

The in-sandbox registry contains only its own project. The host’s registry remains authoritative for lifecycle, UID allocation, mounts, resources and credentials.

### Backup changes

Keep restic over SFTP and NAS-owned snapshots, but expand the source set to include:

- Every project’s workspace, Pi state, relevant Claude conversation state and raw history.
- Rex layout state.
- Each project’s memini database.
- Root-owned lifecycle records, UID assignments, runtime/image digests and effective network policies.

Exclude exact external credential files and reproducible caches. Separate Rex layout data from node credentials before defining exclusions. Do not broadly exclude all Claude state or all `.lock` files.

For hourly memory backup, use SQLite’s supported online backup mechanism rather than copying an active database file without its consistency requirements.

For a verified checkpoint:

1. Settle the agent and stop new launches.
2. Require Jan’s shell work to pause.
3. Stop or freeze all workspace writers and cleanly stop the project’s memory service.
4. Finalize the staging copy.
5. Validate Git, sessions, generation state and SQLite integrity.
6. Resume services, then upload staging.

Stopping one runner is no longer sufficient. Never mark a forced, interrupted checkpoint verified merely because the container stopped.

Run validators on untrusted repository metadata inside restricted validation environments, not as host root executing repository-controlled helpers.

Fresh-host restore recreates host directories and UID assignments, but restores the same **in-sandbox** paths. Reissue external credentials and re-enroll Rex nodes. Never expose restored raw project trees to operator-wide automatic tool discovery.

## D. Changed migration of live `home`

Retain the earlier content and submodule migration, with these changes in order:

1. **Preserve everything first.** Include the dirty `notes/STATE.md`, workspace Git metadata, nested repositories, worktrees, generation files, Pi history, relevant Claude history and Rex layout. Inventory embedded historical credentials without printing them.

2. **Establish and test BigMouth recovery.** Keep the old GitHub workspace copy until the approved archive point.

3. **Build an empty isolated test project first.** Prove Rex attachment, Pi/bridge operation, local child tabs, credentials, memory isolation and the actual HA config check. Do not experiment by incrementally restricting the live `home` process.

4. **Provision `home`’s credentials and memory store.** Export its memory with an operator-held credential. Import its own namespace and reviewed shared facts only. Keep the original shared store unchanged during validation.

5. **Reach the agreed idle boundary.** Checkpoint and stop the existing runner. Ensure there are no remaining host-side children or background project tasks.

6. **Copy into `/srv/agents/home/home/`.** Preserve the old tree as a private rollback source. Copy only `home`’s session/history material, not all of `ubuntu`’s Pi or Claude directories. Preserve in-sandbox paths.

7. **Perform the earlier Git and knowledge migration.** Adopt `home-assistant` without reset or reclone, retain `ha-inventory`, retire the permissive HA instructions, remove workspace `AGENTS.md`, and untrack runtime `.agent` state without deleting it. Recheck the recorded HA revision rather than assuming it has remained unchanged.

8. **Start the new Rex remote and generation 2.** Use the new standards/context loader and isolated memini endpoint. Keep generation 1 as history.

9. **Run positive and negative acceptance tests.** Include other-workspace file reads, memory access, host Rex access, Docker access, metadata access and resource exhaustion. No deployment or HA mutation is part of this test.

10. **Take a verified post-migration backup.** Then retire the old host runner and its project tabs with Jan’s approval.

**Explicit revision:** do not promise the same Rex server/session identity across migration. Preserve useful history and labels, but create the active `home` session in the sandbox’s Rex server.

Remove stale all-project credential copies from agent-visible historical state. If old sessions contain shared credentials, revoke or rotate those credentials before declaring isolation complete. Moving a leaked token into a private session file does not reduce its authority.

Rollback must stop the sandbox writer before reopening the old environment. No two authoritative `home` agents.

## E. New and changed build steps

Insert these gates into the earlier plan.

| Position | Scope | Done check |
|---|---|---|
| **Before old step 1** | Security contract and fixed runtime schema | Defines UID, mount, egress, resource and credential boundaries. Fixtures reject arbitrary mounts, runtimes and host commands. |
| **Before launcher work** | Isolated ARM64 compatibility prototype | On an approved disposable setup, run Pi, claude-bridge, mise, Git/worktrees, Rex, children and the real HA validator under pinned runsc. Record latency and resource overhead. No host-mode fallback. |
| **Expand old step 1** | Registry and lifecycle metadata | Stable UID allocation, runtime/image digests, quotas, credential references and memory-service identity are operator-owned. A project sees only its own rendered registry. |
| **Replace old step 3** | Host lifecycle plus in-sandbox launcher | `agent up` reconciles sandbox services. In-sandbox `agent-run` handles only its own generations and Rex tabs. All arbitrary shell execution stays inside. |
| **Add before live secrets** | Network, quota and adversarial tests | Two synthetic projects cannot access each other’s files, memory, Rex or credentials. Fork, disk-fill and memory-pressure tests stay bounded. Test IPv6, metadata and tailnet bypass routes. |
| **Expand old step 7** | Immutable platform image and credential materializer | No host credential cache is inherited. Image layers contain no build tokens. Repo-scoped GitHub credentials deny an unrelated fixture repo. Mise caches are project-private. |
| **Add before migration** | Per-project memini and migration tooling | Direct REST/MCP calls cannot reach another store. Changing namespace, home, scope or memory ID reveals no foreign data. Export/import preserves required facts and provenance. |
| **Add before migration** | Restricted HA checker | Valid config check passes. Attempts to supply arbitrary images, paths, commands, oversized input and escaping archive entries fail safely. |
| **Expand old steps 8-10** | Backup, checkpoint and restore | Restore includes memory, Pi/Claude history, project IDs and linked worktrees. SQLite/Git validation succeeds. No credential or network access is accidentally widened after restore. |
| **Revise old step 11** | Migrate `home` | New Rex remote, generation transition, no lost dirty work, old writer stopped and verified backup complete. |
| **Expand old step 12** | Operator runbooks and upgrades | Document image promotion, runtime security updates, token rotation, Rex enrollment, quota changes, memory recovery and rollback. Re-run isolation tests before upgrades. |

Relevant repository changes would involve `executable_agent-run`, `ai-sync.fish.tmpl`, Linux provisioning and allowlists, Pi configuration/context handling, `rex-inspector.ts`, `docs/projects.md`, `docs/aether.md`, and new root-installed units/profiles under `home/.system/`.

Do not apply the full `ubuntu` dotfile environment to project accounts. That would recreate the shared credential and host-control problem.

## Risks

1. **Compatibility is unproven on aether.** ARM64 systrap support is documented. This exact Rex, Pi, Claude and HA combination has not been run under it. The prototype is a hard gate.
2. **Memini isolation changes the product experience.** Automatic cross-project and personal recall disappears. Reviewed shared facts can be copied, but there is no transparent global memory view for agents.
3. **The shared Claude login remains a shared authority.** Separate directories do not isolate account abuse, revocation or quota.
4. **The privileged control plane is security-critical.** Runtime profiles, credential provisioning, the HA checker and backup handling must never interpret project input as host commands or unrestricted paths.
5. **Network paths can undermine filesystem isolation.** Broad tailnet grants, host Rex access, metadata access or an exposed daemon socket would invalidate the design.
6. **Historical data can carry old authority.** Sessions, shell history and handoffs may contain copied tokens. Credential rotation may be necessary before migration is considered complete.
7. **Operational cost increases.** Each project gains runtime state, a Rex identity and a memory store. Pinned images and automated diagnostics are necessary to keep this manageable.
8. **The earlier resilience limits remain.** BigMouth is not an independent off-site copy. Verified checkpoints still require control over writers. Approval guards still do not stop arbitrary scripted API writes.

## Need from main agent

The architecture is decided. At most three execution questions for Jan:

1. Approve gVisor provisioning, enforced storage/network limits and one tagged Rex remote per project, including loss of automatic client-controlled tab selection?
2. Approve isolated memini stores and migration of only project-owned memory plus reviewed shared facts, with no live shared personal-memory inheritance?
3. When can `home` be stopped for the credential audit, migration and verified restore drill, alongside the already-required BigMouth provisioning?

## Suggested execution prompt

**No implementation handoff is warranted in this read-only task.** After approval, the first implementation should be the fixed runtime/security schema and a disposable compatibility fixture, not migration of live `home`.

### Sources

1. gVisor [platforms](https://gvisor.dev/docs/user_guide/platforms/), [ARM64 support and DNS caveat](https://gvisor.dev/docs/user_guide/faq/), [network isolation](https://gvisor.dev/docs/user_guide/networking/) and [security model](https://gvisor.dev/docs/architecture_guide/security/).
2. memini [`docs/api-keys.md`, “Keys are identity, not isolation”](https://github.com/eleboucher/memini/blob/main/docs/api-keys.md).
3. Rex [remote access](https://www.superlogical.com/rex/docs/linux/remote-access) and [server modes](https://www.superlogical.com/rex/docs/linux/server-modes), corroborated by aether’s installed `rex server run --help` and `rex login-server --help`.
4. memini [configuration reference](https://github.com/eleboucher/memini/blob/main/docs/reference/configuration.md), including SQLite, embeddings and PostgreSQL backends.
5. gVisor [Docker-in-gVisor requirements](https://gvisor.dev/docs/tutorials/docker-in-gvisor/).
6. Local sources inspected: `docs/projects.md`, `docs/aether.md`, `home/dot_local/bin/executable_agent-run`, `home/dot_config/fish/functions/ai-sync.fish.tmpl`, `home/dot_config/fish/config.fish.tmpl`, `home/.system/rex-accounts.jsonc`, `home/.chezmoiscripts/run_onchange_after_07-linux-rex.sh.tmpl`, and the Pi wrapper, settings and Rex inspector under `home/dot_pi/private_agent/`.