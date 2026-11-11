# Configura el entorno «release» de yagues1/duovra (ver docs/distribution.md). Ejecútalo tú:
#   powershell -ExecutionPolicy Bypass -File scripts/release/setup-release-env.ps1
# Lee la clave de %USERPROFILE%\.duovra-signing y sube los secretos por stdin, sin imprimirlos.
$ErrorActionPreference = 'Stop'
$repo = 'yagues1/duovra'
if ((gh api user --jq .login) -ne 'yagues1') { throw 'La cuenta activa de gh no es yagues1.' }
$dir = Join-Path $env:USERPROFILE '.duovra-signing'
$uid = gh api users/yagues1 --jq .id

# Entorno «release»: solo la rama main y aprobación obligatoria del propietario.
$body = @{ reviewers = @(@{ type = 'User'; id = [int]$uid }); deployment_branch_policy = @{ protected_branches = $false; custom_branch_policies = $true } } | ConvertTo-Json -Depth 5
$body | gh api -X PUT "repos/$repo/environments/release" --input - | Out-Null
'{"name":"main","type":"branch"}' | gh api -X POST "repos/$repo/environments/release/deployment-branch-policies" --input - 2>$null | Out-Null

# Secretos por stdin (nunca se imprimen).
$secure = Get-Content (Join-Path $dir 'duovra-updater.password.dpapi') | ConvertTo-SecureString
$password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
Get-Content -Raw (Join-Path $dir 'duovra-updater.key') | gh secret set TAURI_SIGNING_PRIVATE_KEY --env release -R $repo
$password | gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --env release -R $repo
$password = $null

# Clave pública: contenido del archivo .pub (publicable).
$pub = (Get-Content -Raw (Join-Path $dir 'duovra-updater.key.pub')).Trim()
gh variable set STUDIO_UPDATER_PUBLIC_KEY -R $repo --body $pub
gh secret list --env release -R $repo
gh variable list -R $repo
gh api "repos/$repo/environments/release" --jq '{name, rules: [.protection_rules[].type], branches: .deployment_branch_policy}'
