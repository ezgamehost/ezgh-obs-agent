import { spawnSync } from "bun";

// Helm's default Kubernetes version differs between Helm releases; the chart reads it (podSpecs:
// auto), so tests pin one unless they pass their own.
export const KUBE_VERSION = "1.34.0";

export function render(args: string[] = [], release = "ezgh-obs-agent", namespace = "ezgh-obs") {
  const kube = args.includes("--kube-version") ? [] : ["--kube-version", KUBE_VERSION];
  const result = spawnSync(["helm", "template", release, "charts/ezgh-obs-agent",
    "--namespace", namespace, "-f", "tests/values.yaml", ...kube, ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const documents = result.stdout.toString().split(/^---\s*$/m)
    .map((part) => Bun.YAML.parse(part) as any).filter(Boolean);
  const configOf = (name: string) => {
    const cm = documents.find((d) => d.kind === "ConfigMap" && d.metadata.name === name);
    return cm ? Bun.YAML.parse(cm.data["collector.yaml"]) as any : undefined;
  };
  const clusterName = `${release.slice(0, 55).replace(/-+$/, "")}-cluster`;
  return { documents, config: configOf(release), clusterConfig: configOf(clusterName) };
}
