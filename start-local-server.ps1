[CmdletBinding()]
param(
    [int]$Port = 8787,
    [switch]$NoBrowser,
    # Force a fresh start even when a healthy server already holds the port.
    # Without this, an already-running server is reused as-is, which means
    # source changes made after it started are NOT loaded.
    [switch]$Restart
)

$ErrorActionPreference = "Stop"
$projectRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$wranglerPath = Join-Path $projectRoot "node_modules\.bin\wrangler.CMD"

# Only these images may be terminated automatically, and only when they are
# listening on the target port AND belong to this project. Both conditions are
# required by docs	 section 1; anything else must be reported, never killed.
$script:ExpectedServerImages = @("workerd.exe", "node.exe")

function Get-PreferredPnpm {
    $pnpm = Get-Command pnpm.cmd -ErrorAction SilentlyContinue
    if (-not $pnpm) {
        $pnpm = Get-Command pnpm -ErrorAction SilentlyContinue
    }
    return $pnpm
}

function Get-LocalIPv4Address {
    $addresses = @()
    try {
        $addresses = @(
            Get-NetIPAddress -AddressFamily IPv4 -PrefixOrigin Manual,Dhcp -AddressState Preferred |
                Where-Object { $_.IPAddress -notmatch "^(127\.|169\.254\.)" } |
                Select-Object -ExpandProperty IPAddress -Unique
        )
    }
    catch {
        $addresses = @()
    }

    if ($addresses.Count -eq 0) {
        try {
            $addresses = @(
                [System.Net.Dns]::GetHostEntry([System.Net.Dns]::GetHostName()).AddressList |
                    Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork } |
                    ForEach-Object { $_.IPAddressToString } |
                    Where-Object { $_ -notmatch "^(127\.|169\.254\.)" } |
                    Select-Object -Unique
            )
        }
        catch {
            $addresses = @()
        }
    }

    return $addresses
}

function Test-PortInUse {
    param([int]$CandidatePort)

    $listeners = [System.Net.NetworkInformation.IPGlobalProperties]::GetIPGlobalProperties().GetActiveTcpListeners()
    return @($listeners | Where-Object { $_.Port -eq $CandidatePort }).Count -gt 0
}

function Test-HubHealth {
    param([int]$CandidatePort)

    # /api/health answers without touching the database, so a server whose data
    # layer is broken still reports 200 there. On 2026-08-24 a stale server did
    # exactly that: health returned 200 while every gallery request returned 500,
    # so this launcher kept saying "already running" and never loaded newer code.
    # Probing a database-backed endpoint too is what makes "healthy" mean "usable".
    foreach ($probePath in @("/api/health", "/api/gallery/projects")) {
        try {
            $response = Invoke-WebRequest -Uri "http://127.0.0.1:$CandidatePort$probePath" -UseBasicParsing -TimeoutSec 3
            if ($response.StatusCode -ne 200) {
                return $false
            }
        }
        catch {
            return $false
        }
    }

    return $true
}

function Get-PortOwnerProcessId {
    param([int]$CandidatePort)

    try {
        $connection = Get-NetTCPConnection -LocalPort $CandidatePort -State Listen -ErrorAction Stop |
            Select-Object -First 1
        if ($connection) {
            return [int]$connection.OwningProcess
        }
    }
    catch {
        # Get-NetTCPConnection is unavailable on some systems. The caller treats
        # a zero result as "owner unknown" and refuses to terminate anything.
    }

    return 0
}

function Get-ProcessSummary {
    param([int]$ProcessId)

    if ($ProcessId -le 0) {
        return "owner unknown"
    }

    $proc = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if (-not $proc) {
        return "PID $ProcessId (already gone)"
    }

    $started = "unknown start time"
    try {
        $started = "started $($proc.StartTime.ToString('yyyy-MM-dd HH:mm:ss'))"
    }
    catch {
        # Access to StartTime can be denied for processes owned by another user.
    }

    return "PID $($proc.Id)  $($proc.ProcessName).exe  $started"
}

