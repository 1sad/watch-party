# Runs packaged copies of Watch Party from fresh folders with a stripped
# environment (T46), so "it works where nothing is installed" is measured the
# same way every time instead of copied, stripped and hunted by hand.
#
# Per copy, this rig:
#   - copies -Exe into a new folder under %TEMP%\wp-portable-<stamp>\copy-<n>\
#     and launches it from there, so nothing beside the exe is a leftover;
#   - starts it with a cleared environment: no WATCHPARTY_* at all except the
#     DevTools port this rig assigns, and PATH set to C:\Windows\System32 alone,
#     so a node.exe or dotnet on this machine cannot be what makes it work;
#     only the variables Windows itself needs (SystemRoot, TEMP, the user
#     folders, PATHEXT, COMSPEC) are put back;
#   - waits for that copy's own host log inside the copied folder itself,
#     <copy folder>\logs\ -- the file name carries the pid, so a
#     log from another window can never be mistaken for this one -- and for the
#     "parsed sidecar PORT <n>" line inside it;
#   - prints one block: the exe, its folder, its pid, the invite scheme's
#     registration before and after that launch, its log path, the runtime
#     folder it unpacked, the profile folder the log names, the PORT line, and
#     the first lines of the log. The app rewrites
#     HKCU\Software\Classes\watchparty\shell\open\command to its own
#     Application.ExecutablePath on every start (ProtocolRegistration.cs:23,34,
#     called at MainForm.cs:258), so each copy steals the scheme and the key
#     follows the newest copy into the %TEMP% folder this rig leaves behind
#     (T87). Printing it before and after makes that visible in this output;
#   - leaves the window up, visible and not minimised, and leaves the copied
#     folder on disk, so a later check can photograph the window and read the
#     same log. The host is a WinExe and starts its sidecar with a hidden
#     console, so a copy writes nothing to this script's console: the host log
#     is the record.
#
# Run it from a console, or capture its output - both return. Each copy is
# created by the Windows process service (Win32_Process.Create) with the
# environment below carried in a startup record, not by this script, so the
# copy inherits none of the rig's handles: whatever captures this script's
# output (a pipe, a file, Start-Process -Wait) is released when the script
# exits, not when the windows it leaves open are closed (T46b, measured
# 2026-11-22: a copy started with Process.Start kept the caller's pipe open
# long after the rig had exited; a process-service copy does not). The caller
# has to do nothing to keep the windows up - exiting the rig does not touch
# them, and each block printed below names its pid. The way to provoke the
# failure path is any exe that never logs a host PORT, e.g.
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe C:\Windows\System32\notepad.exe -WaitSec 8
#
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path> -Count 2 | Out-String
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path> -Count 2 > out.txt
#
# Copies start one at a time and each one's PORT line is waited for before the
# next starts, so the first run's payload extraction has finished before the
# second copy unpacks its own (ADR-043: every copy owns the folder it sits in).
#
# The ports this rig assigns are the engine's DevTools ports
# (WATCHPARTY_CDP_PORT), 9222 upwards, one per copy. The room's own port cannot
# be assigned from outside: the sidecar binds port 0 and prints whichever port
# Windows gave it, so each copy's PORT is read back from its log and the two are
# required to differ. Only a Debug host reads the DevTools seam (ADR-042), so
# with the shipped `portable` exe the assigned number is inert; it is printed
# anyway, because the packaged measuring build (portable-debug) is what uses it.
#
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path>
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path> -Count 2
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Exe <path> -CdpPort 9300 -Count 3 -WaitSec 120
#   powershell -NoProfile -File scripts/portable-launch.ps1 -Restore
#
# Switches:
#   -Exe <path>    The packaged exe to copy. Default: the newest
#                  release\WatchParty-*-portable*.exe.
#   -Count <n>     How many copies to launch, 1..5. Default 1.
#   -CdpPort <n>   The first copy's DevTools port; copy n gets n-1 more.
#                  Default 9222. The run refuses (exit 1) when an assigned
#                  port is already listening, so two windows are never told
#                  apart by a port another process owns.
#   -WaitSec <n>   Seconds to wait for each copy's PORT line. Default 60.
#   -Restore       Point HKCU\Software\Classes\watchparty\shell\open\command
#                  back at the developer host - the newest WatchParty.Host.exe
#                  under host\WatchParty.Host\bin\Debug\ - or, when there is no
#                  such exe, remove the HKCU\Software\Classes\watchparty tree.
#                  It prints which of the two it did and the value written, and
#                  touches no other key. Given alone it launches nothing and
#                  needs no -Exe, which is how it is used after the rig: run it
#                  once the copies have registered, so the scheme does not keep
#                  pointing into a %TEMP% folder that a later cleanup removes.
#                  Given together with -Exe or -Count it runs after those copies
#                  are up, because they must register first. It never changes
#                  what this rig launches or the environment it passes.
#   -Close         Close the copies this invocation started - the pids printed
#                  in its blocks, and nothing else - the way a person would, by
#                  WM_CLOSE to each window, so the host runs its own shutdown
#                  and kills its sidecar (MainForm.cs:2010-2028). A copy that
#                  will not close in 10 s is ended, and a sidecar left behind by
#                  such a forced close is ended too, because it is the only thing
#                  that could keep the copy's folder from being swept. Prints one
#                  line per pid and then "closed: <n> copy/copies". Given alone
#                  it launches nothing, so it closes nothing and says so.
#   -Sweep         Remove %TEMP%\wp-portable-*\ folders left by earlier runs,
#                  printing each one removed. A folder that still holds a
#                  running process is kept and the process named. Nothing
#                  outside %TEMP%\wp-portable-* is touched. Given alone it
#                  launches nothing; given with -Exe or -Count it runs first,
#                  before this run creates its own folder.
#   -Close and -Sweep change nothing about what the rig launches, the
#   environment it passes or its output when neither is given.
#
# Exit code: 0 only when every copy logged a PORT; otherwise one line on stderr
# and 1. Every line printed is ASCII (AGENTS.md rule 10).
[CmdletBinding()]
param(
  [string]$Exe,

  [ValidateRange(1, 5)]
  [int]$Count = 1,

  [int]$CdpPort = 0,

  [ValidateRange(5, 900)]
  [int]$WaitSec = 60,

  [switch]$Restore,

  [switch]$Close,

  [switch]$Sweep
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class WpLaunchWin32 {
    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hwnd, int command);
}
'@

