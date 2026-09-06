# portless-home installer (Windows: per-user scheduled task, no admin needed).
# Installs the home-page server as a login task and pins it to your tailnet
# device URL via `tailscale serve`. Run from the repo directory:
#   powershell -ExecutionPolicy Bypass -File .\install.ps1 [-NoAutostart]
# -NoAutostart starts the server now but skips start-at-login (and crash
# restarts); rerun without the switch to switch back. $env:PORT picks the port.
#Requires -Version 5.1
param([switch]$NoAutostart)
$ErrorActionPreference = 'Stop'

$Task = 'portless-home'
$InstallDir = Join-Path $env:USERPROFILE '.portless-home'
$Port = if ($env:PORT) { [int]$env:PORT } else { 5995 }
$User = "$env:USERDOMAIN\$env:USERNAME"

$Node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $Node) { Write-Host 'node not found on PATH.'; exit 1 }
# --env-file (below) arrived in node 20.6.
if ([version](& $Node --version).TrimStart('v') -lt [version]'20.6') { Write-Host 'node 20.6 or newer required.'; exit 1 }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
Copy-Item -Path "$PSScriptRoot\server.mjs", "$PSScriptRoot\render.mjs", "$PSScriptRoot\i18n.mjs", "$PSScriptRoot\peers.mjs", "$PSScriptRoot\menubar.mjs", "$PSScriptRoot\live.mjs" -Destination $InstallDir

# Task Scheduler cannot set environment variables per action, and under the S4U
# logon type below %USERPROFILE% is not guaranteed to be the real profile, so the
# server gets its config as absolute paths through node's --env-file. Written
# without a BOM: node would read the first key as "<BOM>PORT".
$EnvFile = Join-Path $InstallDir 'service.env'
[IO.File]::WriteAllText($EnvFile, (@(
	"PORT=$Port",
	"PORTLESS_ROUTES=$env:USERPROFILE\.portless\routes.json",
	"PORTLESS_NAMES=$InstallDir\names.json",
	"PORTLESS_LAYOUT=$InstallDir\layout.json",
	"PORTLESS_PEERS=$InstallDir\peers.json"
) -join "`n") + "`n")

# node runs as the task's own process (no cmd/powershell wrapper): Stop-ScheduledTask
# only ends that process, and would leave a wrapped node behind. S4U ("run whether
# user is logged on or not", no stored password) keeps it off the desktop, so no
# console window appears.
$Action = New-ScheduledTaskAction -Execute $Node -Argument "--env-file=`"$EnvFile`" `"$InstallDir\server.mjs`"" -WorkingDirectory $InstallDir
$Principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U
$Settings = @{ ExecutionTimeLimit = [TimeSpan]::Zero; AllowStartIfOnBatteries = $true; DontStopIfGoingOnBatteries = $true; MultipleInstances = 'IgnoreNew' }
if (-not $NoAutostart) { $Settings.RestartCount = 99; $Settings.RestartInterval = New-TimeSpan -Minutes 1 }
$Register = @{ TaskName = $Task; Action = $Action; Principal = $Principal; Settings = New-ScheduledTaskSettingsSet @Settings; Description = 'portless-home tailnet directory page' }
if (-not $NoAutostart) { $Register.Trigger = New-ScheduledTaskTrigger -AtLogOn -User $User }

if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
	Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue
	Unregister-ScheduledTask -TaskName $Task -Confirm:$false
	# Stop returns before the old node has exited and freed the port.
	foreach ($try in 1..25) {
		$Old = Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like "*$InstallDir\server.mjs*" }
		if (-not $Old) { break }
		Start-Sleep -Milliseconds 200
	}
}
Register-ScheduledTask @Register | Out-Null
Start-ScheduledTask -TaskName $Task

$Up = $false
foreach ($try in 1..10) {
	Start-Sleep -Milliseconds 500
	try { Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$Port/" | Out-Null; $Up = $true; break } catch {}
}
if (-not $Up) {
	Write-Host "Server did not start (Get-ScheduledTaskInfo $Task shows the exit code). To see the error, run:"
	Write-Host "  & `"$Node`" --env-file=`"$EnvFile`" `"$InstallDir\server.mjs`""
	exit 1
}
Write-Host "Home page running on 127.0.0.1:$Port"
if ($NoAutostart) { Write-Host 'Start-at-login off (-NoAutostart); rerun install.ps1 to turn it on.' }

# The Tailscale CLI is not always on PATH on Windows.
$Tailscale = (Get-Command tailscale.exe -ErrorAction SilentlyContinue).Source
if (-not $Tailscale -and (Test-Path "$env:ProgramFiles\Tailscale\tailscale.exe")) { $Tailscale = "$env:ProgramFiles\Tailscale\tailscale.exe" }
# Windows PowerShell turns a native command's stderr into terminating errors
# under Stop; nothing below needs Stop anyway.
$ErrorActionPreference = 'Continue'
$TailscaleUp = $false
if ($Tailscale) { & $Tailscale status *> $null; $TailscaleUp = ($LASTEXITCODE -eq 0) }
if ($TailscaleUp) {
	& $Tailscale serve --bg --https=443 "http://127.0.0.1:$Port" | Out-Null
	if ($LASTEXITCODE) { Write-Host 'tailscale serve failed; the server runs, but it is not pinned to :443.'; exit 1 }
	$Device = (& $Tailscale status --json | ConvertFrom-Json).Self.DNSName.TrimEnd('.')
	Write-Host "Pinned to https://$Device (persists across reboots)."
	Write-Host 'Portless apps will now land on :8443, :8444, ...'
} else {
	Write-Host 'Tailscale not running - skipped the serve rule. When it is up, run:'
	Write-Host "  tailscale serve --bg --https=443 http://127.0.0.1:$Port"
}
