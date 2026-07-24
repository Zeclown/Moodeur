[CmdletBinding()]
param(
    [Parameter(Mandatory)]
    [string]$AssetDirectory
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$resolvedDirectory = (Resolve-Path -LiteralPath $AssetDirectory).Path
$outputPath = Join-Path $resolvedDirectory "SHA256SUMS.txt"
$assets = Get-ChildItem -LiteralPath $resolvedDirectory -File -Recurse |
    Where-Object { $_.Name -ne "SHA256SUMS.txt" } |
    Sort-Object FullName

if (-not $assets) {
    throw "No release assets were found in $resolvedDirectory."
}

$lines = foreach ($asset in $assets) {
    $digest = (Get-FileHash -LiteralPath $asset.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    $relativePath = [System.IO.Path]::GetRelativePath($resolvedDirectory, $asset.FullName).Replace('\', '/')
    "$digest  $relativePath"
}

$lines | Out-File -LiteralPath $outputPath -Encoding ascii
Write-Host "Wrote $($assets.Count) checksums to $outputPath."
