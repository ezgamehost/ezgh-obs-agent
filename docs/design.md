# Kubernetes agent chart

One public, independently versioned Helm chart installs a Linux DaemonSet (and, since
0.3.0, a one-replica cluster-state Deployment) using OpenTelemetry Collector Contrib. Each node tails its container logs and polls its
kubelet; an internal OTLP Service accepts instrumented application telemetry.
All signals leave via OTLP/HTTP protobuf with gzip and verified HTTPS.

One release targets one project (selected by an existing Secret's ingest key)
and one environment. Installation overwrites the environment and cluster name;
it preserves application/service attributes and fills missing application names.
Node identity is attached only to locally collected telemetry, never to arbitrary
OTLP traffic routed by the Service. Log identity comes from CRI paths; metric
identity comes from kubelet responses. Since 0.2.0 each agent also watches its own
node's pods (k8sattributes, node-filtered; read-only pods, ReplicaSets and Jobs)
to add pod and owner-workload metadata, and names telemetry without a real
`service.name` after its Deployment (or StatefulSet, DaemonSet, CronJob, Job).
Application OTLP is enriched only when the Service's internalTrafficPolicy is
Local, so a pod is never matched by an agent that doesn't watch it. Container
logs without a level get one parsed from common formats (JSON, logfmt, klog, a
leading level word), stored as canonical text and number; unmatched lines stay
unset.

Use pinned upstream components, read-only log mounts, root without capabilities
for host-file access, read-only root filesystem, and a dedicated writable hostPath
for file offsets and export queues. Separate queues per signal prevent one signal
from consuming the others' capacity. Bound batches by serialized bytes below the
ingest request cap; persist before batching to minimize acknowledged volatile data.
Document at-least-once retries, node-loss limitations, finite disk capacity, and
rotation/uninstall behavior. Health probes check the process, not remote ingestion.

Values expose signal toggles, log exclusions, kubelet TLS, resources, scheduling,
queue capacity, and Secret references. Validate values and validate rendered
Collector configuration using the exact pinned Collector binary. Test forwarding
all signals through a local OTLP sink, and a disposable multi-node cluster in CI.

Since 0.3.0 (for EZGH's built-in Kubernetes dashboards, service-template
`docs/observability/kubernetes-dashboards.md`, D13):

- **Kubernetes labels.** obs's PromQL labels only `service.name`/`service.instance.id` among
  resource attributes, so per-node and per-pod series would merge. `transform/k8slabels`, last on
  every metrics pipeline, copies the `k8s.*` identity attributes (cluster, namespace, node, pod,
  container, workloads, HPA, PVC, volume, quota) onto datapoints when the resource has them and
  the datapoint doesn't. Resource attributes, logs and traces are unchanged.
- **Cluster state singleton.** A one-replica `Recreate` Deployment (`clusterState`) runs
  `k8s_cluster` (with node conditions, allocatable, PVC and status-reason metrics) and
  `k8s_objects` on `events.k8s.io` Events, which become logs (`kubernetes-events`; note as body,
  Warning/Normal as WARN/INFO; reason, type, object and count attributes; DELETED watch events,
  which are TTL expiry, dropped). A cluster-wide `k8sattributes` names pods' workloads so `job`
  matches the kubelet metrics. Own ServiceAccount and read-only ClusterRole, so the DaemonSet's
  RBAC doesn't grow; non-root, no host paths, queues in an emptyDir. Two replicas would double
  every series; leader election is a later option.
- **Pod specs from the kubelet.** Request/limit utilization and volume types read `/pods`, which
  kubelets authorize with `nodes/pods` from 1.33 (KubeletFineGrainedAuthz) and otherwise only with
  `nodes/proxy`, which allows exec into pods and is never granted. `podSpecs: auto` turns it on
  where Helm reports a 1.33+ API server. A failed `/pods` read fails the whole scrape, and kubelets
  may lag the control plane, so these metrics (with the volume group, which needs the specs for
  volume types) run in a second `kubelet_stats/pods` receiver: a lagging node loses only those.
  The cost is a second `/stats/summary` read per node per interval.
- **Self-telemetry.** A second periodic reader sends each Collector's metrics every 60 s to its
  own OTLP receiver (`service.name=ezgh-obs-agent`, instance = node or `cluster-state`), through
  the normal metrics pipeline once. The Prometheus pull endpoint on 8888 stays. The final flush at
  shutdown finds the receiver stopped, so the Collector exits 1 after a clean shutdown.

No UI, application auto-instrumentation, arbitrary Prometheus discovery, control-plane metrics,
new ingestion API, or production deployment is included.
The chart's source and packaged GitHub Release are public, and the same archive is
published as a public OCI artifact at `oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent`
(the preferred install source); credentials are never stored in Helm values.
