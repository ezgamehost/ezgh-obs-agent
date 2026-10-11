import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, openSync, closeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { render } from "./helpers";

const binary = process.env.COLLECTOR_BIN ?? ".tools/otelcol-contrib";

async function port(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = (server.address() as any).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}

type Point = { name: string; resource: Record<string, unknown>; attributes: Record<string, unknown> };

function value(v: any): unknown {
  return v?.stringValue ?? (v?.intValue !== undefined ? Number(v.intValue) : v?.doubleValue ?? v?.boolValue);
}

function attributeMap(list: any[] | undefined) {
  return Object.fromEntries((list ?? []).map((a) => [a.key, value(a.value)]));
}

// Every number datapoint the sink received, with its metric name and resource.
function metricPoints(records: any[]): Point[] {
  return records.flatMap((r) => r.resourceMetrics ?? []).flatMap((rm) => {
    const resource = attributeMap(rm.resource.attributes);
    return rm.scopeMetrics.flatMap((sm) => sm.metrics.flatMap((m) =>
      ((m.gauge ?? m.sum ?? m.histogram)?.dataPoints ?? []).map((d) =>
        ({ name: m.name, resource, attributes: attributeMap(d.attributes) }))));
  });
}

async function eventually(check: () => Promise<void>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (e) { error = e; }
    await Bun.sleep(100);
  }
  throw error;
}

// The chart's configs use current component names and formats: the Collector logs no deprecation
// warnings for them ("alias is deprecated", "legacy … format").
async function expectNoDeprecations(log: string) {
  const warnings = (await Bun.file(log).text()).split("\n")
    .filter((line) => /"level":"warn"/.test(line) && /deprecated|legacy/i.test(line));
  expect(warnings).toEqual([]);
}

