#!/usr/bin/env bash
set -euo pipefail

# yt-filter-cookies.sh
# Filters a Netscape cookies.txt to only keep cookies relevant for YouTube/YouTube Music
# and related Google auth, producing a clean jar suitable for yt-dlp.
#
# Usage:
#   ./scripts/yt-filter-cookies.sh <input_cookies.txt> [output_file]
#
# Optional environment variables:
#   EXTRA_DOMAINS   Comma-separated extra domains to keep (e.g., ".googleusercontent.com,consent.youtube.com")
#
# Notes:
# - Keeps comment lines intact (e.g., Netscape header, #HttpOnly_ markers where appropriate)
# - Normalizes youtube.* domains to ".youtube.com" and sets Include-Subdomains=TRUE
# - Does NOT widen google domains (keeps accounts.google.com/.google.com as-is)

if [[ ${1:-} == "" ]]; then
  echo "Usage: $0 <input_cookies.txt> [output_file]" >&2
  exit 1
fi

infile="$1"
if [[ ! -f "$infile" ]]; then
  echo "Input file not found: $infile" >&2
  exit 1
fi

outfile="${2:-}"
if [[ -z "$outfile" ]]; then
  # Default to sibling yt-cookies.txt next to input
  base="$(basename -- "$infile")"
  dir="$(cd "$(dirname -- "$infile")" && pwd)"
  outfile="$dir/yt-cookies.txt"
fi

# Default domain allowlist (single-line; macOS awk is picky with newlines in -v assignments)
ALLOWED_DEFAULT=".youtube.com,youtube.com,www.youtube.com,music.youtube.com,m.youtube.com,studio.youtube.com,consent.youtube.com,accounts.youtube.com,.google.com,google.com,accounts.google.com"

# Merge optional extra domains provided by user
if [[ -n "${EXTRA_DOMAINS:-}" ]]; then
  # Normalize spaces/newlines -> commas and trim leading/trailing commas
  extra=$(printf '%s' "$EXTRA_DOMAINS" | tr ' \n' ',,' | tr -s ',' | sed -E 's/^,+|,+$//g')
  domains="$ALLOWED_DEFAULT,$extra"
else
  domains="$ALLOWED_DEFAULT"
fi

# Build AWK-safe domain list (comma separated, already)
awk -v doms="$domains" '
  BEGIN {
    FS=OFS="\t";
    n = split(doms, raw, ",");
    for (i=1;i<=n;i++) {
      gsub(/^\s+|\s+$/, "", raw[i]);
      if (raw[i] == "") continue;
      allow[raw[i]] = 1;
    }
  }

  # Print comment lines (headers) unchanged
  /^#/ { print; next }

  # Skip malformed rows (Netscape format has 7+ columns)
  NF < 7 { next }

  {
    orig = $0;
    domField = $1;
    httpOnly = 0;
    if (domField ~ /^#HttpOnly_/) {
      httpOnly = 1;
      sub(/^#HttpOnly_/, "", domField);
    }

    # Decide if we keep this cookie by domain allowlist
    keep = 0;
    for (d in allow) {
      if (domField == d) { keep = 1; break }
    }
    if (!keep) { next }

    # Normalize YouTube family: widen to .youtube.com and set include-subdomains TRUE
    if (domField == ".youtube.com" || domField == "youtube.com" || domField == "www.youtube.com" || domField == "music.youtube.com" || domField == "m.youtube.com" || domField == "studio.youtube.com" || domField == "accounts.youtube.com" || domField == "consent.youtube.com") {
      $1 = (httpOnly ? "#HttpOnly_.youtube.com" : ".youtube.com");
      $2 = "TRUE";
    } else {
      # Restore HttpOnly marker if present for non-YouTube domains
      if (httpOnly) $1 = "#HttpOnly_" domField;
    }

    line = $0;
    if (!seen[line]++) print line;
  }
' "$infile" > "$outfile.tmp"

# Final dedupe (defense-in-depth) and write out
awk '!seen[$0]++' "$outfile.tmp" > "$outfile"
rm -f "$outfile.tmp"

echo "Wrote: $outfile"
exit 0
