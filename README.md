# EZGH Obs Agent

A Helm chart that forwards Kubernetes container logs, node/pod/container metrics,
and application OpenTelemetry data to [EZGH Cloud](https://ezghcloud.com).

One Linux DaemonSet pod per eligible node, using OpenTelemetry Collector Contrib
**0.162.0**. No operator, CRDs, custom agent binary, or application changes are
needed for container logs and infrastructure metrics. Application traces require
an existing SDK or other instrumentation.

## Install

Requires Helm 3.17+ or Helm 4, Kubernetes 1.28+, IPv4-capable Linux nodes with standard
`/var/log/pods` CRI logs, and permission to create a DaemonSet and cluster RBAC.
Windows, serverless nodes without hostPath access, and restricted Pod Security
namespaces are not supported by the default installation.

Create a project ingest key allowing **`obs.logs.ingest`**, **`obs.metrics.ingest`**,
and **`obs.traces.ingest`**. Use one key per cluster so it can be revoked independently.
Save the token in a local file named `ingest-key.txt`, without a trailing newline.
This is an ingest key (`ezgh_ik_…`), not a personal API key.

```sh
kubectl create namespace ezgh-obs
kubectl -n ezgh-obs create secret generic ezgh-obs-ingest \
  --from-file=ingest-key=./ingest-key.txt

helm upgrade --install ezgh-obs-agent \
  oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent --version 0.1.0 \
  --namespace ezgh-obs \
  --set cluster.name=production-us-west \
  --set ezgh.environment=production \
  --set auth.existingSecret=ezgh-obs-ingest \
  --wait --timeout 5m
```

Delete the local token file after storing it securely. For GitOps, provision the
Secret through your existing secret manager. The chart never creates a Secret
or stores a credential in Helm values or release history.

The chart is published as an OCI artifact on GHCR, which is the preferred source
(`helm pull oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent --version 0.1.0`; Helm
3.8+ needs no `helm repo add`). The same package is attached to each GitHub
Release, for networks that can't reach ghcr.io: replace the `oci://…` reference
and `--version` with
`https://github.com/ezgamehost/ezgh-obs-agent/releases/download/v0.1.0/ezgh-obs-agent-0.1.0.tgz`
(checksums in that release's `SHA256SUMS`). To install from source, use
`./charts/ezgh-obs-agent`.
See [production values](examples/production.yaml) and [OTLP-only values](examples/otlp-only.yaml).

## Collection and routing

| Source | Default behavior |
| --- | --- |
| Container logs | Read `/var/log/pods/*/*/*.log`; parse containerd, CRI-O and Docker JSON formats; recover CRI partial lines. Exclude this agent's own pod. |
| Kubelet | Poll `/stats/summary` every 30 seconds for node, pod, container and volume metrics. |
| Application OTLP | Accept enabled signals on the internal Service: gRPC 4317, HTTP 4318. |
| Export | OTLP/HTTP protobuf, gzip, verified HTTPS to `https://obs-ingest.ezghcloud.com`. |

The ingest key selects the project. `ezgh.environment` overwrites
`ezgh.metadata.environment` on every record and selects its dataset. The backend
can create that dataset on first ingestion; create it beforehand to choose retention.
An environment must match `[a-z0-9][a-z0-9._-]{0,62}`.

Cluster name and optional UID are installation-wide resource attributes. Keep
the name stable and unique within the project. Node-local logs and metrics get
the actual node name; incoming application OTLP retains its source node identity.
`ezgh.metadata.application` is preserved when present; otherwise it falls back
to `service.name`, then container name, then `kubernetes`. `service.name` is preserved.

This chart does not use a Kubernetes metadata informer/cache. Log identity comes
from file paths, metric identity from kubelet responses, and application identity
from OTLP resource attributes. Deployment-owner and arbitrary pod-label enrichment,
Kubernetes events, cluster-state metrics, Prometheus target discovery and automatic
application instrumentation are outside v1.

## Send application telemetry

For the default release and namespace:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://ezgh-obs-agent.ezgh-obs.svc:4318
OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf
OTEL_SERVICE_NAME=checkout
OTEL_RESOURCE_ATTRIBUTES=ezgh.metadata.application=storefront
```

For gRPC, use `http://ezgh-obs-agent.ezgh-obs.svc:4317` and protocol `grpc`.
Applications do not need the EZGH ingest key; only agents receive it. Configure
application pod/namespace/node resource attributes through the SDK and Downward
API if you want that correlation. The Service may send data to any agent node.

The internal OTLP receiver is plaintext and unauthenticated. All pods able to
reach it can submit data to this installation's project. Use your cluster's
NetworkPolicies to restrict callers and agent egress. The chart does not create
an Ingress, LoadBalancer, host port, or public telemetry endpoint.

## Configuration

All settings are in [values.yaml](charts/ezgh-obs-agent/values.yaml), with a strict
[values schema](charts/ezgh-obs-agent/values.schema.json).

| Setting | Purpose |
| --- | --- |
| `cluster.name`, `ezgh.environment`, `auth.existingSecret` | Required installation inputs. |
| `auth.secretKey` | Secret entry, default `ingest-key`. |
| `logs.enabled`, `metrics.enabled`, `traces.enabled` | Enable/disable entire signal pipelines. At least one must remain enabled. |
| `logs.collectContainerLogs` | Disable file collection while continuing to receive OTLP logs. |
| `metrics.collectKubeletMetrics` | Disable kubelet collection while continuing to receive OTLP metrics. Removes cluster RBAC and token mount. |
| `logs.excludeNamespaces`, `logs.exclude` | Namespace exclusions and additional file globs. These filter **file collection**, not application OTLP. |
| `logs.startAt` | `beginning` by default, capturing existing files on first install and short-lived pods. Use `end` to avoid an initial backlog. Saved offsets take precedence. |
| `logs.maxLogSize` | Default `256KiB`, including recombined CRI records. Keep records small enough for the backend request limit. |
| `metrics.collectionInterval` | Default `30s`. |
| `metrics.kubelet.endpoint` | Default node IPv4 address on HTTPS 10250; supports Collector `${env:…}` substitutions. |
| `metrics.kubelet.caConfigMap`, `metrics.kubelet.caKey` | Custom kubelet CA; otherwise use the ServiceAccount CA. |
| `metrics.kubelet.insecureSkipVerify` | Default `false`. An explicit opt-out for clusters with untrusted kubelet serving certificates; retains encryption but skips server identity verification. |
| `export.queueSizeMiB` | Default 64 MiB of queued payload **per signal per node**. |
| `export.storageMaxMiB` | Default 128 MiB per storage database, including storage overhead. Must exceed the queue size. |
| `storage.hostPath` | Base directory; namespace and release name are appended. |
| `resources`, `memoryLimiter` | Container budget and Collector pressure limits; increase together for busy nodes. |
| `nodeSelector`, `tolerations`, `affinity` | Node coverage. Linux selection is mandatory. |
| `image.digest` | Optional immutable image digest, overriding the pinned version tag. |

The default tolerations do not include control-plane or custom workload taints.
Add only the tolerations needed for the nodes you intend to observe. There should
be only one log/metric collection installation per node for a destination; multiple
releases collecting the same files produce duplicate telemetry.

## Privileges and delivery

The collector runs as UID 0 to read root-owned container logs and write the
node-local queue directory. It drops every Linux capability, disables privilege
escalation, uses a read-only root filesystem and RuntimeDefault seccomp, and does
not use privileged mode, host networking, host PID, or a runtime socket.
The log hostPath is read-only. Kubelet access grants only `get` on `nodes/stats`;
the chart cannot read Kubernetes Secrets through the API.

File offsets and three independent export queues use persistent node storage with
fsync. Telemetry is enqueued before exporter batching. Batches are bounded to
1 MiB (individual oversized items cannot necessarily be split). Retries use
backoff; retryable failures are retried while queued. Queue saturation applies
backpressure to file reads and rejects OTLP requests so SDKs can retry.

This is **at-least-once best-effort delivery**, not a lossless or exactly-once
guarantee. Node replacement, disk exhaustion, file rotation during extended
backpressure, memory pressure, and permanent backend rejections can lose records.
Retries can duplicate data. Queue capacity measures payload bytes, not filesystem
usage; storage overhead and startup compaction require additional disk space.
Queues contain customer telemetry; protect node disks accordingly.

## Verify and operate

```sh
kubectl -n ezgh-obs get daemonset ezgh-obs-agent
kubectl -n ezgh-obs logs -l app.kubernetes.io/instance=ezgh-obs-agent --tail=50
```

Ready pods mean the collector process is healthy, not that EZGH has accepted data.
Check the destination dataset for recent logs and metrics; traces arrive only
when applications emit them. Agent Prometheus self-metrics are available on each
pod's port 8888 for your existing scraper, without a public Service.
Inspect exporter queue size, enqueue/send failures and receiver refusals.

| Symptom | Check |
| --- | --- |
| `CreateContainerConfigError` | The named Secret and its entry exist in the release namespace. |
| Kubelet certificate error | Configure the serving CA and matching endpoint; use the explicit verification opt-out only if intended. |
| Kubelet `403` | Node webhook authorization and the generated `nodes/stats` binding. |
| Export `401`/`403` | Key validity and all enabled signal permissions. These failures are not a durable holding mechanism; fix and restart after key rotation. |
| Export `429`/`503` | Backend throttling/outage; inspect queue and disk capacity. |
| Missing node data | DaemonSet coverage, taints, node selectors, log exclusions and network access to kubelet 10250. |

After replacing the Secret token, restart the DaemonSet because the token is read
from the environment at process startup:

```sh
kubectl -n ezgh-obs rollout restart daemonset/ezgh-obs-agent
kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent
```

Use the same `helm upgrade --install` command with an explicit new chart version
for upgrades. Configuration changes roll pods automatically; updates use zero
surge to avoid simultaneous readers of the same host files/state.

`helm uninstall ezgh-obs-agent -n ezgh-obs` leaves the externally managed Secret
and node directories intact. Reinstalling the same release resumes state. Revoke
the key when retiring the installation; remove retained state separately when no
collector is using it. Do not reuse old queues after changing the destination
project/environment: use a new release name or drain/remove old state first.

## Develop and release

Requires Bun 1.3+ (CI pins 1.4.2), Helm and OpenSSL. No package dependencies.

```sh
scripts/download-collector.sh       # downloads the pinned binary and verifies its checksum
bun run lint
bun run test
bun run validate
bun run test:integration
bun run package                    # dist/ezgh-obs-agent-0.1.0.tgz
```

Set `COLLECTOR_BIN` to use an existing binary. Offline validation substitutes
kubelet authentication because there is no projected Kubernetes token outside
a pod; CI's real multi-node test covers the rendered ServiceAccount configuration.
Set `TEST_CA_FILE` if your system CA bundle is not `/etc/ssl/cert.pem`.

The integration test runs real Collector processes, a fixture kubelet HTTPS server,
and a local sink: all three signals, kubelet polling, gzip/auth headers, CRI parsing, source metadata, and forced-restart queue
recovery. It sends no telemetry to EZGH. CI additionally installs the chart in a
disposable two-worker kind cluster and verifies node metrics, pod logs, traces,
TLS export, and a rolling restart. `scripts/smoke.sh` refuses any context other
than `kind-ezgh-obs-agent`.

To release, increment `Chart.yaml`'s `version`, update the install examples, and
push the matching `v<version>` tag. The release workflow reruns CI, publishes
the Helm archive and SHA256SUMS as public GitHub Release assets, pushes the same
archive to `oci://ghcr.io/ezgamehost/charts`, and checks that it pulls anonymously
with the pushed digest (`scripts/publish-oci.sh`). Running the workflow by hand
with an existing tag publishes that release's verified archive to GHCR. This repository
does not deploy an agent into a production cluster.

Licensed under [Apache-2.0](LICENSE). OpenTelemetry is a CNCF project; this chart
is maintained by EZGH Cloud and is not an upstream OpenTelemetry distribution.
