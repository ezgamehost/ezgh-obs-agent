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

async function eventually(check: () => Promise<void>, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let error: unknown;
  while (Date.now() < deadline) {
    try { await check(); return; } catch (e) { error = e; }
    await Bun.sleep(100);
  }
  throw error;
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
    kubelet = Bun.serve({ hostname: "127.0.0.1", port: 0,
      tls: { cert: Bun.file(cert), key: Bun.file(key) },
      fetch(request) {
        if (new URL(request.url).pathname !== "/stats/summary") return new Response(null, { status: 404 });
        kubeletRequests++;
        const time = new Date().toISOString();
        return Response.json({ node: { nodeName: "collector-node", startTime: time,
          cpu: { time, usageCoreNanoSeconds: 1000000, usageNanoCores: 1000 },
          memory: { time, usageBytes: 2048, workingSetBytes: 1024, availableBytes: 1048576 },
        }, pods: [] });
      },
    });
    const { config } = render(["--set", "metrics.collectionInterval=1s"]);
    // Keep the chart's URL shape and NODE_IP expansion; only substitute fixture port/auth.
    config.receivers.kubelet_stats.endpoint = config.receivers.kubelet_stats.endpoint.replace(":10250", `:${kubelet.port}`);
    config.receivers.kubelet_stats.auth_type = "tls";
    config.receivers.kubelet_stats.cert_file = cert;
    config.receivers.kubelet_stats.key_file = key;
    config.receivers.kubelet_stats.insecure_skip_verify = true;
    config.receivers.kubelet_stats.ca_file = cert;
    // No Kubernetes API here: the kind smoke test covers pod metadata; this one checks the naming
    // rule on attributes as k8sattributes would leave them.
    delete config.processors.k8sattributes;
    for (const pipeline of Object.values(config.service.pipelines) as any[]) {
      pipeline.processors = pipeline.processors.filter((p: string) => p !== "k8sattributes");
    }
    config.extensions.file_storage.directory = join(dir, "storage");
    config.extensions.file_storage.compaction.directory = join(dir, "compaction");
    config.extensions.health_check.endpoint = `127.0.0.1:${healthPort}`;
    config.receivers.otlp.protocols.http.endpoint = `127.0.0.1:${httpPort}`;
    config.receivers.otlp.protocols.grpc.endpoint = `127.0.0.1:${grpcPort}`;
    config.service.telemetry.metrics.readers[0].pull.exporter.prometheus.port = metricsPort;
    const logRoot = join(dir, "var/log/pods");
    const logDir = join(logRoot, "default_checkout-abc_12345678-1234-1234-1234-123456789abc/app");
    mkdirSync(logDir, { recursive: true });
    config.receivers.filelog.include = [`${logRoot}/*/*/*.log`];
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
      name: "smoke.gauge", gauge: { dataPoints: [{ timeUnixNano: now, asDouble: 42 }] },
    }] }] }] });
    await send("traces", { resourceSpans: [{ resource: { attributes }, scopeSpans: [{ spans: [{
      traceId: "0123456789abcdef0123456789abcdef", spanId: "0123456789abcdef", name: "smoke-span",
      startTimeUnixNano: now, endTimeUnixNano: String(BigInt(now) + 1000000n),
    }] }] }] });
    await Bun.write(join(logDir, "0.log"), `${new Date().toISOString()} stdout F cri-marker\n`);
    async function records() {
      return (await Bun.file(output).text()).trim().split("\n").filter(Boolean).map((s) => JSON.parse(s));
    }
    await eventually(async () => {
      const text = JSON.stringify(await records());
      for (const marker of ["otlp-marker", "deployment-marker", "named-marker", "cri-marker", "smoke.gauge", "smoke-span", "k8s.node.cpu"]) expect(text).toContain(marker);
      expect(kubeletRequests).toBeGreaterThan(0);
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
      } else if (attrs["service.name"] === "checkout") {
        expect(attrs["k8s.node.name"]).toBe("application-node");
        expect(attrs["ezgh.metadata.application"]).toBe("checkout");
      } else if (attrs["k8s.container.name"] === "app") {
        expect(attrs["k8s.node.name"]).toBe("collector-node");
        expect(attrs["k8s.namespace.name"]).toBe("default");
        expect(attrs["k8s.container.name"]).toBe("app");
      } else {
        expect(attrs["k8s.node.name"]).toBe("collector-node");
        expect(attrs["ezgh.metadata.application"]).toBe("kubernetes");
      }
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
