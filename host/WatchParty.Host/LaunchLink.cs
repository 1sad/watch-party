namespace WatchParty.Host;

/// <summary>
/// The page URL the window loads. A clicked <c>watchparty://</c> link — or, since
/// T193, the one plain <c>http://…/join?c=</c> address the screen prints
/// (ADR-056) — arrives as one command-line argument; the host hands it to the
/// page as one percent-encoded <c>?join=</c> value and reads nothing inside it —
/// <c>h</c>, <c>p</c> and <c>c</c> belong to the join box (T3b, ADR-034).
///
/// Twin of <c>src/shared/launch.ts</c>, whose table <c>npm test</c> checks, in
/// the same way <see cref="PortLine"/> is the twin of <c>port.ts</c>.
/// </summary>
internal static class LaunchLink
{
    /// <summary>Our scheme, without the colon <see cref="Uri.Scheme"/> reports.</summary>
    public const string Scheme = "watchparty";

    /// <summary>The path of the one plain invitation the screen prints (ADR-056).</summary>
    private const string JoinPath = "/join";

    /// <summary>
    /// The first argument that is an invite — an absolute <c>watchparty:</c> URI
    /// or the plain <c>http://&lt;host&gt;:&lt;port&gt;/join?c=&lt;code&gt;</c>
    /// address — or <c>null</c>. <c>--foo</c>, a path, plain text and a malformed
    /// link are all just "no invite" (T2b item 4).
    /// </summary>
    public static string? Find(string[]? args)
    {
        if (args is null) return null;

        foreach (string argument in args)
        {
            string text = argument.Trim();
            if (text.Length == 0) continue;

            if (IsInvite(text)) return text;
        }

        return null;
    }

    /// <summary>
    /// True when <paramref name="text"/> is an absolute <c>watchparty:</c> URI,
    /// or the plain invitation's shape: an absolute <c>http:</c> URI whose path is
    /// <c>/join</c> and whose query starts with <c>?c=</c>. The code's own shape
    /// is the join box's to read (T183), so this reads as little of the plain
    /// address as it reads of <c>watchparty://</c>'s <c>h</c>/<c>p</c>/<c>c</c>.
    /// </summary>
    private static bool IsInvite(string text)
    {
        if (!Uri.TryCreate(text, UriKind.Absolute, out Uri? uri)) return false;

        if (string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase))
            return true;

        // T193 / ADR-056: the one invitation the screen prints is the plain
        // address, so a window handed it on the command line (or in a shortcut)
        // opens on the room the same way a watchparty:// link does (R57). The
        // room's port is the address's own, not the page's (T183), and the
        // scheme is http only - the page's parser refuses https, so forwarding
        // one would show the box's sentence instead of the front door.
        return string.Equals(uri.Scheme, "http", StringComparison.OrdinalIgnoreCase)
            && string.Equals(uri.AbsolutePath, JoinPath, StringComparison.Ordinal)
            && uri.Query.StartsWith("?c=", StringComparison.Ordinal);
    }

    /// <summary>
    /// <paramref name="baseUrl"/> with <c>?join=&lt;the whole link, encoded&gt;</c>
    /// appended, or unchanged when the app was not started by a link.
    /// </summary>
    public static string PageUrl(string baseUrl, string[]? args)
    {
        string? invite = Find(args);
        if (invite is null) return baseUrl;

        string separator = baseUrl.Contains('?') ? "&" : "?";
        return $"{baseUrl}{separator}join={Uri.EscapeDataString(invite)}";
    }
}
