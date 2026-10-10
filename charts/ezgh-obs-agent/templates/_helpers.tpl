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
