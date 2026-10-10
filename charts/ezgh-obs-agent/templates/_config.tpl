{{- define "agent.config" -}}
extensions:
  health_check:
    endpoint: "0.0.0.0:13133"
  file_storage:
    directory: /var/lib/ezgh-obs-agent/data
    create_directory: true
    directory_permissions: "0700"
    fsync: true
    max_size: {{ mul .Values.export.storageMaxMiB 1048576 }}
    compaction:
      on_start: true
      directory: /var/lib/ezgh-obs-agent/compaction

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
  filelog:
    include: ["/var/log/pods/*/*/*.log"]
    exclude:
      - '/var/log/pods/${env:POD_NAMESPACE}_${env:POD_NAME}_*/*/*.log'
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
    auth_type: serviceAccount
    endpoint: {{ .Values.metrics.kubelet.endpoint | quote }}
    insecure_skip_verify: {{ .Values.metrics.kubelet.insecureSkipVerify }}
    {{- if .Values.metrics.kubelet.caConfigMap }}
    ca_file: /etc/kubelet-ca/ca.crt
    {{- end }}
    collection_interval: {{ .Values.metrics.collectionInterval | quote }}
    metric_groups: [node, pod, container, volume]
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
  transform/application:
    error_mode: ignore
    {{- if .Values.logs.enabled }}
    log_statements:
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}
    {{- if .Values.metrics.enabled }}
    metric_statements:
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}
    {{- if .Values.traces.enabled }}
    trace_statements:
      {{- include "agent.applicationStatements" . | nindent 6 }}
    {{- end }}

exporters:
  {{- range $signal := list "logs" "metrics" "traces" }}
  {{- if (index $.Values $signal).enabled }}
  otlp_http/{{ $signal }}:
    endpoint: {{ $.Values.ezgh.endpoint | quote }}
    headers:
      authorization: "Bearer ${env:EZGH_INGEST_KEY}"
    compression: gzip
    timeout: {{ $.Values.export.timeout | quote }}
    retry_on_failure:
      enabled: true
      initial_interval: 1s
      max_interval: 30s
      max_elapsed_time: 0s
    sending_queue:
      enabled: true
      storage: file_storage
      sizer: bytes
      queue_size: {{ mul $.Values.export.queueSizeMiB 1048576 }}
      num_consumers: {{ $.Values.export.numConsumers }}
      # Batch after durable enqueue, with byte limits below EZGH's 5 MiB wire cap.
      batch:
        sizer: bytes
        min_size: 262144
        max_size: 1048576
        flush_timeout: 1s
  {{- end }}
  {{- end }}

service:
  extensions: [health_check, file_storage]
  telemetry:
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
  pipelines:
    {{- if .Values.logs.enabled }}
    logs:
      receivers: [otlp]
      processors: [memory_limiter, resource/ezgh, transform/application]
      exporters: [otlp_http/logs]
    {{- if .Values.logs.collectContainerLogs }}
    logs/node:
      receivers: [filelog]
      processors: [memory_limiter, resource/node, resource/ezgh, transform/application]
      exporters: [otlp_http/logs]
    {{- end }}
    {{- end }}
    {{- if .Values.metrics.enabled }}
    metrics:
      receivers: [otlp]
      processors: [memory_limiter, resource/ezgh, transform/application]
      exporters: [otlp_http/metrics]
    {{- if .Values.metrics.collectKubeletMetrics }}
    metrics/node:
      receivers: [kubelet_stats]
      processors: [memory_limiter, resource/node, resource/ezgh, transform/application]
      exporters: [otlp_http/metrics]
    {{- end }}
    {{- end }}
    {{- if .Values.traces.enabled }}
    traces:
      receivers: [otlp]
      processors: [memory_limiter, resource/ezgh, transform/application]
      exporters: [otlp_http/traces]
    {{- end }}
{{- end -}}
