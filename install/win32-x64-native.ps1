# Bob AI installer — Windows x86_64 (PowerShell)
# Usage:
#   From cloned repo:  .\install\win32-x64-native.ps1
#   One-liner:         irm https://raw.githubusercontent.com/nilcaream/bobai/main/install/win32-x64-native.ps1 | iex
#
# If execution policy blocks the script:
#   powershell -ExecutionPolicy Bypass -File .\install\win32-x64-native.ps1

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

$BUN_VERSION = "1.3.3"
$BUN_SHA256 = "53e239b058c13f0bb70949b222c4d40c5ab7d6cad22268b2ace2187fcfd7a247"
$BUN_ARCHIVE = "bun-windows-x64.zip"
$BUN_EXTRACT_DIR = "bun-windows-x64"
$BOBAI_PLATFORM = "win32-x64-native"
$REPO_URL = "https://github.com/nilcaream/bobai.git"
$BUN_URL = "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/${BUN_ARCHIVE}"

$BOBAI_HOME = "$env:LOCALAPPDATA\bobai"
$BUN_EXE = "$BOBAI_HOME\bun.exe"
$BIN_DIR = "$BOBAI_HOME\bin"
$DIST_DIR = "$BOBAI_HOME\dist"

$script:CloneDir = $null

function Write-Info  { Write-Host "[INFO]  $args" }
function Write-Error { Write-Host "[ERROR] $args" -ForegroundColor Red }

function Exit-WithError {
    param([string]$Message)
    Write-Error $Message
    exit 1
}

# ── Cleanup ──────────────────────────────────────────────────────────

function Invoke-Cleanup {
    if ($script:CloneDir -and (Test-Path $script:CloneDir)) {
        Remove-Item -Recurse -Force $script:CloneDir -ErrorAction SilentlyContinue
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

# ── Source resolution ────────────────────────────────────────────────

function Test-RepoRoot {
    param([string]$Path)
    if ((Test-Path "$Path\package.json") -and (Select-String -Path "$Path\package.json" -Pattern '"bobai"' -Quiet)) {
        return $true
    }
    return $false
}

function Resolve-Source {
    if (Test-RepoRoot -Path (Get-Location)) {
        return (Get-Location).Path
    }

    # Not inside a repo clone — fetch the source
    $script:CloneDir = Join-Path $env:TEMP "bobai-clone-$(New-Guid)"
    Write-Info "Cloning Bob AI repository..."
    git clone --depth 1 $REPO_URL $script:CloneDir
    if ($LASTEXITCODE -ne 0) {
        Exit-WithError "Failed to clone repository."
    }
    return $script:CloneDir
}

# ── Build ────────────────────────────────────────────────────────────

function Build-Dist {
    param([string]$SourceDir)

    Write-Info "Installing dependencies..."
    Push-Location $SourceDir
    try {
        & $BUN_EXE install --frozen-lockfile
        if ($LASTEXITCODE -ne 0) { throw "bun install failed" }
    } finally {
        Pop-Location
    }

    Write-Info "Bundling server..."
    & $BUN_EXE build --target=bun --minify `
        --outfile="$SourceDir\dist\server.js" `
        "$SourceDir\packages\server\src\index.ts"
    if ($LASTEXITCODE -ne 0) { throw "Server build failed" }

    Write-Info "Building UI..."
    Push-Location "$SourceDir\packages\ui"
    try {
        & $BUN_EXE x vite build
        if ($LASTEXITCODE -ne 0) { throw "UI build failed" }
    } finally {
        Pop-Location
    }
}

# ── Deploy ───────────────────────────────────────────────────────────

function Deploy-Dist {
    param([string]$SourceDir)

    Remove-Item -Recurse -Force $DIST_DIR -ErrorAction SilentlyContinue
    New-Item -ItemType Directory -Force -Path "$DIST_DIR\ui" | Out-Null

    Copy-Item "$SourceDir\dist\server.js" "$DIST_DIR\server.js"
    Copy-Item -Recurse "$SourceDir\packages\ui\dist\*" "$DIST_DIR\ui\"
    Write-Info "Dist deployed to ${DIST_DIR}"
}

# ── Runner ───────────────────────────────────────────────────────────

function Install-Runner {
    param([string]$SourceDir)

    $buildRev = git -C $SourceDir rev-parse --short HEAD
    if ($LASTEXITCODE -ne 0) {
        Exit-WithError "Failed to get git revision."
    }

    $buildDate = Get-Date -Format "yyyy-MM-dd HH:mm:ss"

    New-Item -ItemType Directory -Force -Path $BIN_DIR | Out-Null

    $runnerPath = "$BIN_DIR\bobai.cmd"

    $runnerContent = @"
@echo off
setlocal
set "BOBAI_HOME=%LOCALAPPDATA%\bobai"
echo Bob AI ($buildRev $buildDate)
set BUN_CONFIG_INSTALL_AUTO=disable
set BOBAI_BUILD_REV=$buildRev
set BOBAI_BUILD_DATE=$buildDate
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

        $sourceDir = Resolve-Source
        Build-Dist -SourceDir $sourceDir
        Deploy-Dist -SourceDir $sourceDir
        Install-Runner -SourceDir $sourceDir

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
