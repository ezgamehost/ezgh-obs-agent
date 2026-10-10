import { describe, expect, test } from "bun:test";
import { render } from "./helpers";

describe("Helm installation contract", () => {
  test("installs one secured agent per node and exports all signals with a Secret", () => {
    const { documents, config } = render();
    const ds = documents.find((d) => d.kind === "DaemonSet");
    expect(ds).toBeDefined();
    const pod = ds.spec.template.spec;
    const agent = pod.containers[0];
    expect(agent.env.find((e) => e.name === "EZGH_INGEST_KEY").valueFrom.secretKeyRef)
      .toEqual({ name: "test-ingest", key: "ingest-key" });
    expect(documents.some((d) => d.kind === "Secret")).toBe(false);
    expect(agent.securityContext.allowPrivilegeEscalation).toBe(false);
    expect(agent.securityContext.capabilities.drop).toEqual(["ALL"]);
    expect(agent.securityContext.readOnlyRootFilesystem).toBe(true);
    expect(pod.hostNetwork ?? false).toBe(false);
    expect(agent.volumeMounts.find((m) => m.name === "pod-logs").readOnly).toBe(true);
    for (const signal of ["logs", "metrics", "traces"]) {
      expect(Object.keys(config.service.pipelines).some((p) => p.split("/")[0] === signal)).toBe(true);
      const exporter = config.exporters[`otlp_http/${signal}`];
      expect(exporter.endpoint).toBe("https://obs-ingest.ezghcloud.com");
      expect(exporter.headers.authorization).toBe("Bearer ${env:EZGH_INGEST_KEY}");
      expect(exporter.sending_queue.storage).toBe("file_storage");
      expect(exporter.sending_queue.batch.max_size).toBeLessThan(5 * 1024 * 1024);
    }
  });

  test("OTLP traffic is not stamped with the receiving agent's node", () => {
    const { config } = render();
    for (const [name, pipeline] of Object.entries(config.service.pipelines) as any) {
      expect(pipeline.processors.includes("resource/node")).toBe(name.endsWith("/node"));
    }
    expect(config.processors.k8sattributes).toBeUndefined();
  });

  test("traces-only mode removes log access and kubelet privileges", () => {
    const { documents, config } = render(["--set", "logs.enabled=false,metrics.enabled=false"]);
    expect(Object.keys(config.service.pipelines)).toEqual(["traces"]);
    expect(Object.keys(config.receivers)).toEqual(["otlp"]);
    expect(documents.some((d) => d.kind === "ClusterRole")).toBe(false);
    const pod = documents.find((d) => d.kind === "DaemonSet").spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.volumes.some((v) => v.name === "pod-logs")).toBe(false);
  });

  test("release and namespace isolate RBAC and persisted state", () => {
    const a = render([], "agent", "one");
    const b = render([], "agent", "two");
    expect(a.documents.find((d) => d.kind === "ClusterRole").metadata.name)
      .not.toBe(b.documents.find((d) => d.kind === "ClusterRole").metadata.name);
    const storage = (r) => r.documents.find((d) => d.kind === "DaemonSet").spec.template.spec.volumes
      .find((v) => v.name === "storage").hostPath.path;
    expect(storage(a)).not.toBe(storage(b));
  });

  test("namespace exclusions and own-pod exclusion prevent collection loops", () => {
    const { config } = render(["--set", "logs.excludeNamespaces[0]=private"]);
    expect(config.receivers.filelog.exclude).toContain("/var/log/pods/private_*/*/*.log");
    expect(config.receivers.filelog.exclude).toContain("/var/log/pods/${env:POD_NAMESPACE}_${env:POD_NAME}_*/*/*.log");
  });

  test.each([
    ["auth.existingSecret="],
    ["cluster.name="],
    ["ezgh.environment=Bad Value"],
    ["ezgh.endpoint=http://example.com"],
    ["logs.enabled=false,metrics.enabled=false,traces.enabled=false"],
    ["export.queueSizeMiB=0"],
  ])("rejects invalid configuration: %s", (value) => {
    expect(() => render(["--set", value])).toThrow();
  });
});
