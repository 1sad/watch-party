using System.Diagnostics;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WatchParty.Host;

/// <summary>
/// The window: one WebView2 control filling it, the request filter, and the
/// sidecar's lifetime in both directions. It holds no room state and imports
/// nothing from the sidecar's product code (ADR-034).
/// </summary>
public sealed class MainForm : Form
{
    // TEMPORARY (T1): the dev page requests https://blocked.invalid/p.png, which
    // gives the filter something to cancel until T30 owns the real list.
    private static readonly string[] BlockedHosts = ["blocked.invalid"];

    private readonly WebView2 _page = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer _portTimeout = new() { Interval = 20_000 };

    // Command-line arguments, untouched: when the app was opened from a clicked
    // invite link, one of them is that link (T2b).
    private readonly string[] _launchArgs;

    private Process? _sidecar;
    private string _root = string.Empty;
    private bool _closing;
    private bool _navigated;

    public MainForm(string[]? launchArgs)
    {
        _launchArgs = launchArgs ?? [];

        Text = "Watch Party";
        ClientSize = new Size(1100, 720);
        MinimumSize = new Size(640, 420);
        StartPosition = FormStartPosition.CenterScreen;
        Controls.Add(_page);

        Load += OnLoad;
        FormClosed += OnFormClosed;
        _portTimeout.Tick += OnPortTimeout;
    }

    private async void OnLoad(object? sender, EventArgs e)
    {
        try
        {
            _root = ProgramRoot.Find();
            HostLog.Open(_root);
        }
        catch (Exception error)
        {
            ShowFailure("Watch Party could not find its own program folder.");
            HostLog.Write($"startup: {error.Message}");
            return;
        }

        HostLog.Write($"host started; program folder {_root}");

        // One registry key, for this user only; failure is a log line, never a
        // dialog and never a reason to stop (T2b item 3).
        if (ProtocolRegistration.TryRegister(out string command))
        {
            HostLog.Write($"watchparty:// registered for this user: {command}");
        }
        else
        {
            HostLog.Write($"watchparty:// registration failed: {command}. A clicked invite link will not open "
                + "Watch Party; pasting the link into the join box still works.");
        }

        try
        {
            await _page.EnsureCoreWebView2Async();
        }
        catch (Exception error)
        {
            HostLog.Write($"webview2 unavailable: {error}");
            ShowFailure("Watch Party cannot open its browser window. The WebView2 runtime is missing or blocked.");
            return;
        }

        InstallRequestFilter();
        _page.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
        StartSidecar();
        _portTimeout.Start();
    }

    private void InstallRequestFilter()
    {
        CoreWebView2 core = _page.CoreWebView2;

        // The three-argument form: the two-argument one is documented not to
        // behave as expected for iframes, and cross-origin player frames are the
        // normal case (ADR-034).
        core.AddWebResourceRequestedFilter(
            "*",
            CoreWebView2WebResourceContext.All,
            CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += OnWebResourceRequested;

        HostLog.Write($"request filter installed; temporary list has {BlockedHosts.Length} host(s)");
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        string uri = e.Request.Uri;
        if (!IsBlocked(uri)) return;

        // An empty 403 replaces the response, which cancels the request: the page
        // never receives bytes from the blocked host.
        e.Response = _page.CoreWebView2.Environment.CreateWebResourceResponse(
            new MemoryStream(Array.Empty<byte>()), 403, "Blocked", "Content-Type: text/plain");
        HostLog.Write($"blocked {uri}");
    }

    /// <summary>Matches a request URL's host against the temporary block list.</summary>
    internal static bool IsBlocked(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return false;

        foreach (string host in BlockedHosts)
        {
            if (string.Equals(parsed.Host, host, StringComparison.OrdinalIgnoreCase)) return true;
        }

        return false;
    }

    private void StartSidecar()
    {
        ProcessStartInfo start;
        try
        {
            start = new ProcessStartInfo(NodePath.Resolve())
            {
                WorkingDirectory = _root,
                UseShellExecute = false,
                CreateNoWindow = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
            };
        }
        catch (Exception error)
        {
            HostLog.Write($"sidecar: {error.Message}");
            ShowFailure("Watch Party could not start: Node was not found on this machine.");
            return;
        }

        start.ArgumentList.Add("src/server/main.ts");

        Process sidecar = new() { StartInfo = start, EnableRaisingEvents = true };
        sidecar.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            HostLog.Write($"sidecar: {line.Data}");
            if (PortLine.TryParse(line.Data, out int port))
            {
                BeginInvoke(() => OnPortParsed(port));
            }
        };
        sidecar.ErrorDataReceived += (_, line) =>
        {
            if (line.Data is not null) HostLog.Write($"sidecar error: {line.Data}");
        };
        sidecar.Exited += (_, _) => BeginInvoke(OnSidecarExited);

        _sidecar = sidecar;

        try
        {
            sidecar.Start();
            sidecar.BeginOutputReadLine();
            sidecar.BeginErrorReadLine();
            HostLog.Write($"sidecar started, pid {sidecar.Id}");
        }
        catch (Exception error)
        {
            HostLog.Write($"sidecar failed to start: {error.Message}");
            _sidecar = null;
            ShowFailure("Watch Party's room process did not start.");
        }
    }

