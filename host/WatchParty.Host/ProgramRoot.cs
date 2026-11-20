namespace WatchParty.Host;

/// <summary>
/// Finds the folder that holds <c>package.json</c>: the sidecar's entry point and
/// the built page both live under it. Launched via <c>npm run dev</c> that folder
/// is the working directory, but a host started from its own <c>bin</c> folder
/// still has to find it, so the search walks up from the executable.
/// </summary>
internal static class ProgramRoot
{
    public static string Find()
    {
        string? configured = Environment.GetEnvironmentVariable("WATCHPARTY_ROOT");
        if (!string.IsNullOrWhiteSpace(configured) && File.Exists(Path.Combine(configured, "package.json")))
        {
            return Path.GetFullPath(configured);
        }

        DirectoryInfo? directory = new(AppContext.BaseDirectory);
        for (int depth = 0; depth < 8 && directory is not null; depth++)
        {
            if (File.Exists(Path.Combine(directory.FullName, "package.json")))
            {
                return directory.FullName;
            }

            directory = directory.Parent;
        }

        throw new DirectoryNotFoundException(
            $"no package.json above {AppContext.BaseDirectory}");
    }
}