# The copies are created through the Windows process service rather than by
# Process.Start, because a child started by this script - with or without
# redirected output - inherits every inheritable handle the rig holds,
# including the caller's pipe, and keeps that pipe open for as long as the
# window lives (T46b, measured 2026-11-22). The service is a different process,
# so nothing of the rig's is handed on.
$wmiProcess = [wmiclass]'Win32_Process'
$wmiStartup = [wmiclass]'Win32_ProcessStartup'

function Stop-Rig([string]$Message) {
  # A failure after some copies are up must not leave them on screen when the
  # caller asked for -Close.
  if ($Close) { Close-RigCopies }
  [Console]::Error.WriteLine("portable-launch: $Message")
  exit 1
}

# --- closing and sweeping (T109) -------------------------------------------
# The copies this invocation started, in launch order: the only pids -Close may
# touch. Each entry keeps the folder it was launched from, so a pid Windows has
# recycled since cannot be closed by mistake.
$script:startedPids = @()

# Every process whose own exe sits inside this folder - a copy's host, its
# sidecar node.exe, and any WebView2 process that runs from the runtime folder.
# ExecutablePath is the signal, not a name: the same node.exe name is all over
# this machine.
function Get-ProcessesUnderFolder([string]$Folder) {
  $prefix = $Folder.TrimEnd('\') + '\'
  @(Get-CimInstance -ClassName Win32_Process -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) })
}

