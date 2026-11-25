# Starts one real, installed browser at an address, in a throwaway profile under
# %TEMP%, with its DevTools port open, and prints what a caller needs to drive
# it with scripts/cdp.mjs and to close it again (T175).
#
#   powershell -NoProfile -File scripts/browser-open.ps1 -Url <url> -Port 9333
#   powershell -NoProfile -File scripts/browser-open.ps1 -Url <url> -Port 9333 -Width 390 -Height 844
#   powershell -NoProfile -File scripts/browser-open.ps1 -Url <url> -Name "C:\Program Files\Vivaldi\Application\vivaldi.exe"
#   powershell -NoProfile -File scripts/browser-open.ps1 -Close
#
# The browser is msedge.exe, falling back to chrome.exe, from the standard
# install folders; -Name takes a path to any other Chromium-based browser (the
# project's CDP tool speaks the same DevTools protocol to each). Every launch
# gets its own --user-data-dir under %TEMP%\wp-browser-<stamp>, so the user's
# own browser profile is never opened, read or written, and a closed browser
# can be removed whole. The user-data-dir also makes this a new browser
# instance: an already running browser does not take the command line.
#
# One block printed per launch, so a caller never has to guess:
#   exe:     the browser executable that was started
#   pid:     the browser process this script started (not a child it spawned)
#   port:    the DevTools port, which is what cdp.mjs --port <n> takes
#   profile: the throwaway folder, removed by -Close (or swept after a day)
#   size:    <width>x<height> when the window size was asked for, else default
#
# The port is checked before anything is started: a port already listening is
# refused with one line on stderr and exit 2, never silently shared. The script
# then waits for that port's DevTools endpoint to answer before it prints, so
# the very next `node scripts/cdp.mjs --port <n> targets` sees the page.
#
# A browser whose own first-run page takes the window instead of the address
# (Vivaldi does this: its welcome tab is the only page) has the address opened
# through the same DevTools endpoint, with /json/new, and the tool waits for
# that page before it prints. A browser that already shows the address is not
# given a second tab; Edge and Chrome do show it.
#
# -Width/-Height set the window's size. A tabbed Edge or Chrome window will not
# shrink below about 500 CSS px, so a width under 500 is opened as an app
# window instead (--app=<url>): a real browser window, with no toolbar, whose
# page does honour the size. Measured 2026-11-25 at 125% scaling: a tabbed
# --window-size=390,844 reads window.innerWidth 502, while --app=<url> at the
# same size reads 376. A width of 500 or more keeps the normal tabbed window.
#
# -Close given alone launches nothing: it reads the launches this script
# recorded under %TEMP%\wp-browser-state\, closes exactly those pids (checked
# against the exe and start time recorded with them, so a recycled pid is never
# touched), waits for each port to stop listening, removes the profile folder,
# and prints one `closed: <n>` line. Given with -Url it launches first, prints
# the block, then closes again, so one command can prove the pair.
#
# A profile folder under %TEMP%\wp-browser-* older than a day is swept like the
# portable rig's -Sweep: a folder whose browser is still running is kept and
# named; nothing outside %TEMP%\wp-browser-* (and the state folder) is touched.
#
# The browser is created by the Windows process service (Win32_Process.Create),
# not by this script, for the reason scripts/portable-launch.ps1 records
# (T46b): a child started by this script keeps the caller's pipe open for as
# long as its window lives, while a process-service copy hands nothing on. It
# runs from the profile folder with only the environment Windows and Chromium
# need, so a WATCHPARTY_* or CHROME_* left in this shell cannot change what is
# measured.
#
# Exit codes: 0 success; 1 one line on stderr for any other failure (no browser
# found, the browser exited before its endpoint answered, a close that could
# not end a process); 2 the DevTools port is already listening. Every line
# printed is ASCII (AGENTS.md rule 10).
[CmdletBinding()]
param(
  [string]$Url,

  [int]$Port = 9222,

  [int]$Width = 0,

  [int]$Height = 0,

  [string]$Name = 'edge',

  [switch]$Close
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# The process service, not Start-Process: see the header and T46b.
$wmiProcess = [wmiclass]'Win32_Process'
$wmiStartup = [wmiclass]'Win32_ProcessStartup'

# The launches this script started, one JSON file per DevTools port, under a
# folder beside the profiles. Deliberately not named wp-browser-<stamp>, so the
# profile sweep never mistakes it for a profile.
$stateRoot = Join-Path $env:TEMP 'wp-browser-state'
$profilePattern = '^wp-browser-\d{8}-\d{6}(-\d+)?$'

function Stop-BrowserOpen([int]$Code, [string]$Message) {
  [Console]::Error.WriteLine("browser-open: $Message")
  exit $Code
}

function Test-PortFree([int]$PortToTest) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $PortToTest)
    $listener.Start()
    return $true
  }
  catch {
    return $false
  }
  finally {
    if ($listener) { try { $listener.Stop() } catch { } }
  }
}

