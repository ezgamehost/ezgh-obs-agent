{{- /* The cluster-state Deployment's Collector: one replica for the whole cluster. Cluster metrics
(k8s_cluster) when metrics are enabled; Kubernetes events (k8s_objects) when logs are. */ -}}
{{- define "agent.clusterConfig" -}}
extensions:
  health_check:
    endpoint: "0.0.0.0:13133"
  {{- include "agent.fileStorage" . | nindent 2 }}

receivers:
  {{- if .Values.metrics.enabled }}
  # Only this Collector's own telemetry; not exposed outside the pod.
  otlp:
    protocols:
      http:
        endpoint: "127.0.0.1:4318"
  k8s_cluster:
    auth_type: serviceAccount
    collection_interval: {{ .Values.clusterState.collectionInterval | quote }}
    allocatable_types_to_report: [cpu, memory, pods]
    node_conditions_to_report: [Ready, MemoryPressure, DiskPressure, PIDPressure]
    metrics:
      k8s.node.condition: {enabled: true}
      k8s.pod.status_reason: {enabled: true}
      k8s.container.status.reason: {enabled: true}
      k8s.persistentvolumeclaim.status.phase: {enabled: true}
      k8s.persistentvolumeclaim.storage.capacity: {enabled: true}
      k8s.persistentvolumeclaim.storage.request: {enabled: true}
  {{- end }}
  {{- if .Values.logs.enabled }}
  k8s_objects:
    auth_type: serviceAccount
    objects:
      - name: events
        group: events.k8s.io
        mode: watch
        # Expiring events aren't news; additions and updates (a repeat raises its count) are.
        exclude_watch_type: [DELETED]
  {{- end }}

processors:
  memory_limiter:
    check_interval: 1s
    limit_mib: {{ .Values.clusterState.memoryLimiter.limitMiB }}
    spike_limit_mib: {{ .Values.clusterState.memoryLimiter.spikeLimitMiB }}
  resource/ezgh:
    attributes:
      - {key: ezgh.metadata.environment, value: "${env:EZGH_ENVIRONMENT}", action: upsert}
      - {key: k8s.cluster.name, value: "${env:CLUSTER_NAME}", action: upsert}
      {{- if .Values.cluster.uid }}
      - {key: k8s.cluster.uid, value: "${env:CLUSTER_UID}", action: upsert}
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
  {{- if .Values.metrics.enabled }}
  {{- if .Values.kubernetesMetadata.enabled }}
  # Pod and container metrics get their workload, as on the nodes, so service.name (PromQL job)
  # names the same workload in kubelet and cluster metrics.
  k8s_attributes:
    auth_type: serviceAccount
    wait_for_metadata: true
    wait_for_metadata_timeout: 1m
    extract:
      metadata:
        - k8s.deployment.name
        - k8s.statefulset.name
        - k8s.daemonset.name
        - k8s.cronjob.name
        - k8s.job.name
    pod_association:
      - sources: [{from: resource_attribute, name: k8s.pod.uid}]
  {{- end }}
  {{- include "agent.k8sLabelsProcessor" . | nindent 2 }}
  {{- end }}
  {{- if .Values.logs.enabled }}
  # events.k8s.io/v1 Event → log: the note as body, Warning → WARN and Normal → INFO, the reason,
  # type, object and count as attributes. The receiver already set k8s.namespace.name.
  transform/events:
    error_mode: ignore
    log_statements:
      - context: resource
        statements:
          - 'set(attributes["service.name"], "kubernetes-events")'
          - 'set(attributes["ezgh.metadata.application"], "kubernetes")'
      - context: log
        conditions:
          - IsMap(body) and IsMap(body["object"])
        statements:
          - 'set(cache["e"], body["object"])'
          - 'set(attributes["k8s.event.reason"], cache["e"]["reason"]) where cache["e"]["reason"] != nil'
          - 'set(attributes["k8s.event.type"], cache["e"]["type"]) where cache["e"]["type"] != nil'
          - 'set(attributes["k8s.object.kind"], cache["e"]["regarding"]["kind"]) where IsMap(cache["e"]["regarding"])'
          - 'set(attributes["k8s.object.name"], cache["e"]["regarding"]["name"]) where IsMap(cache["e"]["regarding"])'
          - 'set(attributes["k8s.event.count"], 1)'
          - 'set(attributes["k8s.event.count"], Int(cache["e"]["deprecatedCount"])) where cache["e"]["deprecatedCount"] != nil'
          - 'set(attributes["k8s.event.count"], Int(cache["e"]["series"]["count"])) where IsMap(cache["e"]["series"]) and cache["e"]["series"]["count"] != nil'
          - 'set(severity_text, "WARN") where cache["e"]["type"] == "Warning"'
          - 'set(severity_number, SEVERITY_NUMBER_WARN) where cache["e"]["type"] == "Warning"'
          - 'set(severity_text, "INFO") where cache["e"]["type"] == "Normal"'
          - 'set(severity_number, SEVERITY_NUMBER_INFO) where cache["e"]["type"] == "Normal"'
          - 'delete_key(attributes, "k8s.resource.name")'
          - 'delete_key(attributes, "event.domain")'
          - 'delete_key(attributes, "event.name")'
          - 'set(body, cache["e"]["reason"]) where cache["e"]["note"] == nil or cache["e"]["note"] == ""'
          - 'set(body, cache["e"]["note"]) where cache["e"]["note"] != nil and cache["e"]["note"] != ""'
  {{- end }}

exporters:
  {{- $signals := list }}
  {{- if .Values.logs.enabled }}{{ $signals = append $signals "logs" }}{{ end }}
  {{- if .Values.metrics.enabled }}{{ $signals = append $signals "metrics" }}{{ end }}
  {{- include "agent.exporters" (dict "root" . "signals" $signals) | trim | nindent 2 }}

service:
  extensions: [health_check, file_storage]
  {{- include "agent.telemetry" (dict "root" . "instance" "cluster-state" "resource" dict) | nindent 2 }}
  pipelines:
    {{- if .Values.metrics.enabled }}
    metrics/cluster:
      receivers: [k8s_cluster]
      processors: [memory_limiter{{ if .Values.kubernetesMetadata.enabled }}, k8s_attributes{{ end }}, resource/ezgh, transform/application, transform/k8slabels]
      exporters: [otlp_http/metrics]
    metrics/self:
      receivers: [otlp]
      processors: [memory_limiter, resource/ezgh, transform/application, transform/k8slabels]
      exporters: [otlp_http/metrics]
    {{- end }}
    {{- if .Values.logs.enabled }}
    logs/events:
      receivers: [k8s_objects]
      processors: [memory_limiter, resource/ezgh, transform/events, transform/application]
      exporters: [otlp_http/logs]
    {{- end }}
{{- end -}}
