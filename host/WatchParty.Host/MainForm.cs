using System.Diagnostics;
using System.Text.Json;
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

    /// <summary>
    /// §14's autoplay grant, and the one Debug switch that withholds it so the
    /// "click to join playback" overlay can be seen and tested. A released
    /// build has no switch and always grants.
    /// </summary>
#if DEBUG
    private static readonly bool AutoplayGranted =
        Environment.GetEnvironmentVariable("WATCHPARTY_AUTOPLAY_GRANT") != "off";
#else
    private const bool AutoplayGranted = true;
#endif

    private readonly WebView2 _page = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer _portTimeout = new() { Interval = 20_000 };

    // Command-line arguments, untouched: when the app was opened from a clicked
    // invite link, one of them is that link (T2b).
    private readonly string[] _launchArgs;

    private Process? _sidecar;
    private string _root = string.Empty;
    private bool _closing;
    private bool _navigated;
    /// <summary>T9a2: one dialog at a time, and the file it last returned.</summary>
    private bool _pickOpen;
    private string? _pickedPath;
#if DEBUG
    /// <summary>
    /// T8d: whether this window is the measuring one — the window <c>dev:debug</c>
    /// opened, which is also the one that loads the development page. Only that
    /// page has the dev log lines to forward, so only that window asks for them.
    /// </summary>
    private bool _measuring;

    /// <summary>
    /// E10: the address this window opens <em>instead of</em> the app page, when
    /// <c>WATCHPARTY_SPIKE_URL</c> names one. Null in every normal run, which is
    /// what keeps the spike unreachable: no variable, no injection, no hand-off.
    /// </summary>
    private string? _spikeUrl;
#endif

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
            await EnsurePageAsync();
        }
        catch (Exception error)
        {
            HostLog.Write($"webview2 unavailable: {error}");
            ShowFailure("Watch Party cannot open its browser window. The WebView2 runtime is missing or blocked.");
            return;
        }

        InstallRequestFilter();
        InstallAutoplayGrant();
        InstallFilePicker();
#if DEBUG
        InstallPageConsole();
        await InstallSpikeAsync();
#endif
        _page.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
        StartSidecar();
        _portTimeout.Start();
    }

    /// <summary>
    /// The window's one WebView2 control, created with the environment §14 needs
    /// — and, in a Debug build only, a loopback CDP port so the checks that need
    /// to read the page (the applied position, `paused`, the overlay) do not need
    /// a person clicking. The environment variable is what arms it.
    /// </summary>
    private async Task EnsurePageAsync()
    {
        // §14's grant. ADR-034 names `PermissionRequested` as the Autoplay
        // lever, but the engine only raises that request in a policy mode it
        // does not use by default — measured on WebView2 157: with the default
        // policy the event never fired and `play()` was refused.
        // `no-user-gesture-required` is the mode in which §14's "no click" is
        // true; the handler below stays installed as the ADR's lever, for any
        // engine that does ask.
        string autoplayPolicy =
            AutoplayGranted ? "--autoplay-policy=no-user-gesture-required" : string.Empty;
#if DEBUG
        string? debugPort = Environment.GetEnvironmentVariable("WATCHPARTY_CDP_PORT");
        if (debugPort is not null)
        {
            _measuring = true;
            HostLog.Write($"dev: remote debugging on 127.0.0.1:{debugPort} (Debug build only)");
            // Its own profile: WebView2 refuses a second controller in the
            // browser process another window already owns (0x8007139F), and
            // two windows on one debugging port could not be told apart.
            string userData = Path.Combine(Path.GetTempPath(), $"watchparty-dev-{debugPort}");
            CoreWebView2Environment debugEnvironment = await CoreWebView2Environment.CreateAsync(
                null, userData,
                new CoreWebView2EnvironmentOptions(
                    $"{autoplayPolicy} --remote-debugging-port={debugPort}".Trim()));
            await _page.EnsureCoreWebView2Async(debugEnvironment);
            return;
        }
#endif
        CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
            null, null, new CoreWebView2EnvironmentOptions(autoplayPolicy));
        await _page.EnsureCoreWebView2Async(environment);
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

        // T9a2: the page measuring the file it just picked. Only the one path the
        // dialog returned, and only while the measurement is in flight.
        if (Uri.TryCreate(uri, UriKind.Absolute, out Uri? probe)
            && string.Equals(probe.Host, FilePick.MediaHost, StringComparison.OrdinalIgnoreCase))
        {
            e.Response = ProbeResponse(probe);
            return;
        }

        if (!IsBlocked(uri)) return;

        // An empty 403 replaces the response, which cancels the request: the page
        // never receives bytes from the blocked host.
        e.Response = _page.CoreWebView2.Environment.CreateWebResourceResponse(
            new MemoryStream(Array.Empty<byte>()), 403, "Blocked", "Content-Type: text/plain");
        HostLog.Write($"blocked {uri}");
    }

    /// <summary>
    /// §14: a scheduled start must not be refused by the autoplay policy, so the
    /// window grants the page the <c>Autoplay</c> permission before it loads
    /// (ADR-034 names <c>PermissionRequested</c> as the lever; the request filter
    /// above stays in its three-argument form, which is a different event).
    ///
    /// The switch that withholds the grant exists only in this Debug build — the
    /// one <c>npm run dev</c> runs — so a shipped window has no way to be talked
    /// out of granting it. With it off, the page's own §14 overlay is what has to
    /// appear, which is how the overlay is tested at all.
    /// </summary>
    private void InstallAutoplayGrant()
    {
        bool grant = AutoplayGranted;
        _page.CoreWebView2.PermissionRequested += (_, e) =>
        {
            if (e.PermissionKind != CoreWebView2PermissionKind.Autoplay) return;

            // Not handled would mean a prompt this window has no way to show.
            e.Handled = true;
            // Not remembered: a profile that saved "allow" would keep autoplay
            // on even when this build was started with the grant disabled.
            e.SavesInProfile = false;
            e.State = grant ? CoreWebView2PermissionState.Allow : CoreWebView2PermissionState.Deny;
            HostLog.Write(
                $"autoplay permission for {e.Uri}: {(grant ? "allowed" : "denied (dev switch)")}");
        };
        HostLog.Write($"autoplay permission handler installed; grant={grant}");
    }

    /// <summary>
    /// T9a2's bridge. The page asks for a file, the host opens the native dialog
    /// (ADR-034), and then serves that one file to the page so it can wait for
    /// <c>loadedmetadata</c> before the room hears anything. Three messages in,
    /// and only the page ever initiates.
    /// </summary>
    private void InstallFilePicker()
    {
        _page.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
        HostLog.Write("file picker bridge installed");
    }

