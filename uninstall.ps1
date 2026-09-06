# Removes the portless-home scheduled task (Windows), serve rule, and installed files.
#Requires -Version 5.1
$Task = 'portless-home'
$InstallDir = Join-Path $env:USERPROFILE '.portless-home'

if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
	Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $Task -Confirm:$false
}
Remove-Item -Recurse -Force -Path $InstallDir -ErrorAction SilentlyContinue

$Tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $Tailscale -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $Tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if ($Tailscale) { & $Tailscale serve --https=443 off *> $null }
Write-Host 'portless-home removed.'
