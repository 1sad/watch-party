# Photographs the whole window, not one page (T10; pid, pairs and placement T11).
#
# `node scripts/cdp.mjs shot` captures a single page through DevTools, which is
# the right tool when the check is about a page. It never shows the site view,
# the strip and the sidebar together, because those are different surfaces of
# one WinForms window. This is that missing picture.
#
# The one thing that must happen first is the DPI declaration. This machine runs
# at 125%, so a DPI-unaware process is handed a virtualised rectangle and
# `PrintWindow` happily fills it: ticket 02 lost turns to a 894x614 capture with
# the sidebar cut in half, while the window was really 1118x767. Declaring
# awareness before any measurement is what makes the two agree.
#
# T11 added what a second window needs. Both of this app's windows are titled
# "Watch Party" in process WatchParty.Host, so title-and-process can only ever
# name the topmost one: -Pid selects by the window's owning process instead.
# -Pids photographs several windows into ONE image, top to bottom, each row
# labelled with its pid, rectangle and the instant it was captured, so one
# command yields one moment and the two clock panels can be read against each
# other. -Place moves the named windows to separate rectangles before the
# capture, because a fully occluded window can hand back a frame painted seconds
# ago (03d read a clock 4.3 s behind the shot); it prints every rectangle it
# used and leaves the windows where it put them — it never moves one back.
# -MaxHeight <px> is for a short screen: a stack that does not fit is shrunk to
# the space available before it is captured, in this process's physical pixels,
# because a caller's own SetWindowPos writes logical ones and its "shrink until
# it fits" loop never ends at 125% scaling (T88). -MaxHeight needs -Place.
#
# T91 gave it a size, because this phase's acceptance is pictures at two window
# sizes. -Width <px> and -Height <px> set the window's OUTER size and -Maximise
# maximises it, both before the picture and both followed by a settle; both
# print the rectangle Windows ended up with, next to the PNG's own size in the
# common tail, because PrintWindow hands back the last composited frame - a size
# the window refused, or a picture still showing the old one, has to show in the
# output rather than in a reader's eye (docs/testing-manual.md section 7, trap
# 8). A size and -Maximise name one window and never combine with -Place, which
# only ever moves: those combinations are refused rather than guessed. A size
# the window refuses is printed and the exit code is 3, so no caller believes a
# picture is the size it asked for when it is not.
#
#   powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [title] [-Process <name>]
#   powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [-Pid <n>] [-Width <px>] [-Height <px>] [-Maximise]
#   powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [-Pids <n,n>] [-Place] [-MaxHeight <px>]
#
# With no arguments beyond the path it looks for the app's own window. A title
# is a case-insensitive substring; -Process matches the owning process name; a
# pid needs neither. stdout carries the pid, the rectangle, the instant of each
# capture, the size read back off the saved PNG and the path; every complaint is
# one line on stderr and a non-zero exit, so a check never hangs on a window that
# is not there.
[CmdletBinding()]
param(
  [Parameter(Position = 0)]
  [string]$Path,

  [Parameter(Position = 1)]
  [string]$Title,

  [string]$Process,

  # `$Pid` is a read-only automatic variable in PowerShell, so a parameter of
  # that name cannot bind; the alias is what makes `-Pid 1234` work (03d hit
  # this, T11 pays it).
  [Alias('Pid')]
  [int]$MatchPid = 0,

  # Two or more pids, photographed into one image from one command. Taken as
  # strings because `-File` hands "1,2" over whole: the split below is what makes
  # both `-Pids 1,2` and `-Pids 1, 2` mean two windows.
  [string[]]$Pids,

  # Move the named windows to separate rectangles before capturing them.
  [switch]$Place,

  # Fit a short screen: shrink the windows being stacked until the stack fits
  # this many physical pixels (the screen's own height when it is shorter).
  # Physical, because the DPI declaration above makes every rectangle in this
  # process physical. The app's own window will not go below 420px tall (its
  # MinimumSize, measured T89), so two of them plus the gaps do not fit a
  # 1080px screen before any shrinking (T88).
  [ValidateRange(120, 20000)]
  [int]$MaxHeight = 0,

  # The window's outer size, in the unit every rectangle below is printed in:
  # physical pixels, since this process declared DPI awareness before it
  # measured anything. Either one alone changes only that dimension.
  [ValidateRange(120, 20000)]
  [int]$Width = 0,

  [ValidateRange(120, 20000)]
  [int]$Height = 0,

  # Maximise the window (ShowWindow SW_MAXIMIZE) before the picture.
  [switch]$Maximise
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$usage = 'usage: powershell -NoProfile -File scripts/window-shot.ps1 <file.png> [title] [-Process <name>] [-Pid <n>] [-Pids <n,n>] [-Place] [-MaxHeight <px>] [-Width <px>] [-Height <px>] [-Maximise]'

function Fail([string]$message, [int]$code = 1) {
  [Console]::Error.WriteLine("watch-party: $message")
  exit $code
}

if (-not $Path) {
  [Console]::Error.WriteLine('watch-party: no output path')
  [Console]::Error.WriteLine($usage)
  exit 2
}

Add-Type -AssemblyName System.Drawing

Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public static class WindowShot
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left, Top, Right, Bottom; }

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool IsIconic(IntPtr hwnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern bool IsZoomed(IntPtr hwnd);

    [DllImport("user32.dll")]
    public static extern bool ShowWindowAsync(IntPtr hwnd, int command);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    // -4 is PER_MONITOR_AWARE_V2 and needs Windows 10 1703+; -1 is system aware.
    // The old SetProcessDPIAware is the last resort. Any of them beats being
    // handed a virtualised rectangle at this machine's 125% scaling (T2, T10).
    public static string MakeDpiAware()
    {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
        if (SetProcessDpiAwarenessContext(new IntPtr(-1))) return "system-aware";
        if (SetProcessDPIAware()) return "system-aware-legacy";
        return "none";
    }

    public static List<IntPtr> TopLevelWindows()
    {
        var found = new List<IntPtr>();
        EnumWindows((hwnd, _) => { found.Add(hwnd); return true; }, IntPtr.Zero);
        return found;
    }

    public static string TitleOf(IntPtr hwnd)
    {
        var text = new StringBuilder(1024);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    public static string ProcessOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        try { return System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; }
        catch { return "pid " + pid; }
    }

    public static int ProcessIdOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return (int)pid;
    }

    // Position only: SWP_NOSIZE keeps the window's own size, SWP_NOZORDER leaves
    // the z-order alone and SWP_NOACTIVATE does not steal the focus. Separating
    // the rectangles is what makes an otherwise covered window paint again.
    public static bool MoveTo(IntPtr hwnd, int x, int y)
    {
        return SetWindowPos(hwnd, IntPtr.Zero, x, y, 0, 0, 0x0015);
    }

    // Physical pixels, because the DPI declaration above has already happened.
    public static int ScreenWidth() { return GetSystemMetrics(0); }
    public static int ScreenHeight() { return GetSystemMetrics(1); }

    // Size and position, in physical pixels too: SWP_NOZORDER leaves the
    // z-order alone, SWP_NOACTIVATE does not steal the focus. A maximised
    // window ignores a new size, so it is restored first - a shorter window for
    // the picture is a resize, not putting a window back where it was.
    // SW_SHOWNOACTIVATE (4) restores it without bringing it to the front.
    public static bool SetRect(IntPtr hwnd, int x, int y, int cx, int cy)
    {
        if (IsZoomed(hwnd)) { ShowWindowAsync(hwnd, 4); }
        return SetWindowPos(hwnd, IntPtr.Zero, x, y, cx, cy, 0x0014);
    }
}
'@

