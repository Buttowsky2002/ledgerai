{{/*
Expand the chart name.
*/}}
{{- define "agentledger.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Fully qualified app name (release-scoped).
*/}}
{{- define "agentledger.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/*
Common labels.
*/}}
{{- define "agentledger.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
app.kubernetes.io/name: {{ include "agentledger.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: agentledger
{{- end -}}

{{/*
Selector labels for a single service. Call with (dict "root" $ "name" $svcName).
*/}}
{{- define "agentledger.selectorLabels" -}}
app.kubernetes.io/name: {{ include "agentledger.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .name }}
{{- end -}}

{{/*
ServiceAccount name.
*/}}
{{- define "agentledger.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "agentledger.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/*
Per-service resource name: "<fullname>-<service>".
Call with (dict "root" $ "name" $svcName).
*/}}
{{- define "agentledger.svcName" -}}
{{- printf "%s-%s" (include "agentledger.fullname" .root) .name | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Resolve a service's container image.
Call with (dict "root" $ "name" $svcName "svc" $svc).
*/}}
{{- define "agentledger.image" -}}
{{- $img := .root.Values.image -}}
{{- $tag := default .root.Chart.AppVersion $img.tag -}}
{{- if .svc.image -}}
{{- .svc.image -}}
{{- else -}}
{{- printf "%s/%s-%s:%s" $img.registry $img.repository .name $tag -}}
{{- end -}}
{{- end -}}
