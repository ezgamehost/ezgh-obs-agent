# Kubernetes agent chart

One public, independently versioned Helm chart installs a Linux DaemonSet using
OpenTelemetry Collector Contrib. Each node tails its container logs and polls its
kubelet; an internal OTLP Service accepts instrumented application telemetry.
All signals leave via OTLP/HTTP protobuf with gzip and verified HTTPS.

One release targets one project (selected by an existing Secret's ingest key)
and one environment. Installation overwrites the environment and cluster name;
it preserves application/service attributes and fills missing application names.
Node identity is attached only to locally collected telemetry, never to arbitrary
OTLP traffic routed by the Service. No Kubernetes metadata watch cache is added.
Log identity comes from CRI paths; metric identity comes from kubelet responses.

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

No UI, application auto-instrumentation, arbitrary Prometheus discovery, cluster
state singleton, new ingestion API, or production deployment is included in v1.
The chart's source and packaged GitHub Release are public, and the same archive is
published as a public OCI artifact at `oci://ghcr.io/ezgamehost/charts/ezgh-obs-agent`
(the preferred install source); credentials are never stored in Helm values.
