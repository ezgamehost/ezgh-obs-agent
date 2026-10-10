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

  test("OTLP traffic is not stamped with the receiving agent's node or pods", () => {
    const { documents, config } = render();
    for (const [name, pipeline] of Object.entries(config.service.pipelines) as any) {
      expect(pipeline.processors.includes("resource/node")).toBe(name.endsWith("/node"));
      // Node-local sources get pod metadata; OTLP may have come from another node's pod.
      expect(pipeline.processors.includes("k8sattributes")).toBe(name.endsWith("/node"));
    }
    const k8s = config.processors.k8sattributes;
    expect(k8s.filter.node_from_env_var).toBe("NODE_NAME");
    expect(k8s.pod_association).toEqual([{ sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] }]);
    expect(k8s.extract.metadata).toContain("k8s.deployment.name");
    expect(documents.find((d) => d.kind === "Service").spec.internalTrafficPolicy).toBe("Cluster");
  });

  test("workloads without a service name are named after their Deployment (or other owner)", () => {
    const { config } = render();
    for (const key of ["log_statements", "metric_statements", "trace_statements"]) {
      const statements = config.processors["transform/application"][key].flatMap((s) => s.statements);
      const owners = ["deployment", "statefulset", "daemonset", "cronjob", "job"];
      owners.forEach((owner, i) => {
        expect(statements[i]).toStartWith(`set(attributes["service.name"], attributes["k8s.${owner}.name"]) where`);
        expect(statements[i]).toContain(`IsMatch(attributes["service.name"], "^unknown_service")`);
      });
      // The application falls back to the service name only after it's derived.
      expect(statements.findIndex((s) => s.includes("ezgh.metadata.application"))).toBeGreaterThan(owners.length - 1);
    }
  });

  test("pod metadata needs read-only access to pods, ReplicaSets and Jobs", () => {
    const { documents } = render();
    const rules = documents.find((d) => d.kind === "ClusterRole").rules;
    expect(rules).toEqual([
      { apiGroups: [""], resources: ["nodes/stats"], verbs: ["get"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch"] },
    ]);
  });

  test("Local traffic policy gives application OTLP its pod's metadata", () => {
    const { documents, config } = render(["--set", "otlp.internalTrafficPolicy=Local"]);
    for (const pipeline of Object.values(config.service.pipelines) as any) {
      expect(pipeline.processors).toContain("k8sattributes");
    }
    expect(config.processors.k8sattributes.pod_association.at(-1)).toEqual({ sources: [{ from: "connection" }] });
    expect(documents.find((d) => d.kind === "Service").spec.internalTrafficPolicy).toBe("Local");
    const tracesOnly = render(["--set", "logs.enabled=false,metrics.enabled=false,otlp.internalTrafficPolicy=Local"]);
    expect(tracesOnly.documents.find((d) => d.kind === "ClusterRole").rules.map((r) => r.resources[0]))
      .toEqual(["pods", "replicasets", "jobs"]);
    expect(tracesOnly.documents.find((d) => d.kind === "DaemonSet").spec.template.spec.automountServiceAccountToken).toBe(true);
  });

  test("kubernetesMetadata.enabled=false reads nothing from the Kubernetes API", () => {
    const { documents, config } = render(["--set", "kubernetesMetadata.enabled=false,otlp.internalTrafficPolicy=Local"]);
    expect(config.processors.k8sattributes).toBeUndefined();
    for (const pipeline of Object.values(config.service.pipelines) as any) expect(pipeline.processors).not.toContain("k8sattributes");
    expect(documents.find((d) => d.kind === "ClusterRole").rules).toEqual([{ apiGroups: [""], resources: ["nodes/stats"], verbs: ["get"] }]);
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
    ["otlp.internalTrafficPolicy=Nearest"],
  ])("rejects invalid configuration: %s", (value) => {
    expect(() => render(["--set", value])).toThrow();
  });
});
