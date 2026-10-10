# EZGH Obs Agent implementation plan

> Execute inline with the executing-plans skill; run one fresh review before delivery.

**Goal:** Publish a public repository containing a usable Kubernetes telemetry Helm chart.

**Architecture:** A DaemonSet uses pinned Collector Contrib receivers and processors,
persisted per-signal OTLP export queues, and an existing ingest-key Secret.

**Tech stack:** Helm, Kubernetes, OpenTelemetry Collector Contrib 0.162.0, Bun tests.

**Spec:** [Design](../../design.md).

## Global constraints

- One release targets one project and environment; no UI or production deployment.
- Secret references only; HTTPS exporter; no authorization or metadata caches.
- Node-local collection must not mislabel remote OTLP sources.
- No privileged containers, runtime sockets, or host networking.
- Preserve logs/queue state across same-node restarts; never promise lossless delivery.

## Review focus

- Disabled signals must remove unused host mounts, ports/pipelines and RBAC where applicable.
- Helm values must reject missing credentials, invalid environment names and HTTP export.
- Release renames/namespaces must not collide in cluster-scoped RBAC or host storage.
- Collector configuration must run, not merely parse as YAML.
- Exported data must retain source identity, use the configured environment and send the key.

### Task 1: Chart and behavioral validation

Files: `charts/ezgh-obs-agent/{Chart.yaml,values.yaml,values.schema.json,templates/*}`,
`tests/chart.test.ts`, `tests/values.yaml`, `scripts/validate-collector.ts`.
Produces: rendered manifests and Collector ConfigMap consumed by integration tests.

- [ ] Write render/validation tests for the five review-focus cases and run them red.
- [ ] Implement schema, templates, RBAC and pipeline configuration.
- [ ] Run `bun test`, `bun run lint`, and exact-binary Collector config validation.
- [ ] Commit the verified chart with documentation.

### Task 2: Integration, documentation and distribution

Files: `tests/collector.test.ts`, `scripts/smoke.sh`, `.github/workflows/*`, `README.md`,
`LICENSE`, `examples/*`.
Consumes: Task 1 manifests and pinned Collector version.
Produces: repeatable checks, install examples and downloadable release chart.

- [ ] Exercise real Collector forwarding, auth, metadata and CRI parsing against a local sink.
- [ ] Add disposable Kubernetes smoke CI for rollout, node metrics and pod logs.
- [ ] Document install, privileges, durability, exclusions, rotation and scope limits.
- [ ] Add CI and tag-triggered packaging; run full checks, review, commit and push.
- [ ] Verify public visibility, successful CI and published package installation/rendering.
