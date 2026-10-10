# EZGH Obs initial UI handoff

Baseline: 2026-10-10. This is a task prompt for the next coding session. Recheck
current code and deployed revisions before implementing; the paths below describe
the inspected baseline, not a permanent API contract.

## Task

Implement Kubernetes onboarding for **EZGH Obs Agent** in the EZGH Console.
Extend the existing Obs **Send data** flow at `/obs/ingest` so a customer can
configure a cluster, provision an ingest key, copy installation commands, and
verify telemetry arrival. The Helm chart is already shipped. Build the console
experience around its actual capabilities.

Work primarily in `console/services/obs`. Preserve the other Collector, SDK,
environment-variable, and Prometheus onboarding methods. Do not build a cluster
control plane, automatic instrumentation, or a new backend registration API.
The console generates commands for customers to run; it does not access their
Kubernetes credentials or execute an installation itself.

## Read before changing code

The workspace is `~/code`, containing independent sibling repositories. Read
its `AGENTS.md`, check each relevant repository's Git status, and preserve other
sessions' edits. Read these sources:

- `console/AGENTS.md`, `console/README.md`.
- `console/docs/ui-design.md` and `console/docs/style-guide.md`.
- `console/services/obs/AGENTS.md` and `console/services/obs/README.md`.
- `console/package.json`, `console/services/obs/package.json`, and
  `console/.github/workflows/ci.yml` for current checks and toolchain.
- This repository's `README.md`, `docs/design.md`,
  `charts/ezgh-obs-agent/values.yaml`, and
  `charts/ezgh-obs-agent/values.schema.json` for the shipped chart contract.
- Current Obs backend routes and the deployed revisions in
  `platform/charts/apps/values.yaml` before relying on query/filter behavior.
  Inspect the applicable platform contracts before changing any API interface.

Useful console entry points:

| File under `console/services/obs/` | Existing responsibility |
| --- | --- |
| `src/routes/ingest.tsx` | Send data setup, inline key creation, verification, and key list. |
| `src/lib/ingest-snippets.ts` | Exporter methods and generated commands. The current `k8s` branch is generic Collector configuration; replace it with the released agent flow. |
| `src/lib/obs-display.ts` | Ingest endpoint, signal/action helpers, arrival helpers, and explorer paths. |
| `src/api.ts` | Effect Schema decoders and `ObsApi`, including project ingest-key operations. |
| `src/lib/obs.ts` | Query hooks and mutations, including `useObsActions().createIngestKey`. |
| `src/lib/query.ts` | Existing Effect/TanStack adapters. |
| `src/components/explorer.tsx` | Existing code-block presentation. |
| `src/api.test.ts` | API, arrival, and ingest-action tests. |

Obs already owns a client for project ingest keys. Reuse it instead of adding an
unnecessary dependency on the console IAM package. Respect service boundaries:
cross-service imports must use declared `@console/<id>/public` contracts.

## Shipped agent baseline

