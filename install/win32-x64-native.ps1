# Bob AI installer — Windows x86_64 (PowerShell)
# Usage:
#   One-liner:  irm https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-native.ps1 | iex
#   From clone: .\install\win32-x64-native.ps1
#
# If execution policy blocks the script:
#   powershell -ExecutionPolicy Bypass -File .\install\win32-x64-native.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BUN_VERSION      = "1.3.3"
$BUN_SHA256       = "53e239b058c13f0bb70949b222c4d40c5ab7d6cad22268b2ace2187fcfd7a247"
$BUN_ARCHIVE      = "bun-windows-x64.zip"
$BUN_EXTRACT_DIR  = "bun-windows-x64"
$BOBAI_PLATFORM   = "win32-x64-native"
$BUN_URL          = "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARCHIVE}"
$RELEASE_ARCHIVE  = "bobai-${BOBAI_PLATFORM}.zip"
$RELEASE_URL      = "https://github.com/nilcaream/bobai/releases/latest/download/${RELEASE_ARCHIVE}"

$BOBAI_HOME = "$env:LOCALAPPDATA\bobai"
$BUN_EXE    = "$BOBAI_HOME\bun.exe"
$BIN_DIR    = "$BOBAI_HOME\bin"
$DIST_DIR   = "$BOBAI_HOME\dist"

$script:TmpDir = $null

function Write-Info  { Write-Host "[INFO]  $args" }
function Write-Err   { Write-Host "[ERROR] $args" -ForegroundColor Red }

function Exit-WithError {
    param([string]$Message)
    Write-Err $Message
    exit 1
}

# ── Cleanup ──────────────────────────────────────────────────────────

function Invoke-Cleanup {
    if ($script:TmpDir -and (Test-Path $script:TmpDir)) {
        Remove-Item -Recurse -Force $script:TmpDir -ErrorAction SilentlyContinue
    }
}

# ── Bun install ──────────────────────────────────────────────────────

function Install-Bun {
    New-Item -ItemType Directory -Force -Path $BOBAI_HOME | Out-Null

    if (Test-Path $BUN_EXE) {
        try {
            $currentVersion = (& $BUN_EXE --version 2>$null) -replace '\s+', ''
            if ($currentVersion -eq $BUN_VERSION) {
                Write-Info "Bun ${BUN_VERSION} already installed."
                return
            }
            Write-Info "Bun version mismatch (have ${currentVersion}, need ${BUN_VERSION}). Updating..."
        } catch {
            Write-Info "Existing bun binary is invalid. Reinstalling..."
        }
    }

    $tmpZip = "$BOBAI_HOME\bun-download.zip"
    Write-Info "Downloading Bun ${BUN_VERSION}..."
    Invoke-WebRequest -Uri $BUN_URL -OutFile $tmpZip

    Write-Info "Verifying checksum..."
    $actualHash = (Get-FileHash -Path $tmpZip -Algorithm SHA256).Hash.ToLower()
    if ($actualHash -ne $BUN_SHA256) {
        Remove-Item -Force $tmpZip -ErrorAction SilentlyContinue
        Exit-WithError "Checksum mismatch! Expected ${BUN_SHA256}, got ${actualHash}"
    }

    $tmpExtract = "$BOBAI_HOME\bun-extract"
    Remove-Item -Recurse -Force $tmpExtract -ErrorAction SilentlyContinue
    Expand-Archive -Path $tmpZip -DestinationPath $tmpExtract -Force
    Move-Item -Force "$tmpExtract\$BUN_EXTRACT_DIR\bun.exe" $BUN_EXE
    Remove-Item -Recurse -Force $tmpExtract, $tmpZip -ErrorAction SilentlyContinue
    Write-Info "Bun ${BUN_VERSION} installed."
}

# ── Fetch release ────────────────────────────────────────────────────

function Get-Release {
    $script:TmpDir = Join-Path $env:TEMP "bobai-install-$(New-Guid)"
    New-Item -ItemType Directory -Force -Path $script:TmpDir | Out-Null

    Write-Info "Downloading Bob AI release..."
    $zipPath = "$script:TmpDir\bobai.zip"
    Invoke-WebRequest -Uri $RELEASE_URL -OutFile $zipPath

    Write-Info "Unpacking..."
    Expand-Archive -Path $zipPath -DestinationPath $script:TmpDir -Force
    Remove-Item -Force $zipPath
}

# ── Deploy ───────────────────────────────────────────────────────────

function Deploy-Dist {
    Remove-Item -Recurse -Force $DIST_DIR -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "$DIST_DIR\ui" | Out-Null

    Copy-Item "$script:TmpDir\dist\server.js" "$DIST_DIR\server.js"
    Copy-Item -Recurse "$script:TmpDir\dist\ui\*" "$DIST_DIR\ui\"
    Write-Info "Dist deployed to ${DIST_DIR}"
}

# ── Runner ───────────────────────────────────────────────────────────

function Install-Runner {
    $versionFile = "$script:TmpDir\VERSION"
    $buildVersion = if (Test-Path $versionFile) { Get-Content $versionFile -Raw | ForEach-Object { $_.Trim() } } else { "unknown" }

    New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null

    $runnerPath = "$BIN_DIR\bobai.cmd"
    $runnerContent = @"
@echo off
setlocal
set "BOBAI_HOME=%LOCALAPPDATA%\bobai"
echo Bob AI $buildVersion
set BUN_CONFIG_INSTALL_AUTO=disable
set BOBAI_VERSION=$buildVersion
set BOBAI_PLATFORM=$BOBAI_PLATFORM
"%BOBAI_HOME%\bun.exe" "%BOBAI_HOME%\dist\server.js" %*
endlocal
"@
    Set-Content -Path $runnerPath -Value $runnerContent -Encoding UTF8
    Write-Info "Runner installed at ${runnerPath}"
}

# ── PATH check ───────────────────────────────────────────────────────

function Assert-OnPath {
    $currentPath = [Environment]::GetEnvironmentVariable("PATH", "User")
    if ($currentPath -notlike "*$BIN_DIR*") {
        Write-Host "Note: ${BIN_DIR} is not on your PATH."
        Write-Host "Add to your user PATH:"
        Write-Host ""
        Write-Host "  [Environment]::SetEnvironmentVariable('PATH', `$env:PATH + ';${BIN_DIR}', 'User')"
        Write-Host ""
        Write-Host "Then restart your terminal."
        Write-Host ""
    }
}

# ── Main ─────────────────────────────────────────────────────────────

function Main {
    Write-Info "Installing Bob AI for Windows..."

    try {
        Install-Bun
        Get-Release
        Deploy-Dist
        Install-Runner

        Write-Host ""
        Write-Host "Bob AI installed successfully!"
        Write-Host ""
        Write-Host "  Authenticate:  bobai auth"
        Write-Host "  Start:         bobai"
        Write-Host ""

        Assert-OnPath
    } finally {
        Invoke-Cleanup
    }
}

Main
