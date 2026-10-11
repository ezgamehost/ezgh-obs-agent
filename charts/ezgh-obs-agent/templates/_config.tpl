{{- define "agent.config" -}}
extensions:
  health_check:
    endpoint: "0.0.0.0:13133"
  {{- include "agent.fileStorage" . | nindent 2 }}

receivers:
  otlp:
    protocols:
      grpc:
        endpoint: "0.0.0.0:4317"
        max_recv_msg_size_mib: 4
      http:
        endpoint: "0.0.0.0:4318"
        max_request_body_size: 4194304
  {{- if and .Values.logs.enabled .Values.logs.collectContainerLogs }}
  file_log:
    include: ["/var/log/pods/*/*/*.log"]
    exclude:
      - '/var/log/pods/${env:POD_NAMESPACE}_${env:POD_NAME}_*/*/*.log'
      {{- if include "agent.clusterState" . }}
      # The cluster-state Deployment's pods: <deployment>-<replicaset hash>-<suffix>, with the
      # generated prefix cut to 58 characters.
      - {{ printf "/var/log/pods/${env:POD_NAMESPACE}_%s*_*/*/*.log" (printf "%s-" (include "agent.clusterStateName" .) | trunc 58) | quote }}
      {{- end }}
      {{- range .Values.logs.excludeNamespaces }}
      - {{ printf "/var/log/pods/%s_*/*/*.log" . | quote }}
      {{- end }}
      {{- range .Values.logs.exclude }}
      - {{ . | quote }}
      {{- end }}
    start_at: {{ .Values.logs.startAt }}
    include_file_path: true
    include_file_name: false
    max_log_size: {{ .Values.logs.maxLogSize | quote }}
    storage: file_storage
    retry_on_failure:
      enabled: true
      max_elapsed_time: 0s
    operators:
      - type: container
        max_log_size: {{ .Values.logs.maxLogSize | quote }}
  {{- end }}
  {{- if and .Values.metrics.enabled .Values.metrics.collectKubeletMetrics }}
  kubelet_stats:
    {{- include "agent.kubeletClient" . | nindent 4 }}
    metric_groups: [node, pod, container{{ if not (include "agent.podSpecs" .) }}, volume{{ end }}]
    metrics:
      k8s.node.uptime: {enabled: true}
      k8s.pod.uptime: {enabled: true}
      k8s.node.filesystem.inode.count: {enabled: true}
      k8s.node.filesystem.inode.free: {enabled: true}
  {{- if include "agent.podSpecs" . }}
  # What needs pod specs from the kubelet's /pods (nodes/pods), in its own receiver: a kubelet that
  # refuses /pods (older than 1.33, e.g. a node pool behind its control plane) fails only this
  # scrape (request/limit utilization, volume metrics), not the node, pod and container metrics.
  kubelet_stats/pods:
    {{- include "agent.kubeletClient" . | nindent 4 }}
    metric_groups: [pod, container, volume]
    # Volume types and PVC names on volume metrics.
    extra_metadata_labels: [k8s.volume.type]
    metrics:
      {{- range $kind := list "pod" "container" }}
      {{- range $m := list "cpu_limit" "cpu_request" "memory_limit" "memory_request" }}
      k8s.{{ $kind }}.{{ $m }}_utilization: {enabled: true}
      {{- end }}
      {{- end }}
      # The rest of the pod and container groups come from kubelet_stats.
      {{- range $m := list "cpu.time" "cpu.usage" "filesystem.available" "filesystem.capacity" "filesystem.usage" "memory.available" "memory.major_page_faults" "memory.page_faults" "memory.rss" "memory.usage" "memory.working_set" }}
      k8s.pod.{{ $m }}: {enabled: false}
      container.{{ $m }}: {enabled: false}
      {{- end }}
      k8s.pod.network.errors: {enabled: false}
      k8s.pod.network.io: {enabled: false}
  {{- end }}
  {{- end }}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: {{ .Values.memoryLimiter.limitMiB }}
    spike_limit_mib: {{ .Values.memoryLimiter.spikeLimitMiB }}
  resource/ezgh:
    attributes:
      - {key: ezgh.metadata.environment, value: "${env:EZGH_ENVIRONMENT}", action: upsert}
      - {key: k8s.cluster.name, value: "${env:CLUSTER_NAME}", action: upsert}
      {{- if .Values.cluster.uid }}
      - {key: k8s.cluster.uid, value: "${env:CLUSTER_UID}", action: upsert}
      {{- end }}
  {{- if or (and .Values.logs.enabled .Values.logs.collectContainerLogs) (and .Values.metrics.enabled .Values.metrics.collectKubeletMetrics) }}
  resource/node:
    attributes:
      - {key: k8s.node.name, value: "${env:NODE_NAME}", action: upsert}
  {{- end }}
  {{- if include "agent.k8sMetadata" . }}
  k8s_attributes:
    auth_type: serviceAccount
    # Only this node's pods: each agent watches what it collects, not the whole cluster.
    filter:
      node_from_env_var: NODE_NAME
    # Hold telemetry at startup until the pod list has synced, so the first logs are named too.
    wait_for_metadata: true
    wait_for_metadata_timeout: 1m
    extract:
      metadata:
        - k8s.namespace.name
        - k8s.pod.name
        - k8s.pod.uid
        - k8s.deployment.name
        - k8s.statefulset.name
        - k8s.daemonset.name
        - k8s.cronjob.name
        - k8s.job.name
    pod_association:
      - sources: [{from: resource_attribute, name: k8s.pod.uid}]
      {{- if include "agent.k8sMetadataOtlp" . }}
      - sources: [{from: resource_attribute, name: k8s.pod.ip}]
      - sources: [{from: connection}]
      {{- end }}
  {{- end }}
  {{- if and .Values.logs.enabled .Values.logs.collectContainerLogs .Values.logs.parseSeverity }}
  transform/severity:
    error_mode: ignore
    log_statements:
      {{- include "agent.severityStatements" . | nindent 6 }}
  {{- end }}
  transform/application:
    error_mode: ignore
    {{- if .Values.logs.enabled }}
    log_statements:
      {{- include "agent.serviceStatements" . | nindent 6 }}
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}
    {{- if .Values.metrics.enabled }}
    metric_statements:
      {{- include "agent.serviceStatements" . | nindent 6 }}
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}
    {{- if .Values.traces.enabled }}
    trace_statements:
      {{- include "agent.serviceStatements" . | nindent 6 }}
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}
  {{- if .Values.metrics.enabled }}
  {{- include "agent.k8sLabelsProcessor" . | nindent 2 }}
  {{- end }}

