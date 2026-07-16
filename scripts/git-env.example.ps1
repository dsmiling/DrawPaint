# Template only. Prefer the popup setup:
#   powershell -ExecutionPolicy Bypass -File .\scripts\setup-git-env.ps1
#
# Or copy to git-env.local.ps1 manually (gitignored).

$env:GH_TOKEN = "github_pat_xxxxxxxx"
$env:GITHUB_TOKEN = $env:GH_TOKEN

$env:GIT_AUTHOR_NAME = "your-name"
$env:GIT_AUTHOR_EMAIL = "you@example.com"
$env:GIT_COMMITTER_NAME = $env:GIT_AUTHOR_NAME
$env:GIT_COMMITTER_EMAIL = $env:GIT_AUTHOR_EMAIL

# $env:DRAWPAINT_GIT_REMOTE = "https://github.com/dsmiling/DrawPaint.git"
