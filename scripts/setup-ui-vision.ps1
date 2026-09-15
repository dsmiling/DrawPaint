param(
  [Parameter(Mandatory=$true)][string]$Python,
  [switch]$Cpu,
  [switch]$SkipTorch
)
$ErrorActionPreference = 'Stop'
$project = Split-Path $PSScriptRoot -Parent
$runtime = Join-Path $project '.cache/ui-vision'
New-Item -ItemType Directory -Force -Path $runtime | Out-Null
$venv = Join-Path $runtime 'venv'
if (-not (Test-Path (Join-Path $venv 'Scripts/python.exe'))) {
  & $Python -m venv $venv
  if ($LASTEXITCODE -ne 0) { throw 'Cannot create Python environment' }
}
$visionPython = Join-Path $venv 'Scripts/python.exe'
$pipCache = Join-Path $runtime 'pip-cache'
$index = if ($Cpu) { 'https://download.pytorch.org/whl/cpu' } else { 'https://download.pytorch.org/whl/cu126' }
if (-not $SkipTorch) {
  & $visionPython -m pip install --cache-dir $pipCache --disable-pip-version-check --no-compile torch==2.7.1 torchvision==0.22.1 --index-url $index
  if ($LASTEXITCODE -ne 0) { throw 'PyTorch installation failed' }
}
& $visionPython -m pip install --cache-dir $pipCache --disable-pip-version-check --no-compile -r (Join-Path $PSScriptRoot 'ui-vision/requirements.txt')
if ($LASTEXITCODE -ne 0) { throw 'Vision dependencies installation failed' }
$checkpoint = Join-Path $runtime 'sam_vit_b_01ec64.pth'
if (-not (Test-Path $checkpoint)) {
  & $visionPython -c 'import sys,urllib.request; urllib.request.urlretrieve("https://dl.fbaipublicfiles.com/segment_anything/sam_vit_b_01ec64.pth",sys.argv[1])' "$checkpoint.download"
  if ($LASTEXITCODE -ne 0) { throw 'SAM checkpoint download failed' }
  Move-Item -LiteralPath "$checkpoint.download" -Destination $checkpoint
}
& $visionPython (Join-Path $PSScriptRoot 'ui-vision/worker.py') health --checkpoint $checkpoint
if ($LASTEXITCODE -ne 0) { throw 'Vision health check failed' }
