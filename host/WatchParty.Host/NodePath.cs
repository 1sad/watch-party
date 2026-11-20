namespace WatchParty.Host;

/// <summary>
/// The sidecar is a Node process, so the host needs the full path of node.exe:
/// launching by bare name opens a console search that a windowed app cannot show.
/// </summary>
internal static class NodePath
{
    public static string Resolve()
    {
        string? configured = Environment.GetEnvironmentVariable("WATCHPARTY_NODE");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
        {
            return configured;
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