exporters:
  {{- $signals := list }}
  {{- range $signal := list "logs" "metrics" "traces" }}
  {{- if (index $.Values $signal).enabled }}{{ $signals = append $signals $signal }}{{ end }}
  {{- end }}
  {{- include "agent.exporters" (dict "root" . "signals" $signals) | trim | nindent 2 }}

service:
  extensions: [health_check, file_storage]
  {{- include "agent.telemetry" (dict "root" . "instance" "${env:NODE_NAME}" "resource" (dict "k8s.node.name" "${env:NODE_NAME}")) | nindent 2 }}
  pipelines:
    {{- if .Values.logs.enabled }}
    logs:
      receivers: [otlp]
      processors: [memory_limiter{{ if include "agent.k8sMetadataOtlp" . }}, k8s_attributes{{ end }}, resource/ezgh, transform/application]
      exporters: [otlp_http/logs]
    {{- if .Values.logs.collectContainerLogs }}
    logs/node:
      receivers: [file_log]
      processors: [memory_limiter{{ if include "agent.k8sMetadata" . }}, k8s_attributes{{ end }}, resource/node, resource/ezgh{{ if .Values.logs.parseSeverity }}, transform/severity{{ end }}, transform/application]
      exporters: [otlp_http/logs]
    {{- end }}
    {{- end }}
    {{- if .Values.metrics.enabled }}
    metrics:
      receivers: [otlp]
      processors: [memory_limiter{{ if include "agent.k8sMetadataOtlp" . }}, k8s_attributes{{ end }}, resource/ezgh, transform/application, transform/k8slabels]
      exporters: [otlp_http/metrics]
    {{- if .Values.metrics.collectKubeletMetrics }}
    metrics/node:
      receivers: [kubelet_stats{{ if include "agent.podSpecs" . }}, kubelet_stats/pods{{ end }}]
      processors: [memory_limiter{{ if include "agent.k8sMetadata" . }}, k8s_attributes{{ end }}, resource/node, resource/ezgh, transform/application, transform/k8slabels]
      exporters: [otlp_http/metrics]
    {{- end }}
    {{- end }}
    {{- if .Values.traces.enabled }}
    traces:
      receivers: [otlp]
      processors: [memory_limiter{{ if include "agent.k8sMetadataOtlp" . }}, k8s_attributes{{ end }}, resource/ezgh, transform/application]
      exporters: [otlp_http/traces]
    {{- end }}
{{- end -}}
