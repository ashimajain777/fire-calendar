#!/usr/bin/env bash
# Downloads FIRMS per-country yearly CSVs for India. Skips files already complete.
base=https://firms.modaps.eosdis.nasa.gov/data/country
dl() { s=$1; y=$2; f="work/csv/$s/${s}_${y}_India.csv"; mkdir -p "work/csv/$s"
  [ -s "$f" ] && return
  code=$(curl -sL --retry 3 --retry-delay 5 -o "$f.part" -w '%{http_code}' "$base/$s/$y/${s}_${y}_India.csv")
  if [ "$code" = 200 ]; then mv "$f.part" "$f"; echo "ok $s $y $(wc -l < "$f")"; else rm -f "$f.part"; echo "missing $s $y http=$code"; fi; }
for y in $(seq 2000 2025); do dl modis $y; done
for y in $(seq 2012 2025); do dl viirs-snpp $y; done
for y in $(seq 2017 2025); do dl viirs-jpss1 $y; done
echo DONE