function Close-RigCopies {
  if ($script:startedPids.Count -eq 0) { return }
  $closed = 0
  foreach ($entry in $script:startedPids) {
    $proc = Get-Process -Id $entry.Pid -ErrorAction SilentlyContinue
    if (-not $proc) {
      Write-Output ("closed: pid {0} ({1}) had already exited" -f $entry.Pid, $entry.Name)
      continue
    }
    $ours = $false
    try { $ours = [bool]($proc.Path -and $proc.Path.StartsWith($entry.Folder, [StringComparison]::OrdinalIgnoreCase)) } catch { $ours = $false }
    if (-not $ours) {
      Write-Output ("closed: pid {0} left alone: its exe is not under {1}" -f $entry.Pid, $entry.Folder)
      continue
    }

    $sent = $false
    try { $sent = $proc.CloseMainWindow() } catch { $sent = $false }
    $exited = $false
    try { $exited = $proc.WaitForExit(10000) } catch { $exited = $false }
    if ($exited) {
      $how = if ($sent) { 'window closed' } else { 'exited' }
      Write-Output ("closed: pid {0} ({1}): {2}" -f $entry.Pid, $entry.Name, $how)
    }
    else {
      try { Stop-Process -Id $entry.Pid -Force -ErrorAction Stop } catch { }
      $forced = $false
      try { $forced = $proc.WaitForExit(5000) } catch { $forced = $false }
      if ($forced) {
        Write-Output ("closed: pid {0} ({1}): forced, the window did not close in 10 s" -f $entry.Pid, $entry.Name)
        $exited = $true
      }
      else {
        Write-Output ("closed: pid {0} ({1}): still running after a forced stop" -f $entry.Pid, $entry.Name)
      }
    }
    if ($exited) { $closed++ }
  }

  # A forced close never runs the host's shutdown, so its sidecar can outlive
  # it. That process is this run's own (it runs from this run's folder), and it
  # is the only thing that could stop a later -Sweep from removing the folder,
  # so it is ended here and named.
  foreach ($entry in $script:startedPids) {
    if (-not (Test-Path -LiteralPath $entry.Folder)) { continue }
    foreach ($leftover in (Get-ProcessesUnderFolder $entry.Folder)) {
      if ($leftover.ProcessId -eq $PID) { continue }
      try {
        Stop-Process -Id $leftover.ProcessId -Force -ErrorAction Stop
        Write-Output ("closed: pid {0} ({1}) was still running from {2}" -f $leftover.ProcessId, $leftover.Name, $entry.Folder)
      }
      catch {
        Write-Output ("closed: pid {0} ({1}) would not stop: {2}" -f $leftover.ProcessId, $leftover.Name, $_.Exception.Message)
      }
    }
  }

  $word = if ($closed -eq 1) { 'copy' } else { 'copies' }
  Write-Output ("closed: {0} {1}" -f $closed, $word)
}

