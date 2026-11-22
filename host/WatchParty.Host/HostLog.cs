using System.Diagnostics;

namespace WatchParty.Host;

/// <summary>
/// The host's log goes to its own file in the program folder's <c>logs</c> directory as well as
/// to the console: the app is a WinExe, so a console may not be attached, but the filter and
/// lifetime facts still have to be observable (T1's checks). The file is named
/// <c>host-&lt;yyyyMMdd-HHmmss-fff&gt;-&lt;pid&gt;.log</c>: a sortable timestamp makes the newest window
/// obvious from a directory listing, and the process ID keeps the name unique, because more than one
/// window at a time is the normal case and a shared file was truncated by whichever host started
/// second (T8b).
/// </summary>
internal static class HostLog
{
    /// <summary>The one shared file every host truncated before T8b.</summary>
    private const string LegacyFileName = "host.log";

    private static readonly object Gate = new();
    private static string? _path;

    public static void Open(string programRoot)
    {
        string directory = Path.Combine(programRoot, "logs");
        string path = Path.Combine(directory, NewFileName());
        string? failure = null;

        lock (Gate)
        {
            try
            {
                Directory.CreateDirectory(directory);
                // The path is the file's first line as well as the console's: that one line is
                // how a live check finds the file of the window it is watching (T8b).
                File.WriteAllText(path, path + Environment.NewLine);
                _path = path;
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException)
            {
                // Logging must never take the window down (T8b safety): with no file the
                // window still opens and the console copy is the record.
                _path = null;
                failure = error.Message;
            }

            if (_path is not null)
            {
                // No shared file may survive to be mistaken for the current run.
                try
                {
                    File.Delete(Path.Combine(directory, LegacyFileName));
                }
                catch (Exception error) when (error is IOException or UnauthorizedAccessException)
                {
                    // Another host still holds it, or it is not ours to delete; either way,
                    // this host does not write to it.
                }
            }
        }

        Emit(_path ?? $"log file unavailable ({failure}); console only");
    }

    public static void Write(string message)
    {
        string line = $"[host {DateTimeOffset.Now:HH:mm:ss.fff}] {message}";
        Emit(line);

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

    /// <summary>
    /// AGENTS.md rule 10: log lines stay ASCII, and an engine's or the system's message may not.
    /// Here rather than in the window because the extraction writes the grant lines too (T58).
    /// </summary>
    public static string Ascii(string text) =>
        new(text.Select(character => character is >= ' ' and <= '~' ? character : '?').ToArray());

    private static string NewFileName()
    {
        string stamp = DateTime.Now.ToString("yyyyMMdd-HHmmss-fff", System.Globalization.CultureInfo.InvariantCulture);
        return $"host-{stamp}-{Environment.ProcessId}.log";
    }

    private static void Emit(string line)
    {
        try
        {
            Console.WriteLine(line);
        }
        catch (IOException)
        {
            // No console attached; the file below is the record.
        }

        Debug.WriteLine(line);
    }
}
