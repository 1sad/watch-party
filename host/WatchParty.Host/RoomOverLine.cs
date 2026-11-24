namespace WatchParty.Host;

/// <summary>
/// The sidecar's one "the room is over" line, written at
/// <c>src/server/socket.ts:683</c> as <c>[room] over reason=owner_left id=...</c>.
/// This is the twin of <see cref="PortLine"/>: the prefix is the whole contract, and
/// a line that merely <em>contains</em> those words somewhere in the middle - a picked
/// file's name, for one - is not the goodbye (T130). Change the wording at either end
/// and change it here.
/// </summary>
internal static class RoomOverLine
{
    /// <summary>Everything the sidecar prints before its first `reason=` word.</summary>
    private const string Prefix = "[room] over ";

    /// <summary>
    /// True only for a line that <em>starts</em> with the sidecar's goodbye. Ordinal,
    /// like <see cref="PortLine"/>: the bytes are the contract, not a locale's idea of
    /// them.
    /// </summary>
    public static bool Is(string? line)
    {
        if (line is null) return false;
        return line.StartsWith(Prefix, StringComparison.Ordinal);
    }
}
