$ErrorActionPreference = 'Stop'

$cargo = Get-Command cargo -ErrorAction SilentlyContinue
if (-not $cargo) {
    $cargoPath = Join-Path $env:USERPROFILE '.cargo\bin\cargo.exe'
    if (-not (Test-Path -LiteralPath $cargoPath)) {
        throw 'Rust is not installed. See README.md for the minimal setup.'
    }
    $cargo = $cargoPath
}

& $cargo tauri dev
