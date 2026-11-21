using Microsoft.Web.WebView2.Core;

namespace WatchParty.Host;

/// <summary>
/// T9a2's native half: the owner's file dialog, and the URL the page uses to
/// load the one chosen file once. The host decides nothing about file types —
/// the extension check is the page's judgement and the sidecar's map (ADR-035),
/// never a second copy here.
/// </summary>
internal static class FilePick
{
    /// <summary>
    /// The name the page asks for the picked file on. It is not an address on
    /// the network: <see cref="MainForm"/> answers it from the picked file and
    /// nothing else, in this window's engine only.
    /// </summary>
    public const string MediaHost = "watchparty-media.local";

    /// <summary>Which path in a Debug queue the next pick takes (T9a2's checks).</summary>
    private static int _devPick;

    /// <summary>
    /// The path the dialog returned, or <c>null</c> when it was cancelled. A
    /// Debug build can answer from <c>WATCHPARTY_PICK_PATHS</c> instead — paths
    /// separated by <c>|</c>, one per pick, the last repeating — which is how a
    /// shell drives this ticket's flow without a mouse. The dialog is the only
    /// part skipped, and a released window has no such switch.
    /// </summary>
    public static string? Choose(IWin32Window owner)
    {
#if DEBUG
        string[] seeded = (Environment.GetEnvironmentVariable("WATCHPARTY_PICK_PATHS") ?? string.Empty)
            .Split('|', StringSplitOptions.RemoveEmptyEntries);
        if (seeded.Length > 0)
        {
            string seededPath = seeded[Math.Min(_devPick, seeded.Length - 1)];
            _devPick += 1;
            HostLog.Write($"pick: dev switch, dialog skipped, path {seededPath}");
            return seededPath;
        }
#endif
        HostLog.Write("pick: opening the Windows file dialog");
        // No filter: a host-side filter would be a second, quieter answer to
        // "can the app play this?", and the page is the one that must say.
        using OpenFileDialog dialog = new()
        {
            Title = "Open a file for the room",
            CheckFileExists = true,
            Multiselect = false,
        };
        DialogResult answer = dialog.ShowDialog(owner);
        HostLog.Write($"pick: dialog closed with {answer}, file {dialog.FileName}");
        return answer == DialogResult.OK ? dialog.FileName : null;
    }

    /// <summary>
    /// The URL the page's <c>&lt;video&gt;</c> loads to measure the file. The
    /// content type travels with it because the page already decided it from
    /// ADR-035's four, and the host must not hold a second copy of that map.
    /// </summary>
    public static string ProbeUrl(string contentType)
    {
        return $"https://{MediaHost}/picked?type={Uri.EscapeDataString(contentType)}";
    }

    /// <summary>The <c>type</c> the page put in <see cref="ProbeUrl"/>, or a type nothing plays.</summary>
    public static string ProbeContentType(Uri uri)
    {
        const string Prefix = "type=";
        string query = uri.Query.TrimStart('?');
        foreach (string part in query.Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            if (part.StartsWith(Prefix, StringComparison.Ordinal))
            {
                string value = Uri.UnescapeDataString(part[Prefix.Length..]);
                if (value.Length > 0) return value;
            }
        }

        return "application/octet-stream";
    }
}
