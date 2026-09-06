# Removes the portless-home scheduled task (Windows), serve rule, and installed files.
#Requires -Version 5.1
$Task = 'portless-home'
$InstallDir = Join-Path $env:USERPROFILE '.portless-home'

if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
	Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $Task -Confirm:$false
}
# Stop returns before node has exited, and the install dir is its working directory.
foreach ($try in 1..25) {
	$Server = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$InstallDir\server.mjs*" }
	if (-not $Server) { break }
	Start-Sleep -Milliseconds 200
}
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force -Path $InstallDir }

$Tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $Tailscale -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $Tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe" }
if ($Tailscale) { & $Tailscale serve --https=443 off *> $null }
Write-Host 'portless-home removed.'
