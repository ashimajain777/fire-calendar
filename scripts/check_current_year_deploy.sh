#!/usr/bin/env bash
# Checks that the deployed site serves the files that exist only on the "data" release:
# every dekad_*.parquet and points_*.parquet asset must answer 200 with the asset's size.
# Usage: scripts/check_current_year_deploy.sh [site base URL]      (REPO=owner/name to change the repo)
set -uo pipefail
base=${1:-https://ashimajain777.github.io/fire-calendar}
repo=${REPO:-ashimajain777/fire-calendar}
assets=$(gh release view data --repo "$repo" --json assets \
  --jq '.assets[] | select(.name | test("^(dekad|points)_.*\\.parquet$")) | "\(.name) \(.size)"') || exit 2
[ -n "$assets" ] || { echo "no dekad_/points_ assets on release 'data' of $repo"; exit 2; }
bad=0; n=0
printf '%-24s %-6s %12s %12s  %s\n' file http asset_bytes served_bytes result
while read -r name size; do
  kind=${name%%_*}
  head=$(curl -sI "$base/data/$kind/$name" | tr -d '\r')
  code=$(awk 'NR==1 {print $2}' <<<"$head")
  len=$(awk -F': ' 'tolower($1)=="content-length" {print $2}' <<<"$head")
  if [ "$code" = 200 ] && [ "$len" = "$size" ]; then res=ok; else res=MISMATCH; bad=$((bad + 1)); fi
  n=$((n + 1))
  printf '%-24s %-6s %12s %12s  %s\n' "$name" "${code:--}" "$size" "${len:--}" "$res"
done <<<"$assets"
echo "$n assets checked, $bad mismatched ($base)"
[ "$bad" -eq 0 ]
