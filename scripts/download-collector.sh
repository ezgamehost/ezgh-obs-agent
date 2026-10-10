#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
version=$(bun -e 'console.log(Bun.YAML.parse(await Bun.file("charts/ezgh-obs-agent/Chart.yaml").text()).appVersion)')
case "$(uname -s)" in Darwin) os=darwin ;; Linux) os=linux ;; *) exit 1 ;; esac
case "$(uname -m)" in arm64|aarch64) arch=arm64 ;; x86_64) arch=amd64 ;; *) exit 1 ;; esac
mkdir -p .tools
asset="otelcol-contrib_${version}_${os}_${arch}.tar.gz"
url="https://github.com/open-telemetry/opentelemetry-collector-releases/releases/download/v${version}/${asset}"
curl --fail --location --silent --show-error "$url" -o ".tools/$asset"
curl --fail --location --silent --show-error "$url.sha256" -o ".tools/$asset.sha256"
expected=$(awk '{print $1}' ".tools/$asset.sha256")
actual=$(shasum -a 256 ".tools/$asset" | awk '{print $1}')
if [[ "$actual" != "$expected" ]]; then
  echo "Collector archive checksum mismatch" >&2
  exit 1
fi
tar -xzf ".tools/$asset" -C .tools otelcol-contrib
.tools/otelcol-contrib --version
