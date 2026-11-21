# Photographs the whole window, not one page (T10).
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
#   scripts/window-shot.ps1 <file.png> [title] [-Process <name>]
#
# With no arguments beyond the path it looks for the app's own window. A title
# is a case-insensitive substring; -Process matches the owning process name.
# stdout carries the rectangle, the size read back off the saved PNG and the
# path; every complaint is one line on stderr and a non-zero exit, so a check
# never hangs on a window that is not there.
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Path,

  [Parameter(Position = 1)]
  [string]$Title,

  [string]$Process,

  [int]$MatchPid = 0
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Fail([string]$message, [int]$code = 1) {
  [Console]::Error.WriteLine("watch-party: $message")
  exit $code
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
    public static extern bool SetWindowPos(IntPtr hwnd, IntPtr insertAfter, int x, int y, int cx, int cy, uint flags);

    public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);

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

    public static bool RaiseTop(IntPtr hwnd) { return SetWindowPos(hwnd, new IntPtr(0), 0, 0, 0, 0, 0x0003); }

    public static int ProcessIdOf(IntPtr hwnd)
    {
        uint pid;
        GetWindowThreadProcessId(hwnd, out pid);
        return (int)pid;
    }
}
'@

# Before any measurement, before anything asks the screen a question.
$dpiMode = [WindowShot]::MakeDpiAware()

$wantedTitle = $Title
$wantedProcess = $Process
if (-not $wantedTitle -and -not $wantedProcess) { $wantedTitle = 'Watch Party' }

$match = $null
$seen = @()
foreach ($hwnd in [WindowShot]::TopLevelWindows()) {
  if (-not [WindowShot]::IsWindowVisible($hwnd)) { continue }
  $text = [WindowShot]::TitleOf($hwnd)
  if (-not $text) { continue }
  $name = [WindowShot]::ProcessOf($hwnd)
  $seen += "$($text) [$name]"

  if ($wantedTitle -and $text.IndexOf($wantedTitle, [StringComparison]::OrdinalIgnoreCase) -lt 0) { continue }
  if ($MatchPid -ne 0 -and [WindowShot]::ProcessIdOf($hwnd) -ne $MatchPid) { continue }
  if ($wantedProcess) {
    $wanted = $wantedProcess -replace '\.exe$', ''
    if ($name -ne $wanted) { continue }
  }

  # EnumWindows walks front to back, so the first match is the one on top.
  $match = [pscustomobject]@{ Handle = $hwnd; Title = $text; Process = $name }
  break
}

if (-not $match) {
  $looked = @()
  if ($wantedTitle) { $looked += "title like `"*$wantedTitle*`"" }
  if ($wantedProcess) { $looked += "process `"$wantedProcess`"" }
  $list = if ($seen.Count -gt 0) { "visible windows: " + ($seen -join ', ') } else { 'no visible windows at all' }
  Fail ("no window matching " + ($looked -join ' and ') + " - $list")
}

if ([WindowShot]::IsIconic($match.Handle)) {
  Fail "the window `"$($match.Title)`" is minimised; restore it before photographing it"
}

[WindowShot]::RaiseTop($match.Handle) | Out-Null
Start-Sleep -Milliseconds 320
$rect = New-Object WindowShot+RECT
if (-not [WindowShot]::GetWindowRect($match.Handle, [ref]$rect)) {
  Fail "could not read the rectangle of `"$($match.Title)`""
}

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Fail "the window `"$($match.Title)`" has an empty rectangle ${width}x${height}"
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
  $printed = [WindowShot]::PrintWindow($match.Handle, $hdc, 2)
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

$file = [System.IO.Path]::GetFullPath($Path)
$parent = [System.IO.Path]::GetDirectoryName($file)
if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
$bitmap.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$bitmap.Dispose()

# Read the size back off the file: that is what a caller will see when opening it,
# and it is how a cropped capture announces itself in the output instead of the picture.
$saved = [System.Drawing.Image]::FromFile($file)
$savedWidth = $saved.Width
$savedHeight = $saved.Height
$saved.Dispose()

"window `"$($match.Title)`" ($($match.Process), dpi-aware: $dpiMode)"
"rectangle $($rect.Left),$($rect.Top) ${width}x${height}"
"captured ${savedWidth}x${savedHeight} via $method"
$file