# The browser executable: 'edge' (the default) searches the standard install
# folders for msedge.exe and then chrome.exe; any other -Name is a path, or a
# bare executable name on PATH, and is used as given. An empty answer is one
# clear line, never a guess at a browser.
function Resolve-BrowserExe([string]$RequestedName) {
  if ($RequestedName -and -not $RequestedName.Equals('edge', [StringComparison]::OrdinalIgnoreCase)) {
    if (Test-Path -LiteralPath $RequestedName -PathType Leaf) {
      return (Resolve-Path -LiteralPath $RequestedName).Path
    }
    $command = Get-Command $RequestedName -ErrorAction SilentlyContinue
    if ($command -and $command.Source -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) {
      return $command.Source
    }
    return $null
  }

  $roots = @($env:ProgramFiles, ${env:ProgramFiles(x86)}, $env:LOCALAPPDATA)
  foreach ($relative in @('Microsoft\Edge\Application\msedge.exe', 'Google\Chrome\Application\chrome.exe')) {
    foreach ($root in $roots) {
      if (-not $root) { continue }
      $candidate = Join-Path $root $relative
      if (Test-Path -LiteralPath $candidate -PathType Leaf) {
        return (Resolve-Path -LiteralPath $candidate).Path
      }
    }
  }
  return $null
}

