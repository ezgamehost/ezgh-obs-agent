{{- define "agent.name" -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "agent.clusterRoleName" -}}
{{- $identity := printf "%s/%s" .Release.Namespace .Release.Name -}}
{{- printf "%s-%s" (printf "%s-%s" .Release.Namespace .Release.Name | trunc 50 | trimSuffix "-") (sha256sum $identity | trunc 10) -}}
{{- end -}}

{{- define "agent.selectorLabels" -}}
app.kubernetes.io/name: ezgh-obs-agent
app.kubernetes.io/instance: {{ .Release.Name | quote }}
{{- end -}}

{{- define "agent.labels" -}}
{{ include "agent.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- define "agent.validate" -}}
{{- if not (or .Values.logs.enabled .Values.metrics.enabled .Values.traces.enabled) -}}
{{- fail "at least one of logs.enabled, metrics.enabled, traces.enabled must be true" -}}
{{- end -}}
{{- if ge (int .Values.memoryLimiter.spikeLimitMiB) (int .Values.memoryLimiter.limitMiB) -}}
{{- fail "memoryLimiter.spikeLimitMiB must be less than memoryLimiter.limitMiB" -}}
{{- end -}}
{{- if ge (int .Values.clusterState.memoryLimiter.spikeLimitMiB) (int .Values.clusterState.memoryLimiter.limitMiB) -}}
{{- fail "clusterState.memoryLimiter.spikeLimitMiB must be less than clusterState.memoryLimiter.limitMiB" -}}
{{- end -}}
{{- if and (hasKey .Values.clusterState.nodeSelector "kubernetes.io/os") (ne (index .Values.clusterState.nodeSelector "kubernetes.io/os") "linux") -}}
{{- fail "ezgh-obs-agent supports Linux nodes only" -}}
{{- end -}}
{{- if le (int .Values.export.storageMaxMiB) (int .Values.export.queueSizeMiB) -}}
{{- fail "export.storageMaxMiB must exceed export.queueSizeMiB to allow storage overhead" -}}
{{- end -}}
{{- if and (hasKey .Values.nodeSelector "kubernetes.io/os") (ne (index .Values.nodeSelector "kubernetes.io/os") "linux") -}}
{{- fail "ezgh-obs-agent supports Linux nodes only" -}}
{{- end -}}
{{- end -}}

{{- define "agent.applicationStatements" -}}
- context: resource
  statements:
    - 'set(attributes["ezgh.metadata.application"], attributes["service.name"]) where attributes["ezgh.metadata.application"] == nil or attributes["ezgh.metadata.application"] == ""'
    - 'set(attributes["ezgh.metadata.application"], attributes["k8s.container.name"]) where attributes["ezgh.metadata.application"] == nil or attributes["ezgh.metadata.application"] == ""'
    - 'set(attributes["ezgh.metadata.application"], "kubernetes") where attributes["ezgh.metadata.application"] == nil or attributes["ezgh.metadata.application"] == ""'
{{- end -}}

{{- /* Whether the agent reads pod metadata from the API: some pipeline uses k8sattributes. */ -}}
{{- define "agent.k8sMetadata" -}}
{{- if and .Values.kubernetesMetadata.enabled (or (and .Values.logs.enabled .Values.logs.collectContainerLogs) (and .Values.metrics.enabled .Values.metrics.collectKubeletMetrics) (include "agent.k8sMetadataOtlp" .)) -}}
true
{{- end -}}
{{- end -}}

{{- /* Whether application OTLP gets pod metadata: only when it stays on its node's agent. */ -}}
{{- define "agent.k8sMetadataOtlp" -}}
{{- if and .Values.kubernetesMetadata.enabled (eq .Values.otlp.internalTrafficPolicy "Local") -}}
true
{{- end -}}
{{- end -}}

{{- /* Whether the pod needs a ServiceAccount token: the kubelet or the Kubernetes API. */ -}}
{{- define "agent.apiAccess" -}}
{{- if or (and .Values.metrics.enabled .Values.metrics.collectKubeletMetrics) (include "agent.k8sMetadata" .) -}}
true
{{- end -}}
{{- end -}}

{{- /* service.name from the pod's workload, when the telemetry doesn't name its service. */ -}}
{{- define "agent.serviceStatements" -}}
- context: resource
  statements:
    {{- range list "k8s.deployment.name" "k8s.statefulset.name" "k8s.daemonset.name" "k8s.cronjob.name" "k8s.job.name" "k8s.container.name" }}
    - 'set(attributes["service.name"], attributes["{{ . }}"]) where attributes["{{ . }}"] != nil and attributes["{{ . }}"] != "" and (attributes["service.name"] == nil or attributes["service.name"] == "" or IsMatch(attributes["service.name"], "^unknown_service"))'
    {{- end }}
{{- end -}}

{{- /* A container log's level, when the runtime gave none: from a JSON body's level field (or
pino/bunyan's numbers), logfmt's level=, klog's I/W/E/F prefix, or a leading level word after an
optional timestamp and [thread]. Nothing matched leaves it unset; stderr isn't taken as an error. */ -}}
{{- define "agent.severityStatements" -}}
- context: log
  conditions:
    - severity_number == SEVERITY_NUMBER_UNSPECIFIED
  statements:
    - 'set(cache["json"], ParseJSON(body)) where IsMatch(body, "^\\s*\\{")'
    {{- range list "level" "severity" "lvl" "levelname" "log.level" "loglevel" "@l" }}
    - 'set(cache["level"], cache["json"]["{{ . }}"]) where cache["level"] == nil and cache["json"] != nil and cache["json"]["{{ . }}"] != nil'
    {{- end }}
    {{- range $n, $name := dict "10" "trace" "20" "debug" "30" "info" "40" "warn" "50" "error" "60" "fatal" }}
    - 'set(cache["level"], "{{ $name }}") where cache["level"] == {{ $n }}'
    {{- end }}
    - 'merge_maps(cache, ExtractPatterns(body, "(?:^|\\s)(?:level|lvl|severity)=\"?(?P<level>[A-Za-z]+)"), "insert") where cache["level"] == nil'
    - 'merge_maps(cache, ExtractPatterns(body, "^(?P<klog>[IWEF])\\d{4} \\d{2}:\\d{2}:\\d{2}"), "insert") where cache["level"] == nil'
    {{- range $k, $name := dict "I" "info" "W" "warn" "E" "error" "F" "fatal" }}
    - 'set(cache["level"], "{{ $name }}") where cache["level"] == nil and cache["klog"] == "{{ $k }}"'
    {{- end }}
    - 'merge_maps(cache, ExtractPatterns(body, "^\\s*(?:\\[?[0-9][0-9TZ:.,/+ -]*\\]?\\s+)?(?:\\[[^\\]]{1,40}\\]\\s+)?[\\[<]?(?P<level>(?i:trace|debug|info|notice|warn|warning|error|err|crit|critical|fatal|panic|alert|emerg))[\\]>]?(?:[\\s:|]|$)"), "insert") where cache["level"] == nil'
    {{- range $name, $re := dict "TRACE" "trace" "DEBUG" "debug" "INFO" "info|notice" "WARN" "warn|warning" "ERROR" "error|err" "FATAL" "fatal|panic|crit|critical|alert|emerg" }}
    - 'set(severity_text, "{{ $name }}") where IsString(cache["level"]) and IsMatch(cache["level"], "(?i)^({{ $re }})$")'
    {{- end }}
    {{- range $name := list "TRACE" "DEBUG" "INFO" "WARN" "ERROR" "FATAL" }}
    - 'set(severity_number, SEVERITY_NUMBER_{{ $name }}) where severity_text == "{{ $name }}"'
    {{- end }}
{{- end -}}

{{- /* Kubernetes resource attributes every agent metric datapoint also carries as a point attribute,
so PromQL can group and filter by them (obs turns point attributes into labels; resource attributes
other than service and instance aren't). An attribute the datapoint already has is kept. */ -}}
{{- define "agent.k8sLabelKeys" -}}
{{- list "k8s.cluster.name" "k8s.namespace.name" "k8s.node.name" "k8s.pod.name" "k8s.container.name" "k8s.deployment.name" "k8s.statefulset.name" "k8s.daemonset.name" "k8s.replicaset.name" "k8s.job.name" "k8s.cronjob.name" "k8s.hpa.name" "k8s.persistentvolumeclaim.name" "k8s.volume.name" "k8s.volume.type" "k8s.resourcequota.name" "k8s.replicationcontroller.name" | toJson -}}
{{- end -}}

{{- define "agent.k8sLabelsProcessor" -}}
transform/k8slabels:
  error_mode: ignore
  metric_statements:
    - context: datapoint
      statements:
        {{- range include "agent.k8sLabelKeys" . | fromJsonArray }}
        - 'set(attributes["{{ . }}"], resource.attributes["{{ . }}"]) where resource.attributes["{{ . }}"] != nil and attributes["{{ . }}"] == nil'
        {{- end }}
{{- end -}}

{{- /* Whether kubelet_stats/pods reads pod specs from the kubelet's /pods: requests/limits
utilization and volume types. Kubelets authorize /pods with nodes/pods since 1.33
(KubeletFineGrainedAuthz, beta and on by default); older ones need nodes/proxy, which this chart
never grants. auto: on when the API server is 1.33+. A failed /pods read fails that receiver's
scrape only, so kubelets lagging behind the control plane lose just those metrics. */ -}}
{{- define "agent.podSpecs" -}}
{{- $mode := .Values.metrics.kubelet.podSpecs -}}
{{- if and .Values.metrics.enabled .Values.metrics.collectKubeletMetrics -}}
{{- if or (eq (toString $mode) "true") (and (eq (toString $mode) "auto") (semverCompare ">=1.33.0-0" .Capabilities.KubeVersion.Version)) -}}
true
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Whether the cluster-state Deployment runs: it has cluster metrics or events to send. */ -}}
{{- define "agent.clusterState" -}}
{{- if and .Values.clusterState.enabled (or .Values.metrics.enabled .Values.logs.enabled) -}}
true
{{- end -}}
{{- end -}}

