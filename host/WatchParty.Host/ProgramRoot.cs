namespace WatchParty.Host;

/// <summary>
/// Finds the folder that holds <c>package.json</c>: the sidecar's entry point and
/// the built page both live under it. Launched via <c>npm run dev</c> that folder
/// is the working directory, but a host started from its own <c>bin</c> folder
/// still has to find it, so the search walks up from the executable. A portable
/// exe (ADR-042) has no <c>package.json</c> above it at all: its program root is
/// the folder <see cref="Payload"/> unpacks from the resource it carries.
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

        // Packaged only: a developer build carries no payload resource (M7, ADR-042).
        if (Payload.IsPresent)
        {
            return Payload.ExtractOnce();
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