# Every process whose command line carries this profile, which is how a
# Chromium browser and every child it spawns are recognised: the executable is
# in Program Files, so the profile is the only signal that ties a process to
# one launch.
function Get-ProfileProcesses([string]$ProfilePath) {
  $needle = '--user-data-dir=' + $ProfilePath
  @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($needle, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
}

# --- the environment the browser runs with --------------------------------
# The same kept set scripts/portable-launch.ps1 passes, plus the two names
# Chromium and its crash handler read. PATH is one directory: a browser does
# not need this machine's tools.
function Get-BrowserEnvironment {
  $kept = [ordered]@{
    'PATH'                 = 'C:\Windows\System32'
    'SystemRoot'           = $env:SystemRoot
    'windir'               = $env:windir
    'TEMP'                 = $env:TEMP
    'TMP'                  = $env:TMP
    'USERPROFILE'          = $env:USERPROFILE
    'LOCALAPPDATA'         = $env:LOCALAPPDATA
    'APPDATA'              = $env:APPDATA
    'PROGRAMDATA'          = $env:PROGRAMDATA
    'PUBLIC'               = $env:PUBLIC
    'HOMEDRIVE'            = $env:HOMEDRIVE
    'HOMEPATH'             = $env:HOMEPATH
    'SystemDrive'          = $env:SystemDrive
    'PATHEXT'              = '.COM;.EXE;.BAT;.CMD'
    'COMSPEC'              = (Join-Path $env:SystemRoot 'System32\cmd.exe')
    'NUMBER_OF_PROCESSORS' = $env:NUMBER_OF_PROCESSORS
    'PROCESSOR_ARCHITECTURE' = $env:PROCESSOR_ARCHITECTURE
    'USERNAME'             = $env:USERNAME
    'USERDOMAIN'           = $env:USERDOMAIN
    'OS'                   = 'Windows_NT'
  }
  $list = @()
  foreach ($key in $kept.Keys) {
    if ($kept[$key]) { $list += ('{0}={1}' -f $key, $kept[$key]) }
  }
  return , $list
}

# Quotes one command-line argument only when it would otherwise split. A
# profile under a user name with a space is the reason this exists.
function Format-Argument([string]$Value) {
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

# --- sweeping old profiles (borrowed from -Sweep in portable-launch.ps1) ----
# A direct child of %TEMP% named like a profile, older than a day, and with no
# process running from it. Nothing else is ever considered.
function Invoke-ProfileSweep {
  $tempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')
  $cutoff = (Get-Date).AddDays(-1)
  $folders = @(Get-ChildItem -LiteralPath $tempRoot -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -match $profilePattern } | Sort-Object Name)

  foreach ($folder in $folders) {
    if (-not $folder.FullName.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      continue
    }
    if ($folder.CreationTime -gt $cutoff) { continue }

    $busy = @(Get-ProfileProcesses $folder.FullName)
    if ($busy.Count -gt 0) {
      $who = ($busy | ForEach-Object { 'pid {0} {1}' -f $_.ProcessId, $_.Name }) -join ', '
      Write-Output ("sweep: kept {0}: {1} is still running from it" -f $folder.FullName, $who)
      continue
    }
    try {
      Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction Stop
      Write-Output ("sweep: removed {0}" -f $folder.FullName)
    }
    catch {
      Write-Output ("sweep: kept {0}: it could not be removed ({1})" -f $folder.FullName, $_.Exception.Message)
    }
  }

  # A record whose process is gone is a launch that already ended (a crash, or
  # a person closing the window): its profile is left to the day above and the
  # record is dropped, so -Close never reports it as its own.
  if (Test-Path -LiteralPath $stateRoot) {
    foreach ($file in @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.json' -File -ErrorAction SilentlyContinue)) {
      $record = Read-StateRecord $file.FullName
      if (-not $record) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
        continue
      }
      $targetPid = [int]$record.pid
      if (-not (Get-Process -Id $targetPid -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      }
    }
  }
}

function Read-StateRecord([string]$Path) {
  try {
    return (Get-Content -LiteralPath $Path -Raw -ErrorAction Stop | ConvertFrom-Json)
  }
  catch {
    return $null
  }
}

# Removes one profile folder, retrying briefly: Chromium lets go of its
# SingletonLock and crash-handler files a moment after the process exits.
function Remove-ProfileQuietly([string]$ProfilePath) {
  if (-not $ProfilePath -or -not (Test-Path -LiteralPath $ProfilePath)) { return $true }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      Remove-Item -LiteralPath $ProfilePath -Recurse -Force -ErrorAction Stop
      return $true
    }
    catch {
      Start-Sleep -Milliseconds 250
    }
  }
  Write-Output ("profile kept: {0} (it could not be removed yet; it is swept after a day)" -f $ProfilePath)
  return $false
}