{{- define "agent.clusterStateName" -}}
{{- printf "%s-cluster" (include "agent.name" . | trunc 55 | trimSuffix "-") -}}
{{- end -}}

{{- define "agent.clusterStateSelectorLabels" -}}
app.kubernetes.io/name: ezgh-obs-agent-cluster
app.kubernetes.io/instance: {{ .Release.Name | quote }}
app.kubernetes.io/component: cluster-state
{{- end -}}

{{- define "agent.clusterStateLabels" -}}
{{ include "agent.clusterStateSelectorLabels" . }}
app.kubernetes.io/part-of: ezgh-obs-agent
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service | quote }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}

{{- /* The node-local storage extension (DaemonSet: hostPath; cluster state: emptyDir). */ -}}
{{- define "agent.fileStorage" -}}
file_storage:
  directory: /var/lib/ezgh-obs-agent/data
  create_directory: true
  directory_permissions: "0700"
  fsync: true
  max_size: {{ mul .Values.export.storageMaxMiB 1048576 }}
  compaction:
    on_start: true
    directory: /var/lib/ezgh-obs-agent/compaction
{{- end -}}

{{- /* One durable OTLP/HTTP exporter per signal in .signals. */ -}}
{{- define "agent.exporters" -}}
{{- $root := .root -}}
{{- range $signal := .signals }}
otlp_http/{{ $signal }}:
  endpoint: {{ $root.Values.ezgh.endpoint | quote }}
  headers:
    authorization: "Bearer ${env:EZGH_INGEST_KEY}"
  compression: gzip
  timeout: {{ $root.Values.export.timeout | quote }}
  retry_on_failure:
    enabled: true
    initial_interval: 1s
    max_interval: 30s
    max_elapsed_time: 0s
  sending_queue:
    enabled: true
    storage: file_storage
    sizer: bytes
    queue_size: {{ mul $root.Values.export.queueSizeMiB 1048576 }}
    num_consumers: {{ $root.Values.export.numConsumers }}
    # Batch after durable enqueue, with byte limits below EZGH's 5 MiB wire cap.
    batch:
      sizer: bytes
      min_size: 262144
      max_size: 1048576
      flush_timeout: 1s
{{- end }}
{{- end -}}

