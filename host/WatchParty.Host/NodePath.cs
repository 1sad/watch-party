namespace WatchParty.Host;

/// <summary>
/// The sidecar is a Node process, so the host needs the full path of node.exe:
/// launching by bare name opens a console search that a windowed app cannot show.
/// A portable exe carries its own Node beside the payload's <c>package.json</c>
/// (ADR-042), so that copy is preferred over anything on this machine's PATH.
/// </summary>
internal static class NodePath
{
    public static string Resolve(string programRoot)
    {
        string? configured = Environment.GetEnvironmentVariable("WATCHPARTY_NODE");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
        }

        // The payload's node.exe sits at the program root, beside package.json;
        // it is chosen only when the executable carries the payload at all.
        if (Payload.IsPresent)
        {
            string bundled = Path.Combine(programRoot, "node.exe");
            if (File.Exists(bundled)) return bundled;
        }

        string? path = Environment.GetEnvironmentVariable("PATH");
        if (path is not null)
        {
            foreach (string entry in path.Split(Path.PathSeparator, StringSplitOptions.RemoveEmptyEntries))
            {
                foreach (string name in new[] { "node.exe", "node" })
                {
                    try
                    {
                        string candidate = Path.Combine(entry.Trim('"'), name);
                        if (File.Exists(candidate)) return candidate;
                    }
                    catch (ArgumentException)
                    {
                        // A malformed PATH entry is not a reason to fail; keep looking.
                    }
                }
            }
        }

        throw new FileNotFoundException("node was not found on PATH");
    }
}
