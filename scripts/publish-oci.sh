#!/usr/bin/env bash
# Pushes a packaged chart to GHCR as an OCI artifact, then checks that it can be pulled anonymously
# with the same digest. Usage: scripts/publish-oci.sh dist/ezgh-obs-agent-<version>.tgz
# Needs GITHUB_TOKEN (packages: write) and GITHUB_ACTOR; OCI_REPO overrides the destination.
set -euo pipefail

package=${1:?usage: publish-oci.sh <chart .tgz>}
repo=${OCI_REPO:-oci://ghcr.io/ezgamehost/charts}
name=$(basename "$package" | sed -E 's/-[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?\.tgz$//')
version=$(basename "$package" .tgz | sed "s/^$name-//")
registry=${repo#oci://}
registry=${registry%%/*}

echo "$GITHUB_TOKEN" | helm registry login "$registry" --username "$GITHUB_ACTOR" --password-stdin
pushed=$(helm push "$package" "$repo" 2>&1 | tee /dev/stderr | awk '/^Digest:/ {print $2}')
helm registry logout "$registry"
test -n "$pushed"

# A chart people can't pull isn't released: GHCR packages start private unless the organization
# allows public ones; set the package public in its settings, then rerun this job.
work=$(mktemp -d)
if ! pulled=$(HELM_REGISTRY_CONFIG="$work/none.json" helm pull "$repo/$name" --version "$version" --destination "$work" 2>&1); then
  echo "$pulled" >&2
  echo "::error::$repo/$name:$version was pushed ($pushed) but can't be pulled anonymously; make the GHCR package public and rerun." >&2
  exit 1
fi
echo "$pulled"
grep -q "Digest: $pushed" <<<"$pulled"
cmp "$package" "$work/$name-$version.tgz"
echo "Published $repo/$name:$version ($pushed)"