- Public repository: <https://github.com/ezgamehost/ezgh-obs-agent>.
- Release: [v0.1.0](https://github.com/ezgamehost/ezgh-obs-agent/releases/tag/v0.1.0).
- Source commit: `d284653c234e283f15abf5dc4c3176eab1650972`.
- Package URL:
  `https://github.com/ezgamehost/ezgh-obs-agent/releases/download/v0.1.0/ezgh-obs-agent-0.1.0.tgz`.
- Collector Contrib `0.162.0`; one DaemonSet pod per eligible Linux node.
- Release CI passed Helm 3/4 checks and a two-worker kind smoke test. This is
  chart validation, not evidence of installation in any customer's cluster.

Use the published, version-pinned package URL. There is no shipped OCI registry
installation contract to substitute. Keep the release version and URL in one
place so future upgrades are straightforward.

| Input or behavior | Contract |
| --- | --- |
| `cluster.name` | Required, 1–128 characters, `^[a-zA-Z0-9][a-zA-Z0-9._-]*$`. Stable and unique within the project; emitted as `k8s.cluster.name`. |
| `ezgh.environment` | Required, 1–63 characters, `^[a-z0-9][a-z0-9._-]*$`. Overwrites `ezgh.metadata.environment` and selects the destination dataset. |
| Project | Selected by the project ingest key, not by a Helm project-ID value. |
| `auth.existingSecret` | Required Kubernetes Secret in the release namespace. The chart never creates it. |
| `auth.secretKey` | Secret entry name, default `ingest-key`. No inline token value is supported. |
| Signal flags | `logs.enabled`, `metrics.enabled`, `traces.enabled` default to `true`; at least one must remain enabled. |
| Key actions | Respectively `obs.logs.ingest`, `obs.metrics.ingest`, `obs.traces.ingest`. Use an `ezgh_ik_…` project ingest key, not a personal API key. |
| Local collection | Container logs from `/var/log/pods`; kubelet node/pod/container/volume metrics every 30 seconds. |
| Traces | Require application instrumentation and application OTLP export configuration. Installing the chart alone does not create traces. |
| Application identity | Existing `service.name` and `ezgh.metadata.application` are preserved. Do not force all workloads into one service name. |
| Export endpoint | Verified HTTPS OTLP/HTTP to `https://obs-ingest.ezghcloud.com`. |
| Defaults for examples | Release `ezgh-obs-agent`, namespace `ezgh-obs`, Secret `ezgh-obs-ingest`. |

Prerequisites: Helm 3.17+ or Helm 4, Kubernetes 1.28+, IPv4-capable Linux nodes,
standard CRI log paths, hostPath access, and permission to install cluster RBAC.
The defaults do not support Windows or hostPath-less serverless nodes and do not
satisfy restricted Pod Security policies. Taints can limit node coverage.

Cluster name is not a dataset name. The environment dataset can be created on
first ingestion. There is no registered cluster resource, heartbeat, or installed
agent inventory created by this chart.

## Required customer flow

### 1. Choose Kubernetes and configure the destination

Make the Kubernetes method discoverable from Send data and addressable in the URL
using the console's existing routing conventions. Preserve current signal tabs
and other methods. The agent supports multiple signals in one installation;
do not accidentally limit it to the currently selected logs or metrics tab.

Show the active organization/project, cluster name, environment, and selected
signals. Use cluster identity rather than the generic SDK service-name field for
this method. Default to all signals the caller may enable, explain unavailable
signals, and require at least one. Validate before producing a ready-to-run
command; never silently replace invalid environment input with `production`.

Keep the first pass focused. Sensible release, namespace, and Secret defaults are
sufficient; offer existing-Secret input and link advanced settings to the chart
documentation. If names are editable, validate them against Kubernetes/Helm
constraints as well as escaping generated output correctly.

### 2. Provision or reference the credential

Offer explicit project ingest-key creation and an existing Kubernetes Secret
path. Recommend one key per cluster, with a meaningful default key name.

Use the existing `createIngestKey(orgId, projectId, name, allowedActions,
idempotencyKey)` API through the existing mutation hooks. Gate creation with
`ingestKeys.create` and check authorization for each chosen ingest action.
Recheck the authoritative API's rules; UI checks do not grant access.

The current `ingestActions` helper always includes logs/traces and conditionally
includes metrics. Do not reuse it blindly for selective agent permissions.
The key's granted actions and the generated chart flags must agree. Explicitly
disable every deselected or unavailable signal because all three chart defaults
are enabled. If selection changes after key creation, prevent generating a
configuration that requires actions the created key lacks.

The create response contains `{ ingestKey, token }`; listing keys returns metadata,
not recoverable tokens. Do not imply selecting an old key retrieves its secret.
Existing-Secret mode must work without creating another key and must explain the
required Secret entry and signal permissions.

Display a newly created token only in the intentional one-time credential view.
Offer an explicit download of `ingest-key.txt` containing the exact token with no
trailing newline. Keep it ephemeral; clear secret-bearing component and mutation
state on completion, cancellation, unmount, and organization/project changes.
Revoke any temporary object URL after download. Never persist the token in URL
state, local/session storage, query data, analytics, logs, or error messages.

### 3. Copy setup and installation commands

Separate the Secret prerequisite from the Helm command. For a new installation,
the baseline is:

```sh
kubectl create namespace ezgh-obs
kubectl -n ezgh-obs create secret generic ezgh-obs-ingest \
  --from-file=ingest-key=./ingest-key.txt

helm upgrade --install ezgh-obs-agent \
  https://github.com/ezgamehost/ezgh-obs-agent/releases/download/v0.1.0/ezgh-obs-agent-0.1.0.tgz \
  --namespace ezgh-obs \
  --set cluster.name=production-us-west \
  --set ezgh.environment=production \
  --set auth.existingSecret=ezgh-obs-ingest \
  --wait --timeout 5m
```

Use validated customer inputs and include signal overrides as needed. Explain
that namespace creation is skipped when it already exists. Existing-Secret mode
omits Secret creation entirely. Do not silently overwrite an existing Secret.
Tell customers to remove the downloaded token file after storing it securely;
GitOps customers can provision the Secret using their secret manager.

Never interpolate the actual token into a copied shell command, `--from-literal`,
Helm arguments, or a Helm values file. This keeps it out of shell and Helm release
history. Keep command generation in pure functions with tests for quoting,
validation, and selected-signal behavior. “One command” describes the Helm install
after its prerequisites; do not suggest the browser completed installation.

### 4. Explain application telemetry

Show a separate optional instrumentation step. With the default names,
applications can use:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://ezgh-obs-agent.ezgh-obs.svc:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=checkout
```

The gRPC receiver uses port `4317`. Derive endpoints from the actual release and
namespace if customization is offered. Applications do not need the EZGH ingest
key. The internal receiver is plaintext and unauthenticated; link the chart's
NetworkPolicy guidance. Keep per-application service identity intact.

### 5. Verify arrival honestly

Show independent logs, metrics, and traces states for enabled signals, with links
to the appropriate explorers. Explain that traces wait for instrumented workloads.
Use existing Obs API clients and query hooks; inspect current backend support
before choosing filters or resource-attribute/metric-label field names.

Prefer evidence after setup began, scoped to the project, environment, and
`k8s.cluster.name` where the API supports it. Dataset existence or an old
`lastReceivedAt` value is not proof of this installation. Another sender in the
same environment must not mark this cluster verified. A browser-generated test
event proves an ingest path, not the Kubernetes agent path.

If the supported API cannot attribute arrival to a cluster, label the result
“Data received in this environment” and leave cluster installation unverified.
Do not invent health, node coverage, or heartbeat status. Helm readiness only
indicates the Collector process is ready, not that export succeeded.

Distinguish waiting for data, unavailable verification, denied read permission,
and query errors. Ingest permission does not necessarily include search/read
permission. Preserve existing optional-field compatibility and retry behavior;
avoid aggressive or unbounded polling.

Include concise troubleshooting and links to the agent README: missing Secret,
key permissions, kubelet CA/authorization, node taints, and exporter errors.
Never silently disable kubelet TLS verification. Mention that rotating the
Secret requires a DaemonSet restart. Uninstall retains the Secret and node state;
revocation and state removal are separate decisions. Changing destination with
old queues requires intentional draining/removal or a new release.

## Implementation and acceptance criteria

Use the kit's existing page, form, permission, callout, and code-block components,
theme tokens, accessibility patterns, and loading/error states. Follow the style
guide for responsive layout, light/dark themes, and focus behavior. Do not add
direct component `fetch` calls, unauthorized cross-service imports, or new server
authorization caches. Existing TanStack Query use remains appropriate.

Cover these behaviors with focused tests and browser review:

- Valid inputs produce the released chart URL and matching key actions/flags;
  unavailable metrics cannot leave `metrics.enabled=true` accidentally.
- Invalid/empty/oversized names, all signals disabled, and shell/YAML injection
  inputs cannot produce an apparently valid installation command.
- New-key and existing-Secret paths work; retries do not duplicate key creation.
  Project changes reset credentials and verification context.
- Tokens appear only in the deliberate one-time credential view/download and
  never in generated install commands or persistent state.
- Existing data, unrelated cluster data, absent optional arrival fields, denied
  read permissions, and delayed traces do not produce false installation success.
- The method is deep-linkable, keyboard usable, and usable on narrow screens;
  other onboarding methods and the existing key list remain functional.

Run the current repository checks from `console` (confirm scripts first):

```sh
bun run --filter @console/obs check
bun run lint
bun run typecheck
bun run test
bun run build
```

Inspect the UI in-browser, including 1440×900 light, 1440×900 dark, and 390px-wide
views as required by the style guide. Exercise success, permissions, waiting,
error, and existing-Secret states; do not create real customer keys just to take
screenshots. Report exactly what was tested and any verification limitation.

Update relevant console documentation, commit and push verified changes according
to workspace instructions, and report the commit and remaining limitations.
No production deployment is authorized by this handoff. If an API gap prevents
an honest UI, describe it explicitly and use the supported fallback instead of
silently expanding scope into backend or platform changes.
