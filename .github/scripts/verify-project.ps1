[CmdletBinding()]
param(
    [string]$Tag = ""
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$repositoryRoot = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$cargoManifestPath = Join-Path $repositoryRoot "src-tauri\Cargo.toml"
$tauriConfigPath = Join-Path $repositoryRoot "src-tauri\tauri.conf.json"

$cargoManifest = Get-Content -LiteralPath $cargoManifestPath -Raw
$packageSection = [regex]::Match(
    $cargoManifest,
    '(?ms)^\[package\]\s*(.*?)(?=^\[|\z)'
)
if (-not $packageSection.Success) {
    throw "Could not find [package] in src-tauri/Cargo.toml."
}

$cargoVersionMatch = [regex]::Match(
    $packageSection.Groups[1].Value,
    '(?m)^version\s*=\s*"([^"]+)"\s*$'
)
if (-not $cargoVersionMatch.Success) {
    throw "Could not read the Cargo package version."
}

$cargoVersion = $cargoVersionMatch.Groups[1].Value
$tauriVersion = (Get-Content -LiteralPath $tauriConfigPath -Raw | ConvertFrom-Json).version
if ($cargoVersion -ne $tauriVersion) {
    throw "Version mismatch: Cargo.toml=$cargoVersion, tauri.conf.json=$tauriVersion."
}

if ($Tag) {
    if ($Tag -notmatch '^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$') {
        throw "Release tag '$Tag' is not a supported semantic version tag."
    }
    if ($Tag.Substring(1) -ne $cargoVersion) {
        throw "Release tag $Tag does not match source version $cargoVersion."
    }
}

$expectedDigests = [ordered]@{
    "src-tauri/binaries/yt-dlp-x86_64-pc-windows-msvc.exe" = "52fe3c26dcf71fbdc85b528589020bb0b8e383155cfa81b64dd447bbe35e24b8"
    "src-tauri/binaries/yt-dlp-x86_64-apple-darwin" = "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b"
    "src-tauri/binaries/yt-dlp-aarch64-apple-darwin" = "498bd0dae17855c599d371d68ec5bafc439a9d8640e838be25c765a9792f261b"
    "src-tauri/binaries/qjs-x86_64-pc-windows-msvc.exe" = "5ea527b0405f0f3d11904c8722a4f1df9b631a4beed2bf988d0a831eb9f8e913"
    "src-tauri/binaries/qjs-x86_64-apple-darwin" = "badc31a289050d56f1d184651736bfa6399ef0ad40db6b210b8a88a3d34be36a"
    "src-tauri/binaries/qjs-aarch64-apple-darwin" = "badc31a289050d56f1d184651736bfa6399ef0ad40db6b210b8a88a3d34be36a"
}

foreach ($entry in $expectedDigests.GetEnumerator()) {
    $relativePath = $entry.Key
    $absolutePath = Join-Path $repositoryRoot ($relativePath -replace '/', '\')
    if (-not (Test-Path -LiteralPath $absolutePath -PathType Leaf)) {
        throw "Missing bundled sidecar: $relativePath"
    }

    $actualDigest = (Get-FileHash -LiteralPath $absolutePath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actualDigest -ne $entry.Value) {
        throw "SHA-256 mismatch for ${relativePath}: expected $($entry.Value), got $actualDigest."
    }
}

$trackedDownloads = @(& git -C $repositoryRoot ls-files -- downloads)
if ($LASTEXITCODE -ne 0) {
    throw "Could not inspect tracked files."
}
if ($trackedDownloads.Count -gt 0) {
    throw "Personal download files must not be tracked: $($trackedDownloads -join ', ')"
}

if ($env:GITHUB_OUTPUT) {
    "version=$cargoVersion" | Out-File -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8 -Append
}

Write-Host "Project metadata and bundled sidecars are valid for version $cargoVersion."