#if DEBUG
    /// <summary>
    /// T8d: the page's own console, into this window's own log file. A live check
    /// reads a window's timing numbers from its log, not by wrapping
    /// <c>console.info</c> in the page through the DevTools endpoint.
    ///
    /// The engine's <c>Runtime.consoleAPICalled</c> event is the source, through
    /// <c>GetDevToolsProtocolEventReceiver</c>: nothing is injected into the page,
    /// so the line in the log is the line the page printed. <c>Runtime.enable</c>
    /// is what makes the engine send those events at all, and it needs no
    /// debugging port — the port only decides whether a shell may drive the
    /// window.
    ///
    /// Armed only for the measuring window. The page's dev log lines are compiled
    /// out of the production page, and <c>npm run dev</c> opens that page, so the
    /// normal run has no page lines either way; this switch keeps the ordinary
    /// window's log free of console noise as well.
    ///
    /// The ordering rule the integration suite depends on is untouched: this
    /// writes nothing of its own but one host line after the picker's, and a page
    /// line can only arrive once a document exists — long after the sidecar's
    /// <c>PORT</c> line, which is the first line of the sidecar's stdout.
    /// </summary>
    private void InstallPageConsole()
    {
        if (!_measuring) return;

        try
        {
            CoreWebView2DevToolsProtocolEventReceiver receiver =
                _page.CoreWebView2.GetDevToolsProtocolEventReceiver("Runtime.consoleAPICalled");
            receiver.DevToolsProtocolEventReceived += OnPageConsoleMessage;
            // Not awaited: the window must not wait on the engine to open, and
            // the first line in this log is what proves it worked. A fault here
            // is a page whose console is missing, not a window that dies.
            _ = _page.CoreWebView2.CallDevToolsProtocolMethodAsync("Runtime.enable", "{}");
            HostLog.Write("page console forwarded into this log (Debug build only)");
        }
        catch (Exception error)
        {
            // Logging must never take the window down: without forwarding, the
            // window still plays and the debug endpoint still answers.
            HostLog.Write($"page console not forwarded: {error.Message}");
        }
    }

    /// <summary>
    /// One page console call. <c>page:</c> in front, and the level's own name when
    /// it is one worth noticing (<c>page error:</c>), so a reader can tell a page
    /// line from a <c>sidecar:</c> line at a glance.
    /// </summary>
    private void OnPageConsoleMessage(object? sender, CoreWebView2DevToolsProtocolEventReceivedEventArgs e)
    {
        string level;
        string text;
        try
        {
            using JsonDocument payload = JsonDocument.Parse(e.ParameterObjectAsJson);
            JsonElement root = payload.RootElement;
            level = root.TryGetProperty("type", out JsonElement type) && type.ValueKind == JsonValueKind.String
                ? type.GetString() ?? "log"
                : "log";
            text = root.TryGetProperty("args", out JsonElement args) && args.ValueKind == JsonValueKind.Array
                ? string.Join(" ", args.EnumerateArray().Select(ConsoleArgumentText))
                : string.Empty;
        }
        catch (JsonException)
        {
            // Not a console event we can read: nothing to log.
            return;
        }

        string marker = level is "log" or "info" or "debug" ? "page" : $"page {level}";
        HostLog.Write($"{marker}: {text}");
    }

    /// <summary>One console argument as text, the way the console shows it.</summary>
    private static string ConsoleArgumentText(JsonElement argument)
    {
        if (argument.ValueKind != JsonValueKind.Object) return argument.GetRawText();

        if (argument.TryGetProperty("value", out JsonElement value))
        {
            return value.ValueKind == JsonValueKind.String
                ? value.GetString() ?? string.Empty
                : value.GetRawText();
        }

        if (argument.TryGetProperty("unserializableValue", out JsonElement special))
        {
            return special.GetString() ?? string.Empty;
        }

        if (argument.TryGetProperty("description", out JsonElement description))
        {
            return description.GetString() ?? string.Empty;
        }

        return string.Empty;
    }

    /// <summary>
    /// E10: the one Debug-only hand-off. With <c>WATCHPARTY_SPIKE_URL</c> unset
    /// this returns before it reads the probe, so a normal run — Debug or not —
    /// never injects a script and never navigates anywhere but the app page.
    ///
    /// The probe is registered before the first navigation, which is the order
    /// the engine requires: the documentation says an added script applies to
    /// "all future top level document and child frame navigations". Whether it
    /// really reaches a cross-origin child frame is what the spike measures.
    /// </summary>
    private async Task InstallSpikeAsync()
    {
        string? url = Environment.GetEnvironmentVariable("WATCHPARTY_SPIKE_URL");
        if (string.IsNullOrWhiteSpace(url)) return;

        try
        {
            string probe = ReadSpikeProbe();
            await _page.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(probe);
            // The engine's own documentation says `CoreWebView2.WebMessageReceived`
            // is raised for the top-level document, and that an iframe's message
            // arrives on that frame's event instead. Subscribing here is what
            // lets a cross-origin player frame be heard at all; a frame that
            // already existed would be missed, and before the first navigation
            // there is none.
            _page.CoreWebView2.FrameCreated += OnSpikeFrameCreated;
            _spikeUrl = url;
            HostLog.Write($"spike: probe registered for every document; the window will open {url}");
        }
        catch (Exception error)
        {
            // A broken spike is a log line, not a window that fails to open.
            HostLog.Write($"spike: probe not registered: {error.Message}");
        }
    }

    /// <summary>One frame's message, on that frame's own event (see InstallSpikeAsync).</summary>
    private void OnSpikeFrameCreated(object? sender, CoreWebView2FrameCreatedEventArgs e)
    {
        CoreWebView2Frame frame = e.Frame;
        frame.WebMessageReceived += LogSpikeMessage;
        HostLog.Write($"spike: child frame created, name=\"{frame.Name}\"");
    }

    /// <summary>The probe's text, embedded in this host (WatchParty.Host.csproj).</summary>
    private static string ReadSpikeProbe()
    {
        using Stream? stream = typeof(MainForm).Assembly
            .GetManifestResourceStream("WatchParty.Host.spike.probe.js");
        if (stream is null) throw new InvalidOperationException("the spike probe is not embedded in this host");
        using StreamReader reader = new(stream);
        return reader.ReadToEnd();
    }

    /// <summary>
    /// One spike message, as one <c>site:</c> line: the frame's URL from
    /// <c>e.Source</c> (the whole point of the spike), then every field the probe
    /// sent, written as it arrived.
    /// </summary>
    private static void LogSpikeMessage(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string fields;
        try
        {
            using JsonDocument payload = JsonDocument.Parse(e.WebMessageAsJson);
            fields = string.Join(" ", SpikeFields.Select(
                name => $"{name}={SpikeFieldText(payload.RootElement, name)}"));
        }
        catch (JsonException)
        {
            fields = "unreadable payload";
        }

        HostLog.Write($"site: source={e.Source} {fields}");
    }

    private static readonly string[] SpikeFields = ["href", "count", "w", "h", "readyState", "duration", "t"];

    private static string SpikeFieldText(JsonElement root, string name)
    {
        if (!root.TryGetProperty(name, out JsonElement value)) return "-";
        return value.ValueKind switch
        {
            JsonValueKind.Null or JsonValueKind.Undefined => "-",
            JsonValueKind.String => value.GetString() ?? "-",
            _ => value.GetRawText(),
        };
    }
