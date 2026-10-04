<#
    install-prereqs.ps1

    Runs as a deferred custom action during the Rachna AI Studio MSI install,
    BEFORE the app is ever launched. It checks for:

      1. Microsoft Edge WebView2 Runtime
      2. Microsoft Visual C++ 2015-2022 Redistributable (x64)

    ...and silently downloads + installs whichever of these is missing,
    using Microsoft's official "evergreen" download links (so we always
    fetch whatever the current released build is, not a version we baked
    in at compile time). Already-installed prerequisites are left alone.

    UI: a small WinForms progress window (title + status text + progress
    bar). On a download/install failure, a Retry/Cancel message box is
    shown. Retry loops back and tries again; Cancel aborts the custom
    action (non-zero exit), which fails/rolls back the MSI with a clear
    error instead of silently leaving the machine half-configured.

    IMPORTANT - Session 0 isolation:
    This custom action is scheduled with Impersonate="yes" (see prereqs.wxs).
    Deferred custom actions that run as LocalSystem (Impersonate="no") execute
    in Session 0 on Vista+, which has NO desktop interaction - any UI you
    create there is invisible to the user, which would silently break the
    progress/retry UI this script relies on. Running impersonated instead
    executes as the (already UAC-elevated, administrator) user who launched
    the installer, in their interactive session, so the window is visible.
    That impersonated token is still an administrator token, which is all
    that installing WebView2 / VC++ Redist requires - do not change this to
    Impersonate="no" without re-verifying the UI is still visible.

    Logs to: %TEMP%\RachnaAIStudio-Prereqs.log
#>

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$LogPath = Join-Path $env:TEMP 'RachnaAIStudio-Prereqs.log'

function Write-Log {
    param([string]$Message)
    $line = "[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message
    try { Add-Content -Path $LogPath -Value $line -Encoding UTF8 } catch {}
}

Write-Log '--- Prerequisite check starting ---'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

# ---------------------------------------------------------------------------
# Detection
# ---------------------------------------------------------------------------

function Test-WebView2Installed {
    # Official detection method Microsoft documents for the Evergreen
    # Runtime: a non-empty "pv" (product version) value under this
    # well-known per-product client GUID, checked across the machine-wide
    # and per-user install locations.
    $clientGuid = '{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
    $paths = @(
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\$clientGuid",
        "HKLM:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid",
        "HKCU:\SOFTWARE\Microsoft\EdgeUpdate\Clients\$clientGuid"
    )
    foreach ($p in $paths) {
        try {
            $val = (Get-ItemProperty -Path $p -Name pv -ErrorAction Stop).pv
            if ($val -and $val -ne '0.0.0.0') {
                Write-Log "WebView2 detected via $p (pv=$val)"
                return $true
            }
        } catch {}
    }
    return $false
}

function Test-VCRedistInstalled {
    # The 2015-2022 x64 redistributables are ABI-compatible and share this
    # registry location; "Installed" = 1 means a compatible runtime is
    # already present, regardless of which exact 2015-2022 build put it there.
    $paths = @(
        'HKLM:\SOFTWARE\Microsoft\VisualStudio\14.0\VC\Runtimes\X64',
        'HKLM:\SOFTWARE\WOW6432Node\Microsoft\VisualStudio\14.0\VC\Runtimes\X64'
    )
    foreach ($p in $paths) {
        try {
            $val = (Get-ItemProperty -Path $p -Name Installed -ErrorAction Stop).Installed
            if ($val -eq 1) {
                Write-Log "VC++ Redistributable (x64) detected via $p"
                return $true
            }
        } catch {}
    }
    return $false
}

# ---------------------------------------------------------------------------
# Progress UI
# ---------------------------------------------------------------------------

$script:Form = New-Object System.Windows.Forms.Form
$script:Form.Text = 'Rachna AI Studio Setup'
$script:Form.Size = New-Object System.Drawing.Size(440, 150)
$script:Form.FormBorderStyle = 'FixedDialog'
$script:Form.StartPosition = 'CenterScreen'
$script:Form.ControlBox = $false
$script:Form.TopMost = $true

$script:Label = New-Object System.Windows.Forms.Label
$script:Label.Text = 'Preparing to install required components...'
$script:Label.AutoSize = $false
$script:Label.Size = New-Object System.Drawing.Size(400, 40)
$script:Label.Location = New-Object System.Drawing.Point(20, 20)
$script:Form.Controls.Add($script:Label)

$script:ProgressBar = New-Object System.Windows.Forms.ProgressBar
$script:ProgressBar.Size = New-Object System.Drawing.Size(400, 24)
$script:ProgressBar.Location = New-Object System.Drawing.Point(20, 70)
$script:ProgressBar.Style = 'Marquee'
$script:ProgressBar.MarqueeAnimationSpeed = 30
$script:Form.Controls.Add($script:ProgressBar)

function Show-ProgressForm {
    $script:Form.Show() | Out-Null
    Pump-UI
}

function Set-Status {
    param([string]$Text, [int]$Percent = -1)
    $script:Label.Text = $Text
    if ($Percent -ge 0) {
        $script:ProgressBar.Style = 'Continuous'
        $script:ProgressBar.Value = [Math]::Min(100, [Math]::Max(0, $Percent))
    } else {
        $script:ProgressBar.Style = 'Marquee'
    }
    Pump-UI
    Write-Log $Text
}

function Pump-UI {
    # Simple, dependency-free way to keep a WinForms window responsive
    # while we do synchronous work on the same thread.
    [System.Windows.Forms.Application]::DoEvents()
}

# ---------------------------------------------------------------------------
# Download + install helpers
# ---------------------------------------------------------------------------

