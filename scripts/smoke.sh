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
EOF
kubectl apply -f "$scratch/sink.yaml"
kubectl -n obs-test rollout status deployment/sink --timeout=180s
helm upgrade --install ezgh-obs-agent charts/ezgh-obs-agent --namespace ezgh-obs \
  -f tests/values.yaml --set ezgh.endpoint=https://sink.obs-test.svc \
  --set metrics.kubelet.insecureSkipVerify=true --set metrics.collectionInterval=5s \
  --set 'logs.excludeNamespaces[0]=obs-test'
# Trust only the disposable sink CA for this test. Production uses the system CA bundle.
kubectl -n ezgh-obs patch daemonset ezgh-obs-agent --type=strategic --patch '
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
kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent --timeout=180s
ready=$(kubectl -n ezgh-obs get daemonset ezgh-obs-agent -o jsonpath='{.status.numberReady}')
[[ "$ready" == 2 ]]
# Push one trace through the in-cluster OTLP Service (logs/metrics come from the nodes).
kubectl run smoke-trace --namespace obs-test --image=curlimages/curl:8.12.1 --restart=Never --command -- \
  curl --fail --retry 5 --retry-connrefused \
  -H 'Content-Type: application/json' \
  --data '{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"smoke-client"}}]},"scopeSpans":[{"spans":[{"traceId":"0123456789abcdef0123456789abcdef","spanId":"0123456789abcdef","name":"ezgh-smoke-span","startTimeUnixNano":"1791590400000000000","endTimeUnixNano":"1791590400001000000"}]}]}]}' \
  http://ezgh-obs-agent.ezgh-obs.svc:4318/v1/traces
for attempt in $(seq 1 60); do
  kubectl -n obs-test logs deployment/sink > "$scratch/received.log"
  if grep -q 'ezgh-smoke-log' "$scratch/received.log" && \
     grep -q 'ezgh-smoke-span' "$scratch/received.log" && \
     grep -q 'k8s.node.cpu' "$scratch/received.log" && \
     grep -q 'Str(ezgh-obs-agent-worker)' "$scratch/received.log" && \
     grep -q 'Str(ezgh-obs-agent-worker2)' "$scratch/received.log"; then
    kubectl -n ezgh-obs rollout restart daemonset/ezgh-obs-agent
    kubectl -n ezgh-obs rollout status daemonset/ezgh-obs-agent --timeout=180s
    echo 'PASS: two agents, container logs, kubelet metrics, application traces, TLS export, rolling restart'
    exit 0
  fi
  sleep 2
done
echo 'Expected telemetry did not arrive at the test sink' >&2
exit 1
