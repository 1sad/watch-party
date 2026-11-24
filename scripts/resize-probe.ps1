# Drags a live window's frame the way a person does, and measures whether the
# window keeps up (T151).
#
# The fault this exists for: "resizing lags the window and mouse, so i drag it a
# bunch to resize and then let go of the mouse and it will keep dragging for a
# second". The window frame follows the pointer, but the work a resize starts
# queues in the window's own message queue, so the window trails what was asked
# for and goes on catching up after the button is released. Nothing about that is
# visible in a still picture, and a person cannot hold a drag for 120 moves and
# write down a rectangle for each one - so this posts the drag's own messages at
# a fixed pace and reads the window's rectangle back itself.
#
# What it does, in order:
#
#   * finds the visible top-level window owned by -Pid, and prints the pid, its
#     title and its whole-window rectangle, so a wrong window shows in its own
#     output rather than in a reader's judgement;
#   * restores a maximised window (a maximised one ignores a new size) and sets
#     one start size, then reads back what Windows accepted;
#   * posts WM_ENTERSIZEMOVE (0x0231), the message Windows sends when a drag
#     begins on a frame or the title bar;
#   * sends <Count> SetWindowPos calls, <IntervalMs> apart, each asking for a
#     rectangle on a wave between the start width and 260 px narrower - the wave
#     crosses the app's own 900 CSS px layout threshold, so a host that publishes
#     its layout per resize writes a layout: line per crossing and one that waits
#     for the drag's end writes none;
#   * after each request, gives the window the rest of the interval and reads its
#     rectangle back - the gap is how far the window still is, in physical px, from
#     what was asked for when the interval ran out. One move of lag on this wave
#     is about 33 px, so a gap above 40 px is more than one move behind;
#   * posts WM_EXITSIZEMOVE (0x0232), then times how long the window went on
#     moving after the last request.
#
# The requests are posted with SWP_ASYNCWINDOWPOS on purpose. Without it a
# cross-thread SetWindowPos blocks until the window's thread has processed the
# change, which hides exactly the queue this probe is asking about; with it the
# request is queued like every other message a drag sends, and the rectangle read
# back is the honest answer to "has the window done it yet".
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resize-probe.ps1 -Pid <pid> [-Count 120] [-IntervalMs 17]
#
# The window's start size is chosen to fit this screen (physical px, DPI-aware, so
# a 125% screen's 976 logical px is 1220 physical), and the wave stays well above
# the app's own 640x420 minimum. Both the size and the wave are printed, so two
# runs - before a change and after it - can be compared on the same numbers.
#
# stdout carries the header, the table, the summary and the timings; a failure is
# one line on stderr and a non-zero exit. The instants are hh:mm:ss.fff local time,
# the same clock the host's own log writes, so a probe line and a host line for the
# same moment can be compared without a conversion.
#
# Exit 0 when every move's rectangle was read back; 2 when the pid has no window,
# or when a call the table depends on fails.
[CmdletBinding()]
param(
  # -Pid, by alias: $Pid is a read-only automatic variable in PowerShell and a
  # parameter of that name cannot bind (03d hit this, T11 and T89 pay it).
  [Alias('Pid')]
  [int]$MatchPid = 0,

  # Moves in the drag.
  [int]$Count = 120,

  # Milliseconds between moves: 17 ms is about one frame at 60 Hz, which is what a
  # dragged frame's size messages arrive at.
  [int]$IntervalMs = 17
)

$usage = 'usage: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/resize-probe.ps1 -Pid <pid> [-Count 120] [-IntervalMs 17]'

function Fail([string]$Message) {
  [Console]::Error.WriteLine("resize-probe: $Message")
  exit 2
}

