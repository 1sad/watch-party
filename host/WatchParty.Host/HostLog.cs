using System.Diagnostics;

namespace WatchParty.Host;

/// <summary>
/// The host's log goes to <c>logs/host.log</c> in the program folder as well as
/// to the console: the app is a WinExe, so a console may not be attached, but
/// the filter and lifetime facts still have to be observable (T1's checks).
/// </summary>
internal static class HostLog
{
    private static readonly object Gate = new();
    private static string? _path;

    public static void Open(string programRoot)
    {
        string directory = Path.Combine(programRoot, "logs");
        Directory.CreateDirectory(directory);
        lock (Gate)
        {
            _path = Path.Combine(directory, "host.log");
            File.WriteAllText(_path, string.Empty);
        }
    }

    public static void Write(string message)
    {
        string line = $"[host {DateTimeOffset.Now:HH:mm:ss.fff}] {message}";

        try
        {
            Console.WriteLine(line);
        }
        catch (IOException)
        {
            // No console attached; the file below is the record.
        }

        Debug.WriteLine(line);

        lock (Gate)
        {
            if (_path is null) return;
            try
            {
                File.AppendAllText(_path, line + Environment.NewLine);
            }
            catch (IOException)
            {
                // Logging must never take the window down.
            }
        }
    }
}
