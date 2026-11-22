using System.IO.Compression;
using System.Security.Cryptography;
using System.Text.Json;

namespace WatchParty.Host;

/// <summary>
/// M7 (ADR-042): <c>npm run portable</c> embeds one zip under the resource name
/// <c>WatchParty.Payload.zip</c>; this class unpacks it once per version and
/// payload hash into <c>&lt;the exe's own folder&gt;\runtime\&lt;version&gt;-&lt;hash8&gt;\</c>
/// and hands that folder back as the program root. A build without the resource
/// (every developer build) never reaches this class, so the walk-up for
/// <c>package.json</c> and the <c>PATH</c> lookup for node are unchanged.
///
/// ADR-043: the whole app is the folder the exe sits in - the payload, the
/// browser profile and the host log all live there, and nothing is written under
/// <c>%LOCALAPPDATA%</c> or <c>%APPDATA%</c>.
///
/// The folder is written under a <c>.tmp-&lt;pid&gt;</c> name and renamed when the
/// last file is in place; the stamp file is written last of all, so a crash or a
/// second double-click during the write can never leave a folder that looks
/// finished (ADR-042, spec §Slice).
/// </summary>
internal static class Payload
{
    /// <summary>The one resource name the build script's csproj item assigns.</summary>
    public const string ResourceName = "WatchParty.Payload.zip";

    /// <summary>Written inside a runtime folder only once every payload file is in place.</summary>
    private const string StampFileName = "stamp";

    private static readonly Lazy<bool> PresentCheck = new(() =>
        typeof(Payload).Assembly
            .GetManifestResourceNames()
            .Contains(ResourceName, StringComparer.Ordinal));

    /// <summary>Whether the running executable carries the payload resource.</summary>
    public static bool IsPresent => PresentCheck.Value;

    /// <summary>
    /// What the one-time extraction did about the fixed engine (ADR-041/ADR-042): the
    /// <c>icacls</c> lines <see cref="WebView2Engine.ApplyWindows10Grants"/> produced, empty when
    /// no fixed runtime was unpacked or Windows 11 needed none. Extraction runs before the host
    /// log is open, so the lines are kept here and written by the window once it has one.
    /// </summary>
    public static IReadOnlyList<string> LastExtractionNotes { get; private set; } = Array.Empty<string>();

    /// <summary>
    /// The folder the running executable sits in: what "portable" means since
    /// ADR-043 - copy the folder and the state goes with it, delete it and
    /// nothing is left behind. <see cref="Environment.ProcessPath"/> is the exe
    /// itself in a single-file build; the base folder is the same folder for the
    /// host started from its own <c>bin</c>.
    /// </summary>
    public static string Folder
    {
        get
        {
            string? executable = Environment.ProcessPath;
            string folder = string.IsNullOrWhiteSpace(executable)
                ? AppContext.BaseDirectory
                : Path.GetDirectoryName(executable)!;
            return Path.GetFullPath(folder);
        }
    }

    /// <summary>Where every unpacked payload lives: <c>&lt;folder&gt;\runtime\</c>.</summary>
    public static string RuntimeBase => Path.Combine(Folder, "runtime");

    /// <summary>
    /// The engine's browser profile: <c>&lt;folder&gt;\profile</c>, one per folder
    /// (ADR-043). Not keyed by pid any more - a fresh key per run is what signed a
    /// returning host out of the site every evening.
    /// </summary>
    public static string ProfileFolder => Path.Combine(Folder, "profile");

    /// <summary>
    /// Thrown when the folder the exe sits in cannot be written: <c>Program Files</c>
    /// or a read-only stick. Carries the one plain sentence the window shows.
    /// </summary>
    public sealed class FolderNotWritableException(string folder, Exception cause)
        : Exception(
            $"Watch Party cannot write in the folder it was started from ({folder}). "
            + "Copy the program to a folder you can write in, such as one under your Documents folder, "
            + "and start it from there.",
            cause);

    /// <summary>
    /// Returns the folder holding the unpacked payload, extracting it first if this
    /// version-hash pair has no folder carrying a stamp yet.
    /// </summary>
    public static string ExtractOnce()
    {
        // ADR-043: the folder must be writable - a read-only stick is no longer a
        // goal. Probed before anything is unpacked, so a copy in Program Files says
        // one plain sentence instead of half-running.
        EnsureFolderWritable();

        using Stream resource = typeof(Payload).Assembly.GetManifestResourceStream(ResourceName)
            ?? throw new FileNotFoundException($"the executable carries no {ResourceName}");

        // The hash covers the zip itself, so a rebuilt exe of the same version
        // cannot run last build's payload (ADR-042).
        string hash8 = Convert.ToHexString(SHA256.HashData(resource)).ToLowerInvariant()[..8];
        resource.Position = 0;

        using ZipArchive zip = new(resource, ZipArchiveMode.Read);
        string version = ReadVersion(zip);
        string folder = Path.Combine(RuntimeBase, $"{version}-{hash8}");

        if (!File.Exists(Path.Combine(folder, StampFileName)))
        {
            Extract(zip, folder, version, hash8);
        }

        PruneOtherFolders(folder);
        return folder;
    }

