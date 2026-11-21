namespace WatchParty.Host;

/// <summary>
/// R20's ad-host list, as data: one bare host per line in <c>data/ad-hosts.txt</c>
/// beside the program folder, with its source, date and licence in the file's first
/// line. A text file is data, not a package (ADR-035); the host reads it and keeps
/// no other copy of it. A bare host stands for that host and all of its subdomains,
/// which is what EasyList's <c>||host^</c> means — E2 found the player in a
/// cross-origin frame on 6 of 11 sites, and those frames ask ad hosts by their own
/// names (ADR-034).
/// </summary>
internal static class AdHosts
{
    public const string RelativePath = "data/ad-hosts.txt";

    /// <summary>
    /// Reads the list. A missing or unreadable file is a log line and an empty set,
    /// never a window that fails to open: with no list the site view cancels
    /// nothing, which is the state T1 shipped in.
    /// </summary>
    public static HashSet<string> Load(string programRoot)
    {
        string path = Path.Combine(programRoot, "data", "ad-hosts.txt");
        HashSet<string> hosts = new(StringComparer.OrdinalIgnoreCase);
        try
        {
            foreach (string line in File.ReadLines(path))
            {
                string host = line.Trim();
                if (host.Length == 0 || host[0] == '#') continue;
                hosts.Add(host);
            }

            HostLog.Write($"site: ad list {hosts.Count} host(s) from {RelativePath}");
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            HostLog.Write(
                $"site: ad list unreadable at {path}: {error.Message}; the site view blocks nothing");
        }

        return hosts;
    }

    /// <summary>
    /// The host itself or any parent domain of it is on the list. Matching every
    /// parent is what makes <c>a-ads.com</c> cover <c>cdn.a-ads.com</c>; walking up
    /// from the full host is at most one lookup per label, so it costs the request
    /// path nothing worth measuring.
    /// </summary>
    public static bool Matches(HashSet<string> hosts, string host)
    {
        if (hosts.Count == 0 || host.Length == 0) return false;

        string candidate = host;
        while (true)
        {
            if (hosts.Contains(candidate)) return true;

            int dot = candidate.IndexOf('.');
            if (dot < 0) return false;
            candidate = candidate[(dot + 1)..];
        }
    }
}