{{- /* The Collector's own logs and metrics. Metrics stay on :8888 for a scraper, and, when metrics
are enabled, also go every 60 s to this agent's own OTLP receiver, through its normal metrics
pipeline (once: the pipeline doesn't feed telemetry back), as service.name=ezgh-obs-agent.
.instance is service.instance.id; .resource adds attributes. */ -}}
{{- define "agent.telemetry" -}}
telemetry:
  {{- if .root.Values.metrics.enabled }}
  resource:
    service.name: ezgh-obs-agent
    service.instance.id: {{ .instance | quote }}
    k8s.cluster.name: "${env:CLUSTER_NAME}"
    k8s.namespace.name: "${env:POD_NAMESPACE}"
    k8s.pod.name: "${env:POD_NAME}"
    {{- range $k, $v := .resource }}
    {{ $k }}: {{ $v | quote }}
    {{- end }}
  {{- end }}
  logs:
    level: info
    encoding: json
  metrics:
    readers:
      - pull:
          exporter:
            prometheus:
              host: "0.0.0.0"
              port: 8888
      {{- if .root.Values.metrics.enabled }}
      - periodic:
          interval: 60000
          timeout: 30000
          exporter:
            otlp:
              protocol: http/protobuf
              endpoint: http://127.0.0.1:4318/v1/metrics
      {{- end }}
{{- end -}}

{{- define "agent.kubeletClient" -}}
auth_type: serviceAccount
endpoint: {{ .Values.metrics.kubelet.endpoint | quote }}
insecure_skip_verify: {{ .Values.metrics.kubelet.insecureSkipVerify }}
{{- if .Values.metrics.kubelet.caConfigMap }}
ca_file: /etc/kubelet-ca/ca.crt
{{- end }}
collection_interval: {{ .Values.metrics.collectionInterval | quote }}
{{- end -}}