    private void OnPortParsed(int port)
    {
        if (_closing || _navigated) return;

        _portTimeout.Stop();
        // The page's own URL, plus `?join=` carrying the launched link whole and
        // encoded. This line is the record of where the window went (T2b check 2).
        string url = LaunchLink.PageUrl($"http://127.0.0.1:{port}/", _launchArgs);
        HostLog.Write($"parsed sidecar PORT {port}; navigating to {url}");
        _navigated = true;
        _page.CoreWebView2.Navigate(url);
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        HostLog.Write(
            $"navigation completed {_page.CoreWebView2.Source} success={e.IsSuccess} " +
            $"status={e.HttpStatusCode} error={e.WebErrorStatus}");
    }

    private void OnSidecarExited()
    {
        int code = -1;
        try
        {
            if (_sidecar is not null) code = _sidecar.ExitCode;
        }
        catch (InvalidOperationException)
        {
            // Already disposed; the code is a detail, not the point.
        }

        HostLog.Write($"sidecar exited with code {code}");
        _sidecar = null;

        if (_closing) return;

        _portTimeout.Stop();
        ShowFailure("Watch Party's room process stopped, so this page is no longer connected. "
            + "Close the window and start Watch Party again.");
    }

    private void OnPortTimeout(object? sender, EventArgs e)
    {
        _portTimeout.Stop();
        HostLog.Write("sidecar did not report a port within 20 s");
        ShowFailure("Watch Party's room process did not report a port, so there is no page to show.");
    }

    private void ShowFailure(string sentence)
    {
        HostLog.Write($"failure page: {sentence}");

        if (_page.CoreWebView2 is null)
        {
            Text = sentence;
            return;
        }

        string html =
            "<!doctype html><html><head><meta charset=\"utf-8\"><title>Watch Party</title></head>"
            + "<body style=\"margin:0;padding:3rem;background:#14151a;color:#e9e9ef;"
            + "font:1.15rem 'Segoe UI',system-ui,sans-serif\">"
            + $"<p>{System.Net.WebUtility.HtmlEncode(sentence)}</p></body></html>";
        _page.CoreWebView2.NavigateToString(html);
    }

    private void OnFormClosed(object? sender, FormClosedEventArgs e)
    {
        _closing = true;
        _portTimeout.Stop();
        StopSidecar();
    }

    private void StopSidecar()
    {
        Process? sidecar = _sidecar;
        _sidecar = null;
        if (sidecar is null) return;

        try
        {
            if (!sidecar.HasExited)
            {
                HostLog.Write($"closing: killing sidecar pid {sidecar.Id}");
                sidecar.Kill(entireProcessTree: true);
                sidecar.WaitForExit(5_000);
            }
        }
        catch (Exception error)
        {
            HostLog.Write($"closing: could not kill the sidecar: {error.Message}");
        }
        finally
        {
            sidecar.Dispose();
        }
    }
}
