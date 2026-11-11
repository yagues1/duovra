# Crea la junction .claude/skills -> .agents/skills para que Claude Code lea las skills
# del proyecto sin mantener una segunda copia. Las junctions no requieren privilegios de administrador.
$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$source = Join-Path $root '.agents\skills'
$target = Join-Path $root '.claude\skills'

if (-not (Test-Path -LiteralPath $source)) {
    throw "No existe la carpeta de origen: $source"
}

if (-not (Test-Path -LiteralPath (Join-Path $root '.claude'))) {
    New-Item -ItemType Directory -Path (Join-Path $root '.claude') | Out-Null
}

if (Test-Path -LiteralPath $target) {
    $item = Get-Item -LiteralPath $target -Force
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        Write-Output "La junction ya existe: $target"
        exit 0
    }
    throw "$target ya existe y no es una junction. Revísalo manualmente antes de continuar."
}

New-Item -ItemType Junction -Path $target -Target $source | Out-Null
Write-Output "Junction creada: $target -> $source"