test("real Collector forwards all signals, parses CRI, and replays durable queues after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ezgh-collector-test-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const fds: number[] = [];
  let proxy: ReturnType<typeof Bun.serve> | undefined;
  let kubelet: ReturnType<typeof Bun.serve> | undefined;
  try {
    const [sinkPort, httpPort, grpcPort, healthPort, metricsPort] = await Promise.all(
      Array.from({ length: 5 }, () => port()));
    const output = join(dir, "received.json");
    const sinkConfig = {
      receivers: { otlp: { protocols: { http: { endpoint: `127.0.0.1:${sinkPort}` } } } },
      exporters: { file: { path: output, flush_interval: "100ms" } },
      service: { telemetry: { metrics: { level: "none" } }, pipelines: Object.fromEntries(
        ["logs", "metrics", "traces"].map((s) => [s, { receivers: ["otlp"], exporters: ["file"] }])) },
    };
    async function launch(name: string, config: any, env: Record<string, string> = {}) {
      const path = join(dir, `${name}.yaml`);
      await Bun.write(path, Bun.YAML.stringify(config));
      const fd = openSync(join(dir, `${name}.log`), "a");
      fds.push(fd);
      const child = Bun.spawn([binary, `--config=${path}`], {
        env: { ...process.env, ...env }, stdout: fd, stderr: fd,
      });
      children.push(child);
      return child;
    }
    await launch("sink", sinkConfig);
    const requests: { path: string; auth: string | null; encoding: string | null }[] = [];
    let unavailable = false;
    proxy = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const path = new URL(request.url).pathname;
      requests.push({ path, auth: request.headers.get("authorization"), encoding: request.headers.get("content-encoding") });
      if (unavailable) return new Response("unavailable", { status: 503 });
      return fetch(`http://127.0.0.1:${sinkPort}${path}`, {
        method: "POST", headers: request.headers, body: await request.arrayBuffer(),
      });
    } });
    const cert = join(dir, "cert.pem");
    const key = join(dir, "key.pem");
    expect(Bun.spawnSync(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
      "-subj", "/CN=localhost", "-keyout", key, "-out", cert]).exitCode).toBe(0);
    let kubeletRequests = 0;
    let podsRequests = 0;
    kubelet = Bun.serve({ hostname: "127.0.0.1", port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch(request) {
        // Pod specs, for request/limit utilization and volume types (podSpecs).
        if (new URL(request.url).pathname === "/pods") {
          podsRequests++;
          return Response.json({ kind: "PodList", apiVersion: "v1", items: [{
            metadata: { name: "web-1", namespace: "shop", uid: "uid-web-1" },
            spec: { containers: [{ name: "web", resources: { requests: { cpu: "100m", memory: "16Mi" }, limits: { cpu: "1", memory: "64Mi" } } }],
              volumes: [{ name: "data", persistentVolumeClaim: { claimName: "data-web-1" } }] },
            status: { containerStatuses: [{ name: "web", containerID: "containerd://abc" }] },
          }] });
        }
        if (new URL(request.url).pathname !== "/stats/summary") return new Response(null, { status: 404 });
        kubeletRequests++;
        const time = new Date().toISOString();
        return Response.json({ node: { nodeName: "collector-node", startTime: time,
          cpu: { time, usageCoreNanoSeconds: 1000000, usageNanoCores: 1000 },
          memory: { time, usageBytes: 2048, workingSetBytes: 1024, availableBytes: 1048576 },
        }, pods: [{ podRef: { name: "web-1", namespace: "shop", uid: "uid-web-1" }, startTime: time,
          cpu: { time, usageCoreNanoSeconds: 1000000, usageNanoCores: 1000 },
          memory: { time, usageBytes: 4096, workingSetBytes: 2048, rssBytes: 1024 },
          containers: [{ name: "web", startTime: time, cpu: { time, usageCoreNanoSeconds: 1000000, usageNanoCores: 1000 },
            memory: { time, usageBytes: 4096, workingSetBytes: 2048, rssBytes: 1024 } }],
          volume: [{ name: "data", time, availableBytes: 900, capacityBytes: 1000, usedBytes: 100,
            inodesFree: 90, inodes: 100, inodesUsed: 10, pvcRef: { name: "data-web-1", namespace: "shop" } }],
        }] });
      },
    });
    const { config } = render(["--set", "metrics.collectionInterval=1s"]);
    // Keep the chart's URL shape and NODE_IP expansion; only substitute fixture port/auth.
    expect(Object.keys(config.receivers).filter((r) => r.startsWith("kubelet_stats"))).toEqual(["kubelet_stats", "kubelet_stats/pods"]);
    for (const receiver of [config.receivers.kubelet_stats, config.receivers["kubelet_stats/pods"]]) {
      receiver.endpoint = receiver.endpoint.replace(":10250", `:${kubelet.port}`);
      receiver.auth_type = "tls";
      receiver.cert_file = cert;
      receiver.key_file = key;
      receiver.insecure_skip_verify = true;
      receiver.ca_file = cert;
    }
    // No Kubernetes API here: the kind smoke test covers pod metadata; this one checks the naming
    // rule on attributes as k8s_attributes would leave them.
    delete config.processors.k8s_attributes;
    for (const pipeline of Object.values(config.service.pipelines) as any[]) {
      pipeline.processors = pipeline.processors.filter((p: string) => p !== "k8s_attributes");
    }
    config.extensions.file_storage.directory = join(dir, "storage");
    config.extensions.file_storage.compaction.directory = join(dir, "compaction");
    config.extensions.health_check.endpoint = `127.0.0.1:${healthPort}`;
    config.receivers.otlp.protocols.http.endpoint = `127.0.0.1:${httpPort}`;
    config.receivers.otlp.protocols.grpc.endpoint = `127.0.0.1:${grpcPort}`;
    config.service.telemetry.metrics.readers[0].pull.exporter.prometheus.port = metricsPort;
    // Self-telemetry goes to this agent's own OTLP receiver; sooner than 60 s here.
    const selfReader = config.service.telemetry.metrics.readers[1].periodic;
    expect(selfReader.exporter.otlp.endpoint).toBe("http://127.0.0.1:4318/v1/metrics");
    selfReader.interval = 1000;
    selfReader.exporter.otlp.endpoint = `http://127.0.0.1:${httpPort}/v1/metrics`;
    const logRoot = join(dir, "var/log/pods");
    const logDir = join(logRoot, "default_checkout-abc_12345678-1234-1234-1234-123456789abc/app");
    mkdirSync(logDir, { recursive: true });
    config.receivers.file_log.include = [`${logRoot}/*/*/*.log`];
    for (const exporter of Object.values(config.exporters) as any[]) {
      exporter.endpoint = `http://127.0.0.1:${proxy.port}`;
    }
    const env = { NODE_NAME: "collector-node", NODE_IP: "127.0.0.1", POD_NAME: "agent",
      POD_NAMESPACE: "ezgh-obs", CLUSTER_NAME: "test-cluster", EZGH_ENVIRONMENT: "production",
      EZGH_INGEST_KEY: "test-placeholder-not-a-credential" };
    let agent = await launch("agent", config, env);
    async function healthy() {
      await eventually(async () => {
        expect(agent.exitCode).toBeNull();
        expect((await fetch(`http://127.0.0.1:${healthPort}`)).status).toBe(200);
      });
    }
    await healthy();
    const attributes = [
      { key: "service.name", value: { stringValue: "checkout" } },
      { key: "k8s.node.name", value: { stringValue: "application-node" } },
      { key: "ezgh.metadata.environment", value: { stringValue: "untrusted-environment" } },
    ];
    const now = String(BigInt(Date.now()) * 1000000n);
    async function send(signal: string, payload: object) {
      const response = await fetch(`http://127.0.0.1:${httpPort}/v1/${signal}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload),
      });
      expect(response.status).toBe(200);
    }
    const logs = (body: string) => ({ resourceLogs: [{ resource: { attributes }, scopeLogs: [{
      logRecords: [{ timeUnixNano: now, body: { stringValue: body } }],
    }] }] });
    await send("logs", logs("otlp-marker"));
    // An SDK's default name gives way to the Deployment's; a name the app chose doesn't.
    const owned = (service: string, body: string) => ({ resourceLogs: [{ resource: { attributes: [
      { key: "service.name", value: { stringValue: service } },
      { key: "k8s.deployment.name", value: { stringValue: "storefront-web" } },
      { key: "k8s.node.name", value: { stringValue: "application-node" } },
    ] }, scopeLogs: [{ logRecords: [{ timeUnixNano: now, body: { stringValue: body } }] }] }] })
    await send("logs", owned("unknown_service:node", "deployment-marker"));
    await send("logs", owned("cart-api", "named-marker"));
    await send("metrics", { resourceMetrics: [{ resource: { attributes }, scopeMetrics: [{ metrics: [{
      name: "smoke.gauge", gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 42,
        attributes: [{ key: "k8s.node.name", value: { stringValue: "point-node" } }] }] },
    }] }] }] });
    await send("traces", { resourceSpans: [{ resource: { attributes }, scopeSpans: [{ spans: [{
      traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "smoke-span",
      startTimeUnixNano: now, endTimeUnixNano: String(BigInt(now) + 1000000n),
    }] }] }] });
    // Levels the runtime doesn't give: each line's expected severity text (null: left unset).
    const levels: Array<[string, string | null]> = [
      [`{"level":"warn","msg":"json-level-marker"}`, "WARN"],
      [`{"level":50,"msg":"pino-level-marker"}`, "ERROR"],
      [`{"severity":"DEBUG","message":"json-severity-marker"}`, "DEBUG"],
      [`ts=2026-10-10T12:00:00Z level=error msg=logfmt-marker`, "ERROR"],
      [`E1010 12:00:00.000000       1 controller.go:42] klog-marker`, "ERROR"],
      [`2026-10-10 12:00:00.123 [main] WARN  com.example.App - java-marker`, "WARN"],
      [`2026/10/10 12:00:00 [error] 12#0: nginx-marker`, "ERROR"],
      [`INFO:root:python-marker`, "INFO"],
      [`[2026-10-10T12:00:00Z] notice: notice-marker`, "INFO"],
      [`Information about plain-marker`, null],
      [`{"msg":"json-without-level-marker"}`, null],
    ];
    const time = new Date().toISOString();
    await Bun.write(join(logDir, "0.log"), [`${time} stdout F cri-marker`, ...levels.map(([line]) => `${time} stderr F ${line}`)].join("\n") + "\n");
    async function records() {
      return (await Bun.file(output).text()).trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
    }
    await eventually(async () => {
      const text = JSON.stringify(await records());
      for (const marker of ["otlp-marker", "deployment-marker", "named-marker", "cri-marker", "klog-marker", "json-without-level-marker", "smoke.gauge", "smoke-span", "k8s.node.cpu", "k8s.node.uptime", "k8s.container.memory_limit_utilization", "k8s.volume.capacity", "otelcol_scraper_scraped_metric_points"]) expect(text).toContain(marker);
      expect(kubeletRequests).toBeGreaterThan(0);
      expect(podsRequests).toBeGreaterThan(0);
    });
    for (const signal of ["logs", "metrics", "traces"]) {
      expect(requests.some((r) => r.path === `/v1/${signal}` &&
        r.auth === "Bearer test-placeholder-not-a-credential" && r.encoding === "gzip")).toBe(true);
    }
    const resources = (await records()).flatMap((r) => r.resourceLogs ?? r.resourceMetrics ?? r.resourceSpans);
    for (const r of resources) {
      const attrs = Object.fromEntries(r.resource.attributes.map((a) => [a.key, a.value.stringValue]));
      expect(attrs["ezgh.metadata.environment"]).toBe("production");
      expect(attrs["k8s.cluster.name"]).toBe("test-cluster");
      if (attrs["k8s.deployment.name"] === "storefront-web") {
        const body = JSON.stringify(r);
        const expected = body.includes("deployment-marker") ? "storefront-web" : "cart-api";
        expect(attrs["service.name"]).toBe(expected);
        expect(attrs["ezgh.metadata.application"]).toBe(expected);
      } else if (attrs["service.name"] === "ezgh-obs-agent") {
        expect(attrs["service.instance.id"]).toBe("collector-node");
      } else if (attrs["service.name"] === "checkout") {
        expect(attrs["k8s.node.name"]).toBe("application-node");
        expect(attrs["ezgh.metadata.application"]).toBe("checkout");
      } else if (attrs["k8s.container.name"] === "app") {
        expect(attrs["k8s.node.name"]).toBe("collector-node");
        expect(attrs["k8s.namespace.name"]).toBe("default");
        expect(attrs["k8s.container.name"]).toBe("app");
      } else if (attrs["k8s.pod.name"] === "web-1") {
        // The fixture kubelet's pod: its container's metrics are named after the container.
        expect(attrs["k8s.node.name"]).toBe("collector-node");
        expect(attrs["ezgh.metadata.application"]).toBe(attrs["k8s.container.name"] ? "web" : "kubernetes");
      } else {
        expect(attrs["k8s.node.name"]).toBe("collector-node");
        expect(attrs["ezgh.metadata.application"]).toBe("kubernetes");
      }
    }
    // Every metric datapoint carries its resource's Kubernetes attributes as point attributes.
    const points = metricPoints(await records());
    const nodeCpu = points.filter((p) => p.name === "k8s.node.memory.working_set");
    expect(nodeCpu.length).toBeGreaterThan(0);
    for (const p of nodeCpu) {
      expect(p.attributes["k8s.node.name"]).toBe("collector-node");
      expect(p.attributes["k8s.cluster.name"]).toBe("test-cluster");
    }
    // Pod specs (kubelet_stats/pods): request/limit utilization, and volume types and PVC names.
    const limit = points.find((p) => p.name === "k8s.container.memory_limit_utilization")!;
    expect(limit.attributes).toMatchObject({ "k8s.pod.name": "web-1", "k8s.container.name": "web", "k8s.namespace.name": "shop" });
    const volume = points.find((p) => p.name === "k8s.volume.capacity")!;
    expect(volume.attributes).toMatchObject({ "k8s.volume.name": "data", "k8s.volume.type": "persistentVolumeClaim",
      "k8s.persistentvolumeclaim.name": "data-web-1", "k8s.pod.name": "web-1", "k8s.node.name": "collector-node" });
    // Each pod metric comes from one receiver only.
    const scraped = points.filter((p) => p.name === "otelcol_scraper_scraped_metric_points");
    expect(new Set(scraped.map((p) => p.attributes.receiver))).toEqual(new Set(["kubelet_stats", "kubelet_stats/pods"]));
    // Application OTLP: the resource's node (as sent) and the cluster; an attribute the
    // datapoint already had is kept.
    const app = points.find((p) => p.name === "smoke.gauge")!;
    expect(app.attributes).toEqual({ "k8s.node.name": "point-node", "k8s.cluster.name": "test-cluster" });
    const self = points.find((p) => p.name === "otelcol_process_uptime")!;
    expect(self.resource["service.name"]).toBe("ezgh-obs-agent");
    expect(self.resource["service.instance.id"]).toBe("collector-node");
    expect(self.attributes).toMatchObject({ "k8s.node.name": "collector-node", "k8s.cluster.name": "test-cluster",
      "k8s.namespace.name": "ezgh-obs", "k8s.pod.name": "agent" });
    if (process.env.DUMP_RECEIVED) await Bun.write(process.env.DUMP_RECEIVED, Bun.file(output));
    const logRecords = (await records()).flatMap((r) => r.resourceLogs ?? []).flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
    for (const [line, expected] of levels) {
      const record = logRecords.find((l) => l.body?.stringValue === line);
      expect({ line, severity: record?.severityText ?? null }).toEqual({ line, severity: expected });
      expect(record.severityNumber ?? 0).toBe(expected ? { DEBUG: 5, INFO: 9, WARN: 13, ERROR: 17 }[expected] : 0);
    }
    unavailable = true;
    await send("logs", logs("durable-replay-marker"));
    // The OTLP acknowledgement follows persistent enqueue (no volatile batch processor).
    agent.kill("SIGKILL");
    await agent.exited;
    unavailable = false;
    agent = await launch("agent", config, env);
    await healthy();
    await eventually(async () => expect(JSON.stringify(await records())).toContain("durable-replay-marker"));
    await expectNoDeprecations(join(dir, "agent.log"));
  } catch (error) {
    for (const name of ["agent", "sink"]) {
      const file = Bun.file(join(dir, `${name}.log`));
      if (await file.exists()) console.error((await file.text()).slice(-8000));
    }
    throw error;
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); }
    await Promise.all(children.map((c) => c.exited));
    proxy?.stop(true);
    kubelet?.stop(true);
    fds.forEach(closeSync);
    rmSync(dir, { recursive: true, force: true });
  }
}, 45000);