function Invoke-DownloadWithProgress {
    param(
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$Destination,
        [Parameter(Mandatory)][string]$DisplayName
    )

    Set-Status "Downloading $DisplayName..." 0

    $bitsAvailable = $null -ne (Get-Module -ListAvailable -Name BitsTransfer -ErrorAction SilentlyContinue)
    if ($bitsAvailable) {
        try {
            Import-Module BitsTransfer -ErrorAction Stop
            $job = Start-BitsTransfer -Source $Url -Destination $Destination -Asynchronous -DisplayName $DisplayName
            while ($job.JobState -in @('Connecting', 'Transferring', 'TransientError')) {
                if ($job.BytesTotal -gt 0) {
                    $pct = [int](($job.BytesTransferred / $job.BytesTotal) * 100)
                    Set-Status "Downloading $DisplayName... $pct%" $pct
                } else {
                    Set-Status "Downloading $DisplayName..." -1
                }
                Start-Sleep -Milliseconds 200
                $job = Get-BitsTransfer -JobId $job.JobId
            }
            switch ($job.JobState) {
                'Transferred' { Complete-BitsTransfer -BitsJob $job; Set-Status "Downloaded $DisplayName" 100; return }
                default {
                    Remove-BitsTransfer -BitsJob $job -ErrorAction SilentlyContinue
                    throw "BITS transfer for $DisplayName ended in state '$($job.JobState)'"
                }
            }
        } catch {
            Write-Log "BITS download failed for $DisplayName ($_), falling back to Invoke-WebRequest"
        }
    }

    # Fallback: plain HTTP download (no fine-grained progress, but reliable).
    Set-Status "Downloading $DisplayName..." -1
    Invoke-WebRequest -Uri $Url -OutFile $Destination -UseBasicParsing
    Set-Status "Downloaded $DisplayName" 100
}

function Install-Prereq {
    param(
        [Parameter(Mandatory)][string]$Name,
        [Parameter(Mandatory)][scriptblock]$TestInstalled,
        [Parameter(Mandatory)][string]$Url,
        [Parameter(Mandatory)][string]$FileName,
        [Parameter(Mandatory)][string]$InstallArgs
    )

    if (& $TestInstalled) {
        Write-Log "$Name already installed - skipping."
        return
    }

    $downloadPath = Join-Path $env:TEMP $FileName

    while ($true) {
        try {
            Invoke-DownloadWithProgress -Url $Url -Destination $downloadPath -DisplayName $Name

            Set-Status "Installing $Name..." -1
            $proc = Start-Process -FilePath $downloadPath -ArgumentList $InstallArgs -Wait -PassThru -WindowStyle Hidden
            # 0 = success, 3010 = success but reboot required - both are fine here.
            if ($proc.ExitCode -ne 0 -and $proc.ExitCode -ne 3010) {
                throw "$Name installer exited with code $($proc.ExitCode)"
            }

            if (-not (& $TestInstalled)) {
                throw "$Name did not report as installed after running the installer"
            }

            Write-Log "$Name installed successfully."
            Remove-Item -Path $downloadPath -Force -ErrorAction SilentlyContinue
            return
        } catch {
            Write-Log "ERROR installing $Name : $_"
            $script:Form.TopMost = $false
            $result = [System.Windows.Forms.MessageBox]::Show(
                "Rachna AI Studio needs to install $Name to continue, but setup ran into a problem:`n`n$_`n`nCheck your internet connection, then Retry - or Cancel to stop the installation.`n`nDetails were logged to:`n$LogPath",
                'Rachna AI Studio Setup',
                [System.Windows.Forms.MessageBoxButtons]::RetryCancel,
                [System.Windows.Forms.MessageBoxIcon]::Error
            )
            $script:Form.TopMost = $true
            Remove-Item -Path $downloadPath -Force -ErrorAction SilentlyContinue
            if ($result -eq [System.Windows.Forms.DialogResult]::Cancel) {
                Write-Log "User cancelled $Name installation - aborting setup."
                $script:Form.Close()
                exit 1
            }
            Write-Log "User chose Retry for $Name."
            # loop and try again
        }
    }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

$prereqs = @(
    @{
        Name         = 'Microsoft Edge WebView2 Runtime'
        TestInstalled = { Test-WebView2Installed }
        # Microsoft's official "evergreen bootstrapper" permalink - always
        # resolves to the current released build.
        Url          = 'https://go.microsoft.com/fwlink/p/?LinkId=2124703'
        FileName     = 'MicrosoftEdgeWebview2Setup.exe'
        InstallArgs  = '/silent /install'
    },
    @{
        Name         = 'Microsoft Visual C++ 2015-2022 Redistributable (x64)'
        TestInstalled = { Test-VCRedistInstalled }
        # Microsoft's official "latest release" permalink for the x64
        # redistributable (see learn.microsoft.com/cpp/windows/latest-supported-vc-redist).
        Url          = 'https://aka.ms/vs/17/release/vc_redist.x64.exe'
        FileName     = 'vc_redist.x64.exe'
        InstallArgs  = '/install /quiet /norestart'
    }
)

$missing = $prereqs | Where-Object { -not (& $_.TestInstalled) }

if (-not $missing) {
    Write-Log 'All prerequisites already present - nothing to do.'
    exit 0
}

Write-Log ("Missing prerequisites: {0}" -f (($missing | ForEach-Object { $_.Name }) -join ', '))

try {
    Show-ProgressForm
    foreach ($p in $missing) {
        Install-Prereq -Name $p.Name -TestInstalled $p.TestInstalled -Url $p.Url -FileName $p.FileName -InstallArgs $p.InstallArgs
    }
    Set-Status 'All required components are installed.' 100
    Start-Sleep -Milliseconds 400
} finally {
    $script:Form.Close()
}

Write-Log '--- Prerequisite check complete ---'
exit 0
