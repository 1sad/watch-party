using System.Diagnostics;
using Microsoft.Win32;

namespace WatchParty.Host;

/// <summary>
/// M7 (ADR-041): where the window's engine comes from, and which one it is.
///
/// <c>portable</c> uses the WebView2 runtime the machine already has; <c>portable-full</c>
/// carries a fixed runtime inside its payload, and this class finds it and hands the folder
/// that holds <c>msedgewebview2.exe</c> to <c>CoreWebView2Environment.CreateAsync</c> before
/// either view loads a page (Microsoft, webview2/concepts/distribution). One log line per
/// start names the engine actually used, plus the machine's evergreen version when there is
/// one, so the two flavours are told apart by the log and not by trust.
/// </summary>
internal static class WebView2Engine
{
    /// <summary>The payload folder <c>portable-full</c> puts the unpacked fixed runtime in.</summary>
    private const string FixedFolderName = "webview2";

    /// <summary>Microsoft's name for the engine binary: the folder holding it is the engine folder.</summary>
    private const string EngineExecutable = "msedgewebview2.exe";

    /// <summary>
    /// Microsoft's two grants for an unpackaged app using a Fixed Version from 120 on, on
    /// Windows 10 only (webview2/concepts/distribution, fetched 2026-11-22): the renderer runs
    /// in an app container and cannot read the runtime without them. All application packages,
    /// then all restricted application packages. Windows 11 needs neither.
    /// </summary>
    private static readonly string[] Windows10Grants =
    {
        "*S-1-15-2-2:(OI)(CI)(RX)",
        "*S-1-15-2-1:(OI)(CI)(RX)",
    };

    /// <summary>The evergreen runtime's product id, the registry key Microsoft names.</summary>
    private const string EvergreenClientId = "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}";

    /// <summary>
    /// The folder a full payload puts the fixed engine in, whether or not it is there. The
    /// no-engine log line names it, so the folder this start looked for is in the record even
    /// when it was absent (T47b).
    /// </summary>
    public static string FixedFolder(string programRoot) => Path.Combine(programRoot, FixedFolderName);

    /// <summary>
    /// The fixed engine folder inside a program root, or null when there is none - a developer
    /// build, or a <c>portable</c> copy, which uses the machine's runtime exactly as before.
    /// </summary>
    public static string? FindFixed(string programRoot)
    {
        string folder = FixedFolder(programRoot);
        return File.Exists(Path.Combine(folder, EngineExecutable)) ? folder : null;
    }

    /// <summary>The engine folder's own version - read from the binary that will run, not from a note.</summary>
    public static string? VersionOf(string folder)
    {
        try
        {
            FileVersionInfo info = FileVersionInfo.GetVersionInfo(Path.Combine(folder, EngineExecutable));
            return info.FileVersion ?? info.ProductVersion;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            return null;
        }
    }

    /// <summary>
    /// The evergreen runtime's version from the registry, per-machine then per-user, or null
    /// on a machine with no runtime at all. The same two keys Microsoft documents for detecting
    /// the runtime; a fixed-only machine (the one <c>portable-full</c> exists for) reads null.
    /// </summary>
    public static string? EvergreenVersion()
    {
        string[] paths =
        {
            $@"SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{EvergreenClientId}",
            $@"SOFTWARE\Microsoft\EdgeUpdate\Clients\{EvergreenClientId}",
        };

        foreach (RegistryKey root in new[] { Registry.LocalMachine, Registry.CurrentUser })
        {
            foreach (string path in paths)
            {
                object? value = ReadProductVersion(root, path);
                if (value is string text && text.Length > 0 && text != "0.0.0.0") return text;
            }
        }

        return null;
    }

    private static object? ReadProductVersion(RegistryKey root, string path)
    {
        try
        {
            using RegistryKey? key = root.OpenSubKey(path);
            return key?.GetValue("pv");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or System.Security.SecurityException)
        {
            return null;
        }
    }

    /// <summary>
    /// Applies Microsoft's two grants to a freshly unpacked fixed engine folder, on Windows 10
    /// only, and returns one ASCII log line per grant. Called from the payload's one-time
    /// extraction, so it runs once per unpacked folder; a failure is logged and not fatal, because
    /// the engine's own error is the one that says what is wrong.
    /// </summary>
    public static string[] ApplyWindows10Grants(string engineFolder)
    {
        if (!IsWindows10) return Array.Empty<string>();

        try
        {
            string? icacls = IcaclsPath();
            if (icacls is null)
            {
                // A machine without icacls in its system folder still starts, with a line
                // that says why no grant was applied (T58).
                return new[]
                {
                    HostLog.Ascii(
                        $"engine: windows 10 grants not applied on {engineFolder}: "
                        + $"icacls.exe is not in {Environment.SystemDirectory}"),
                };
            }

            string[] lines = new string[Windows10Grants.Length];
            for (int index = 0; index < Windows10Grants.Length; index++)
            {
                string grant = Windows10Grants[index];
                string outcome = RunIcacls(icacls, engineFolder, grant);
                // Flattened, not dropped: a localized icacls message or a folder name outside
                // ASCII must not reach the log as garbage (AGENTS.md rule 10, T58).
                lines[index] = HostLog.Ascii($"engine: windows 10 grant {grant} on {engineFolder}: {outcome}");
            }

            return lines;
        }
        catch (Exception error)
        {
            // Nothing this method raises may reach Payload.Extract, which would turn a grant
            // that Windows 11 does not need into a start that does not happen (T58).
            return new[]
            {
                HostLog.Ascii($"engine: windows 10 grants not applied on {engineFolder}: {error.Message}"),
            };
        }
    }

    /// <summary>Windows 11 starts at build 22000; Windows 10 builds are below it.</summary>
    private static bool IsWindows10 => Environment.OSVersion.Version.Build < 22000;

    /// <summary>
    /// The full path of Windows 10's icacls.exe in the system folder, or null when it is not
    /// there - a windowed app cannot show the console search a bare name starts (NodePath.cs:3-5,
    /// ADR-034).
    /// </summary>
    private static string? IcaclsPath()
    {
        string directory = Environment.SystemDirectory;
        if (string.IsNullOrEmpty(directory)) return null;

        string candidate = Path.Combine(directory, "icacls.exe");
        return File.Exists(candidate) ? candidate : null;
    }

    private static string RunIcacls(string icacls, string folder, string grant)
    {
        try
        {
            ProcessStartInfo start = new(icacls)
            {
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
            start.ArgumentList.Add(folder);
            start.ArgumentList.Add("/grant");
            start.ArgumentList.Add(grant);

            using Process process = Process.Start(start)
                ?? throw new InvalidOperationException("icacls did not start");
            string output = process.StandardOutput.ReadToEnd() + process.StandardError.ReadToEnd();
            process.WaitForExit();
            return process.ExitCode == 0
                ? "ok"
                : $"failed (exit {process.ExitCode}): {output.Replace('\r', ' ').Replace('\n', ' ').Trim()}";
        }
        catch (Exception error)
        {
            // Win32Exception included: a path that does not start is an ExternalException, not
            // an IOException, and the caller's line is the answer rather than a thrown start (T58).
            return $"failed: {error.Message}";
        }
    }
}
