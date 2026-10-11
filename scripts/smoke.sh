#!/usr/bin/env bash
# Only runs in the explicitly named disposable kind cluster; no real ingest key needed.
set -euo pipefail
cd "$(dirname "$0")/.."
if [[ "$(kubectl config current-context)" != "kind-ezgh-obs-agent" ]]; then
  echo 'Refusing to run: current context must be kind-ezgh-obs-agent' >&2
  exit 1
fi
scratch=$(mktemp -d)
cleanup() {
  result=$?
  if [[ $result != 0 ]]; then
    kubectl -n ezgh-obs get pods -o wide || true
    kubectl -n ezgh-obs logs -l app.kubernetes.io/instance=ezgh-obs-agent --tail=100 || true
    kubectl -n obs-test logs deployment/sink --tail=100 || true
  fi
  rm -rf "$scratch"
  exit "$result"
}
trap cleanup EXIT
kubectl create namespace ezgh-obs
kubectl create namespace obs-test
openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj '/CN=sink.obs-test.svc' \
  -addext 'subjectAltName=DNS:sink.obs-test.svc' \
  -keyout "$scratch/key.pem" -out "$scratch/cert.pem" 2>/dev/null
kubectl -n obs-test create secret generic sink-tls \
  --from-file=cert.pem="$scratch/cert.pem" --from-file=key.pem="$scratch/key.pem"
kubectl -n ezgh-obs create configmap sink-ca --from-file=ca.crt="$scratch/cert.pem"
kubectl -n ezgh-obs create secret generic test-ingest \
  --from-literal=ingest-key=test-placeholder-not-a-credential
version=$(bun -e 'console.log(Bun.YAML.parse(await Bun.file("charts/ezgh-obs-agent/Chart.yaml").text()).appVersion)')
cat > "$scratch/sink.yaml" <<EOF
apiVersion: v1
kind: ConfigMap
metadata: {name: sink, namespace: obs-test}
data:
  config.yaml: |
    receivers:
      otlp:
        protocols:
          http:
            endpoint: 0.0.0.0:4318
            tls:
              cert_file: /tls/cert.pem
              key_file: /tls/key.pem
    exporters:
      debug:
        verbosity: detailed
        sampling_initial: 100000
        sampling_thereafter: 1
    service:
      pipelines:
        logs: {receivers: [otlp], exporters: [debug]}
        metrics: {receivers: [otlp], exporters: [debug]}
        traces: {receivers: [otlp], exporters: [debug]}
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: sink, namespace: obs-test}
spec:
  selector: {matchLabels: {app: sink}}
  template:
    metadata: {labels: {app: sink}}
    spec:
      containers:
        - name: collector
          image: otel/opentelemetry-collector-contrib:${version}
          args: [--config=/config/config.yaml]
          volumeMounts:
            - {name: config, mountPath: /config, readOnly: true}
            - {name: tls, mountPath: /tls, readOnly: true}
      volumes:
        - name: config
          configMap: {name: sink}
        - name: tls
          secret: {secretName: sink-tls}
---
apiVersion: v1
kind: Service
metadata: {name: sink, namespace: obs-test}
spec:
  selector: {app: sink}
  ports: [{port: 443, targetPort: 4318}]
---
apiVersion: apps/v1
kind: DaemonSet
metadata: {name: smoke-logs, namespace: default}
spec:
  selector: {matchLabels: {app: smoke-logs}}
  template:
    metadata: {labels: {app: smoke-logs}}
    spec:
      containers:
        - name: logger
          image: busybox:1.37.0
          command: [sh, -c, 'while true; do echo ezgh-smoke-log; sleep 2; done']
---
apiVersion: apps/v1
kind: Deployment
metadata: {name: smoke-web, namespace: default}
spec:
  replicas: 1
  selector: {matchLabels: {app: smoke-web}}
  template:
    metadata: {labels: {app: smoke-web}}
    spec:
      containers:
        - name: web
          image: busybox:1.37.0
          command: [sh, -c, 'while true; do echo ezgh-smoke-deployment-log; sleep 2; done']
          resources:
            requests: {cpu: 10m, memory: 16Mi}
            limits: {memory: 64Mi}
EOF
kubectl apply -f "$scratch/sink.yaml"
kubectl -n obs-test rollout status deployment/sink --timeout=180s
helm upgrade --install ezgh-obs-agent charts/ezgh-obs-agent --namespace ezgh-obs \
  -f tests/values.yaml --set ezgh.endpoint=https://sink.obs-test.svc \
  --set metrics.kubelet.insecureSkipVerify=true --set metrics.collectionInterval=5s \
  --set clusterState.collectionInterval=5s \
  --set 'logs.excludeNamespaces[0]=obs-test' --set otlp.internalTrafficPolicy=Local
# Trust only the disposable sink CA for this test. Production uses the system CA bundle.
for workload in daemonset/ezgh-obs-agent deployment/ezgh-obs-agent-cluster; do
kubectl -n ezgh-obs patch "$workload" --type=strategic --patch '
spec:
  template:
    spec:
      containers:
        - name: collector
          env:
            - {name: SSL_CERT_FILE, value: /test-ca/ca.crt}
          volumeMounts:
            - {name: test-ca, mountPath: /test-ca, readOnly: true}
      volumes:
        - name: test-ca
          configMap: {name: sink-ca}
