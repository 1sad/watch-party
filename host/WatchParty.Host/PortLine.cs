namespace WatchParty.Host;

/// <summary>
/// The only contract with the sidecar is one stdout line, <c>PORT &lt;n&gt;</c>.
/// The parser is deliberately strict: anything else on stdout is logged and
/// ignored, so a stray message can never be mistaken for a port.
/// </summary>
internal static class PortLine
{
    private const string Prefix = "PORT ";

    public static bool TryParse(string? line, out int port)
    {
        port = 0;
        if (line is null) return false;

        string text = line.TrimEnd('\r', '\n').Trim();
        if (!text.StartsWith(Prefix, StringComparison.Ordinal)) return false;

        string digits = text[Prefix.Length..];
        if (digits.Length is 0 or > 5) return false;
        if (!int.TryParse(digits, out int value)) return false;
        if (value is < 1 or > 65535) return false;

        port = value;
        return true;
    }
}
