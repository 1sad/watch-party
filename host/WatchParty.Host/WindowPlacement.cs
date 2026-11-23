using System.Text.Json;

namespace WatchParty.Host;

/// <summary>
/// T93, ADR-047 ("window size"): the window's rectangle and state, kept in one
/// small file inside the browser profile folder. The remembered size belongs to
/// the <em>profile</em> - two windows with two profiles have two remembered
/// sizes, and one profile has one - and a packaged copy's profile is already in
/// the app's own folder with the logs (ADR-043).
/// </summary>
internal static class WindowPlacement
{
    internal const string FileName = "window.json";

    /// <summary>
    /// The outer rectangle and the state as last saved. <c>Maximised</c> is the
    /// state, not the rectangle: a maximised close still records the normal
    /// bounds it must be restored from.
    /// </summary>
    internal sealed record Saved(int X, int Y, int Width, int Height, bool Maximised);

    internal static string PathIn(string profileFolder) => Path.Combine(profileFolder, FileName);

    /// <summary>
    /// The saved placement, or null when there is none or it cannot be read. A
    /// missing or damaged file is a first run, never a reason to refuse to open.
    /// </summary>
    internal static Saved? TryRead(string file)
    {
        try
        {
            if (!File.Exists(file)) return null;
            Saved? saved = JsonSerializer.Deserialize<Saved>(File.ReadAllText(file));
            return saved is { Width: > 0, Height: > 0 } ? saved : null;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException)
        {
            HostLog.Write($"window: could not read {file}: {error.Message}");
            return null;
        }
    }

    /// <summary>
    /// Writes the file. A failure is one log line: a full disk must not stop the
    /// window closing.
    /// </summary>
    internal static void Write(string file, Saved saved)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(file)!);
            File.WriteAllText(file, JsonSerializer.Serialize(saved));
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            HostLog.Write($"window: could not save {file}: {error.Message}");
        }
    }
}
