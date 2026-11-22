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
#   - waits for that copy's own host log under
#     %LOCALAPPDATA%\watch-party\runtime\ -- the file name carries the pid, so a
#     log from another window can never be mistaken for this one -- and for the
#     "parsed sidecar PORT <n>" line inside it;
#   - prints one block: the exe, its folder, its pid, its log path, the runtime
#     folder it unpacked, the profile folder the log names, the PORT line, and
#     the first lines of the log;
#   - leaves the window up, visible and not minimised, and leaves the copied
#     folder on disk, so a later check can photograph the window and read the
#     same log. Each copy's console output is drained and dropped; the host log
#     is the record.
#
# Run it from a console. When a caller captures its output through a pipe, the
# windows it deliberately leaves running keep that pipe open after the script
# has exited (measured 2026-11-22, T46), so the caller waits until they close:
# redirect to a file and wait for the process instead, for example
#   Start-Process powershell -ArgumentList '-NoProfile','-File',
#     'scripts\portable-launch.ps1','-Exe','release\WatchParty-0.1.0-portable.exe',
#     '-Count','2' -RedirectStandardOutput $out -RedirectStandardError $err -Wait
#
# Copies start one at a time and each one's PORT line is waited for before the
# next starts, so the first run's payload extraction has finished before the
# second copy shares the same runtime folder (ADR-042).
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
  [int]$WaitSec = 60
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

function Stop-Rig([string]$Message) {
  [Console]::Error.WriteLine("portable-launch: $Message")
  exit 1
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

$runtimeGlob = Join-Path $env:LOCALAPPDATA 'watch-party\runtime'
$results = @()
$drains = @()

for ($i = 0; $i -lt $Count; $i++) {
  $copyNo = $i + 1
  $folder = Join-Path $root ("copy-{0}" -f $copyNo)
  New-Item -ItemType Directory -Path $folder -Force | Out-Null
  $copyExe = Join-Path $folder (Split-Path -Leaf $Exe)
  Copy-Item -LiteralPath $Exe -Destination $copyExe -Force

  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $copyExe
  $psi.WorkingDirectory = $folder
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $false
  # The window's console output is drained and dropped: the log is the record,
  # and a child that kept this script's own stdout open would make any caller
  # that captures the rig's output wait for the windows to close (T46).
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
  $psi.EnvironmentVariables.Clear()
  foreach ($name in $kept.Keys) {
    if ($kept[$name]) { $psi.EnvironmentVariables[$name] = [string]$kept[$name] }
  }
  $psi.EnvironmentVariables['WATCHPARTY_CDP_PORT'] = [string]$cdpPorts[$i]

  $proc = $null
  try {
    $proc = [System.Diagnostics.Process]::Start($psi)
  }
  catch {
    Stop-Rig ("copy {0} would not start: {1}" -f $copyNo, $_.Exception.Message)
  }
  # Keep the drain tasks alive for as long as this rig runs; they empty the two
  # pipes so neither a window's console output nor the pipe itself outlives us.
  $drains += $proc.StandardOutput.ReadToEndAsync()
  $drains += $proc.StandardError.ReadToEndAsync()

  # The log's name carries the pid, so this can only ever be this copy's file.
  $deadline = (Get-Date).AddSeconds($WaitSec)
  $log = $null
  while (-not $log -and (Get-Date) -lt $deadline) {
    $found = Get-ChildItem -Path (Join-Path $runtimeGlob ('*\logs\host-*-{0}.log' -f $proc.Id)) -File -ErrorAction SilentlyContinue |
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
    if (-not $runtimeFolder -and $line -match 'payload: runtime folder .+; program root (.+)$') {
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
  Write-Output ("  cdp port:       {0} (Debug host only; the sidecar picks its own)" -f $cdpPorts[$i])
  if ($log) {
    Write-Output ("  log:            {0}" -f $log)
  }
  else {
    Write-Output ("  log:            (none found under {0} within {1} s)" -f $runtimeGlob, $WaitSec)
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

Write-Output ''
Write-Output ("windows left up and visible: {0}" -f (($results | ForEach-Object { $_.Pid }) -join ', '))
Write-Output 'stop them with: Stop-Process -Id <pid>; then kill any leftover node by path *watch-party\runtime*'
exit 0
