namespace WatchParty.Host;

/// <summary>
/// T184: the one plain sentence a window with no browser surface shows, and which of the two
/// it is.
///
/// Measured 2026-11-26: the old sentence - "The WebView2 runtime is missing or blocked." - was
/// shown while the WebView2 runtime was installed (157.0.4341.46) and the engine folder was
/// found, so it named a cause that was not there and left the person nothing to do. The two
/// branches are decided by what WebView2 itself raised:
/// - <see cref="Microsoft.Web.WebView2.Core.WebView2RuntimeNotFoundException"/> - no engine at
///   all: the older wording stands, which names both ways to get one (T47b);
/// - anything else - the engine is there and the start failed: name the profile folder this
///   window could not use, and the one thing a person can do about a folder another window
///   holds.
/// </summary>
internal static class EngineSentence
{
    /// <summary>
    /// No engine at all (T47b, ADR-041): unchanged, so a machine with no runtime at all is
    /// still told the truth and given both ways forward.
    /// </summary>
    public static string MissingRuntime() =>
        "Watch Party cannot open its browser window because its engine is missing: "
        + "use the larger build that carries its own engine, or install the WebView2 runtime "
        + "from Microsoft.";

    /// <summary>
    /// The engine is installed and the start still failed - a profile folder another window
    /// holds, or a folder this window cannot use. The folder is named, because a person can
    /// act on a folder and not on "blocked" (T184).
    /// </summary>
    public static string EngineFailed(string? profileFolder)
    {
        string where = string.IsNullOrEmpty(profileFolder) ? string.Empty : $" ({profileFolder})";
        return "Watch Party cannot open its browser window. The WebView2 engine is installed, but this window "
            + $"could not use its profile folder{where}. Close any other Watch Party window and start "
            + "Watch Party again.";
    }
}
