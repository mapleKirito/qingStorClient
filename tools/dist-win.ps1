# Packaging script for QingStorClient (Windows).
#
# Why this exists (two real problems it works around):
#
#  1) EPREM/EPERM on rename
#     electron-builder extracts Electron into "win-unpacked.tmp" and then renames
#     it to "win-unpacked". A real-time AV scanner (e.g. Tencent PC Manager) may
#     hold handles on the freshly extracted .exe/.dll files at that moment, which
#     makes the rename fail with "EPERM: operation not permitted".
#     We pre-extract Electron ourselves and pass it via electronDist, so
#     electron-builder takes the copyDir branch (no .tmp, no rename). We also
#     build into a temp directory outside the workspace and copy artifacts back.
#
#  2) Slow / blocked downloads in China
#     Electron and electron-builder binaries are pulled from GitHub. The mirrors
#     below (npmmirror) avoid ECONNRESET. They are only set for this process.
#
# Usage:
#   powershell -ExecutionPolicy Bypass -File tools\dist-win.ps1      (or: npm run dist:win)
#
# IMPORTANT: keep every string in this file ASCII. Windows PowerShell 5.1 reads a
# BOM-less UTF-8 script as ANSI/GBK, which corrupts non-ASCII literals and can even
# break parsing. ASCII bytes are identical under every code page.

$ErrorActionPreference = 'Stop'

# --- Node 22 (electron-builder 26 needs it; nvm only affects newly opened shells) ---
$nvmNode = "C:\Users\maple\AppData\Roaming\nvm\v22.22.2"
if (Test-Path (Join-Path $nvmNode "node.exe")) {
    $env:NODE_HOME = $nvmNode
    $env:PATH      = "$nvmNode;$env:PATH"
}

# --- China mirrors (download-skipping; harmless when cache is already warm) ---
$env:ELECTRON_MIRROR                  = "https://npmmirror.com/mirrors/electron/"
$env:ELECTRON_BUILDER_BINARIES_MIRROR = "https://npmmirror.com/mirrors/electron-builder-binaries/"
# No code-signing certificate: disable automatic identity discovery.
$env:CSC_IDENTITY_AUTO_DISCOVERY      = "false"

$root = Split-Path -Parent $PSScriptRoot
Push-Location $root
try {
    Write-Host "-> Node $(node --version)" -ForegroundColor Cyan

    # --- Resolve a ready-to-use Electron runtime (win32-x64) ---
    $electronVersion = (Get-Content "node_modules\electron\package.json" -Raw | ConvertFrom-Json).version
    $directDist = Join-Path $root "node_modules\electron\dist"
    $cachedDist = Join-Path $env:LOCALAPPDATA "electron\dist\electron-v$electronVersion-win32-x64"

    if (Test-Path (Join-Path $directDist "electron.exe")) {
        # npm install already extracted it; use it as-is (fastest path).
        $electronDist = $directDist
    }
    elseif (Test-Path (Join-Path $cachedDist "electron.exe")) {
        $electronDist = $cachedDist
    }
    else {
        $zip = Get-ChildItem (Join-Path $env:LOCALAPPDATA "electron\Cache") -Recurse `
            -Filter "electron-v$electronVersion-win32-x64.zip" -ErrorAction SilentlyContinue |
            Select-Object -First 1
        if (-not $zip) {
            throw "Electron v$electronVersion runtime not found. Run 'npm install' first."
        }
        Write-Host "-> pre-extracting Electron v$electronVersion to $cachedDist" -ForegroundColor Cyan
        Remove-Item -Recurse -Force $cachedDist -ErrorAction SilentlyContinue
        New-Item -ItemType Directory -Path $cachedDist -Force | Out-Null
        tar -xf $zip.FullName -C $cachedDist
        if ($LASTEXITCODE -ne 0) { throw "failed to extract $($zip.FullName)" }
        $electronDist = $cachedDist
    }
    Write-Host "-> electronDist: $electronDist" -ForegroundColor Cyan

    # --- Build into a temp dir, then copy artifacts back ---
    $tmpOut = Join-Path $env:LOCALAPPDATA "Temp\qingStorClient-dist"
    Remove-Item -Recurse -Force $tmpOut -ErrorAction SilentlyContinue
    Write-Host "-> output dir: $tmpOut" -ForegroundColor Cyan
    Write-Host "-> building..." -ForegroundColor Cyan

    npx electron-builder --win --config electron-builder.yml `
        --config.directories.output="$tmpOut" `
        --config.electronDist="$electronDist" `
        --publish never
    if ($LASTEXITCODE -ne 0) { throw "electron-builder failed, exit code: $LASTEXITCODE" }

    New-Item -ItemType Directory -Path "dist" -Force | Out-Null
    Copy-Item "$tmpOut\*.exe" -Destination "dist" -Force
    Copy-Item "$tmpOut\*.blockmap" -Destination "dist" -Force -ErrorAction SilentlyContinue

    Write-Host ""
    Write-Host "=== Done. Artifacts copied to dist/ ===" -ForegroundColor Green
    Get-ChildItem dist -Force | Where-Object { -not $_.PSIsContainer } |
        Format-Table Name, @{N = 'MB'; E = { [math]::Round($_.Length / 1MB, 1) } }, LastWriteTime -AutoSize
}
finally {
    Pop-Location
}
