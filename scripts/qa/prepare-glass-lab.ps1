$ErrorActionPreference = 'Stop'
$root = Join-Path (Resolve-Path "$PSScriptRoot/../..") 'output/qa/liquid-glass/sources'
$sources = [ordered]@{
  'rdev/liquid-glass-react' = 'ac48eab18d1f7f444ae30002d240cae29c863a21'
  'huozhi/vaso' = 'a7ab5b7a2872e8140bdad6deef5b8c4089575dfd'
  'runvendo/fluidkit' = 'b1e6e6109e14c31ed43a99e2a373f4727c867ecb'
  'ibelick/motion-primitives' = '120f64f6ca60348e251f929e9c81f11ccbe45eda'
}
New-Item -ItemType Directory -Force $root | Out-Null
foreach ($repo in $sources.Keys) {
  $name = $repo.Split('/')[1]
  $revision = $sources[$repo]
  if (!(Test-Path "$root/$name/$name-$revision")) {
    Invoke-WebRequest "https://codeload.github.com/$repo/zip/$revision" -OutFile "$root/$name.zip"
    Expand-Archive "$root/$name.zip" "$root/$name" -Force
  }
}

# El componente del registro usa alias de Next y un helper de clases. El laboratorio
# conserva el código del componente y sustituye únicamente ese adaptador de estilos.
$motion = "$root/motion-primitives/motion-primitives-$($sources['ibelick/motion-primitives'])"
$component = Get-Content "$motion/components/core/morphing-popover.tsx" -Raw
$component = $component.Replace('@/hooks/useClickOutside', './motion-primitives/motion-primitives-120f64f6ca60348e251f929e9c81f11ccbe45eda/hooks/useClickOutside')
$component = $component.Replace("import { cn } from '@/lib/utils';", "const cn = (...classes: unknown[]) => classes.filter(Boolean).join(' ');")
Set-Content "$root/morphing-popover.tsx" $component -Encoding utf8