'
done
kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent --timeout=180s
kubectl -n ezgh-obs rollout status deployment/ezgh-obs-agent-cluster --timeout=180s
ready=$(kubectl -n ezgh-obs get daemonset ezgh-obs-agent -o jsonpath='{.status.numberReady}')
[[ "$ready" == 2 ]]
# Cluster state is watching now: things that make events. Scaling smoke-web (ScalingReplicaSet,
# Normal) also gives the Deployment two pods; an image that can't be pulled gives Warnings and a
# container status reason.
sleep 5
kubectl -n default scale deployment/smoke-web --replicas=2
kubectl -n default run smoke-broken --image=registry.invalid/ezgh/missing:0 --restart=Never
# Push one trace through the in-cluster OTLP Service (logs/metrics come from the nodes).
kubectl run smoke-trace --namespace obs-test --image=curlimages/curl:8.12.1 --restart=Never --command -- \
  curl --fail --retry 5 --retry-connrefused \
  -H 'Content-Type: application/json' \
  --data '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke-client"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"ezgh-smoke-span","startTimeUnixNano":"1791590400000000000","endTimeUnixNano":"1791590400001000000"}]}]}]}' \
  http://ezgh-obs-agent.ezgh-obs.svc:4318/v1/traces
# A span with only the SDK's default name, from a Job: its node's agent names it after the Job.
# It waits first: an IP is matched to a pod once the kubelet has reported it, a moment after start.
kubectl -n obs-test create job smoke-job --image=curlimages/curl:8.12.1 -- sh -c 'sleep 5; exec "$@"' -- \
  curl --fail --retry 5 --retry-connrefused \
  -H 'Content-Type: application/json' \
  --data '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"unknown_service:curl"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdee","spanId":"0123456789abcdee","name":"ezgh-smoke-job-span","startTimeUnixNano":"1791590400000000000","endTimeUnixNano":"1791590400001000000"}]}]}]}' \
  http://ezgh-obs-agent.ezgh-obs.svc:4318/v1/traces
expected=(
  'ezgh-smoke-log' 'ezgh-smoke-span' 'k8s.node.cpu'
  'Str(ezgh-obs-agent-worker)' 'Str(ezgh-obs-agent-worker2)'
  'ezgh-smoke-deployment-log' 'service.name: Str(smoke-web)' 'k8s.deployment.name: Str(smoke-web)'
  'service.name: Str(smoke-logs)'
  'ezgh-smoke-job-span' 'service.name: Str(smoke-job)'
)
missing() {
  local m=()
  for pattern in "${expected[@]}"; do grep -qF "$pattern" "$scratch/received.log" || m+=("$pattern"); done
  if [[ ${#m[@]} -gt 0 ]]; then printf '%s\n' "${m[@]}"; fi
  # Structured checks: point vs resource attributes, cluster state, events, self-telemetry.
  bun scripts/smoke-check.ts "$scratch/received.log"
}
# The sink's debug output is large enough for the kubelet to rotate its log during the test, and
# kubectl logs reads only the current file: keep everything seen so far, appending what's new.
kubectl -n obs-test logs deployment/sink > "$scratch/received.log"
# Self-telemetry is sent every 60 s, so allow a few minutes.
for _ in $(seq 1 120); do
  kubectl -n obs-test logs deployment/sink --since=10s >> "$scratch/received.log"
  if [[ -z "$(missing)" ]]; then
    # The full configs (k8s_attributes, file_log, k8s_cluster, k8s_objects, telemetry resource)
    # log no deprecation warnings.
    deprecations=$(kubectl -n ezgh-obs logs -l app.kubernetes.io/instance=ezgh-obs-agent --tail=-1 --prefix \
      | grep '"level":"warn"' | grep -iE 'deprecated|legacy' || true)
    if [[ -n "$deprecations" ]]; then
      echo 'The agents logged deprecation warnings:' >&2
      echo "$deprecations" >&2
      exit 1
    fi
    kubectl -n ezgh-obs rollout restart daemonset/ezgh-obs-agent
    kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent --timeout=180s
    kubectl -n ezgh-obs rollout restart deployment/ezgh-obs-agent-cluster
    kubectl -n ezgh-obs rollout status deployment/ezgh-obs-agent-cluster --timeout=180s
    echo 'PASS: two agents, container logs, kubelet metrics, Kubernetes labels, cluster state, events, self-telemetry, application traces, workload service names, TLS export, no deprecation warnings, rolling restart'
    exit 0
  fi
  sleep 2
done
echo 'Expected telemetry did not arrive at the test sink. Missing:' >&2
missing | sed 's/^/  /' >&2
for span in ezgh-smoke-span ezgh-smoke-job-span; do
  echo "Resource of $span:" >&2
  grep -B40 "$span" "$scratch/received.log" | grep -E 'Resource attributes|->' | tail -15 >&2 || true
done
kubectl -n obs-test get pods -o wide >&2 || true
for pod in $(kubectl -n ezgh-obs get pods -l app.kubernetes.io/instance=ezgh-obs-agent -o name); do
  echo "Self-metrics of $pod:" >&2
  kubectl get --raw "/api/v1/namespaces/ezgh-obs/pods/${pod#pod/}:8888/proxy/metrics" \
    | grep -E '^otelcol_(receiver_(accepted|refused)|processor_|exporter_(sent|send_failed|enqueue_failed)|exporter_queue_size)' \
    | grep -iE 'span|trace|queue_size' >&2 || true
done
exit 1