if ($MatchPid -le 0) { Fail "no pid given; $usage" }
if ($Count -lt 1) { Fail "Count must be 1 or more, not $Count" }
if ($IntervalMs -lt 1) { Fail "IntervalMs must be 1 or more, not $IntervalMs" }

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class ResizeProbe
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
    public static extern bool PostMessage(IntPtr hwnd, int message, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern int GetSystemMetrics(int index);

    // The 1 ms timer resolution the paced loop needs: without it Thread.Sleep(1)
    // sleeps a whole 15.6 ms tick, so "17 ms apart" would really be 31 ms apart
    // and the drag would be half the speed it claims (measured 2026-11-24).
    [DllImport("winmm.dll")]
    public static extern uint timeBeginPeriod(uint milliseconds);

    [DllImport("winmm.dll")]
    public static extern uint timeEndPeriod(uint milliseconds);

    // -4 is PER_MONITOR_AWARE_V2, -1 system aware, and the legacy call the last
    // resort. Without one of them a 125% screen hands this process a virtualised
    // rectangle and every number here would be in the wrong unit (T2, T10).
    public static string MakeDpiAware()
    {
        if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return "per-monitor-v2";
        if (SetProcessDpiAwarenessContext(new IntPtr(-1))) return "system-aware";
        if (SetProcessDPIAware()) return "system-aware-legacy";
        return "none";
    }

    // The pid's first visible top-level window, front to back. The app's windows
    // are titled the same thing, so the pid is what names one - and the title is
    // printed anyway, so a wrong window is visible in the output.
    public static IntPtr FindWindow(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if ((int)owner != pid) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    public static string TitleOf(IntPtr hwnd)
    {
        var text = new StringBuilder(1024);
        GetWindowTextW(hwnd, text, text.Capacity);
        return text.ToString();
    }

    public static string RectOf(IntPtr hwnd, out RECT rect)
    {
        if (!GetWindowRect(hwnd, out rect)) return "none";
        return string.Format("{0}x{1} at {2},{3}", rect.Right - rect.Left, rect.Bottom - rect.Top, rect.Left, rect.Top);
    }

    // SWP_NOMOVE keeps the window where it is, SWP_NOZORDER leaves the z-order
    // alone, SWP_NOACTIVATE does not steal the focus and SWP_ASYNCWINDOWPOS queues
    // the request instead of blocking until the window's thread has done it.
    const uint Async = 0x0002 | 0x0004 | 0x0010 | 0x4000;

    // The same without SWP_ASYNCWINDOWPOS: used only to put the window at its
    // start size, where the caller wants it done before it measures anything.
    const uint Sync = 0x0002 | 0x0004 | 0x0010;

    public static bool RequestSize(IntPtr hwnd, int cx, int cy)
    {
        return SetWindowPos(hwnd, IntPtr.Zero, 0, 0, cx, cy, Async);
    }

    public static bool SetSize(IntPtr hwnd, int cx, int cy)
    {
        return SetWindowPos(hwnd, IntPtr.Zero, 0, 0, cx, cy, Sync);
    }

    public static bool Post(IntPtr hwnd, int message)
    {
        return PostMessage(hwnd, message, IntPtr.Zero, IntPtr.Zero);
    }

    // Physical pixels: the DPI declaration above has already happened.
    public static int ScreenWidth() { return GetSystemMetrics(0); }
    public static int ScreenHeight() { return GetSystemMetrics(1); }
}
'@

$dpiMode = [ResizeProbe]::MakeDpiAware()
if ($dpiMode -eq 'none') { Fail "this process could not declare DPI awareness, so every rectangle it reads would be in the wrong unit" }

$hwnd = [ResizeProbe]::FindWindow($MatchPid)
if ($hwnd -eq [IntPtr]::Zero) { Fail "pid $MatchPid has no visible top-level window" }

$title = [ResizeProbe]::TitleOf($hwnd)
$start = New-Object ResizeProbe+RECT
$found = [ResizeProbe]::RectOf($hwnd, [ref]$start)
if ($found -eq 'none') { Fail "pid $MatchPid's window would not report its rectangle" }

$screenW = [ResizeProbe]::ScreenWidth()
$screenH = [ResizeProbe]::ScreenHeight()

Write-Output "resize-probe: pid $MatchPid"
Write-Output "title: ""$title"""
Write-Output "window: 0x$($hwnd.ToString('X8'))  $found"
Write-Output "dpi: $dpiMode  screen: ${screenW}x${screenH} physical"

# A maximised window ignores a new size, so put it back to an ordinary window
# first. SW_SHOWNOACTIVATE (4) restores without bringing it to the front.
if ([ResizeProbe]::IsZoomed($hwnd)) {
  [ResizeProbe]::ShowWindowAsync($hwnd, 4) | Out-Null
  $stopBy = (Get-Date).AddSeconds(4)
  while ([ResizeProbe]::IsZoomed($hwnd) -and (Get-Date) -lt $stopBy) { Start-Sleep -Milliseconds 50 }
  if ([ResizeProbe]::IsZoomed($hwnd)) { Fail "pid $MatchPid's window would not come out of being maximised" }
  Start-Sleep -Milliseconds 300
  Write-Output 'restored: the window was maximised'
}

# The start size: this screen is 976 logical px wide at 125%, so a 1160 px outer
# window fits - and it is on the WIDE side of the app's own 900 CSS px layout
# threshold, which at this scaling is an outer width of about 1142 px (measured
# 2026-11-24: a 912 px outer window has a 716 CSS px viewport, so 17 px of frame
# and 0.8 device px per CSS px). The wave takes the window 260 px narrower, so
# every pass over that threshold changes the page's layout shape: a host that
# publishes its layout on every resize writes a layout: line for it, and one that
# waits for the drag's end writes none. A start width below 1142 would leave the
# whole wave on one side of the threshold and the drag would prove nothing.
$startW = [Math]::Min(1160, $screenW - 40)
$startH = [Math]::Min(700, $screenH - 120)
[ResizeProbe]::SetSize($hwnd, $startW, $startH) | Out-Null
Start-Sleep -Milliseconds 400
$at = New-Object ResizeProbe+RECT
$accepted = [ResizeProbe]::RectOf($hwnd, [ref]$at)
if ($accepted -eq 'none') { Fail "pid $MatchPid's window would not report its rectangle after the start size" }
$baseW = $at.Right - $at.Left
$baseH = $at.Bottom - $at.Top
$narrowW = [Math]::Max(680, $baseW - 260)

Write-Output "start: requested ${startW}x${startH}, the window took $accepted"
Write-Output "wave: ${baseW}x${baseH} to ${narrowW}x${baseH}, $Count moves ${IntervalMs} ms apart"
Write-Output ''

# One instant for every move, on the same clock the host's log writes.
function Now { (Get-Date).ToString('HH:mm:ss.fff') }

# A triangle wave that starts at the wide end - the window's start size - so the
# first move asks for what the window already has and a gap there is never a
# jump: half a period down to the narrow end, half back up.
$half = 8
function Wave([int]$Index) {
  $phase = $Index % (2 * $half)
  $t = if ($phase -lt $half) { ($half - $phase) / $half } else { ($phase - $half) / $half }
  [int][Math]::Round($narrowW + ($baseW - $narrowW) * $t)
}

if (-not [ResizeProbe]::Post($hwnd, 0x0231)) { Fail "could not post WM_ENTERSIZEMOVE to pid $MatchPid's window" }
$enterAt = Now
Write-Output "enter: WM_ENTERSIZEMOVE posted at $enterAt"
Start-Sleep -Milliseconds 40

# The paced drag. Move i goes out at i*IntervalMs on a stopwatch, and the request
# made one interval earlier is read back at that same instant: the question is
# what the window still showed when the next request was due, which is the lag.
# A 1 ms timer resolution is asked for, or Thread.Sleep(1) sleeps a 15.6 ms tick
# and the drag would be half the pace it claims (measured 2026-11-24).
$rows = @()
$readBack = 0
$lastRequestAt = Get-Date
$sw = [System.Diagnostics.Stopwatch]::StartNew()
[void][ResizeProbe]::timeBeginPeriod(1)

for ($i = 0; $i -lt $Count; $i++) {
  $deadline = $i * $IntervalMs
  while ($sw.Elapsed.TotalMilliseconds -lt $deadline - 2) { Start-Sleep -Milliseconds 1 }
  while ($sw.Elapsed.TotalMilliseconds -lt $deadline) { }

  # Read back the request made one interval ago, now that its interval is up.
  if ($rows.Count -gt 0) {
    $row = $rows[$rows.Count - 1]
    $rect = New-Object ResizeProbe+RECT
    if ([ResizeProbe]::RectOf($hwnd, [ref]$rect) -eq 'none') { Fail "move $($row.Move): the window would not report its rectangle" }
    $readBack++
    $actW = $rect.Right - $rect.Left
    $actH = $rect.Bottom - $rect.Top
    $row.Actual = "${actW}x${actH}"
    $row.Gap = [Math]::Max([Math]::Abs($row.RequestW - $actW), [Math]::Abs($baseH - $actH))
  }

  $reqW = Wave $i
  if (-not [ResizeProbe]::RequestSize($hwnd, $reqW, $baseH)) { Fail "move $($i + 1): SetWindowPos was refused" }
  $rows += [pscustomobject]@{
    Move = $i + 1
    AtMs = $sw.Elapsed.TotalMilliseconds
    Instant = Now
    Requested = "${reqW}x${baseH}"
    RequestW = $reqW
    Actual = 'pending'
    Gap = -1
  }
  if ($i -eq $Count - 1) { $lastRequestAt = Get-Date }
}

# How long the window went on moving after the last request: the last queued
# request can still land, and anything else the window was still doing shows
# here as movement. Polled until the rectangle has been still for 150 ms; this
# settled read is also the last row's read-back and the final rectangle.
$previous = New-Object ResizeProbe+RECT
[void][ResizeProbe]::RectOf($hwnd, [ref]$previous)
$lastChangeAt = $lastRequestAt
$stopBy = (Get-Date).AddMilliseconds(3000)
while ((Get-Date) -lt $stopBy) {
  Start-Sleep -Milliseconds 5
  $settled = New-Object ResizeProbe+RECT
  if ([ResizeProbe]::RectOf($hwnd, [ref]$settled) -eq 'none') { break }
  if ($settled.Left -ne $previous.Left -or $settled.Top -ne $previous.Top -or
      $settled.Right -ne $previous.Right -or $settled.Bottom -ne $previous.Bottom) {
    $lastChangeAt = Get-Date
    $previous = $settled
    continue
  }
  if (((Get-Date) - $lastChangeAt).TotalMilliseconds -ge 150) { break }
}
[void][ResizeProbe]::timeEndPeriod(1)

$end = New-Object ResizeProbe+RECT
$finalRect = [ResizeProbe]::RectOf($hwnd, [ref]$end)
$stillMovingMs = [int][Math]::Round(($lastChangeAt - $lastRequestAt).TotalMilliseconds)
if ($stillMovingMs -lt 0) { $stillMovingMs = 0 }

$last = $rows[$rows.Count - 1]
if ($last.Gap -lt 0) {
  $readBack++
  $last.Actual = "$($end.Right - $end.Left)x$($end.Bottom - $end.Top)"
  $last.Gap = [Math]::Max([Math]::Abs($last.RequestW - ($end.Right - $end.Left)), [Math]::Abs($baseH - ($end.Bottom - $end.Top)))
}

if (-not [ResizeProbe]::Post($hwnd, 0x0232)) { Fail "could not post WM_EXITSIZEMOVE to pid $MatchPid's window" }
$exitAt = Now

$maxGap = 0
$maxGapAt = 0
$maxGapRequested = ''
$maxGapActual = ''
foreach ($row in $rows) {
  if ($row.Gap -gt $maxGap) {
    $maxGap = $row.Gap
    $maxGapAt = $row.Move
    $maxGapRequested = $row.Requested
    $maxGapActual = $row.Actual
  }
}

Write-Output ''
Write-Output '  move  instant        requested    actual       gap'
foreach ($row in $rows) {
  '{0,6}  {1}  {2,10}  {3,10}  {4,4}' -f $row.Move, $row.Instant, $row.Requested, $row.Actual, $row.Gap | Write-Output
}

$pace = 0
if ($Count -gt 1) { $pace = [int][Math]::Round(($rows[$Count - 1].AtMs - $rows[0].AtMs) / ($Count - 1)) }

Write-Output ''
Write-Output "exit: WM_EXITSIZEMOVE posted at $exitAt"
Write-Output "after: the window was still moving $stillMovingMs ms after the last request; it ended at $finalRect"
if ($maxGap -eq 0) {
  Write-Output 'gap: 0 px on every move - no move was still unapplied when the next one was due'
} else {
  Write-Output "gap: largest ${maxGap} px at move $maxGapAt (requested $maxGapRequested, actual $maxGapActual)"
}
Write-Output "rects: first requested $($rows[0].Requested), last requested $($rows[$Count - 1].Requested), final actual $finalRect"
Write-Output "moves: $readBack of $Count read back"
Write-Output "pacing: ${pace} ms between moves on average (asked ${IntervalMs})"
Write-Output "instant: last move $($rows[$Count - 1].Instant) (actual $($rows[$Count - 1].Actual))"

if ($readBack -ne $Count) { Fail "$readBack of $Count moves were read back" }
exit 0