# --- closing what this script started --------------------------------------
# Only a recorded pid whose executable and start time still match the record is
# closed, so a pid Windows recycled since is left alone. The window is closed
# the way a person closes it (WM_CLOSE); a window that will not close in 10 s is
# ended, and any child still running from that profile is ended too, because it
# is what could keep the port listening or the folder locked.
function Close-RecordedBrowsers {
  $closed = 0
  $script:closeFailed = $false

  if (-not (Test-Path -LiteralPath $stateRoot)) {
    Write-Output 'closed: 0'
    return
  }

  foreach ($file in @(Get-ChildItem -LiteralPath $stateRoot -Filter '*.json' -File -ErrorAction SilentlyContinue | Sort-Object Name)) {
    $record = Read-StateRecord $file.FullName
    if (-not $record) {
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      continue
    }

    $targetPid = [int]$record.pid
    $exe = [string]$record.exe
    $profile = [string]$record.profile
    $port = [int]$record.port
    $proc = Get-Process -Id $targetPid -ErrorAction SilentlyContinue

    if (-not $proc) {
      Write-Output ("closed: pid {0} ({1}) had already exited" -f $targetPid, $exe)
      Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
      Remove-ProfileQuietly $profile | Out-Null
      continue
    }

    # Two signals, because one is not enough against a recycled pid: the exe
    # must be the one recorded, and the process must have started when the
    # record says it did.
    $ours = $false
    try { $ours = [bool]($proc.Path -and $proc.Path.Equals($exe, [StringComparison]::OrdinalIgnoreCase)) } catch { $ours = $false }
    if ($ours -and $record.started) {
      try {
        $recordedStart = [datetime]::Parse($record.started, [Globalization.CultureInfo]::InvariantCulture)
        $ours = [Math]::Abs(($proc.StartTime - $recordedStart).TotalSeconds) -lt 10
      }
      catch {
        $ours = $false
      }
    }
    if (-not $ours) {
      Write-Output ("closed: pid {0} ({1}) left alone: it is not the process this script started" -f $targetPid, $exe)
      continue
    }

    $sent = $false
    try { $sent = $proc.CloseMainWindow() } catch { $sent = $false }
    $exited = $false
    try { $exited = $proc.WaitForExit(10000) } catch { $exited = $false }
    if ($exited) {
      $how = if ($sent) { 'window closed' } else { 'exited' }
      Write-Output ("closed: pid {0} ({1}): {2}" -f $targetPid, (Split-Path -Leaf $exe), $how)
    }
    else {
      try { Stop-Process -Id $targetPid -Force -ErrorAction Stop } catch { }
      try { $exited = $proc.WaitForExit(5000) } catch { $exited = $false }
      if ($exited) {
        Write-Output ("closed: pid {0} ({1}): forced, the window did not close in 10 s" -f $targetPid, (Split-Path -Leaf $exe))
      }
      else {
        Write-Output ("closed: pid {0} ({1}): still running after a forced stop" -f $targetPid, (Split-Path -Leaf $exe))
      }
    }
    if ($exited) { $closed++ } else { $script:closeFailed = $true }

    # A forced close can leave a renderer behind; it runs from this profile and
    # would hold the port or the folder. It is this launch's own process.
    foreach ($leftover in @(Get-ProfileProcesses $profile)) {
      if ($leftover.ProcessId -eq $PID) { continue }
      try {
        Stop-Process -Id $leftover.ProcessId -Force -ErrorAction Stop
        Write-Output ("closed: pid {0} ({1}) was still running from {2}" -f $leftover.ProcessId, $leftover.Name, $profile)
      }
      catch {
        Write-Output ("closed: pid {0} ({1}) would not stop: {2}" -f $leftover.ProcessId, $leftover.Name, $_.Exception.Message)
      }
    }

    # The port is what a caller drives and what "closed" has to mean: wait for
    # it to stop listening, and say so if it does not.
    $portFree = Test-PortFree $port
    for ($wait = 0; -not $portFree -and $wait -lt 40; $wait++) {
      Start-Sleep -Milliseconds 250
      $portFree = Test-PortFree $port
    }
    if (-not $portFree) {
      [Console]::Error.WriteLine("browser-open: port $port is still listening after closing pid $targetPid")
      $script:closeFailed = $true
    }

    Remove-Item -LiteralPath $file.FullName -Force -ErrorAction SilentlyContinue
    Remove-ProfileQuietly $profile | Out-Null
  }

  Write-Output ("closed: {0}" -f $closed)
}

# Polls the DevTools endpoint until it answers, or gives up. The answer is the
# one signal that cdp.mjs will work; the window existing is not enough.
function Wait-DevToolsEndpoint([int]$PortToPoll, $Process, [int]$TimeoutSec) {
  $uri = 'http://127.0.0.1:{0}/json/version' -f $PortToPoll
  $deadline = (Get-Date).AddSeconds($TimeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ($Process.HasExited) { return $false }
    try {
      $response = Invoke-WebRequest -Uri $uri -UseBasicParsing -TimeoutSec 2 -ErrorAction Stop
      if ($response.StatusCode -eq 200) { return $true }
    }
    catch {
      # Not listening yet; the browser is still starting.
    }
    Start-Sleep -Milliseconds 250
  }
  return $false
}

# The page targets the browser has open, read over the DevTools HTTP endpoint.
# An empty list is "not answering yet", never an error here.
function Get-PageTargets([int]$PortToRead) {
  try {
    $response = Invoke-WebRequest -Uri ('http://127.0.0.1:{0}/json/list' -f $PortToRead) -UseBasicParsing -TimeoutSec 3 -ErrorAction Stop
    # Assigned before it is piped: Windows PowerShell's ConvertFrom-Json hands a
    # top-level JSON array on as one object, so piping it straight into
    # Where-Object would filter the array itself instead of its targets.
    $parsed = $response.Content | ConvertFrom-Json
    return @($parsed | Where-Object { $_.type -eq 'page' })
  }
  catch {
    return @()
  }
}

