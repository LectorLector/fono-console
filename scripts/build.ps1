# Build FonoConsole.exe on Windows. Needs Go 1.24+ (winget install GoLang.Go).
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
New-Item -ItemType Directory -Force dist | Out-Null
if (Test-Path docs\app) { Remove-Item docs\app -Recurse -Force }
Copy-Item web docs\app -Recurse   # live demo for the guide (/guide/ and GitHub Pages)
$env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
go build -trimpath -ldflags "-H=windowsgui -s -w" -o dist\FonoConsole.exe .
Write-Host "dist\FonoConsole.exe ready. Next: scripts\setup.cmd"
