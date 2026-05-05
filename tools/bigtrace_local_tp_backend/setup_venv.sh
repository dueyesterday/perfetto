#!/usr/bin/env bash
# Set up the .venv and install the required packages, including the in-repo
# perfetto Python package as an editable install.
#
# Re-run this whenever requirements.txt changes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PERFETTO_PY="$HERE/../../../perfetto/python"

if [[ ! -d "$PERFETTO_PY" ]]; then
  echo "ERROR: cannot find perfetto python package at $PERFETTO_PY" >&2
  exit 1
fi

if [[ ! -d "$HERE/.venv" ]]; then
  echo "Creating venv at $HERE/.venv..."
  python3 -m venv "$HERE/.venv"
fi

"$HERE/.venv/bin/pip" install --quiet --upgrade pip
"$HERE/.venv/bin/pip" install --quiet -r "$HERE/requirements.txt"
# Editable install of the in-repo perfetto package — this is the version we
# want, not the PyPI release.
"$HERE/.venv/bin/pip" install --quiet -e "$PERFETTO_PY"

echo "Venv ready at $HERE/.venv"
echo "Run: $HERE/.venv/bin/python $HERE/server.py --traces-dir <DIR>"