function Test-IsProjectServerProcess {
    param($ProcessInfo)

    if (-not $ProcessInfo) {
        return $false
    }

    if ($script:ExpectedServerImages -notcontains $ProcessInfo.Name) {
        return $false
    }

    $root = $projectRoot.ToLowerInvariant()

    if ($ProcessInfo.ExecutablePath) {
        if ($ProcessInfo.ExecutablePath.ToLowerInvariant().StartsWith($root)) {
            return $true
        }
    }

    if ($ProcessInfo.CommandLine) {
        $commandLine = $ProcessInfo.CommandLine.ToLowerInvariant()
        if ($commandLine.Contains($root)) {
            return $true
        }
    }

    return $false
}

function Stop-ProjectServer {
    param([int]$CandidatePort)

    $ownerPid = Get-PortOwnerProcessId -CandidatePort $CandidatePort
    if ($ownerPid -le 0) {
        return $false
    }

    $allProcesses = @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
        Select-Object ProcessId, ParentProcessId, Name, ExecutablePath, CommandLine)
    if ($allProcesses.Count -eq 0) {
        return $false
    }

    $byId = @{}
    foreach ($proc in $allProcesses) {
        $byId[[int]$proc.ProcessId] = $proc
    }

    $owner = $byId[$ownerPid]
    if (-not (Test-IsProjectServerProcess -ProcessInfo $owner)) {
        return $false
    }

    # Collect the owner, every descendant, and the matching ancestors. Killing
    # only the port owner is not enough: wrangler runs workerd as a child, and
    # removing the child while the parent survives leaves the parent wedged --
    # it respawns a worker that never answers (observed 2026-08-24).
    $targets = New-Object System.Collections.Generic.List[int]
    $targets.Add($ownerPid) | Out-Null

    $pending = New-Object System.Collections.Generic.List[int]
    $pending.Add($ownerPid) | Out-Null
    while ($pending.Count -gt 0) {
        $current = $pending[0]
        $pending.RemoveAt(0)
        foreach ($proc in $allProcesses) {
            if ([int]$proc.ParentProcessId -eq $current) {
                $childId = [int]$proc.ProcessId
                if (-not $targets.Contains($childId)) {
                    $targets.Add($childId) | Out-Null
                    $pending.Add($childId) | Out-Null
                }
            }
        }
    }

    $ancestor = $byId[[int]$owner.ParentProcessId]
    while ((Test-IsProjectServerProcess -ProcessInfo $ancestor)) {
        $ancestorId = [int]$ancestor.ProcessId
        if ($targets.Contains($ancestorId)) {
            break
        }
        $targets.Add($ancestorId) | Out-Null
        $ancestor = $byId[[int]$ancestor.ParentProcessId]
    }

    # Children first so a parent cannot respawn a worker mid-cleanup.
    foreach ($targetId in ($targets | Sort-Object -Descending)) {
        $summary = Get-ProcessSummary -ProcessId $targetId
        Write-Host "  [cleanup] stopping $summary"
        Stop-Process -Id $targetId -Force -ErrorAction SilentlyContinue
    }

    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (-not (Test-PortInUse -CandidatePort $CandidatePort)) {
            return $true
        }
        Start-Sleep -Milliseconds 250
    }

    return -not (Test-PortInUse -CandidatePort $CandidatePort)
}

function Start-BrowserWhenReady {
    param(
        [string]$HealthUrl,
        [string]$PageUrl
    )

    return Start-Job -ScriptBlock {
        param($JobHealthUrl, $JobPageUrl)

        for ($attempt = 0; $attempt -lt 80; $attempt++) {
            try {
                $response = Invoke-WebRequest -Uri $JobHealthUrl -UseBasicParsing -TimeoutSec 1
                if ($response.StatusCode -eq 200) {
                    Start-Process $JobPageUrl
                    return
                }
            }
            catch {
                # The server is still starting. Try again shortly.
            }

            Start-Sleep -Milliseconds 250
        }
    } -ArgumentList $HealthUrl, $PageUrl
}

if ($Port -lt 1 -or $Port -gt 65535) {
    throw "Port must be between 1 and 65535."
}

