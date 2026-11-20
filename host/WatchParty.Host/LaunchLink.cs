namespace WatchParty.Host;

/// <summary>
/// The page URL the window loads. A clicked <c>watchparty://</c> link arrives as
/// one command-line argument; the host hands it to the page as one
/// percent-encoded <c>?join=</c> value and reads nothing inside it — <c>h</c>,
/// <c>p</c> and <c>c</c> belong to the join box (T3b, ADR-034).
///
/// Twin of <c>src/shared/launch.ts</c>, whose table <c>npm test</c> checks, in
/// the same way <see cref="PortLine"/> is the twin of <c>port.ts</c>.
/// </summary>
internal static class LaunchLink
{
    /// <summary>Our scheme, without the colon <see cref="Uri.Scheme"/> reports.</summary>
    public const string Scheme = "watchparty";

    /// <summary>
    /// The first argument that is an absolute <c>watchparty:</c> URI, or
    /// <c>null</c>. <c>--foo</c>, a path, plain text and a malformed link are
    /// all just "no invite" (T2b item 4).
    /// </summary>
    public static string? Find(string[]? args)
    {
        if (args is null) return null;

        foreach (string argument in args)
        {
            string text = argument.Trim();
            if (text.Length == 0) continue;

            if (Uri.TryCreate(text, UriKind.Absolute, out Uri? uri)
                && string.Equals(uri.Scheme, Scheme, StringComparison.OrdinalIgnoreCase))
            {
                return text;
            }
        }

        return null;
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
