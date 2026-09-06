# portless-home in the system tray, the Windows counterpart of the xbar/SwiftBar
# plugin in menubar/: your running portless apps with health dots and tailnet
# links, plus Start/Stop/Restart for the login task. Run it without a window:
#   powershell -WindowStyle Hidden -ExecutionPolicy Bypass -File tray\portless-home-tray.ps1
# A shortcut to that command in shell:startup brings it back at every login.
#
# Nothing here reads routes.json: the server renders the menu at GET /api/menubar
# (see menubar.mjs) in the plugin text format, and the port comes from the
# service.env install.ps1 writes (PORTLESS_HOME_URL overrides the server URL).
#Requires -Version 5.1
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$ProgressPreference = 'SilentlyContinue'

$Task = 'portless-home'
$Port = 5995
$EnvFile = Join-Path $env:USERPROFILE '.portless-home\service.env'
if (Test-Path $EnvFile) {
	$Found = Select-String -Path $EnvFile -Pattern '^PORT=(\d+)$' | Select-Object -First 1
	if ($Found) { $Port = $Found.Matches[0].Groups[1].Value }
}
$Url = if ($env:PORTLESS_HOME_URL) { $env:PORTLESS_HOME_URL.TrimEnd('/') } else { "http://127.0.0.1:$Port" }

# A house, green when the server is up and grey when it is down: visible on
# light and dark taskbars alike, no image files to ship.
function New-HouseIcon($Color) {
	$Bitmap = New-Object Drawing.Bitmap 32, 32
	$Canvas = [Drawing.Graphics]::FromImage($Bitmap)
	$Canvas.SmoothingMode = 'AntiAlias'
	$Points = [Drawing.Point[]]@(
		(New-Object Drawing.Point 16, 2), (New-Object Drawing.Point 31, 16), (New-Object Drawing.Point 26, 16),
		(New-Object Drawing.Point 26, 30), (New-Object Drawing.Point 6, 30), (New-Object Drawing.Point 6, 16),
		(New-Object Drawing.Point 1, 16)
	)
	$Canvas.FillPolygon((New-Object Drawing.SolidBrush $Color), $Points)
	$Canvas.Dispose()
	[Drawing.Icon]::FromHandle($Bitmap.GetHicon())
}
$UpIcon = New-HouseIcon ([Drawing.Color]::FromArgb(52, 199, 89))
$DownIcon = New-HouseIcon ([Drawing.Color]::Gray)

$Tray = New-Object Windows.Forms.NotifyIcon
$Menu = New-Object Windows.Forms.ContextMenuStrip
$Tray.ContextMenuStrip = $Menu
$Tray.Visible = $true
$Script:MenuText = $null

function Update-Tray {
	try { $Script:MenuText = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 "$Url/api/menubar").Content } catch { $Script:MenuText = $null }
	if ($Script:MenuText) {
		$Tray.Icon = $UpIcon
		# Line 1 is the plugin's menu bar title (e.g. "⌂ 3"); Text is capped at 63 chars.
		$Tray.Text = "portless-home $(($Script:MenuText -split "`n")[0])"
	} else {
		$Tray.Icon = $DownIcon
		$Tray.Text = 'portless-home is not running'
	}
}

function Invoke-ServiceAction($Verb) {
	if ($Verb -ne 'start') { Stop-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue }
	if ($Verb -ne 'stop') { Start-ScheduledTask -TaskName $Task }
	Start-Sleep -Seconds 1
	Update-Tray
}

# One plugin line ("text | key=value ...") as a menu item. "&" would become a
# mnemonic in WinForms, and labels are user-influenced (rename).
function New-MenuLine($Line) {
	if ($Line -eq '---') { return New-Object Windows.Forms.ToolStripSeparator }
	$Text, $Params = $Line -split ' \| ', 2
	$Item = New-Object Windows.Forms.ToolStripMenuItem ($Text -replace '&', '&&')
	if ($Params -match 'href=(\S+)') {
		$Item.Tag = $Matches[1]
		$Item.Add_Click({ param($Sender, $EventArgs) Start-Process $Sender.Tag })
	}
	if ($Params -match 'disabled=true') { $Item.Enabled = $false }
	if ($Params -match 'color=gray') { $Item.ForeColor = [Drawing.Color]::Gray }
	$Item
}

function New-ActionItem($Text, $Verb) {
	$Item = New-Object Windows.Forms.ToolStripMenuItem $Text
	$Item.Tag = $Verb
	$Item.Add_Click({ param($Sender, $EventArgs) Invoke-ServiceAction $Sender.Tag })
	$Item
}

# The menu is rebuilt each time it opens, from the last fetched text.
$Menu.Add_Opening({
	$Menu.Items.Clear()
	if ($Script:MenuText) {
		foreach ($Line in ($Script:MenuText -split "`n" | Select-Object -Skip 1)) {
			if ($Line) { [void]$Menu.Items.Add((New-MenuLine $Line)) }
		}
	} else {
		[void]$Menu.Items.Add((New-MenuLine 'portless-home is not running | disabled=true color=gray'))
	}
	[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
	if (Get-ScheduledTask -TaskName $Task -ErrorAction SilentlyContinue) {
		if ($Script:MenuText) {
			[void]$Menu.Items.Add((New-ActionItem 'Restart service' 'restart'))
			[void]$Menu.Items.Add((New-ActionItem 'Stop service' 'stop'))
		} else {
			[void]$Menu.Items.Add((New-ActionItem 'Start service' 'start'))
		}
	} else {
		[void]$Menu.Items.Add((New-MenuLine 'No login service found - run install.ps1 | disabled=true color=gray'))
	}
	[void]$Menu.Items.Add((New-Object Windows.Forms.ToolStripSeparator))
	$Refresh = New-Object Windows.Forms.ToolStripMenuItem 'Refresh'
	$Refresh.Add_Click({ Update-Tray })
	[void]$Menu.Items.Add($Refresh)
	$Quit = New-Object Windows.Forms.ToolStripMenuItem 'Exit'
	$Quit.Add_Click({ $Tray.Visible = $false; [Windows.Forms.Application]::Exit() })
	[void]$Menu.Items.Add($Quit)
})

$Timer = New-Object Windows.Forms.Timer
$Timer.Interval = 15000
$Timer.Add_Tick({ Update-Tray })
$Timer.Start()

Update-Tray
[Windows.Forms.Application]::Run()
$Tray.Dispose()
