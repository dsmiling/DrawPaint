# Load local Git/GitHub env vars into the CURRENT PowerShell session.
# Usage (dot-source so variables persist):
#   . .\scripts\set-git-env.ps1
#
# First-time / update token (popup):
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-git-env.ps1

$ErrorActionPreference = "Stop"

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$localEnv = Join-Path $scriptDir "git-env.local.ps1"
$setupScript = Join-Path $scriptDir "setup-git-env.ps1"

if (-not (Test-Path $localEnv)) {
    Write-Host "No local env yet. Opening setup popup..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File $setupScript
    if (-not (Test-Path $localEnv)) {
        Write-Host "Setup cancelled." -ForegroundColor Yellow
        return
    }
}

. $localEnv

$missing = @()
if ([string]::IsNullOrWhiteSpace($env:GH_TOKEN) -or $env:GH_TOKEN -like "*xxxxxxxx*") {
    $missing += "GH_TOKEN"
}
if ([string]::IsNullOrWhiteSpace($env:GIT_AUTHOR_NAME) -or $env:GIT_AUTHOR_NAME -eq "your-name") {
    $missing += "GIT_AUTHOR_NAME"
}
if ([string]::IsNullOrWhiteSpace($env:GIT_AUTHOR_EMAIL) -or $env:GIT_AUTHOR_EMAIL -eq "you@example.com") {
    $missing += "GIT_AUTHOR_EMAIL"
}

if ($missing.Count -gt 0) {
    Write-Host "Local env incomplete ($($missing -join ', ')). Opening setup popup..." -ForegroundColor Yellow
    & powershell -ExecutionPolicy Bypass -File $setupScript
    . $localEnv
}

if ([string]::IsNullOrWhiteSpace($env:GITHUB_TOKEN)) {
    $env:GITHUB_TOKEN = $env:GH_TOKEN
}
if ([string]::IsNullOrWhiteSpace($env:GIT_COMMITTER_NAME)) {
    $env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
}
if ([string]::IsNullOrWhiteSpace($env:GIT_COMMITTER_EMAIL)) {
    $env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL
}

Write-Host "Git env loaded for this session." -ForegroundColor Green
Write-Host "  Author : $env:GIT_AUTHOR_NAME <$env:GIT_AUTHOR_EMAIL>"
$tokenPreview = if ($env:GH_TOKEN.Length -gt 12) {
    $env:GH_TOKEN.Substring(0, 10) + "..." + $env:GH_TOKEN.Substring($env:GH_TOKEN.Length - 4)
} else {
    "(set)"
}
Write-Host "  Token  : $tokenPreview"

$gh = Get-Command gh -ErrorAction SilentlyContinue
if ($gh) {
    try {
        $login = gh api user --jq ".login" 2>$null
        if ($login) {
            Write-Host "  GitHub : $login (via GH_TOKEN)" -ForegroundColor Green
        }
    } catch {
        Write-Host "  GitHub : token present, but gh api user failed" -ForegroundColor Yellow
    }
} else {
    Write-Host "  Tip    : install GitHub CLI (gh) for repo create / push helpers"
}

Write-Host ""
Write-Host "Next examples:"
Write-Host "  gh repo create DrawPaint --public --source=. --remote=origin --push"
Write-Host "  git push -u origin master"
