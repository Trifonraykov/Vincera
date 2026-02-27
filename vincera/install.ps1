# Vincera Bot Installer for Windows
$ErrorActionPreference = "Stop"

Write-Host "=== Vincera Bot Installer ==="

# 1. Check Python 3.11+
$python = $null
foreach ($cmd in @("python3", "python")) {
    try {
        $version = & $cmd -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null
        if ($version) {
            $parts = $version.Split(".")
            if ([int]$parts[0] -ge 3 -and [int]$parts[1] -ge 11) {
                $python = $cmd
                break
            }
        }
    } catch {
        continue
    }
}

if (-not $python) {
    Write-Host "ERROR: Python 3.11+ is required but not found." -ForegroundColor Red
    exit 1
}

Write-Host "Using Python: $python ($(& $python --version))"

# 2. Create virtual environment
$venvDir = Join-Path $env:USERPROFILE ".vincera-venv"
if (-not (Test-Path $venvDir)) {
    Write-Host "Creating virtual environment at $venvDir ..."
    & $python -m venv $venvDir
}

# 3. Activate and install
$activateScript = Join-Path $venvDir "Scripts\Activate.ps1"
. $activateScript

Write-Host "Installing Vincera Bot ..."
pip install --upgrade pip --quiet
pip install . --quiet

# 4. Run installer
Write-Host ""
Write-Host "Starting interactive setup ..."
python -m vincera.installer

Write-Host ""
Write-Host "Done. Start Vincera with: $venvDir\Scripts\python.exe -m vincera.main"
