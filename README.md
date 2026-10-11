# EZGH Obs Agent

A Helm chart that forwards Kubernetes container logs, node/pod/container metrics,
cluster state, Kubernetes events and application OpenTelemetry data to
[EZGH Cloud](https://ezghcloud.com).

One Linux DaemonSet pod per eligible node, plus one Deployment pod for cluster state
and events, using OpenTelemetry Collector Contrib **0.162.0**. No operator, CRDs,
custom agent binary, or application changes are needed for container logs and
infrastructure metrics. Application traces require an existing SDK or other
instrumentation. EZGH's built-in Kubernetes dashboards need 0.3.0.

## Install

Requires Helm 3.17+ or Helm 4, Kubernetes 1.28+, IPv4-capable Linux nodes with standard
`/var/log/pods` CRI logs, and permission to create a DaemonSet, a Deployment and cluster RBAC.
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
  oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent --version 0.3.0 \
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
(`helm pull oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent --version 0.3.0`; Helm
3.8+ needs no `helm repo add`). The same package is attached to each GitHub
Release, for networks that can't reach ghcr.io: replace the `oci://…` reference
and `--version` with
`https://github.com/ezgamehost/ezgh-obs-agent/releases/download/v0.3.0/ezgh-obs-agent-0.3.0.tgz`
(checksums in that release's `SHA256SUMS`). To install from source, use
`./charts/ezgh-obs-agent`.
See [production values](examples/production.yaml) and [OTLP-only values](examples/otlp-only.yaml).

## Collection and routing

| Source | Default behavior |
| --- | --- |
| Container logs | Read `/var/log/pods/*/*/*.log`; parse containerd, CRI-O and Docker JSON formats; recover CRI partial lines. Exclude this agent's own pod. |
| Kubelet | Poll `/stats/summary` every 30 seconds for node, pod, container and volume metrics, including node and pod uptime and node inodes. On Kubernetes 1.33+ also read `/pods` for CPU and memory request/limit utilization and volume types (see [Privileges](#privileges-and-delivery)). |
| Cluster state | One Deployment replica watches the API: pod phase and status reason, container restarts, readiness, requests, limits and status reason, Deployment/StatefulSet/DaemonSet/ReplicaSet/Job/CronJob/HPA replicas, namespace phase, resource quotas, node conditions and allocatable CPU, memory and pods, PVC phase and size. Every 30 seconds, once for the cluster. |
| Kubernetes events | The same Deployment watches `events.k8s.io` Events and sends them as logs. |
| Agent self-telemetry | Each agent's own Collector metrics (exports, failures, queue fill, refusals, memory, CPU) every 60 seconds. |
| Application OTLP | Accept enabled signals on the internal Service: gRPC 4317, HTTP 4318. |
| Export | OTLP/HTTP protobuf, gzip, verified HTTPS to `https://obs-ingest.ezghcloud.com`. |

The ingest key selects the project. `ezgh.environment` overwrites
`ezgh.metadata.environment` on every record and selects its dataset. The backend
can create that dataset on first ingestion; create it beforehand to choose retention.
An environment must match `[a-z0-9][a-z0-9._-]{0,62}`.

Cluster name and optional UID are installation-wide resource attributes. Keep
the name stable and unique within the project. Node-local logs and metrics get
the actual node name; incoming application OTLP retains its source node identity.

### Service names from workloads

Each agent watches the pods on its own node through the Kubernetes API
(`k8sattributes`, filtered to the node) and adds `k8s.namespace.name`,
`k8s.pod.name`, `k8s.pod.uid` and the pod's owner: `k8s.deployment.name`,
`k8s.statefulset.name`, `k8s.daemonset.name`, `k8s.cronjob.name` or `k8s.job.name`.
Telemetry without a `service.name`, or with an SDK's `unknown_service…` default,
is then named after that workload, in that order, or else its container: a
Deployment's pods' container logs and pod/container metrics arrive as its
service, without any application change. A `service.name` the application set
is always kept.
`ezgh.metadata.application` is preserved when present; otherwise it falls back
to `service.name`, then container name, then `kubernetes`.

This applies to container logs and kubelet pod/container metrics (matched by pod
UID; node metrics have no pod). Application OTLP gets it only with
`otlp.internalTrafficPolicy: Local`: the Service then keeps each app's traffic on
its own node's agent, which knows the sending pod by its address. With the default
`Cluster`, any agent may receive it, so it's left as sent rather than named
inconsistently. `Local` means apps on nodes without an agent (taints, selectors)
can't send. The agent waits up to a minute at startup for the pod list, so the
first logs are named too; set `kubernetesMetadata.enabled: false` to read nothing
from the API.

Telemetry sent in a pod's first moment, before the kubelet has reported its IP,
can't be matched by address; container logs and metrics (matched by UID) can.

### Log levels

Container runtimes record only stdout or stderr. When a container log has no
level, the agent reads one from the line (`logs.parseSeverity`, default `true`):
a JSON body's `level`, `severity`, `lvl`, `levelname`, `log.level`, `loglevel`
or `@l` (and pino/bunyan's numbers), logfmt's `level=`, klog's `I`/`W`/`E`/`F`
prefix, or a leading level word after an optional timestamp and `[thread]`
(`INFO`, `[warn]`, `error:`). It's stored as `TRACE`, `DEBUG`, `INFO`, `WARN`,
`ERROR` or `FATAL` with the matching severity number. Lines without one stay
unset; stderr isn't assumed to be an error. Application OTLP logs keep their own.

### Kubernetes labels in PromQL

EZGH's PromQL makes labels of every datapoint attribute, but of only two resource
attributes: `service.name` (`job`) and `service.instance.id` (`instance`). Kubernetes
identity is resource attributes, so on its own every node's or pod's series would
merge into one. Every agent metrics pipeline (kubelet, cluster state, self-telemetry
and application OTLP) therefore copies these resource attributes onto each datapoint,
when the resource has them and the datapoint doesn't:

`k8s.cluster.name`, `k8s.namespace.name`, `k8s.node.name`, `k8s.pod.name`,
`k8s.container.name`, `k8s.deployment.name`, `k8s.statefulset.name`,
`k8s.daemonset.name`, `k8s.replicaset.name`, `k8s.job.name`, `k8s.cronjob.name`,
`k8s.hpa.name`, `k8s.persistentvolumeclaim.name`, `k8s.volume.name`,
`k8s.volume.type`, `k8s.resourcequota.name`, `k8s.replicationcontroller.name`.

In PromQL they're `k8s_cluster_name`, `k8s_namespace_name`, `k8s_pod_name` and so on:
`sum by (k8s_node_name) (k8s_node_cpu_usage)`. Logs and traces are unchanged (they
keep `resource.k8s.*`). Application metrics get them only when their resource has
them: as sent, or added by the agent with `otlp.internalTrafficPolicy: Local`; their
series then split by pod, and `sum by` totals stay the same. Data from agents before
0.3.0 has no such labels.

If you run your own OpenTelemetry Collector with `k8sattributes` instead of this
agent, add the same processor to its metrics pipelines, after `k8sattributes`:

```yaml
processors:
  transform/k8slabels:
    error_mode: ignore
    metric_statements:
      - context: datapoint
        statements:
          - set(attributes["k8s.cluster.name"], resource.attributes["k8s.cluster.name"]) where resource.attributes["k8s.cluster.name"] != nil and attributes["k8s.cluster.name"] == nil
          - set(attributes["k8s.namespace.name"], resource.attributes["k8s.namespace.name"]) where resource.attributes["k8s.namespace.name"] != nil and attributes["k8s.namespace.name"] == nil
          - set(attributes["k8s.node.name"], resource.attributes["k8s.node.name"]) where resource.attributes["k8s.node.name"] != nil and attributes["k8s.node.name"] == nil
          - set(attributes["k8s.pod.name"], resource.attributes["k8s.pod.name"]) where resource.attributes["k8s.pod.name"] != nil and attributes["k8s.pod.name"] == nil
          - set(attributes["k8s.container.name"], resource.attributes["k8s.container.name"]) where resource.attributes["k8s.container.name"] != nil and attributes["k8s.container.name"] == nil
          - set(attributes["k8s.deployment.name"], resource.attributes["k8s.deployment.name"]) where resource.attributes["k8s.deployment.name"] != nil and attributes["k8s.deployment.name"] == nil
          - set(attributes["k8s.statefulset.name"], resource.attributes["k8s.statefulset.name"]) where resource.attributes["k8s.statefulset.name"] != nil and attributes["k8s.statefulset.name"] == nil
          - set(attributes["k8s.daemonset.name"], resource.attributes["k8s.daemonset.name"]) where resource.attributes["k8s.daemonset.name"] != nil and attributes["k8s.daemonset.name"] == nil
          - set(attributes["k8s.replicaset.name"], resource.attributes["k8s.replicaset.name"]) where resource.attributes["k8s.replicaset.name"] != nil and attributes["k8s.replicaset.name"] == nil
          - set(attributes["k8s.job.name"], resource.attributes["k8s.job.name"]) where resource.attributes["k8s.job.name"] != nil and attributes["k8s.job.name"] == nil
          - set(attributes["k8s.cronjob.name"], resource.attributes["k8s.cronjob.name"]) where resource.attributes["k8s.cronjob.name"] != nil and attributes["k8s.cronjob.name"] == nil
          - set(attributes["k8s.hpa.name"], resource.attributes["k8s.hpa.name"]) where resource.attributes["k8s.hpa.name"] != nil and attributes["k8s.hpa.name"] == nil
          - set(attributes["k8s.persistentvolumeclaim.name"], resource.attributes["k8s.persistentvolumeclaim.name"]) where resource.attributes["k8s.persistentvolumeclaim.name"] != nil and attributes["k8s.persistentvolumeclaim.name"] == nil
          - set(attributes["k8s.volume.name"], resource.attributes["k8s.volume.name"]) where resource.attributes["k8s.volume.name"] != nil and attributes["k8s.volume.name"] == nil
          - set(attributes["k8s.volume.type"], resource.attributes["k8s.volume.type"]) where resource.attributes["k8s.volume.type"] != nil and attributes["k8s.volume.type"] == nil
          - set(attributes["k8s.resourcequota.name"], resource.attributes["k8s.resourcequota.name"]) where resource.attributes["k8s.resourcequota.name"] != nil and attributes["k8s.resourcequota.name"] == nil
          - set(attributes["k8s.replicationcontroller.name"], resource.attributes["k8s.replicationcontroller.name"]) where resource.attributes["k8s.replicationcontroller.name"] != nil and attributes["k8s.replicationcontroller.name"] == nil
```

### Cluster state and events

Some of what a cluster's dashboards need isn't on any one node: pod phase, restarts,
requests and limits, replica counts, node conditions, events. A single-replica
Deployment, `<release>-cluster`, collects it (`clusterState.enabled`, default `true`)
with the same image, Secret, environment and cluster name, and its own ConfigMap and
ServiceAccount:

- **Cluster metrics** (`k8s_cluster`, every `clusterState.collectionInterval`, 30 s)
  when metrics are enabled. It also adds each pod's workload, so pod and container
  metrics get the same `service.name` as the kubelet's.
- **Kubernetes events** (`k8s_objects`, watching `events.k8s.io/v1` Events) when logs
  are enabled, as logs named `kubernetes-events` (`ezgh.metadata.application:
  kubernetes`), in the event's namespace (`k8s.namespace.name`). The body is the
  event's note, the level is `WARN` for Warning events and `INFO` for Normal ones, and
  the attributes are `k8s.event.reason`, `k8s.event.type`, `k8s.object.kind`,
  `k8s.object.name` and `k8s.event.count`. A repeating event is sent again with a
  higher count; expiring events aren't sent; events during a restart of the Deployment
  are missed.
- **One replica, `Recreate`**: two would send every cluster series twice. A rollout
  leaves a gap of about one collection interval.

It runs as a non-root user, reads no host files and keeps its export queues in an
`emptyDir` (they survive a Collector restart, not a new pod). Its scheduling and
budget are its own: `clusterState.nodeSelector`, `tolerations`, `affinity`,
`priorityClassName`, `resources` and `memoryLimiter`. `clusterState.enabled: false`
removes the Deployment, its ConfigMap, ServiceAccount and RBAC.

### Agent self-telemetry

When metrics are enabled, each agent also sends its own Collector metrics to its own
OTLP receiver every 60 seconds, through its normal metrics pipeline, with
`service.name` `ezgh-obs-agent` and `service.instance.id` set to its node's name (the
cluster-state agent's is `cluster-state`): items accepted and refused by receivers,
sent and failed by exporters, queue size and capacity, and process memory and CPU.
They're about 65 series per node agent. The same metrics stay on each pod's port 8888.
It passes through the pipeline once; processing it only moves counters that are sent
anyway, so it can't grow on itself. One side effect: at shutdown the Collector's
final self-telemetry flush finds its receiver already stopped, so it exits with
status 1 after a clean shutdown.

### Volume

For a 10-node cluster with 300 pods, 0.3.0 sends about 18,000 metric series every
30 seconds, against about 12,000 for 0.2.0: request/limit utilization, uptime and
inodes add about 6 per pod and container; cluster state about 9 per container, 2 per
pod, 2 to 5 per workload and 8 per node, once for the cluster, plus 9 per container for
`k8s.container.status.reason`; self-telemetry about 65 per agent at 60 seconds. The
copied labels add no series; each copied value is stored a second time, a few percent
of compressed bytes. Events are one log record per event or repeat, usually far fewer
than container logs. Turn cluster state off, or raise
`clusterState.collectionInterval`, to send less.

Arbitrary pod-label enrichment, Prometheus target discovery, control-plane metrics
and automatic application instrumentation are not included.

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
API if you want that correlation, or set `otlp.internalTrafficPolicy: Local` so the
agent adds it (see [Service names from workloads](#service-names-from-workloads));
by default the Service may send data to any agent node.

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
| `metrics.kubelet.podSpecs` | `auto` (default), `true` or `false`: read pod specs from the kubelet's `/pods` for request/limit utilization and volume types. `auto` is on for Kubernetes 1.33+. See [Privileges](#privileges-and-delivery). |
| `clusterState.enabled` | Default `true`: the cluster-state Deployment (cluster metrics and events). `false` removes it and its RBAC. |
| `clusterState.collectionInterval` | Default `30s`. |
| `clusterState.resources`, `clusterState.memoryLimiter` | Its own budget; raise both for large clusters. |
| `clusterState.nodeSelector`, `clusterState.tolerations`, `clusterState.affinity`, `clusterState.priorityClassName` | Where it runs. Linux selection is mandatory. |
| `metrics.kubelet.endpoint` | Default node IPv4 address on HTTPS 10250; supports Collector `${env:…}` substitutions. |
| `metrics.kubelet.caConfigMap`, `metrics.kubelet.caKey` | Custom kubelet CA; otherwise use the ServiceAccount CA. |
| `metrics.kubelet.insecureSkipVerify` | Default `false`. An explicit opt-out for clusters with untrusted kubelet serving certificates; retains encryption but skips server identity verification. |
| `logs.parseSeverity` | Default `true`: a container log's level from its text when the runtime has none. |
| `kubernetesMetadata.enabled` | Default `true`: pod and owner-workload metadata from the API for this node's pods, and service names from workloads. |
| `otlp.internalTrafficPolicy` | `Cluster` (default) or `Local`. `Local` keeps application OTLP on its node's agent, which then adds the same metadata. |
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
The log hostPath is read-only. Kubelet access grants only `get` on `nodes/stats`
and, on Kubernetes 1.33+, `nodes/pods`; pod metadata needs only `get`, `list` and
`watch` on pods, ReplicaSets and Jobs.

Request/limit utilization and volume types read pod specs from the kubelet's `/pods`.
From Kubernetes 1.33 kubelets authorize that with `nodes/pods` (KubeletFineGrainedAuthz,
beta and on by default); older ones only with `nodes/proxy`, which also allows running
commands in pods, so the chart never grants it. `metrics.kubelet.podSpecs: auto` turns
this on when Helm reports a 1.33+ API server. It runs as a second kubelet receiver
(`kubelet_stats/pods`, with the volume metrics), so a kubelet that refuses `/pods`, such
as a node pool still behind its upgraded control plane, loses only utilization and
volume metrics (and logs a `403` every interval), never its node, pod and container
metrics. Set `false` if your kubelets have the gate off, and `true` on an older cluster
only if they have it on.

The cluster-state Deployment's own ServiceAccount has cluster-wide `get`, `list` and
`watch` on namespaces, nodes, pods, services, resource quotas, replication controllers,
PersistentVolumeClaims, Deployments, StatefulSets, DaemonSets, ReplicaSets, Jobs,
CronJobs and HorizontalPodAutoscalers (when metrics are enabled), and on
`events.k8s.io` Events (when logs are). The DaemonSet gains only `nodes/pods` (1.33+).
Neither can read Secrets or ConfigMaps through the API.

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
kubectl -n ezgh-obs get deployment ezgh-obs-agent-cluster
kubectl -n ezgh-obs logs -l app.kubernetes.io/instance=ezgh-obs-agent --tail=50
```

Ready pods mean the collector process is healthy, not that EZGH has accepted data.
Check the destination dataset for recent logs and metrics; traces arrive only
when applications emit them. Agent Prometheus self-metrics are available on each
pod's port 8888 for your existing scraper, without a public Service, and in EZGH
as `job="ezgh-obs-agent"` (see [Agent self-telemetry](#agent-self-telemetry)).
Inspect exporter queue size, enqueue/send failures and receiver refusals.

| Symptom | Check |
| --- | --- |
| `CreateContainerConfigError` | The named Secret and its entry exist in the release namespace. |
| Kubelet certificate error | Configure the serving CA and matching endpoint; use the explicit verification opt-out only if intended. |
| Kubelet `403` | Node webhook authorization and the generated `nodes/stats` binding. |
| Export `401`/`403` | Key validity and all enabled signal permissions. These failures are not a durable holding mechanism; fix and restart after key rotation. |
| Export `429`/`503` | Backend throttling/outage; inspect queue and disk capacity. |
| Missing node data | DaemonSet coverage, taints, node selectors, log exclusions and network access to kubelet 10250. |
| Kubelet `/pods` `403`, no utilization or volume metrics | The kubelets don't accept `nodes/pods` (before 1.33, or KubeletFineGrainedAuthz off). Upgrade the node pool, or set `metrics.kubelet.podSpecs: false` to get volume metrics without types. |
| No cluster state or events | The `-cluster` Deployment is running and its ClusterRole binding exists; `clusterState.enabled`. |

After replacing the Secret token, restart the DaemonSet because the token is read
from the environment at process startup:

```sh
kubectl -n ezgh-obs rollout restart daemonset/ezgh-obs-agent deployment/ezgh-obs-agent-cluster
kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent
kubectl -n ezgh-obs rollout status deployment/ezgh-obs-agent-cluster
```

Use the same `helm upgrade --install` command with an explicit new chart version
for upgrades. With Helm 3, don't upgrade from 0.2.x with `--reuse-values` alone: it keeps
the old chart's defaults, which lack 0.3.0's new settings, and the values schema rejects
the upgrade. Pass your settings again, or use `--reset-then-reuse-values`. Configuration changes roll pods automatically; updates use zero
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
bun run package                    # dist/ezgh-obs-agent-0.3.0.tgz
```

Set `COLLECTOR_BIN` to use an existing binary. Offline validation substitutes
kubelet authentication because there is no projected Kubernetes token outside
a pod; CI's real multi-node test covers the rendered ServiceAccount configuration.
Set `TEST_CA_FILE` if your system CA bundle is not `/etc/ssl/cert.pem`.

The integration test runs real Collector processes, a fixture kubelet HTTPS server,
and a local sink: all three signals, kubelet polling, gzip/auth headers, CRI parsing, source metadata, Kubernetes
labels on datapoints, self-telemetry, forced-restart queue recovery, and the cluster-state
Collector's event transformation (with OTLP standing in for the Kubernetes API). It sends no
telemetry to EZGH. CI additionally installs the chart in a disposable two-worker kind cluster
(Kubernetes 1.34) and verifies node metrics, pod logs, traces, one series per pod, cluster
state, events, self-telemetry, TLS export, and rolling restarts (`scripts/smoke-check.ts`
reads the sink's output). `scripts/smoke.sh` refuses any context other than `kind-ezgh-obs-agent`.

To release, increment `Chart.yaml`'s `version`, update the install examples, and
push the matching `v<version>` tag. The release workflow reruns CI, publishes
the Helm archive and SHA256SUMS as public GitHub Release assets, pushes the same
archive to `oci://ghcr.io/ezgamehost/charts`, and checks that it pulls anonymously
with the pushed digest (`scripts/publish-oci.sh`). Running the workflow by hand
with an existing tag publishes that release's verified archive to GHCR. This repository
does not deploy an agent into a production cluster.

Licensed under [Apache-2.0](LICENSE). OpenTelemetry is a CNCF project; this chart
is maintained by EZGH Cloud and is not an upstream OpenTelemetry distribution.