    /// <summary>
    /// Proves the exe's folder accepts a new file: created next to the exe and
    /// removed at once, so a writable folder is left exactly as it was found.
    /// </summary>
    private static void EnsureFolderWritable()
    {
        string probe = Path.Combine(Folder, $".write-probe-{Environment.ProcessId}");
        try
        {
            using (File.Create(probe)) { }
            File.Delete(probe);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new FolderNotWritableException(Folder, error);
        }
    }

    private static void Extract(ZipArchive zip, string folder, string version, string hash8)
    {
        Directory.CreateDirectory(RuntimeBase);

        string temporary = $"{folder}.tmp-{Environment.ProcessId}";
        TryDeleteDirectory(temporary);
        Directory.CreateDirectory(temporary);
        // GetFullPath trims the payload's "./" prefixes and normalises separators;
        // the comparison below then refuses any entry that would land outside the
        // folder the payload is meant to own.
        string temporaryPrefix = Path.GetFullPath(temporary) + Path.DirectorySeparatorChar;

        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\'))
            {
                // A directory entry; the files below create it.
                Directory.CreateDirectory(Path.Combine(temporary, entry.FullName));
                continue;
            }

            string destination = Path.GetFullPath(Path.Combine(temporary, entry.FullName));
            if (!destination.StartsWith(temporaryPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidDataException($"payload entry outside the runtime folder: {entry.FullName}");
            }

            Directory.CreateDirectory(Path.GetDirectoryName(destination)!);
            entry.ExtractToFile(destination, true);
        }

        // Microsoft's rule for an unpackaged app on Windows 10 (ADR-042): the two grants go
        // on the fixed engine folder after it is unpacked and before anything can start the
        // engine. Windows 11 needs neither, and a payload without a fixed runtime has no
        // folder to grant. Still under the temporary name: the ACLs are on the directory, so
        // the rename below carries them.
        string? fixedEngine = WebView2Engine.FindFixed(temporary);
        if (fixedEngine is not null)
        {
            LastExtractionNotes = WebView2Engine.ApplyWindows10Grants(fixedEngine);
        }

        // Last of all, still under the temporary name: nothing can see a finished
        // folder until the rename below puts every file and the stamp there at once.
        File.WriteAllText(
            Path.Combine(temporary, StampFileName),
            $"{version} {hash8} unpacked {DateTimeOffset.Now:O}{Environment.NewLine}");

        try
        {
            Directory.Move(temporary, folder);
        }
        catch (IOException) when (File.Exists(Path.Combine(folder, StampFileName)))
        {
            // A second copy of the same exe finished its extraction first; its
            // folder is the same payload, so ours is thrown away.
            TryDeleteDirectory(temporary);
        }
    }

    /// <summary>
    /// Removes runtime folders that are not the one this run uses: a stale
    /// <c>.tmp-*</c> left by a crash, or another version-hash pair. Best effort -
    /// a folder still in use by another copy stays behind rather than failing the
    /// window (ADR-042).
    /// </summary>
    private static void PruneOtherFolders(string keep)
    {
        string keepFull = Path.GetFullPath(keep);
        try
        {
            foreach (string directory in Directory.EnumerateDirectories(RuntimeBase))
            {
                if (string.Equals(Path.GetFullPath(directory), keepFull, StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                TryDeleteDirectory(directory);
            }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // Pruning is housekeeping; it never takes the window down.
        }
    }

    private static void TryDeleteDirectory(string directory)
    {
        try
        {
            if (Directory.Exists(directory)) Directory.Delete(directory, true);
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            // In use by another copy, or not ours to remove.
        }
    }

    /// <summary>
    /// The payload's own <c>package.json</c> names the version: the build script
    /// copies it from the repository, and no other copy of the number exists in
    /// the exe.
    /// </summary>
    private static string ReadVersion(ZipArchive zip)
    {
        ZipArchiveEntry? entry = zip.Entries.FirstOrDefault(candidate =>
            string.Equals(candidate.FullName.TrimStart('.', '/', '\\'), "package.json", StringComparison.OrdinalIgnoreCase));
        if (entry is null) return "0.0.0";

        try
        {
            using Stream stream = entry.Open();
            using JsonDocument json = JsonDocument.Parse(stream);
            if (json.RootElement.TryGetProperty("version", out JsonElement version)
                && version.ValueKind == JsonValueKind.String
                && !string.IsNullOrWhiteSpace(version.GetString()))
            {
                return version.GetString()!;
            }
        }
        catch (JsonException)
        {
            // A payload without a readable version still runs; the hash keeps it unique.
        }

        return "0.0.0";
    }
}
