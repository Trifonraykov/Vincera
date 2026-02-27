#!/usr/bin/env bash
set -euo pipefail

echo "=== Vincera Bot Installer ==="

# 1. Check Python 3.11+
PYTHON=""
for cmd in python3.12 python3.11 python3 python; do
    if command -v "$cmd" &>/dev/null; then
        version=$("$cmd" -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
        major=$(echo "$version" | cut -d. -f1)
        minor=$(echo "$version" | cut -d. -f2)
        if [ "$major" -ge 3 ] && [ "$minor" -ge 11 ]; then
            PYTHON="$cmd"
            break
        fi
    fi
done

if [ -z "$PYTHON" ]; then
    echo "ERROR: Python 3.11+ is required but not found."
    exit 1
fi

echo "Using Python: $PYTHON ($($PYTHON --version))"

# 2. Create virtual environment
VENV_DIR="$HOME/.vincera-venv"
if [ ! -d "$VENV_DIR" ]; then
    echo "Creating virtual environment at $VENV_DIR …"
    "$PYTHON" -m venv "$VENV_DIR"
fi

# 3. Activate and install
source "$VENV_DIR/bin/activate"
echo "Installing Vincera Bot …"
pip install --upgrade pip --quiet
pip install . --quiet

# 4. Run installer
echo ""
echo "Starting interactive setup …"
python -m vincera.installer

echo ""
echo "Done. Start Vincera with: $VENV_DIR/bin/python -m vincera.main"
