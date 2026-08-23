# Registers the v2 native messaging host for Chrome and Edge.
# Run once after loading the extension, then paste your extension ID below.
# v2 uses its own host name so it never clashes with the v1 registration.
param(
    [Parameter(Mandatory = $true)]
    [string]$ExtensionId
)

$ErrorActionPreference = "Stop"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$manifestPath = Join-Path $here "com.supermemo.paster.v2.json"

$manifest = Get-Content $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
$manifest.allowed_origins = @("chrome-extension://$ExtensionId/")
# Point the host at wherever this folder actually lives (works after cloning
# the repo to any path, not just the original development machine).
$manifest.path = (Join-Path $here "host.bat") -replace '/', '\'
$manifest | ConvertTo-Json -Depth 5 | Set-Content $manifestPath -Encoding UTF8

foreach ($root in @("HKCU:\Software\Google\Chrome\NativeMessagingHosts",
                     "HKCU:\Software\Microsoft\Edge\NativeMessagingHosts")) {
    $key = Join-Path $root "com.supermemo.paster.v2"
    New-Item -Path $key -Force | Out-Null
    Set-ItemProperty -Path $key -Name "(Default)" -Value $manifestPath
}

Write-Host "Native host registered for extension $ExtensionId"
Write-Host "Manifest: $manifestPath"
