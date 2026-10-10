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
