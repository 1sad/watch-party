# Scratch: place the two app windows side by side (stacked, this screen is
# portrait) and photograph both into ONE png at one instant. Not committed.
#   powershell -NoProfile -File logs/03d-pair.ps1 <file.png> <pidA> <pidB> [-Place]
param(
  [Parameter(Mandatory = $true)][string]$Path,
  [Parameter(Mandatory = $true)][int]$PidA,
  [Parameter(Mandatory = $true)][int]$PidB,
  [switch]$Place,
  [string]$Title = 'Watch Party'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

Add-Type -ReferencedAssemblies System.Drawing @'
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Text;

public static class PairShot
{
    public delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr param);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc callback, IntPtr param);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hwnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetWindowPos(IntPtr hwnd, IntPtr after, int x, int y, int cx, int cy, uint flags);
    [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();

    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }

    public static IntPtr FindOf(int pid)
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows((hwnd, _) =>
        {
            if (!IsWindowVisible(hwnd)) return true;
            uint owner;
            GetWindowThreadProcessId(hwnd, out owner);
            if ((int)owner != pid) return true;
            var text = new StringBuilder(512);
            GetWindowTextW(hwnd, text, text.Capacity);
            if (text.Length == 0) return true;
            found = hwnd;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // SWP_NOSIZE only: position is ours, size stays the window's own.
    public static void Place(IntPtr hwnd, int x, int y) { SetWindowPos(hwnd, new IntPtr(0), x, y, 0, 0, 0x0005); }

    public static Bitmap Capture(IntPtr hwnd, out int width, out int height)
    {
        RECT rect;
        GetWindowRect(hwnd, out rect);
        width = rect.Right - rect.Left;
        height = rect.Bottom - rect.Top;
        var bitmap = new Bitmap(width, height, PixelFormat.Format32bppRgb);
        using (var graphics = Graphics.FromImage(bitmap))
        {
            IntPtr hdc = graphics.GetHdc();
            try { PrintWindow(hwnd, hdc, 2); }
            finally { graphics.ReleaseHdc(hdc); }
        }
        return bitmap;
    }
}
'@

[PairShot]::SetProcessDPIAware() | Out-Null
$handleA = [PairShot]::FindOf($PidA)
$handleB = [PairShot]::FindOf($PidB)
if ($handleA -eq [IntPtr]::Zero) { [Console]::Error.WriteLine("no window for pid $PidA"); exit 1 }
if ($handleB -eq [IntPtr]::Zero) { [Console]::Error.WriteLine("no window for pid $PidB"); exit 1 }

if ($Place) {
  [PairShot]::Place($handleA, 0, 0)
  [PairShot]::Place($handleB, 0, 780)
  Start-Sleep -Milliseconds 500
}

$widthA = 0; $heightA = 0
$top = [PairShot]::Capture($handleA, [ref]$widthA, [ref]$heightA)
$widthB = 0; $heightB = 0
$bottom = [PairShot]::Capture($handleB, [ref]$widthB, [ref]$heightB)

$width = [Math]::Max($widthA, $widthB)
$height = $heightA + $heightB + 8
$composite = New-Object System.Drawing.Bitmap($width, $height, [System.Drawing.Imaging.PixelFormat]::Format32bppRgb)
$canvas = [System.Drawing.Graphics]::FromImage($composite)
$canvas.Clear([System.Drawing.Color]::FromArgb(255, 255, 0, 0))
$canvas.DrawImage($top, 0, 0)
$canvas.DrawImage($bottom, 0, $heightA + 8)
$canvas.Dispose()

$file = [System.IO.Path]::GetFullPath($Path)
New-Item -ItemType Directory -Force -Path ([System.IO.Path]::GetDirectoryName($file)) | Out-Null
$composite.Save($file, [System.Drawing.Imaging.ImageFormat]::Png)
$composite.Dispose()
$top.Dispose()
$bottom.Dispose()

[Console]::WriteLine("$file ${width}x${height} (top pid $PidA ${widthA}x${heightA}, bottom pid $PidB ${widthB}x${heightB})")