# -Sweep is deliberately narrow: a direct child of %TEMP% whose own name starts
# with wp-portable-, and nothing else. Both the filter and the guard below say
# so, so a path that ever failed one of them is reported and left alone.
function Invoke-Sweep {
  $tempRoot = (Resolve-Path -LiteralPath $env:TEMP).Path.TrimEnd('\')
  $folders = @(Get-ChildItem -LiteralPath $tempRoot -Directory -Filter 'wp-portable-*' -ErrorAction SilentlyContinue |
    Sort-Object Name)
  if ($folders.Count -eq 0) {
    Write-Output ("sweep: no wp-portable-* folder under {0}" -f $tempRoot)
    return
  }

  $removed = 0
  $kept = 0
  foreach ($folder in $folders) {
    if (-not $folder.Name.StartsWith('wp-portable-', [StringComparison]::OrdinalIgnoreCase) -or
      -not $folder.FullName.StartsWith($tempRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
      Write-Output ("sweep: left alone: {0} is not a wp-portable-* folder directly under {1}" -f $folder.FullName, $tempRoot)
      $kept++
      continue
    }
    $busy = @(Get-ProcessesUnderFolder $folder.FullName)
    if ($busy.Count -gt 0) {
      $who = ($busy | ForEach-Object { 'pid {0} {1}' -f $_.ProcessId, $_.Name }) -join ', '
      Write-Output ("sweep: kept {0}: {1} is still running from it" -f $folder.FullName, $who)
      $kept++
      continue
    }
    try {
      Remove-Item -LiteralPath $folder.FullName -Recurse -Force -ErrorAction Stop
      Write-Output ("sweep: removed {0}" -f $folder.FullName)
      $removed++
    }
    catch {
      Write-Output ("sweep: kept {0}: it could not be removed ({1})" -f $folder.FullName, $_.Exception.Message)
      $kept++
    }
  }
  Write-Output ("sweep: removed {0}, kept {1}" -f $removed, $kept)
}

# --- the invite scheme's registration --------------------------------------
# The app writes this one key on every start, to its own
# Application.ExecutablePath (ProtocolRegistration.cs:23,34, MainForm.cs:258).
# The value is the command Windows runs for a clicked watchparty:// link, so a
# key left pointing into a %TEMP% folder that is later removed makes that click
# do nothing at all (measured 2026-11-23, T87). -Restore is the repair; the
# before/after lines below are what shows a copy stole it.
$schemeKey = 'HKCU:\Software\Classes\watchparty'
$registrationKey = Join-Path $schemeKey 'shell\open\command'

function Get-RegistrationValue {
  try {
    $item = Get-ItemProperty -LiteralPath $registrationKey -Name '(default)' -ErrorAction Stop
    $value = $item.'(default)'
    if ($null -eq $value -or "$value" -eq '') { return $null }
    return [string]$value
  }
  catch {
    return $null
  }
}

function Format-Registration($Value) {
  if ($Value) { return [string]$Value }
  return 'none'
}

# -Restore touches HKCU\Software\Classes\watchparty and nothing else: either the
# command value of this scheme, or (when there is no developer host to point at)
# that one tree. It never launches a copy.
function Invoke-Restore {
  $devRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'host\WatchParty.Host\bin\Debug'
  $devHost = $null
  if (Test-Path -LiteralPath $devRoot) {
    $devHost = Get-ChildItem -Path $devRoot -Filter 'WatchParty.Host.exe' -File -Recurse -ErrorAction SilentlyContinue |
      Sort-Object LastWriteTime -Descending | Select-Object -First 1
  }

  if ($devHost) {
    # The same shape the app itself writes: described, marked as a protocol, and
    # a quoted exe followed by "%1" (ProtocolRegistration.CommandFor).
    $command = '"{0}" "%1"' -f $devHost.FullName
    New-Item -Path $schemeKey -Force | Out-Null
    Set-ItemProperty -Path $schemeKey -Name '(default)' -Value 'URL:Watch Party invite link'
    New-ItemProperty -Path $schemeKey -Name 'URL Protocol' -Value '' -PropertyType String -Force | Out-Null
    New-Item -Path $registrationKey -Force | Out-Null
    Set-ItemProperty -Path $registrationKey -Name '(default)' -Value $command
    Write-Output ("registration: restored to the developer host: {0}" -f $command)
    Write-Output ("registration: read back: {0}" -f (Format-Registration (Get-RegistrationValue)))
    return
  }

  if (Test-Path -LiteralPath $schemeKey) {
    Remove-Item -LiteralPath $schemeKey -Recurse -Force
    Write-Output ("registration: removed HKCU\Software\Classes\watchparty (no WatchParty.Host.exe under {0})" -f $devRoot)
  }
  else {
    Write-Output ("registration: nothing to remove: HKCU\Software\Classes\watchparty was already absent (no WatchParty.Host.exe under {0})" -f $devRoot)
  }
}

# Alone (-Exe and -Count both unbound) -Restore, -Close and -Sweep are the whole
# run: no exe is looked for, nothing is copied, nothing is launched, so there is
# nothing of this invocation's own to close.
$launchesCopies = $PSBoundParameters.ContainsKey('Exe') -or $PSBoundParameters.ContainsKey('Count')
if (-not $launchesCopies -and ($Restore -or $Close -or $Sweep)) {
  if ($Close) { Write-Output 'closed: 0 copies (nothing was launched: no -Exe or -Count given)' }
  if ($Sweep) { Invoke-Sweep }
  if ($Restore) { Invoke-Restore }
  exit 0
}

# With a launch, -Sweep runs first: every folder it can remove belongs to an
# earlier run, because this run's own folder does not exist yet.
if ($Sweep) {
  Write-Output ''
  Invoke-Sweep
}

# --- the exe ---------------------------------------------------------------
if (-not $Exe) {
  $release = Join-Path (Split-Path -Parent $PSScriptRoot) 'release'
  $newest = Get-ChildItem -Path $release -Filter 'WatchParty-*-portable*.exe' -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1
  if (-not $newest) {
    Stop-Rig "no exe given and no release\WatchParty-*-portable*.exe found (run 'npm run portable' first)"
  }
  $Exe = $newest.FullName
}

$resolved = Resolve-Path -LiteralPath $Exe -ErrorAction SilentlyContinue
if (-not $resolved) { Stop-Rig "no such exe: $Exe" }
$Exe = $resolved.Path
$exeFile = Get-Item -LiteralPath $Exe
Write-Output ("exe: {0} ({1} bytes, built {2:yyyy-MM-dd HH:mm:ss})" -f $exeFile.FullName, $exeFile.Length, $exeFile.LastWriteTime)

# --- the ports this run assigns -------------------------------------------
function Test-PortFree([int]$Port) {
  $listener = $null
  try {
    $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, $Port)
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

$firstPort = if ($CdpPort -gt 0) { $CdpPort } else { 9222 }
$cdpPorts = @()
for ($i = 0; $i -lt $Count; $i++) {
  $candidate = $firstPort + $i
  if ($candidate -gt 65535) {
    Stop-Rig ("cannot assign copy {0} a DevTools port: {1} is past 65535" -f ($i + 1), $candidate)
  }
  if (-not (Test-PortFree $candidate)) {
    Stop-Rig ("cannot assign DevTools port {0} to copy {1}: another process is already listening on it" -f $candidate, ($i + 1))
  }
  $cdpPorts += $candidate
}

# --- the fresh folders -----------------------------------------------------
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$root = Join-Path $env:TEMP ("wp-portable-{0}" -f $stamp)
if (Test-Path -LiteralPath $root) {
  $root = Join-Path $env:TEMP ("wp-portable-{0}-{1}" -f $stamp, $PID)
}
New-Item -ItemType Directory -Path $root -Force | Out-Null
Write-Output ("launch folder: {0}" -f $root)

# Only what Windows and the engine need; PATH is one directory on purpose.
$kept = [ordered]@{
  'PATH'                = 'C:\Windows\System32'
  'SystemRoot'          = $env:SystemRoot
  'windir'              = $env:windir
  'TEMP'                = $env:TEMP
  'TMP'                 = $env:TEMP
  'USERPROFILE'         = $env:USERPROFILE
  'LOCALAPPDATA'        = $env:LOCALAPPDATA
  'APPDATA'             = $env:APPDATA
  'HOMEDRIVE'           = $env:HOMEDRIVE
  'HOMEPATH'            = $env:HOMEPATH
  'SystemDrive'         = $env:SystemDrive
  'PATHEXT'             = '.COM;.EXE;.BAT;.CMD'
  'COMSPEC'             = (Join-Path $env:SystemRoot 'System32\cmd.exe')
  'NUMBER_OF_PROCESSORS' = $env:NUMBER_OF_PROCESSORS
  'OS'                  = 'Windows_NT'
}

$results = @()

for ($i = 0; $i -lt $Count; $i++) {
  $copyNo = $i + 1
  $folder = Join-Path $root ("copy-{0}" -f $copyNo)
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $copyExe = Join-Path $folder (Split-Path -Leaf $Exe)
  Copy-Item -LiteralPath $Exe -Destination $copyExe -Force

  # The environment this copy runs with: the kept set and nothing else, so a
  # WATCHPARTY_* left in this shell cannot change what is measured, plus the
  # DevTools port this run assigns to this copy.
  $copyEnv = @()
  foreach ($name in $kept.Keys) {
    if ($kept[$name]) { $copyEnv += ('{0}={1}' -f $name, $kept[$name]) }
  }
  $copyEnv += ('WATCHPARTY_CDP_PORT={0}' -f $cdpPorts[$i])

  $registrationBefore = Get-RegistrationValue

  # Created by the process service, not by this script (T46b): the copy runs
  # with $copyEnv and none of the rig's handles, so a caller that captured this
  # script's output gets it back as soon as the script exits, window or no
  # window. This script's own console is not touched.
  $created = $null
  $proc = $null
  try {
    $startup = $wmiStartup.CreateInstance()
    $startup.ShowWindow = 1                     # SW_SHOWNORMAL: visible
    $startup.EnvironmentVariables = $copyEnv
    $created = $wmiProcess.Create(('"{0}"' -f $copyExe), $folder, $startup)
  }
  catch {
    Stop-Rig ("copy {0} would not start: {1}" -f $copyNo, $_.Exception.Message)
  }
  if (-not $created -or $created.ReturnValue -ne 0) {
    Stop-Rig ("copy {0} would not start: the process service returned {1}" -f $copyNo, $created.ReturnValue)
  }
  $proc = Get-Process -Id $created.ProcessId -ErrorAction SilentlyContinue
  if (-not $proc) {
    Stop-Rig ("copy {0} (pid {1}) was created and is gone already" -f $copyNo, $created.ProcessId)
  }
  $script:startedPids += [pscustomobject]@{
    Pid    = $proc.Id
    Name   = (Split-Path -Leaf $copyExe)
    Folder = $folder
  }

  # The log's name carries the pid, so this can only ever be this copy's file.
  # ADR-043: the log is in the copy's own folder, under logs\.
  $deadline = (Get-Date).AddSeconds($WaitSec)
  $log = $null
  while (-not $log -and (Get-Date) -lt $deadline) {
    $found = Get-ChildItem -Path (Join-Path $folder ('logs\host-*-{0}.log' -f $proc.Id)) -File -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($found) { $log = $found.FullName; break }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  $lines = @()
  $portLine = $null
  $sidecarPort = 0
  while ((Get-Date) -lt $deadline) {
    if ($log) {
      $lines = @(Get-Content -LiteralPath $log -ErrorAction SilentlyContinue)
      $matched = $lines | Where-Object { $_ -match 'parsed sidecar PORT (\d+)' } | Select-Object -Last 1
      if ($matched) {
        $portLine = $matched.Trim()
        $sidecarPort = [int]([regex]::Match($portLine, 'PORT (\d+)').Groups[1].Value)
        break
      }
    }
    if ($proc.HasExited) { break }
    Start-Sleep -Milliseconds 250
  }

  # The app has registered by the time it logs its PORT; if the value has not
  # moved yet, give it a moment rather than printing a half-truth.
  $registrationAfter = Get-RegistrationValue
  $regDeadline = (Get-Date).AddSeconds(5)
  while ($registrationAfter -eq $registrationBefore -and (Get-Date) -lt $regDeadline -and -not $proc.HasExited) {
    Start-Sleep -Milliseconds 250
    $registrationAfter = Get-RegistrationValue
  }

  # Visible, not minimised: a later check photographs this window (manual S7).
  $handle = [IntPtr]::Zero
  for ($wait = 0; $wait -lt 40 -and -not $proc.HasExited; $wait++) {
    $proc.Refresh()
    $handle = $proc.MainWindowHandle
    if ($handle -ne [IntPtr]::Zero) { break }
    Start-Sleep -Milliseconds 250
  }
  if ($handle -ne [IntPtr]::Zero) {
    [void][WpLaunchWin32]::ShowWindowAsync($handle, 1)   # SW_SHOWNORMAL
  }

  $runtimeFolder = $null
  $profileLine = $null
  foreach ($line in $lines) {
    if (-not $runtimeFolder -and $line -match 'payload: runtime folder (.+); program folder .+$') {
      $runtimeFolder = $Matches[1].Trim()
    }
    if (-not $profileLine -and $line -match 'profile: (.+)$') {
      $profileLine = $Matches[1].Trim()
    }
  }

  Write-Output ''
  Write-Output ("==== copy {0} of {1} ====" -f $copyNo, $Count)
  Write-Output ("  exe:            {0}" -f $copyExe)
  Write-Output ("  folder:         {0}" -f $folder)
  Write-Output ("  pid:            {0}" -f $proc.Id)
  Write-Output ("  registration:   before={0} after={1}" -f (Format-Registration $registrationBefore), (Format-Registration $registrationAfter))
  Write-Output ("  cdp port:       {0} (Debug host only; the sidecar picks its own)" -f $cdpPorts[$i])
  if ($log) {
    Write-Output ("  log:            {0}" -f $log)
  }
  else {
    Write-Output ("  log:            (none found under {0} within {1} s)" -f (Join-Path $folder 'logs'), $WaitSec)
  }
  if ($runtimeFolder) {
    Write-Output ("  runtime folder: {0}" -f $runtimeFolder)
  }
  else {
    Write-Output '  runtime folder: (none: the log has no payload line, so this exe carries no payload)'
  }
  if ($profileLine) {
    Write-Output ("  profile:        {0}" -f $profileLine)
  }
  else {
    Write-Output '  profile:        (none: the log names no profile folder)'
  }
  if ($portLine) {
    Write-Output ("  PORT:           {0}" -f $portLine)
  }
  else {
    Write-Output ("  PORT:           (none within {0} s)" -f $WaitSec)
  }
  Write-Output '  first lines of the log:'
  foreach ($line in ($lines | Select-Object -First 12)) {
    Write-Output ("    {0}" -f $line)
  }

  $results += [pscustomobject]@{
    Copy   = $copyNo
    Folder = $folder
    Pid    = $proc.Id
    Log    = $log
    Port   = $sidecarPort
  }

  if (-not $portLine) {
    $logText = if ($log) { $log } else { '(no log file was written)' }
    if ($proc.HasExited) {
      Stop-Rig ("copy {0} (pid {1}) exited without logging a PORT; log: {2}" -f $copyNo, $proc.Id, $logText)
    }
    Stop-Rig ("copy {0} (pid {1}) logged no PORT within {2} s; log: {3}" -f $copyNo, $proc.Id, $WaitSec, $logText)
  }
}

$duplicate = $results | Group-Object Port | Where-Object { $_.Count -gt 1 }
if ($duplicate) {
  Stop-Rig ("two copies reported the same sidecar PORT {0}: they are sharing one room process" -f $duplicate[0].Name)
}

# After the copies, never before: each one rewrites the key as it starts, so a
# restore done first would be overwritten by the copy that launched after it.
if ($Restore) {
  Write-Output ''
  Invoke-Restore
}

Write-Output ''
if ($Close) {
  Close-RigCopies
}
else {
  Write-Output ("windows left up and visible: {0}" -f (($results | ForEach-Object { $_.Pid }) -join ', '))
  # ADR-043: the payload root is runtime\<version>-<hash8>\, so node.exe sits one
  # level deeper than the exe's own folder. The pattern below names this run's own
  # copies, so it can never sweep up a node from another folder or a later run.
  $nodePattern = '{0}\copy-*\runtime\*\node.exe' -f $root
  Write-Output ("stop them with: Stop-Process -Id <pid>; then kill any leftover node by path {0}" -f $nodePattern)
}
exit 0
