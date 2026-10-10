import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "../tests/helpers";

const binary = process.env.COLLECTOR_BIN ?? ".tools/otelcol-contrib";
const cases: string[][] = [
  [],
  ["--set", "logs.enabled=false,metrics.enabled=false"],
  ["--set", "metrics.enabled=false,traces.enabled=false"],
  ["--set", "logs.enabled=false,traces.enabled=false"],
  ["--set", "logs.collectContainerLogs=false,metrics.collectKubeletMetrics=false"],
  ["--set", "metrics.kubelet.caConfigMap=kubelet-ca,cluster.uid=stable-uid"],
  ["--set", "otlp.internalTrafficPolicy=Local"],
  ["--set", "kubernetesMetadata.enabled=false"],
];
const dir = mkdtempSync(join(tmpdir(), "ezgh-collector-validate-"));
try {
  for (const [index, args] of cases.entries()) {
    const { config } = render(args);
    // Validation constructs the kubelet client. The offline test has no projected
    // ServiceAccount token/CA; cluster smoke tests exercise real authentication.
    if (config.receivers.kubelet_stats) {
      config.receivers.kubelet_stats.auth_type = "none";
      config.receivers.kubelet_stats.ca_file = process.env.TEST_CA_FILE ?? "/etc/ssl/cert.pem";
    }
    const path = join(dir, `${index}.yaml`);
    await Bun.write(path, Bun.YAML.stringify(config));
    const result = Bun.spawnSync([binary, "validate", `--config=${path}`], {
      env: { ...process.env, NODE_IP: "127.0.0.1", NODE_NAME: "node", POD_NAME: "agent",
        POD_NAMESPACE: "ezgh-obs", CLUSTER_NAME: "test-cluster", CLUSTER_UID: "stable-uid",
        EZGH_ENVIRONMENT: "test", EZGH_INGEST_KEY: "test-placeholder-not-a-credential" },
    });
    if (result.exitCode !== 0) {
      throw new Error(`Collector config ${index} rejected:\n${result.stderr}\n${result.stdout}`);
    }
    console.log(`Collector config ${index + 1}/${cases.length} valid`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
