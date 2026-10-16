import { describe, expect, test } from "bun:test";
import { render } from "./helpers";

// The DaemonSet's ClusterRole (the cluster-state Deployment has its own, suffixed -cluster).
const agentRole = (documents: any[]) => documents.find((d) => d.kind === "ClusterRole" && !d.metadata.name.endsWith("-cluster"));
const clusterRole = (documents: any[]) => documents.find((d) => d.kind === "ClusterRole" && d.metadata.name.endsWith("-cluster"));

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
      expect(pipeline.processors.includes("k8s_attributes")).toBe(name.endsWith("/node"));
    }
    const k8s = config.processors.k8s_attributes;
    expect(k8s.filter.node_from_env_var).toBe("NODE_NAME");
    expect(k8s.pod_association).toEqual([{ sources: [{ from: "resource_attribute", name: "k8s.pod.uid" }] }]);
    expect(k8s.extract.metadata).toContain("k8s.deployment.name");
    expect(documents.find((d) => d.kind === "Service").spec.internalTrafficPolicy).toBe("Cluster");
  });

  test("workloads without a service name are named after their Deployment (or other owner)", () => {
    const { config } = render();
    for (const key of ["log_statements", "metric_statements", "trace_statements"]) {
      const statements = config.processors["transform/application"][key].flatMap((s) => s.statements);
      const owners = ["deployment", "statefulset", "daemonset", "cronjob", "job", "container"];
      owners.forEach((owner, i) => {
        expect(statements[i]).toStartWith(`set(attributes["service.name"], attributes["k8s.${owner}.name"]) where`);
        expect(statements[i]).toContain(`IsMatch(attributes["service.name"], "^unknown_service")`);
      });
      // The application falls back to the service name only after it's derived.
      expect(statements.findIndex((s) => s.includes("ezgh.metadata.application"))).toBeGreaterThan(owners.length - 1);
    }
  });

  test("cluster Job metrics get their CronJob before the service is named, so runs share one service", () => {
    const { config, clusterConfig } = render();
    const groups = clusterConfig.processors["transform/application"].metric_statements;
    expect(groups[0].conditions[0]).toContain(`attributes["k8s.job.name"]`);
    expect(groups[0].statements.at(-1)).toStartWith(`set(attributes["k8s.cronjob.name"]`);
    expect(groups[1].statements[0]).toStartWith(`set(attributes["service.name"], attributes["k8s.deployment.name"])`);
    // Logs have no Job metrics; node agents get the CronJob from k8s_attributes.
    expect(JSON.stringify(clusterConfig.processors["transform/application"].log_statements)).not.toContain("ExtractPatterns");
    expect(JSON.stringify(config.processors["transform/application"])).not.toContain("ExtractPatterns");
  });

  test("container logs get a level when the runtime gave none; OTLP logs keep theirs", () => {
    const { config } = render();
    expect(config.service.pipelines["logs/node"].processors).toContain("transform/severity");
    expect(config.service.pipelines.logs.processors).not.toContain("transform/severity");
    expect(config.processors["transform/severity"].log_statements[0].conditions).toEqual(["severity_number == SEVERITY_NUMBER_UNSPECIFIED"]);
    const off = render(["--set", "logs.parseSeverity=false"]).config;
    expect(off.processors["transform/severity"]).toBeUndefined();
    expect(off.service.pipelines["logs/node"].processors).not.toContain("transform/severity");
  });

  test("pod metadata needs read-only access to pods, ReplicaSets and Jobs", () => {
    const { documents } = render();
    const rules = agentRole(documents).rules;
    expect(rules).toEqual([
      { apiGroups: [""], resources: ["nodes/stats"], verbs: ["get"] },
      { apiGroups: [""], resources: ["nodes/pods"], verbs: ["get"] },
      { apiGroups: [""], resources: ["pods"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["apps"], resources: ["replicasets"], verbs: ["get", "list", "watch"] },
      { apiGroups: ["batch"], resources: ["jobs"], verbs: ["get", "list", "watch"] },
    ]);
  });

  test("Local traffic policy gives application OTLP its pod's metadata", () => {
    const { documents, config } = render(["--set", "otlp.internalTrafficPolicy=Local"]);
    for (const pipeline of Object.values(config.service.pipelines) as any) {
      expect(pipeline.processors).toContain("k8s_attributes");
    }
    expect(config.processors.k8s_attributes.pod_association.at(-1)).toEqual({ sources: [{ from: "connection" }] });
    expect(documents.find((d) => d.kind === "Service").spec.internalTrafficPolicy).toBe("Local");
    const tracesOnly = render(["--set", "logs.enabled=false,metrics.enabled=false,otlp.internalTrafficPolicy=Local"]);
    expect(agentRole(tracesOnly.documents).rules.map((r) => r.resources[0]))
      .toEqual(["pods", "replicasets", "jobs"]);
    expect(tracesOnly.documents.find((d) => d.kind === "DaemonSet").spec.template.spec.automountServiceAccountToken).toBe(true);
  });

  test("kubernetesMetadata.enabled=false reads nothing from the Kubernetes API", () => {
    const { documents, config } = render(["--set", "kubernetesMetadata.enabled=false,otlp.internalTrafficPolicy=Local"]);
    expect(config.processors.k8s_attributes).toBeUndefined();
    for (const pipeline of Object.values(config.service.pipelines) as any) expect(pipeline.processors).not.toContain("k8s_attributes");
    expect(agentRole(documents).rules.map((r) => r.resources[0])).toEqual(["nodes/stats", "nodes/pods"]);
  });

  test("traces-only mode removes log access and kubelet privileges", () => {
    const { documents, config, clusterConfig } = render(["--set", "logs.enabled=false,metrics.enabled=false"]);
    expect(clusterConfig).toBeUndefined();
    expect(documents.some((d) => d.kind === "Deployment")).toBe(false);
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
    expect(agentRole(a.documents).metadata.name).not.toBe(agentRole(b.documents).metadata.name);
    expect(clusterRole(a.documents).metadata.name).not.toBe(clusterRole(b.documents).metadata.name);
    const storage = (r) => r.documents.find((d) => d.kind === "DaemonSet").spec.template.spec.volumes
      .find((v) => v.name === "storage").hostPath.path;
    expect(storage(a)).not.toBe(storage(b));
  });

  test("namespace exclusions and own-pod exclusion prevent collection loops", () => {
    const { config } = render(["--set", "logs.excludeNamespaces[0]=private"]);
    expect(config.receivers.file_log.exclude).toContain("/var/log/pods/private_*/*/*.log");
    expect(config.receivers.file_log.exclude).toContain("/var/log/pods/${env:POD_NAMESPACE}_${env:POD_NAME}_*/*/*.log");
    // The cluster-state Deployment's pods are the agent's too.
    expect(config.receivers.file_log.exclude).toContain("/var/log/pods/${env:POD_NAMESPACE}_ezgh-obs-agent-cluster-*_*/*/*.log");
    expect(render(["--set", "clusterState.enabled=false"]).config.receivers.file_log.exclude)
      .not.toContain("/var/log/pods/${env:POD_NAMESPACE}_ezgh-obs-agent-cluster-*_*/*/*.log");
  });

  const metricPipelines = (config: any) => Object.entries(config.service.pipelines).filter(([name]) => name.startsWith("metrics"));

  test("every metrics pipeline copies the Kubernetes resource attributes onto datapoints, last", () => {
    for (const config of Object.values(render()).slice(1) as any[]) {
      expect(metricPipelines(config).length).toBeGreaterThan(0);
      for (const [, pipeline] of metricPipelines(config) as any) expect(pipeline.processors.at(-1)).toBe("transform/k8slabels");
      const [group] = config.processors["transform/k8slabels"].metric_statements;
      expect(group.context).toBe("datapoint");
      const keys = ["cluster", "namespace", "node", "pod", "container", "deployment", "statefulset", "daemonset",
        "replicaset", "job", "cronjob", "hpa", "persistentvolumeclaim", "volume"].map((k) => `k8s.${k}.name`).concat("k8s.volume.type");
      for (const key of keys) {
        expect(group.statements).toContain(`set(attributes["${key}"], resource.attributes["${key}"]) where resource.attributes["${key}"] != nil and attributes["${key}"] == nil`);
      }
    }
    // Logs and traces keep their resource attributes as they are.
    const { config } = render();
    for (const [name, pipeline] of Object.entries(config.service.pipelines) as any) {
      if (!name.startsWith("metrics")) expect(pipeline.processors).not.toContain("transform/k8slabels");
    }
    expect(render(["--set", "metrics.enabled=false"]).config.processors["transform/k8slabels"]).toBeUndefined();
  });

  test("kubelet_stats adds uptime and inode metrics; pod-spec metrics (1.33+) have their own receiver", () => {
    const { config } = render();
    const kubelet = config.receivers.kubelet_stats;
    expect(Object.keys(kubelet.metrics)).toEqual(["k8s.node.uptime", "k8s.pod.uptime", "k8s.node.filesystem.inode.count", "k8s.node.filesystem.inode.free"]);
    expect(kubelet.metric_groups).toEqual(["node", "pod", "container"]);
    expect(kubelet.extra_metadata_labels).toBeUndefined();
    // A kubelet refusing /pods (behind its control plane) fails only this receiver's scrape.
    const pods = config.receivers["kubelet_stats/pods"];
    expect(pods.metric_groups).toEqual(["pod", "container", "volume"]);
    expect(pods.extra_metadata_labels).toEqual(["k8s.volume.type"]);
    const utilization = ["pod", "container"].flatMap((k) => ["cpu_limit", "cpu_request", "memory_limit", "memory_request"].map((m) => `k8s.${k}.${m}_utilization`));
    expect(Object.entries(pods.metrics).filter(([, v]: any) => v.enabled).map(([k]) => k)).toEqual(utilization);
    // Every pod and container metric kubelet_stats sends by default is off here, so none is sent twice.
    const defaults = ["cpu.time", "cpu.usage", "filesystem.available", "filesystem.capacity", "filesystem.usage", "memory.available",
      "memory.major_page_faults", "memory.page_faults", "memory.rss", "memory.usage", "memory.working_set"];
    const off = Object.entries(pods.metrics).filter(([, v]: any) => !v.enabled).map(([k]) => k).sort();
    expect(off).toEqual([...defaults.map((m) => `k8s.pod.${m}`), ...defaults.map((m) => `container.${m}`), "k8s.pod.network.errors", "k8s.pod.network.io"].sort());
    expect(config.service.pipelines["metrics/node"].receivers).toEqual(["kubelet_stats", "kubelet_stats/pods"]);
    // Before 1.33 the kubelet authorizes /pods only with nodes/proxy, which the chart never grants.
    for (const args of [["--kube-version", "1.32.2"], ["--set", "metrics.kubelet.podSpecs=false"]]) {
      const { documents, config } = render(args);
      expect(config.receivers["kubelet_stats/pods"]).toBeUndefined();
      expect(config.receivers.kubelet_stats.metric_groups).toEqual(["node", "pod", "container", "volume"]);
      expect(config.service.pipelines["metrics/node"].receivers).toEqual(["kubelet_stats"]);
      expect(agentRole(documents).rules.map((r) => r.resources[0])).not.toContain("nodes/pods");
    }
    const forced = render(["--set", "metrics.kubelet.podSpecs=true", "--kube-version", "1.32.2"]);
    expect(agentRole(forced.documents).rules.map((r) => r.resources[0])).toContain("nodes/pods");
    for (const { documents } of [render(), forced]) {
      expect(documents.flatMap((d) => d.kind === "ClusterRole" ? d.rules.flatMap((r) => r.resources) : [])).not.toContain("nodes/proxy");
    }
  });

  test("the OTLP-only example reads nothing from the Kubernetes API or the host", () => {
    const { documents } = render(["-f", "examples/otlp-only.yaml"]);
    for (const kind of ["ClusterRole", "ClusterRoleBinding", "Deployment"]) expect(documents.some((d) => d.kind === kind)).toBe(false);
    const pod = documents.find((d) => d.kind === "DaemonSet").spec.template.spec;
    expect(pod.automountServiceAccountToken).toBe(false);
    expect(pod.volumes.some((v) => v.name === "pod-logs")).toBe(false);
  });

  test("the cluster-state pod's logs stay excluded for the longest release names", () => {
    const release = "a".repeat(53);
    const { config, documents } = render([], release);
    const deployment = documents.find((d) => d.kind === "Deployment").metadata.name;
    // Pods are <deployment>-<hash>-<suffix>, the generated prefix cut to 58 characters.
    const podName = `${deployment}-5d9f7c6b8d-`.slice(0, 58) + "x7k2p";
    const pattern = config.receivers.file_log.exclude.find((e: string) => e.includes("-cluster") || e.includes(deployment.slice(0, 40)));
    const glob = new Bun.Glob(pattern.replace("${env:POD_NAMESPACE}", "ezgh-obs"));
    expect(glob.match(`/var/log/pods/ezgh-obs_${podName}_uid/collector/0.log`)).toBe(true);
    expect(glob.match(`/var/log/pods/ezgh-obs_${release}-abcde_uid/collector/0.log`)).toBe(false);
  });

  // The telemetry resource as name → value (it's written as service.telemetry.resource.attributes,
  // the list form; the inline map is deprecated).
  const resourceOf = (c: any): Record<string, string> =>
    Object.fromEntries(c.service.telemetry.resource.attributes.map((a: { name: string, value: string }) => [a.name, a.value]));

  test("each agent sends its own metrics to its own OTLP receiver every 60 s", () => {
    const { config, clusterConfig } = render();
    for (const [c, instance] of [[config, "${env:NODE_NAME}"], [clusterConfig, "cluster-state"]] as const) {
      const telemetry = c.service.telemetry;
      const resource = resourceOf(c);
      expect(resource["service.name"]).toBe("ezgh-obs-agent");
      expect(resource["service.instance.id"]).toBe(instance);
      expect(resource["k8s.cluster.name"]).toBe("${env:CLUSTER_NAME}");
      expect(telemetry.metrics.readers[0].pull.exporter.prometheus.port).toBe(8888);
      expect(telemetry.metrics.readers[1].periodic).toMatchObject({ interval: 60000,
        exporter: { otlp: { protocol: "http/protobuf", endpoint: "http://127.0.0.1:4318/v1/metrics" } } });
    }
    expect(resourceOf(config)["k8s.node.name"]).toBe("${env:NODE_NAME}");
    // The Deployment's receiver takes only its own telemetry.
    expect(clusterConfig.receivers.otlp.protocols).toEqual({ http: { endpoint: "127.0.0.1:4318" } });
    expect(clusterConfig.service.pipelines["metrics/self"].receivers).toEqual(["otlp"]);
    // Without a metrics pipeline there is nowhere to send it.
    const noMetrics = render(["--set", "metrics.enabled=false"]);
    for (const c of [noMetrics.config, noMetrics.clusterConfig]) {
      expect(c.service.telemetry.resource).toBeUndefined();
      expect(c.service.telemetry.metrics.readers).toHaveLength(1);
    }
  });

  test("cluster state: one Recreate replica with its own read-only RBAC, cluster metrics and events", () => {
    const { documents, clusterConfig } = render();
    const deployment = documents.find((d) => d.kind === "Deployment");
    expect(deployment.metadata.name).toBe("ezgh-obs-agent-cluster");
    expect(deployment.spec.replicas).toBe(1);
    expect(deployment.spec.strategy).toEqual({ type: "Recreate" });
    // Its pods match neither the DaemonSet's selector nor the OTLP Service's.
    const ds = documents.find((d) => d.kind === "DaemonSet");
    const podLabels = deployment.spec.template.metadata.labels;
    expect(Object.entries(ds.spec.selector.matchLabels).every(([k, v]) => podLabels[k] === v)).toBe(false);
    expect(Object.entries(documents.find((d) => d.kind === "Service").spec.selector).every(([k, v]) => podLabels[k] === v)).toBe(false);
    const pod = deployment.spec.template.spec;
    expect(pod.serviceAccountName).toBe("ezgh-obs-agent-cluster");
    expect(pod.nodeSelector).toEqual({ "kubernetes.io/os": "linux" });
    const [agent] = pod.containers;
    expect(agent.image).toBe(ds.spec.template.spec.containers[0].image);
    expect(agent.env.find((e) => e.name === "EZGH_INGEST_KEY").valueFrom.secretKeyRef).toEqual({ name: "test-ingest", key: "ingest-key" });
    expect(agent.securityContext).toMatchObject({ runAsNonRoot: true, allowPrivilegeEscalation: false,
      readOnlyRootFilesystem: true, capabilities: { drop: ["ALL"] } });
    expect(pod.volumes.find((v) => v.name === "storage").emptyDir).toBeDefined();
    expect(pod.volumes.some((v) => v.hostPath)).toBe(false);
    const binding = documents.find((d) => d.kind === "ClusterRoleBinding" && d.metadata.name.endsWith("-cluster"));
    expect(binding.subjects).toEqual([{ kind: "ServiceAccount", name: "ezgh-obs-agent-cluster", namespace: "ezgh-obs" }]);
    expect(binding.roleRef.name).toBe(clusterRole(documents).metadata.name);
    const rules = clusterRole(documents).rules;
    expect(rules.every((r) => r.verbs.join() === "get,list,watch")).toBe(true);
    expect(rules.flatMap((r) => r.resources)).toEqual(["namespaces", "nodes", "persistentvolumeclaims", "pods",
      "replicationcontrollers", "resourcequotas", "services", "daemonsets", "deployments", "replicasets", "statefulsets",
      "cronjobs", "jobs", "horizontalpodautoscalers", "events"]);
    expect(rules.find((r) => r.resources.includes("events")).apiGroups).toEqual(["events.k8s.io"]);
    expect(rules.flatMap((r) => r.resources)).not.toContain("secrets");

    const cluster = clusterConfig.receivers.k8s_cluster;
    expect(cluster.collection_interval).toBe("30s");
    expect(cluster.allocatable_types_to_report).toEqual(["cpu", "memory", "pods"]);
    expect(cluster.node_conditions_to_report).toEqual(["Ready", "MemoryPressure", "DiskPressure", "PIDPressure"]);
    expect(Object.keys(cluster.metrics)).toEqual(["k8s.node.condition", "k8s.pod.status_reason", "k8s.container.status.reason",
      "k8s.persistentvolumeclaim.status.phase", "k8s.persistentvolumeclaim.storage.capacity", "k8s.persistentvolumeclaim.storage.request"]);
    expect(clusterConfig.service.pipelines["metrics/cluster"].processors)
      .toEqual(["memory_limiter", "k8s_attributes", "resource/ezgh", "transform/application", "transform/k8slabels"]);
    expect(clusterConfig.processors.k8s_attributes.filter).toBeUndefined();
    expect(clusterConfig.service.pipelines["logs/events"]).toEqual({ receivers: ["k8s_objects"],
      processors: ["memory_limiter", "resource/ezgh", "transform/events", "transform/application"], exporters: ["otlp_http/logs"] });
    expect(Object.keys(clusterConfig.exporters)).toEqual(["otlp_http/logs", "otlp_http/metrics"]);
  });

  test("cluster state follows the signals and turns off completely", () => {
    const metricsOnly = render(["--set", "logs.enabled=false"]);
    expect(metricsOnly.clusterConfig.receivers.k8s_objects).toBeUndefined();
    expect(clusterRole(metricsOnly.documents).rules.flatMap((r) => r.resources)).not.toContain("events");
    const logsOnly = render(["--set", "metrics.enabled=false"]);
    expect(Object.keys(logsOnly.clusterConfig.receivers)).toEqual(["k8s_objects"]);
    expect(clusterRole(logsOnly.documents).rules).toEqual([{ apiGroups: ["events.k8s.io"], resources: ["events"], verbs: ["get", "list", "watch"] }]);
    const off = render(["--set", "clusterState.enabled=false"]);
    expect(off.clusterConfig).toBeUndefined();
    for (const kind of ["Deployment", "ServiceAccount", "ClusterRole", "ClusterRoleBinding", "ConfigMap"]) {
      expect(off.documents.filter((d) => d.kind === kind).every((d) => !d.metadata.name.endsWith("-cluster"))).toBe(true);
    }
    expect(off.documents.filter((d) => d.kind === "ClusterRole")).toHaveLength(1);
  });

  test("cluster state scheduling and resources are its own", () => {
    const { documents, clusterConfig } = render(["--set", "clusterState.nodeSelector.pool=system,clusterState.priorityClassName=high,clusterState.resources.limits.memory=1Gi,clusterState.memoryLimiter.limitMiB=800,clusterState.tolerations[0].operator=Exists"]);
    const pod = documents.find((d) => d.kind === "Deployment").spec.template.spec;
    expect(pod.nodeSelector).toEqual({ "kubernetes.io/os": "linux", pool: "system" });
    expect(pod.priorityClassName).toBe("high");
    expect(pod.tolerations).toEqual([{ operator: "Exists" }]);
    expect(pod.containers[0].resources.limits.memory).toBe("1Gi");
    expect(clusterConfig.processors.memory_limiter.limit_mib).toBe(800);
    expect(documents.find((d) => d.kind === "DaemonSet").spec.template.spec.nodeSelector).toEqual({ "kubernetes.io/os": "linux" });
  });

  test.each([
    ["auth.existingSecret="],
    ["cluster.name="],
    ["ezgh.environment=Bad Value"],
    ["ezgh.endpoint=http://example.com"],
    ["logs.enabled=false,metrics.enabled=false,traces.enabled=false"],
    ["export.queueSizeMiB=0"],
    ["otlp.internalTrafficPolicy=Nearest"],
    ["metrics.kubelet.podSpecs=maybe"],
    ["clusterState.collectionInterval=often"],
    ["clusterState.memoryLimiter.spikeLimitMiB=400"],
    ["clusterState.nodeSelector.kubernetes\\.io/os=windows"],
  ])("rejects invalid configuration: %s", (value) => {
    expect(() => render(["--set", value])).toThrow();
  });
});