$requestedPort = $Port
if (Test-PortInUse -CandidatePort $Port) {
    $ownerSummary = Get-ProcessSummary -ProcessId (Get-PortOwnerProcessId -CandidatePort $Port)
    $isHealthy = Test-HubHealth -CandidatePort $Port

    if ($isHealthy -and -not $Restart) {
        $existingPageUrl = "http://localhost:$Port/stage-1/"
        Write-Host "AI Project Hub is already running." -ForegroundColor Green
        Write-Host "  $ownerSummary"
        Write-Host "  This launcher did NOT start a new server. Anything you changed in"
        Write-Host "  the source after that start time is NOT loaded yet." -ForegroundColor Yellow
        Write-Host "  To load your changes, run: .\start-local-server.bat -Restart" -ForegroundColor Yellow
        Write-Host "Open: $existingPageUrl"
        if (-not $NoBrowser) {
            Start-Process $existingPageUrl
        }
        exit 0
    }

    if ($isHealthy) {
        Write-Host "Restart requested. Stopping the server that holds port $Port..." -ForegroundColor Yellow
    }
    else {
        Write-Host "Port $Port is occupied by a server that failed the health check." -ForegroundColor Yellow
        Write-Host "  $ownerSummary"
        Write-Host "  Restarting it, because a half-broken server is never what you want." -ForegroundColor Yellow
    }

    # docs	 section 1 permits terminating the occupier only when it listens on
    # the target port and is one of this project's expected images. Anything else
    # is reported and the script exits non-zero -- it is not ours to kill, and
    # silently moving to another port only hides the problem (the stale server
    # keeps running and the next run is confusing all over again).
    if (-not (Stop-ProjectServer -CandidatePort $Port)) {
        Write-Host ""
        Write-Host "Port $requestedPort is held by a process that is not this project's dev server." -ForegroundColor Red
        Write-Host "  $ownerSummary"
        Write-Host "Stop that program yourself, or pick another port:" -ForegroundColor Red
        Write-Host "  .\start-local-server.bat -Port 8788"
        exit 1
    }

    Write-Host "Port $Port is free again. Starting a fresh server..." -ForegroundColor Green
}

$healthUrl = "http://127.0.0.1:$Port/api/health"
$pageUrl = "http://localhost:$Port/stage-1/"
$browserJob = $null

Push-Location $projectRoot
try {
    $wranglerConfigRoot = Join-Path $env:TEMP "ai-project-hub-wrangler-config"
    New-Item -ItemType Directory -Force -Path $wranglerConfigRoot | Out-Null
    $env:XDG_CONFIG_HOME = $wranglerConfigRoot

    Write-Host "Starting AI Project Hub local server..." -ForegroundColor Cyan
    Write-Host "Teaching page: $pageUrl"
    Write-Host "Home page: http://localhost:$Port/"

    $localAddresses = @(Get-LocalIPv4Address)
    if ($localAddresses.Count -eq 0) {
        Write-Host "LAN URL: no preferred IPv4 address detected." -ForegroundColor Yellow
    }
    else {
        foreach ($address in $localAddresses) {
            Write-Host "LAN URL: http://${address}:$Port/" -ForegroundColor Green
        }
    }

    Write-Host "Binding: 0.0.0.0"
    Write-Host "Stop with Ctrl+C. Windows Firewall may require an allow rule for this port." -ForegroundColor Yellow

    if (-not $NoBrowser) {
        Write-Host "The teaching page will open after the server is ready."
        $browserJob = Start-BrowserWhenReady -HealthUrl $healthUrl -PageUrl $pageUrl
    }

    if (Test-Path -LiteralPath $wranglerPath) {
        & $wranglerPath dev --local --ip 0.0.0.0 --port $Port --show-interactive-dev-session false
        exit $LASTEXITCODE
    }

    $pnpm = Get-PreferredPnpm
    if (-not $pnpm) {
        throw "Wrangler is not installed and pnpm was not found. Run pnpm install first."
    }

    & $pnpm.Source run dev -- --local --ip 0.0.0.0 --port $Port --show-interactive-dev-session false
    exit $LASTEXITCODE
}
finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
        Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
    }
    Pop-Location
}