#endif

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? kind = null;
        string? contentType = null;
        try
        {
            using JsonDocument message = JsonDocument.Parse(e.WebMessageAsJson);
            if (message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("kind", out JsonElement value)
                && value.ValueKind == JsonValueKind.String)
            {
                kind = value.GetString();
            }

            if (message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("type", out JsonElement type)
                && type.ValueKind == JsonValueKind.String)
            {
                contentType = type.GetString();
            }
        }
        catch (JsonException)
        {
            // Not one of ours: ignored, the same rule §5 keeps for unknown frames.
        }

        switch (kind)
        {
            case "pick":
                AskForFile();
                break;
            case "probe":
                OfferProbe(contentType);
                break;
            case "probeDone":
                ConcealPickedFile();
                break;
#if DEBUG
            case "spike":
                LogSpikeMessage(null, e);
                break;
#endif
        }
    }

    private void AskForFile()
    {
        if (_pickOpen) return;
        _pickOpen = true;
        try
        {
            string? path = FilePick.Choose(this);
            if (path is null)
            {
                PostToPage(new { kind = "cancelled" });
                return;
            }

            // The path is remembered here, and only here: the page asks to
            // measure "the picked file", never names a path of its own.
            _pickedPath = path;
            PostToPage(new { kind = "picked", path });
        }
        finally
        {
            _pickOpen = false;
        }
    }

    private void OfferProbe(string? contentType)
    {
        if (_pickedPath is null || !File.Exists(_pickedPath) || string.IsNullOrEmpty(contentType))
        {
            PostToPage(new { kind = "failed", sentence = "The app could not read the file it chose." });
            return;
        }

        PostToPage(new { kind = "probeReady", url = FilePick.ProbeUrl(contentType) });
    }

    private void ConcealPickedFile()
    {
        _pickedPath = null;
    }

    /// <summary>
    /// The picked file's bytes, for the page's one measurement. A whole response
    /// rather than a folder mapping: the mapping's documentation says a page that
    /// is already loaded may not see it without a reload, and a reload would lose
    /// the room this window is in.
    /// </summary>
    private CoreWebView2WebResourceResponse ProbeResponse(Uri uri)
    {
        CoreWebView2Environment environment = _page.CoreWebView2.Environment;
        string? path = _pickedPath;

        if (path is null || !File.Exists(path))
        {
            return environment.CreateWebResourceResponse(
                new MemoryStream(), 404, "Not Found", "Content-Type: text/plain");
        }

        string contentType = FilePick.ProbeContentType(uri);
        try
        {
            // A read-only stream: the engine reads as much as it wants and lets
            // go; the sidecar serves the room from the same file later (T9a3).
            FileStream content = new(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite);
            HostLog.Write($"pick: serving {path} to the page as {contentType}, {content.Length} bytes");
            return environment.CreateWebResourceResponse(
                content,
                200,
                "OK",
                $"Content-Type: {contentType}\r\nContent-Length: {content.Length}\r\nAccept-Ranges: none");
        }
        catch (Exception error)
        {
            HostLog.Write($"pick: could not read {path}: {error.Message}");
            return environment.CreateWebResourceResponse(
                new MemoryStream(), 500, "Unreadable", "Content-Type: text/plain");
        }
    }

    private void PostToPage(object message)
    {
        _page.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(message));
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
#if DEBUG
        // E10: the spike window replaces the app page rather than adding a
        // second one; with the variable unset `_spikeUrl` is null and nothing
        // below changes.
        if (_spikeUrl is not null)
        {
            url = _spikeUrl;
            HostLog.Write($"spike: navigating to {url} instead of the app page");
        }
        else
        {
            HostLog.Write($"parsed sidecar PORT {port}; navigating to {url}");
        }
#else
        HostLog.Write($"parsed sidecar PORT {port}; navigating to {url}");
#endif
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