# Before any measurement, before anything asks the screen a question.
$dpiMode = [WindowShot]::MakeDpiAware()

# One enumeration, used by every selection path below, so a failed pid match can
# say what was actually on screen.
$seen = @()
foreach ($hwnd in [WindowShot]::TopLevelWindows()) {
  if (-not [WindowShot]::IsWindowVisible($hwnd)) { continue }
  $text = [WindowShot]::TitleOf($hwnd)
  if (-not $text) { continue }
  $seen += [pscustomobject]@{
    Handle  = $hwnd
    Title   = $text
    Process = [WindowShot]::ProcessOf($hwnd)
    Pid     = [WindowShot]::ProcessIdOf($hwnd)
  }
}

$summary = if ($seen.Count -gt 0) {
  'visible windows: ' + (($seen | Select-Object -First 8 | ForEach-Object { "$($_.Title) [$($_.Process) $($_.Pid)]" }) -join ', ')
} else {
  'no visible windows at all'
}

# -Pids wins over -Pid; the title, when given too, narrows the pid's windows.
$wantedPids = @()
if ($null -ne $Pids) {
  foreach ($piece in $Pids) {
    foreach ($chunk in ($piece -split ',')) {
      if (-not $chunk.Trim()) { continue }
      $number = 0
      if (-not [int]::TryParse($chunk.Trim(), [ref]$number)) { Fail "`"$chunk`" is not a pid - numbers separated by commas, please" }
      $wantedPids += $number
    }
  }
  if ($wantedPids.Count -eq 0) { Fail '-Pids was given no numbers' }
}
elseif ($MatchPid -ne 0) { $wantedPids = @($MatchPid) }

$targets = @()
if ($wantedPids.Count -gt 0) {
  $distinct = @()
  foreach ($want in $wantedPids) { if ($distinct -notcontains $want) { $distinct += $want } }

  foreach ($want in $distinct) {
    $hits = @($seen | Where-Object { $_.Pid -eq $want })
    if ($Title) { $hits = @($hits | Where-Object { $_.Title.IndexOf($Title, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
    if ($hits.Count -eq 0) {
      $alive = @(Get-Process -Id $want -ErrorAction SilentlyContinue).Count -gt 0
      $why = if ($alive) { "pid $want owns no visible titled window" } else { "no process with pid $want" }
      Fail "$why - $summary"
    }
    # EnumWindows walks front to back, so hits[0] is that pid's topmost window.
    if ($hits.Count -gt 1) { "pid $want owns $($hits.Count) titled windows; photographing `"$($hits[0].Title)`"" }
    $targets += $hits[0]
  }
}
else {
  $wantedTitle = $Title
  $wantedProcess = $Process
  if (-not $wantedTitle -and -not $wantedProcess) { $wantedTitle = 'Watch Party' }

  $match = $null
  foreach ($w in $seen) {
    if ($wantedTitle -and $w.Title.IndexOf($wantedTitle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
    if ($wantedProcess) {
      $wanted = $wantedProcess -replace '\.exe$', ''
      if ($w.Process -ne $wanted) { continue }
    }
    # EnumWindows walks front to back, so the first match is the one on top.
    $match = $w
    break
  }

  if (-not $match) {
    $looked = @()
    if ($wantedTitle) { $looked += "title like `"*$wantedTitle*`"" }
    if ($wantedProcess) { $looked += "process `"$wantedProcess`"" }
    Fail ("no window matching " + ($looked -join ' and ') + " - $summary")
  }
  $targets = @($match)
}

foreach ($t in $targets) {
  if ([WindowShot]::IsIconic($t.Handle)) {
    Fail "the window `"$($t.Title)`" (pid $($t.Pid)) is minimised; restore it before photographing it"
  }
}

if ($MaxHeight -gt 0 -and -not $Place) {
  Fail '-MaxHeight needs -Place: it sizes the stack this tool is about to make; nothing was moved'
}

# A size and a maximised window are one window's business, and neither belongs
# with -Place, which only moves. Refusing by name beats silently picking one of
# two instructions the caller gave.
$resize = $Width -gt 0 -or $Height -gt 0
$sizeRefused = $false
if ($Maximise -and $resize) {
  Fail '-Maximise with -Width/-Height: a maximised window does not take a size, so pick one - nothing was changed'
}
if ($resize -and $Place) {
  Fail '-Width/-Height with -Place: -Place only moves windows and never resizes them, so those two contradict each other - nothing was changed'
}
if ($Maximise -and $Place) {
  Fail '-Maximise with -Place: -Place puts windows where the stack wants them and leaves them there, so which of the two should win is a guess - nothing was changed'
}
if (($resize -or $Maximise) -and $targets.Count -gt 1) {
  Fail ("-Width/-Height and -Maximise size ONE window; $($targets.Count) were named, so which one to size would be a guess. Take the sized picture on its own")
}

# -Place: separate the named windows so none of them is the one underneath.
# Nothing is moved at all if the stack cannot fit, and nothing is ever moved back.
if ($Place) {
  $sizes = @()
  foreach ($t in $targets) {
    $r = New-Object WindowShot+RECT
    if (-not [WindowShot]::GetWindowRect($t.Handle, [ref]$r)) { Fail "could not read the rectangle of pid $($t.Pid)" }
    $sizes += [pscustomobject]@{ Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top }
  }

  $gap = 24
  $stackHeight = $gap * ($sizes.Count - 1)
  foreach ($s in $sizes) { $stackHeight += $s.Height }
  $screenHeight = [WindowShot]::ScreenHeight()

  if ($MaxHeight -le 0) {
    if ($stackHeight -gt $screenHeight) {
      Fail ("$($sizes.Count) stacked windows need ${stackHeight}px and the screen is ${screenHeight}px tall; nothing was moved. Add -MaxHeight $screenHeight to shrink them to fit.")
    }
  }
  else {
    # The space this picture may use: the caller's cap, or the screen when that
    # is shorter. Shrinking only happens when the stack needs it, so a stack
    # that already fits is left the size the app chose.
    $available = [Math]::Min($MaxHeight, $screenHeight)
    if ($stackHeight -gt $available) {
      $before = ($sizes | ForEach-Object { $_.Height }) -join ','
      $perWindow = [int][Math]::Floor(($available - $gap * ($sizes.Count - 1)) / $sizes.Count)
      if ($perWindow -lt 120) {
        Fail ("$($sizes.Count) stacked windows cannot be made to fit ${available}px: each would have to be ${perWindow}px tall with ${gap}px gaps; nothing was moved")
      }
      for ($i = 0; $i -lt $targets.Count; $i++) {
        $t = $targets[$i]
        $r = New-Object WindowShot+RECT
        if (-not [WindowShot]::GetWindowRect($t.Handle, [ref]$r)) { Fail "could not read the rectangle of pid $($t.Pid)" }
        if (-not [WindowShot]::SetRect($t.Handle, $r.Left, $r.Top, $sizes[$i].Width, $perWindow)) {
          Fail "could not size pid $($t.Pid) to $($sizes[$i].Width)x${perWindow}; the windows already resized stay that size"
        }
      }
      # The size Windows accepted is what the stack is measured with: a window
      # with a larger minimum refuses to become that short.
      Start-Sleep -Milliseconds 400
      $sizes = @()
      foreach ($t in $targets) {
        $r = New-Object WindowShot+RECT
        if (-not [WindowShot]::GetWindowRect($t.Handle, [ref]$r)) { Fail "could not read the rectangle of pid $($t.Pid)" }
        $sizes += [pscustomobject]@{ Width = $r.Right - $r.Left; Height = $r.Bottom - $r.Top }
      }
      $stackHeight = $gap * ($sizes.Count - 1)
      foreach ($s in $sizes) { $stackHeight += $s.Height }
      $after = ($sizes | ForEach-Object { $_.Height }) -join ','
      if ($stackHeight -gt $available) {
        Fail ("shrinking requested ${perWindow}px per window left heights ${after}: the stack is still ${stackHeight}px against ${available}px available (a window will not go below its own minimum); the windows resized stay that size and nothing was put back")
      }
      "max height ${MaxHeight}px: shrunk $($sizes.Count) windows from ${before} to ${after} so the stack fits ${stackHeight}px of ${available}px (screen ${screenHeight}px)"
    }
    else {
      $heights = ($sizes | ForEach-Object { $_.Height }) -join ','
      "max height ${MaxHeight}px: no shrink needed, heights ${heights} make a stack of ${stackHeight}px within ${available}px (screen ${screenHeight}px)"
    }
  }

  $x = 0
  $y = 0
  $placed = @()
  for ($i = 0; $i -lt $targets.Count; $i++) {
    $t = $targets[$i]
    if (-not [WindowShot]::MoveTo($t.Handle, $x, $y)) {
      foreach ($p in $placed) { "placed pid $($p.Pid) at $($p.Left),$($p.Top) and left it there" }
      Fail "could not move pid $($t.Pid) to $x,$y; the windows already moved stay where they are"
    }
    $placed += [pscustomobject]@{ Pid = $t.Pid; Left = $x; Top = $y }
    $y += $sizes[$i].Height + $gap
  }
  # The move only takes effect once Windows has repainted, and a picture taken
  # before the repaint is the stale frame this switch exists to avoid.
  Start-Sleep -Milliseconds 400
}

# -Width/-Height and -Maximise: one window, sized or maximised before the
# picture. The rectangle Windows accepted is read back and printed here, and the
# capture loop below prints it again beside the PNG's own size, so a size the
# window refused or a frame still showing the old one is in the output rather
# than in a reader's judgement.
if ($resize -or $Maximise) {
  $only = $targets[0]

  if ($Maximise) {
    # SW_MAXIMIZE (3). ShowWindowAsync returns before Windows has finished, so
    # the wait below is for the window to report itself zoomed.
    [WindowShot]::ShowWindowAsync($only.Handle, 3) | Out-Null
    $stopBy = (Get-Date).AddSeconds(3)
    while (-not [WindowShot]::IsZoomed($only.Handle) -and (Get-Date) -lt $stopBy) { Start-Sleep -Milliseconds 100 }
    if (-not [WindowShot]::IsZoomed($only.Handle)) {
      Fail "pid $($only.Pid) did not report itself maximised within 3 s; it was left as Windows put it and no picture was taken"
    }
    # The composited frame arrives after the resize, not with it (trap 8).
    Start-Sleep -Milliseconds 700

    $now = New-Object WindowShot+RECT
    if (-not [WindowShot]::GetWindowRect($only.Handle, [ref]$now)) { Fail "could not read the rectangle of pid $($only.Pid)" }
    "maximise: SW_MAXIMIZE -> rectangle $($now.Left),$($now.Top) $($now.Right - $now.Left)x$($now.Bottom - $now.Top) (screen $([WindowShot]::ScreenWidth())x$([WindowShot]::ScreenHeight()) physical px; a maximised window includes its invisible resize border)"
  }
  else {
    # Restoring is asynchronous, and a window that still thinks it is maximised
    # ignores a new size outright: SetRect calls SW_RESTORE then sets the
    # rectangle, so a restore that has not landed yet silently loses the size
    # (measured on this ticket, pid 16188: asked 900x500, stayed 900x700).
    if ([WindowShot]::IsZoomed($only.Handle)) {
      [WindowShot]::ShowWindowAsync($only.Handle, 4) | Out-Null
      $stopBy = (Get-Date).AddSeconds(3)
      while ([WindowShot]::IsZoomed($only.Handle) -and (Get-Date) -lt $stopBy) { Start-Sleep -Milliseconds 100 }
      if ([WindowShot]::IsZoomed($only.Handle)) {
        Fail "pid $($only.Pid) is maximised and did not report itself restored within 3 s, so it cannot be sized; no picture was taken"
      }
      Start-Sleep -Milliseconds 200
    }

    $before = New-Object WindowShot+RECT
    if (-not [WindowShot]::GetWindowRect($only.Handle, [ref]$before)) { Fail "could not read the rectangle of pid $($only.Pid)" }
    $cx = if ($Width -gt 0) { $Width } else { $before.Right - $before.Left }
    $cy = if ($Height -gt 0) { $Height } else { $before.Bottom - $before.Top }

    # Outer size, in physical pixels: this process declared per-monitor-v2 DPI
    # awareness before it measured anything, so SetWindowPos takes the same unit
    # GetWindowRect returns and nothing is scaled by the monitor's DPI. SetRect
    # restores a maximised window first (a maximised one ignores a new size) and
    # passes SWP_NOZORDER|SWP_NOACTIVATE, so nothing is raised or focused.
    if (-not [WindowShot]::SetRect($only.Handle, $before.Left, $before.Top, $cx, $cy)) {
      Fail "could not size pid $($only.Pid) to ${cx}x${cy}"
    }

    # The size Windows accepted, then a settled frame: the wait after the match
    # is for the repaint (trap 8), and a window with a larger minimum never
    # matches at all.
    $stopBy = (Get-Date).AddSeconds(3)
    do {
      Start-Sleep -Milliseconds 100
      $now = New-Object WindowShot+RECT
      if (-not [WindowShot]::GetWindowRect($only.Handle, [ref]$now)) { Fail "could not read the rectangle of pid $($only.Pid)" }
      $gotWidth = $now.Right - $now.Left
      $gotHeight = $now.Bottom - $now.Top
      $gotLeft = $now.Left
      $gotTop = $now.Top
    } while (([Math]::Abs($gotWidth - $cx) -gt 2 -or [Math]::Abs($gotHeight - $cy) -gt 2) -and (Get-Date) -lt $stopBy)
    Start-Sleep -Milliseconds 500

    "size: asked ${cx}x${cy} -> rectangle $gotLeft,$gotTop ${gotWidth}x${gotHeight}"
    if ([Math]::Abs($gotWidth - $cx) -gt 2 -or [Math]::Abs($gotHeight - $cy) -gt 2) {
      $sizeRefused = $true
      "size: pid $($only.Pid) did not take ${cx}x${cy}; it reports ${gotWidth}x${gotHeight} (a window keeps its own minimum), and that is the picture taken"
    }
  }
}

# The captures are taken back to back in this one loop: the two instants printed
# below are the honest measure of how close to one moment the pair is.
$stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
$captures = @()
foreach ($t in $targets) {
  $rect = New-Object WindowShot+RECT
  if (-not [WindowShot]::GetWindowRect($t.Handle, [ref]$rect)) {
    Fail "could not read the rectangle of pid $($t.Pid)"
  }

  $width = $rect.Right - $rect.Left
  $height = $rect.Bottom - $rect.Top
  if ($width -le 0 -or $height -le 0) {
    Fail "the window of pid $($t.Pid) has an empty rectangle ${width}x${height}"
  }

  # Format32bppRgb, not Argb: PrintWindow writes no alpha, and an Argb bitmap would
  # save an all-transparent PNG that looks blank in every viewer.
  $bitmap = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  $hdc = $graphics.GetHdc()
  $method = 'PrintWindow'
  try {
    # 2 is PW_RENDERFULLCONTENT: without it a composited child (the WebView2
    # view) comes back blank.
    $printed = [WindowShot]::PrintWindow($t.Handle, $hdc, 2)
  } finally {
    $graphics.ReleaseHdc($hdc)
  }

  if (-not $printed) {
    # Some windows refuse to render into a memory DC. The screen is the fallback,
    # and it only tells the truth when nothing covers the window.
    $method = 'screen'
    $graphics.CopyFromScreen($rect.Left, $rect.Top, 0, 0, (New-Object System.Drawing.Size($width, $height)))
  }
  $graphics.Dispose()

  $captures += [pscustomobject]@{
    Pid     = $t.Pid
    Title   = $t.Title
    Process = $t.Process
    Left    = $rect.Left
    Top     = $rect.Top
    Width   = $width
    Height  = $height
    Bitmap  = $bitmap
    Method  = $method
    At      = (Get-Date)
    Tick    = $stopwatch.ElapsedMilliseconds
  }
}

$file = [System.IO.Path]::GetFullPath($Path)
$parent = [System.IO.Path]::GetDirectoryName($file)
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }

if ($captures.Count -eq 1) {
  $captures[0].Bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
}
else {
  # One image, top to bottom in the order the pids were given, each row carrying
  # its own label so a reader never has to guess which window is which.
  $headerHeight = 26
  $gapHeight = 8
  $rowWidth = 0
  $totalHeight = $gapHeight * ($captures.Count - 1)
  foreach ($c in $captures) {
    if ($c.Width -gt $rowWidth) { $rowWidth = $c.Width }
    $totalHeight += $headerHeight + $c.Height
  }

  $composite = New-Object System.Drawing.Bitmap([int]$rowWidth, [int]$totalHeight, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
  $canvas = [System.Drawing.Graphics]::FromImage($composite)
  $canvas.Clear([System.Drawing.Color]::FromArgb(255, 20, 21, 26))
  $font = New-Object System.Drawing.Font('Consolas', 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
  $labelBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 226, 226, 236))
  $bandBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 52, 53, 66))
  $y = 0
  foreach ($c in $captures) {
    $canvas.FillRectangle($bandBrush, 0, $y, $rowWidth, $headerHeight)
    $label = "pid $($c.Pid)  `"$($c.Title)`"  rect $($c.Left),$($c.Top) $($c.Width)x$($c.Height)  shot $($c.At.ToString('HH:mm:ss.fff'))  $($c.Method)"
    $canvas.DrawString($label, $font, $labelBrush, 6, $y + 6)
    $canvas.DrawImage($c.Bitmap, 0, $y + $headerHeight, $c.Width, $c.Height)
    $y += $headerHeight + $c.Height + $gapHeight
  }
  $font.Dispose()
  $labelBrush.Dispose()
  $bandBrush.Dispose()
  $canvas.Dispose()
  $composite.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
  $composite.Dispose()
}
foreach ($c in $captures) { $c.Bitmap.Dispose() }

# Read the size back off the file: that is what a caller will see when opening it,
# and it is how a cropped capture announces itself in the output instead of the picture.
$saved = [System.Drawing.Image]::FromFile($file)
$savedWidth = $saved.Width
$savedHeight = $saved.Height
$saved.Dispose()

foreach ($c in $captures) {
  "window `"$($c.Title)`" (pid $($c.Pid), $($c.Process), dpi-aware: $dpiMode)"
  "rectangle $($c.Left),$($c.Top) $($c.Width)x$($c.Height)"
  "shot $($c.At.ToString('HH:mm:ss.fff')) via $($c.Method)"
}
if ($captures.Count -gt 1) {
  $first = $captures[0].At
  $last = $captures[$captures.Count - 1].At
  $spread = [int](($last - $first).TotalMilliseconds)
  "captures $($captures.Count) in $spread ms, one command"
}
"captured ${savedWidth}x${savedHeight}"
$file

# A size the caller asked for and the window did not take is a non-zero exit,
# so a script cannot believe the picture is the size it asked for. The path is
# already printed above.
if ($sizeRefused) { exit 3 }
