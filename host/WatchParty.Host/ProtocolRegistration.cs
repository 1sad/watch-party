using Microsoft.Win32;

namespace WatchParty.Host;

/// <summary>
/// Makes a clicked <c>watchparty://</c> link open this app, for the person who
/// is running it and nobody else: one key under <c>HKCU</c>, no installer, no
/// elevation, nothing to configure (ADR-023, <c>spec.md</c> §12).
///
/// Written on every start rather than only the first, so the recorded command
/// corrects itself when the executable moves and a second run leaves exactly one
/// command value (T2b item 1).
/// </summary>
internal static class ProtocolRegistration
{
    private const string KeyPath = @"Software\Classes\watchparty";
    private const string CommandKeyPath = @"Software\Classes\watchparty\shell\open\command";

    /// <summary>
    /// <c>"&lt;exe&gt;" "%1"</c>: Windows substitutes the whole link for
    /// <c>%1</c>, quoted, because a URL is one argument (T2b item 2).
    /// </summary>
    public static string CommandFor(string executablePath) => $"\"{executablePath}\" \"%1\"";

    /// <summary>
    /// Registers the scheme and reports what was written. Never throws and never
    /// retries: a locked-down registry has to leave a working app behind, so the
    /// caller logs one line and carries on (T2b item 3).
    /// </summary>
    public static bool TryRegister(out string detail)
    {
        try
        {
            string command = CommandFor(Application.ExecutablePath);

            using (RegistryKey scheme = Registry.CurrentUser.CreateSubKey(KeyPath, writable: true)
                ?? throw new InvalidOperationException($@"HKCU\{KeyPath} could not be opened for writing"))
            {
                // The description Explorer shows, and the value that makes Windows
                // treat the scheme as a protocol rather than a file type.
                scheme.SetValue(null, "URL:Watch Party invite link", RegistryValueKind.String);
                scheme.SetValue("URL Protocol", string.Empty, RegistryValueKind.String);
            }

            using (RegistryKey open = Registry.CurrentUser.CreateSubKey(CommandKeyPath, writable: true)
                ?? throw new InvalidOperationException($@"HKCU\{CommandKeyPath} could not be opened for writing"))
            {
                open.SetValue(null, command, RegistryValueKind.String);
            }

            detail = command;
            return true;
        }
        catch (Exception error)
        {
            // One line's worth of reason; the window keeps going (T2b item 3).
            detail = error.Message.TrimEnd(' ', '.');
            return false;
        }
    }
}