test("cluster-state Collector: events become logs, metrics get Kubernetes labels, self-telemetry arrives", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ezgh-cluster-test-"));
  const children: ReturnType<typeof Bun.spawn>[] = [];
  const fds: number[] = [];
  try {
    const [sinkPort, selfPort, eventsPort, clusterPort, healthPort, metricsPort] = await Promise.all(
      Array.from({ length: 6 }, () => port()));
    const output = join(dir, "received.json");
    const sink = {
      receivers: { otlp: { protocols: { http: { endpoint: `127.0.0.1:${sinkPort}` } } } },
      exporters: { file: { path: output, flush_interval: "100ms" } },
      service: { telemetry: { metrics: { level: "none" } }, pipelines: Object.fromEntries(
        ["logs", "metrics"].map((s) => [s, { receivers: ["otlp"], exporters: ["file"] }])) },
    };
    const { clusterConfig: config } = render();
    // No Kubernetes API here (the kind smoke test has one): OTLP stands in for k8s_objects and
    // k8s_cluster, carrying what they emit, through the chart's processors and exporters.
    expect(config.receivers.k8s_objects.objects).toEqual([{ name: "events", group: "events.k8s.io", mode: "watch", exclude_watch_type: ["DELETED"] }]);
    delete config.receivers.k8s_objects;
    delete config.receivers.k8s_cluster;
    config.receivers["otlp/events"] = { protocols: { http: { endpoint: `127.0.0.1:${eventsPort}` } } };
    config.receivers["otlp/cluster"] = { protocols: { http: { endpoint: `127.0.0.1:${clusterPort}` } } };
    config.receivers.otlp.protocols.http.endpoint = `127.0.0.1:${selfPort}`;
    config.service.pipelines["logs/events"].receivers = ["otlp/events"];
    config.service.pipelines["metrics/cluster"].receivers = ["otlp/cluster"];
    delete config.processors.k8s_attributes;
    for (const pipeline of Object.values(config.service.pipelines) as any[]) {
      pipeline.processors = pipeline.processors.filter((p: string) => p !== "k8s_attributes");
    }
    const selfReader = config.service.telemetry.metrics.readers[1].periodic;
    selfReader.interval = 1000;
    selfReader.exporter.otlp.endpoint = `http://127.0.0.1:${selfPort}/v1/metrics`;
    config.service.telemetry.metrics.readers[0].pull.exporter.prometheus.port = metricsPort;
    config.extensions.health_check.endpoint = `127.0.0.1:${healthPort}`;
    config.extensions.file_storage.directory = join(dir, "storage");
    config.extensions.file_storage.compaction.directory = join(dir, "compaction");
    for (const exporter of Object.values(config.exporters) as any[]) exporter.endpoint = `http://127.0.0.1:${sinkPort}`;
    for (const [name, c] of [["sink", sink], ["cluster", config]] as const) {
      const path = join(dir, `${name}.yaml`);
      await Bun.write(path, Bun.YAML.stringify(c));
      const fd = openSync(join(dir, `${name}.log`), "a");
      fds.push(fd);
      children.push(Bun.spawn([binary, `--config=${path}`], { stdout: fd, stderr: fd, env: { ...process.env,
        POD_NAME: "agent-cluster-abc", POD_NAMESPACE: "ezgh-obs", CLUSTER_NAME: "test-cluster",
        EZGH_ENVIRONMENT: "production", EZGH_INGEST_KEY: "test-placeholder-not-a-credential" } }));
    }
    await eventually(async () => expect((await fetch(`http://127.0.0.1:${healthPort}`)).status).toBe(200));
    const str = (v: string) => ({ stringValue: v });
    const kv = (o: Record<string, any>): any => ({ kvlistValue: { values: Object.entries(o).map(([key, v]) =>
      ({ key, value: typeof v === "string" ? str(v) : typeof v === "number" ? { intValue: String(v) } : kv(v) })) } });
    // What k8s_objects emits for a watched events.k8s.io/v1 Event (watch mode).
    const event = (name: string, object: Record<string, any>) => ({ resource: { attributes: [{ key: "k8s.namespace.name", value: str("shop") }] },
      scopeLogs: [{ logRecords: [{ observedTimeUnixNano: String(BigInt(Date.now()) * 1000000n),
        attributes: [{ key: "k8s.resource.name", value: str("events") }, { key: "event.domain", value: str("k8s") }, { key: "event.name", value: str(name) }],
        body: kv({ type: "ADDED", object: { apiVersion: "events.k8s.io/v1", kind: "Event", metadata: { name, namespace: "shop" }, ...object } }) }] }] });
    const send = async (port: number, signal: string, body: object) => {
      const response = await fetch(`http://127.0.0.1:${port}/v1/${signal}`, { method: "POST",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      expect(response.status).toBe(200);
    };
    await send(eventsPort, "logs", { resourceLogs: [
      event("web-1.abc", { reason: "BackOff", type: "Warning", note: "Back-off restarting failed container web",
        regarding: { kind: "Pod", name: "web-1", namespace: "shop" }, series: { count: 7 }, deprecatedCount: 0 }),
      event("web.def", { reason: "ScalingReplicaSet", type: "Normal", note: "Scaled up replica set web-5d9 to 2",
        regarding: { kind: "Deployment", name: "web", namespace: "shop" }, deprecatedCount: 3 }),
    ] });
    // What k8s_cluster emits for a pod: workload attributes as k8s_attributes would leave them.
    await send(clusterPort, "metrics", { resourceMetrics: [{ resource: { attributes: [
      { key: "k8s.pod.name", value: str("web-1") }, { key: "k8s.pod.uid", value: str("uid-1") },
      { key: "k8s.namespace.name", value: str("shop") }, { key: "k8s.node.name", value: str("node-a") },
      { key: "k8s.deployment.name", value: str("web") },
    ] }, scopeMetrics: [{ metrics: [{ name: "k8s.pod.phase", gauge: { dataPoints: [{ timeUnixNano: String(BigInt(Date.now()) * 1000000n), asInt: "2" }] } }] }] }] });
    const records = async () => (await Bun.file(output).text()).trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
    await eventually(async () => {
      const text = JSON.stringify(await records());
      for (const marker of ["Back-off restarting", "Scaled up replica set", "k8s.pod.phase", "otelcol_process_uptime"]) expect(text).toContain(marker);
    });
    const logs = (await records()).flatMap((r) => r.resourceLogs ?? []).flatMap((rl) =>
      rl.scopeLogs.flatMap((sl) => sl.logRecords.map((l) => ({ resource: attributeMap(rl.resource.attributes), ...l }))));
    const warning = logs.find((l) => l.body?.stringValue?.startsWith("Back-off"));
    expect(warning.resource).toMatchObject({ "service.name": "kubernetes-events", "ezgh.metadata.application": "kubernetes",
      "k8s.namespace.name": "shop", "k8s.cluster.name": "test-cluster", "ezgh.metadata.environment": "production" });
    expect(warning.severityText).toBe("WARN");
    expect(warning.severityNumber).toBe(13);
    expect(attributeMap(warning.attributes)).toEqual({ "k8s.event.reason": "BackOff", "k8s.event.type": "Warning",
      "k8s.object.kind": "Pod", "k8s.object.name": "web-1", "k8s.event.count": 7 });
    const normal = logs.find((l) => l.body?.stringValue?.startsWith("Scaled up"));
    expect(normal.severityText).toBe("INFO");
    expect(normal.severityNumber).toBe(9);
    expect(attributeMap(normal.attributes)).toEqual({ "k8s.event.reason": "ScalingReplicaSet", "k8s.event.type": "Normal",
      "k8s.object.kind": "Deployment", "k8s.object.name": "web", "k8s.event.count": 3 });
    const points = metricPoints(await records());
    const phase = points.find((p) => p.name === "k8s.pod.phase")!;
    expect(phase.resource["service.name"]).toBe("web");
    expect(phase.attributes).toEqual({ "k8s.cluster.name": "test-cluster", "k8s.namespace.name": "shop",
      "k8s.node.name": "node-a", "k8s.pod.name": "web-1", "k8s.deployment.name": "web" });
    const self = points.find((p) => p.name === "otelcol_process_uptime")!;
    expect(self.resource).toMatchObject({ "service.name": "ezgh-obs-agent", "service.instance.id": "cluster-state" });
    expect(self.attributes).toMatchObject({ "k8s.cluster.name": "test-cluster", "k8s.namespace.name": "ezgh-obs", "k8s.pod.name": "agent-cluster-abc" });
    expect(self.attributes["k8s.node.name"]).toBeUndefined();
    if (process.env.DUMP_RECEIVED_CLUSTER) await Bun.write(process.env.DUMP_RECEIVED_CLUSTER, Bun.file(output));
    await expectNoDeprecations(join(dir, "cluster.log"));
  } catch (error) {
    for (const name of ["cluster", "sink"]) {
      const file = Bun.file(join(dir, `${name}.log`));
      if (await file.exists()) console.error((await file.text()).slice(-8000));
    }
    throw error;
  } finally {
    for (const child of children) { if (child.exitCode === null) child.kill("SIGKILL"); }
    await Promise.all(children.map((c) => c.exited));
    fds.forEach(closeSync);
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
