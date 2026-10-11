// Reads the kind smoke test sink's debug-exporter output (verbosity: detailed) and prints each
// check that isn't met yet, one per line. Nothing printed: all met.
type Attrs = Record<string, string>;
type Point = { metric: string; resource: Attrs; attributes: Attrs; value: string };
type Log = { resource: Attrs; attributes: Attrs; severity: string; body: string };

export function parse(text: string) {
  const points: Point[] = [];
  const logs: Log[] = [];
  let resource: Attrs = {};
  let metric = "";
  let point: Point | undefined;
  let log: Log | undefined;
  let target: Attrs | undefined;
  for (const line of text.split("\n")) {
    if (/(ResourceMetrics|ResourceLog|ResourceSpans) #\d+/.test(line)) {
      resource = {}; point = undefined; log = undefined; target = undefined; continue;
    }
    const attr = line.match(/^ {5}-> ([^:]+): (?:\w+)\((.*)\)$/);
    if (attr && target) { target[attr[1]] = attr[2]; continue; }
    const name = line.match(/^ {5}-> Name: (.+)$/);
    if (name) { metric = name[1]; continue; }
    target = undefined;
    if (line === "Resource attributes:") target = resource;
    else if (/^(Number|Histogram|ExponentialHistogram|Summary)DataPoints #\d+/.test(line)) {
      point = { metric, resource, attributes: {}, value: "" };
      points.push(point);
    } else if (line === "Data point attributes:" && point) target = point.attributes;
    else if (line.startsWith("Value: ") && point) point.value = line.slice(7);
    else if (/^LogRecord #\d+/.test(line)) {
      log = { resource, attributes: {}, severity: "", body: "" };
      logs.push(log);
    } else if (line.startsWith("SeverityText: ") && log) log.severity = line.slice(14);
    else if (line.startsWith("Body: ") && log) log.body = line.replace(/^Body: \w+\((.*)\)$/, "$1");
    else if (line === "Attributes:" && log) target = log.attributes;
  }
  return { points, logs };
}

const workers = ["ezgh-obs-agent-worker", "ezgh-obs-agent-worker2"];

export function missing(text: string): string[] {
  const { points, logs } = parse(text);
  const of = (metric: string) => points.filter((p) => p.metric === metric);
  const checks: [string, boolean][] = [
    // Fix 1: two pods of one Deployment are two series, by the k8s.pod.name point attribute.
    ["two smoke-web pods as two k8s.pod.name series (kubelet)", new Set(of("k8s.pod.cpu.time")
      .filter((p) => p.attributes["k8s.deployment.name"] === "smoke-web").map((p) => p.attributes["k8s.pod.name"])).size >= 2],
    ["k8s.node.name and k8s.cluster.name point labels on both nodes' metrics", workers.every((node) => of("k8s.node.cpu.time")
      .some((p) => p.attributes["k8s.node.name"] === node && p.attributes["k8s.cluster.name"] === "test-cluster"))],
    ["request/limit utilization (kubelet /pods via nodes/pods)", of("k8s.container.memory_limit_utilization")
      .some((p) => p.attributes["k8s.container.name"] === "web")],
    ["cluster state: smoke-web pod phase, named after its Deployment", of("k8s.pod.phase").some((p) =>
      p.attributes["k8s.deployment.name"] === "smoke-web" && p.resource["service.name"] === "smoke-web" && p.value === "2")],
    ["cluster state: container restarts", of("k8s.container.restarts").some((p) => p.attributes["k8s.container.name"] === "web")],
    ["cluster state: node Ready condition and allocatable CPU", of("k8s.node.condition").some((p) => p.attributes.condition === "Ready")
      && of("k8s.node.allocatable_cpu").some((p) => workers.includes(p.attributes["k8s.node.name"]))],
    ["cluster state: smoke-broken image pull reason", of("k8s.container.status.reason").some((p) =>
      p.attributes["k8s.pod.name"] === "smoke-broken" && p.value === "1"
      && ["ErrImagePull", "ImagePullBackOff"].includes(p.attributes["k8s.container.status.reason"]))],
    ["event: ScalingReplicaSet (INFO) for smoke-web", logs.some((l) => l.resource["service.name"] === "kubernetes-events"
      && l.resource["ezgh.metadata.application"] === "kubernetes" && l.resource["k8s.cluster.name"] === "test-cluster"
      && l.resource["k8s.namespace.name"] === "default" && l.severity === "INFO" && l.body !== ""
      && l.attributes["k8s.event.reason"] === "ScalingReplicaSet" && l.attributes["k8s.event.type"] === "Normal"
      && l.attributes["k8s.object.kind"] === "Deployment" && l.attributes["k8s.object.name"] === "smoke-web"
      && l.attributes["k8s.event.count"] !== undefined)],
    ["event: a WARN for smoke-broken", logs.some((l) => l.resource["service.name"] === "kubernetes-events"
      && l.severity === "WARN" && l.attributes["k8s.object.name"] === "smoke-broken")],
    ...workers.map((node): [string, boolean] => [`self-telemetry from ${node}`, of("otelcol_process_uptime").some((p) =>
      p.resource["service.name"] === "ezgh-obs-agent" && p.resource["service.instance.id"] === node
      && p.attributes["k8s.node.name"] === node && p.attributes["k8s.cluster.name"] === "test-cluster")]),
    ["self-telemetry from cluster-state", of("otelcol_process_uptime").some((p) =>
      p.resource["service.name"] === "ezgh-obs-agent" && p.resource["service.instance.id"] === "cluster-state"
      && p.attributes["k8s.cluster.name"] === "test-cluster")],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

if (import.meta.main) {
  for (const name of missing(await Bun.file(process.argv[2]).text())) console.log(name);
}