# A fresh profile has no user tabs, so the only external page it can show is the
# address this launch asked for (or the page that address redirects to). A
# first-run page served from the browser's own extension or chrome:// is not it.
function Test-RequestedPageShown([int]$PortToRead, [string]$Wanted) {
  $targets = Get-PageTargets $PortToRead
  foreach ($target in $targets) {
    $got = [string]$target.url
    if (-not $got) { continue }
    if ($got.TrimEnd('/').Equals($Wanted.TrimEnd('/'), [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($Wanted -match '^https?://' -and $got.StartsWith($Wanted, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  $external = @($targets | Where-Object { $_.url -and $_.url -match '^(https?|file)://' })
  return ($external.Count -ge 1)
}

# Opens the address as a new tab and waits for that tab to leave about:blank.
# Used only when the browser's startup page took the window: /json/new is part
# of the same DevTools endpoint cdp.mjs speaks, and the new tab becomes the
# active one, so the page a caller asked for is the one cdp.mjs sees first.
function Open-RequestedPage([int]$PortToOpen, [string]$Wanted) {
  $escaped = [uri]::EscapeDataString($Wanted)
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Method Put -Uri ('http://127.0.0.1:{0}/json/new?{1}' -f $PortToOpen, $escaped) -UseBasicParsing -TimeoutSec 10 -ErrorAction Stop
      $created = $response.Content | ConvertFrom-Json
    }
    catch {
      # The endpoint answered /json/version but is not ready for a tab yet.
      Start-Sleep -Milliseconds 500
      continue
    }
    if (-not $created.id) {
      Start-Sleep -Milliseconds 500
      continue
    }

    while ((Get-Date) -lt $deadline) {
      foreach ($target in @(Get-PageTargets $PortToOpen)) {
        if ($target.id -ne $created.id) { continue }
        $got = [string]$target.url
        if ($got -and $got -ne 'about:blank') { return $true }
      }
      Start-Sleep -Milliseconds 250
    }
    return $false
  }
  return $false
}

# --- main ------------------------------------------------------------------
if (-not $Url -and -not $Close) {
  Stop-BrowserOpen 1 'nothing to do: pass -Url <url> to start a browser, or -Close to close the ones this script started'
}

if ($Url) {
  if ($Width -eq 0 -and $Height -eq 0) {
    # The default: no --window-size, so the browser's own size is used.
  }
  elseif ($Width -le 0 -or $Height -le 0) {
    Stop-BrowserOpen 1 '-Width and -Height go together, both in pixels (e.g. -Width 390 -Height 844)'
  }

  if ($Port -lt 1 -or $Port -gt 65535) {
    Stop-BrowserOpen 1 "-Port must be a port number, got $Port"
  }

  if (-not (Test-PortFree $Port)) {
    # One line, and exit 2: this is a refusal, not a failure of the browser.
    Stop-BrowserOpen 2 ("port {0} is already listening on 127.0.0.1; choose another with -Port <n>" -f $Port)
  }

  $exe = Resolve-BrowserExe $Name
  if (-not $exe) {
    if ($Name -and -not $Name.Equals('edge', [StringComparison]::OrdinalIgnoreCase)) {
      Stop-BrowserOpen 1 ("no browser at '{0}' - pass -Name <path to a Chromium-based browser.exe>" -f $Name)
    }
    Stop-BrowserOpen 1 'no msedge.exe or chrome.exe in the standard install folders; pass -Name <path to a Chromium-based browser.exe>'
  }

  # Old folders first: this run's own folder does not exist yet, so every
  # folder considered belongs to an earlier run.
  Invoke-ProfileSweep

  $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
  $profile = Join-Path $env:TEMP ("wp-browser-{0}" -f $stamp)
  if (Test-Path -LiteralPath $profile) {
    $profile = Join-Path $env:TEMP ("wp-browser-{0}-{1}" -f $stamp, $PID)
  }
  New-Item -ItemType Directory -Path $profile -Force | Out-Null

  $browserArgs = @(
    ('--user-data-dir={0}' -f $profile),
    ('--remote-debugging-port={0}' -f $Port),
    '--remote-allow-origins=*',
    '--no-first-run',
    '--no-default-browser-check'
  )
  if ($Width -gt 0) {
    if ($Width -lt 500) {
      # A tabbed Chrome or Edge window will not shrink below about 500 CSS px,
      # so a narrower request is opened as an app window instead: a real
      # browser window, with no toolbar, that honours the size. Measured
      # 2026-11-25: --window-size=390,844 in a tabbed window reads
      # window.innerWidth 502; --app=<url> with the same size reads 376.
      $browserArgs = @(('--window-size={0},{1}' -f $Width, $Height)) + $browserArgs
      $browserArgs += ('--app={0}' -f $Url)
    }
    else {
      $browserArgs = @(('--window-size={0},{1}' -f $Width, $Height)) + $browserArgs
      $browserArgs += $Url
    }
  }
  else {
    $browserArgs += $Url
  }

  $commandLine = (@((Format-Argument $exe)) + ($browserArgs | ForEach-Object { Format-Argument $_ })) -join ' '
  $browserEnv = Get-BrowserEnvironment

  $created = $null
  try {
    $startup = $wmiStartup.CreateInstance()
    $startup.ShowWindow = 1                 # SW_SHOWNORMAL: the window is visible
    $startup.EnvironmentVariables = $browserEnv
    $created = $wmiProcess.Create($commandLine, $profile, $startup)
  }
  catch {
    Remove-ProfileQuietly $profile | Out-Null
    Stop-BrowserOpen 1 ("the browser would not start: {0}" -f $_.Exception.Message)
  }
  if (-not $created -or $created.ReturnValue -ne 0) {
    Remove-ProfileQuietly $profile | Out-Null
    $returnValue = if ($created) { $created.ReturnValue } else { 'unknown' }
    Stop-BrowserOpen 1 ("the browser would not start: the process service returned {0}" -f $returnValue)
  }

  $proc = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) {
    Remove-ProfileQuietly $profile | Out-Null
    Stop-BrowserOpen 1 ("the browser (pid {0}) was created and is gone already" -f $created.ProcessId)
  }

  if (-not (Wait-DevToolsEndpoint $Port $proc 30)) {
    $why = if ($proc.HasExited) { 'it exited before answering' } else { 'it did not answer within 30 s' }
    try { if (-not $proc.HasExited) { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } } catch { }
    foreach ($leftover in @(Get-ProfileProcesses $profile)) {
      try { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
    }
    Remove-ProfileQuietly $profile | Out-Null
    Stop-BrowserOpen 1 ("the browser (pid {0}) opened no DevTools endpoint on port {1}: {2}" -f $proc.Id, $Port, $why)
  }

  # The address has to be what the window shows before the block is printed.
  # Edge and Chrome open it from the command line; a browser whose own
  # first-run page takes the window (Vivaldi) gets it opened as a new tab over
  # the endpoint that is now answering.
  if (-not (Test-RequestedPageShown $Port $Url)) {
    if (-not (Open-RequestedPage $Port $Url)) {
      try { Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue } catch { }
      foreach ($leftover in @(Get-ProfileProcesses $profile)) {
        try { Stop-Process -Id $leftover.ProcessId -Force -ErrorAction SilentlyContinue } catch { }
      }
      Remove-ProfileQuietly $profile | Out-Null
      Stop-BrowserOpen 1 ("the browser (pid {0}) started but no page showed {1}" -f $proc.Id, $Url)
    }
  }

  # The record -Close reads. Written only once the endpoint answered, so a
  # record always names a browser that can be driven.
  New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
  $record = [pscustomobject]@{
    pid     = $proc.Id
    exe     = $exe
    port    = $Port
    profile = $profile
    size    = $(if ($Width -gt 0) { '{0}x{1}' -f $Width, $Height } else { 'default' })
    url     = $Url
    started = $proc.StartTime.ToString('o', [Globalization.CultureInfo]::InvariantCulture)
  }
  $recordPath = Join-Path $stateRoot ("{0}.json" -f $Port)
  $record | ConvertTo-Json | Set-Content -LiteralPath $recordPath -Encoding ascii

  Write-Output ("exe: {0}" -f $exe)
  Write-Output ("pid: {0}" -f $proc.Id)
  Write-Output ("port: {0}" -f $Port)
  Write-Output ("profile: {0}" -f $profile)
  Write-Output ("size: {0}" -f $record.size)
}

if ($Close) {
  Close-RecordedBrowsers
  Invoke-ProfileSweep
  if ($script:closeFailed) { exit 1 }
}

exit 0
