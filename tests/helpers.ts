import { spawnSync } from "bun";

export function render(args: string[] = [], release = "ezgh-obs-agent", namespace = "ezgh-obs") {
  const result = spawnSync(["helm", "template", release, "charts/ezgh-obs-agent",
    "--namespace", namespace, "-f", "tests/values.yaml", ...args]);
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  const documents = result.stdout.toString().split(/^---\s*$/m)
    .map((part) => Bun.YAML.parse(part) as any).filter(Boolean);
  const cm = documents.find((d) => d.kind === "ConfigMap");
  return { documents, config: Bun.YAML.parse(cm.data["collector.yaml"]) as any };
}
