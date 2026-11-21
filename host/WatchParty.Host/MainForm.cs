using System.Diagnostics;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WatchParty.Host;

/// <summary>
/// The window: two WebView2 controls — our page as a fixed sidebar on the right,
/// the site filling the lower left — the request filter, and the sidecar's
/// lifetime in both directions. It holds no room state and imports nothing from
/// the sidecar's product code (ADR-034, ADR-038).
/// </summary>
public sealed class MainForm : Form
{
    // TEMPORARY (T1): the dev page requests https://blocked.invalid/p.png, which
    // gives the filter something to cancel until T30 owns the real list.
    private static readonly string[] BlockedHosts = ["blocked.invalid"];

#if DEBUG
    /// <summary>
    /// E10's filter evidence, and only that: while <c>WATCHPARTY_SPIKE_URL</c> is
    /// set the filter also cancels one host the spike's page really requests, so
    /// "the filter sees a site it did not serve" is a measured number rather than
    /// a claim about <c>blocked.invalid</c>, which no real site asks for. Compiled
    /// out of the shipped build and inert with the variable unset, so the
    /// temporary list above is still the only one a normal window uses; T30 owns
    /// the real list.
    ///
    /// The host is the ad script `animex.one` loads (`/script/aclib.js`), read
    /// from that page's own HTML on 2026-11-21.
    /// </summary>
    private static readonly bool SpikeFilterArmed =
        !string.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable("WATCHPARTY_SPIKE_URL"));

    private static readonly string[] SpikeBlockedHosts = ["acscdn.com"];
#endif

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

    /// <summary>
    /// ADR-038's layout, in pixels: the sidebar is a fixed width so a resize
    /// never reflows the site, and the top strip is the height the host reserves.
    /// The strip's contents are our page's own, drawn inside the app view (03b);
    /// the strip over the site is empty until then.
    /// </summary>
    private const int SidebarWidth = 380;
    private const int TopStripHeight = 48;

    private readonly WebView2 _page = new() { Dock = DockStyle.Fill };
    private readonly WebView2 _site = new() { Dock = DockStyle.Fill };
    private readonly Panel _siteColumn = new() { Dock = DockStyle.Fill };
    private readonly Panel _topStrip = new() { Dock = DockStyle.Top };
    private readonly System.Windows.Forms.Timer _portTimeout = new() { Interval = 20_000 };

    // Command-line arguments, untouched: when the app was opened from a clicked
    // invite link, one of them is that link (T2b).
    private readonly string[] _launchArgs;

    private Process? _sidecar;
    private string _root = string.Empty;
    private bool _closing;
    private bool _navigated;
    /// <summary>
    /// The port the sidecar reported, which together with <c>127.0.0.1</c> is the
    /// only origin the app view may navigate to (ADR-038). Null until the PORT
    /// line arrives, which is before the app view's first navigation.
    /// </summary>
    private int? _appPort;
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
    /// E10: the address the measuring build's <em>site view</em> opens, when
    /// <c>WATCHPARTY_SPIKE_URL</c> names one — it stands in for "the room has a
    /// page" until 03 sets a real one. Null in every normal run, which is what
    /// keeps the spike unreachable, and leaves the window in file mode.
    /// </summary>
    private string? _spikeUrl;

    /// <summary>
    /// E10's return half: every child frame the engine has created, so a command
    /// arrives on one as a web message (<c>CoreWebView2.WebMessageReceived</c>
    /// never sees a frame's message, and <c>CoreWebView2Frame</c> is the only
    /// handle that posts back). Only frames created while the spike is armed are
    /// added, and the spike is armed only by `WATCHPARTY_SPIKE_URL`.
    /// </summary>
    private readonly List<CoreWebView2Frame> _spikeFrames = [];
#endif

    public MainForm(string[]? launchArgs)
    {
        _launchArgs = launchArgs ?? [];

        Text = "Watch Party";
        ClientSize = new Size(1100, 720);
        MinimumSize = new Size(640, 420);
        StartPosition = FormStartPosition.CenterScreen;

        // Docking runs from the last child added, so each Fill control goes in
        // before the control that takes space off it: the sidebar takes its
        // width from the right, the site column takes the rest, and the strip
        // takes its height off the top of the site column.
        _topStrip.Height = TopStripHeight;
        // The same dark chrome as our page's own body, so the reserved strip is
        // an empty row rather than a glare next to a dark window (03b fills it).
        _topStrip.BackColor = Color.FromArgb(0x14, 0x15, 0x1A);
        _siteColumn.Controls.Add(_site);
        _siteColumn.Controls.Add(_topStrip);
        Controls.Add(_siteColumn);
        Controls.Add(_page);

        // ADR-038: with no page there is no site view. A window opens with no
        // room, so this is file mode until something sets a page (03), and the
        // app view fills the window exactly as in M1.
        _siteColumn.Visible = false;

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
            await EnsureViewsAsync();
        }
        catch (Exception error)
        {
            HostLog.Write($"webview2 unavailable: {error}");
            ShowFailure("Watch Party cannot open its browser window. The WebView2 runtime is missing or blocked.");
            return;
        }

        // Both views: the app view's copy is what serves the picked file's one
        // measurement to our page, and the site view's is where a blocked host is
        // cancelled once the page in the room is a real site (ADR-038, T30).
        InstallRequestFilter(_page, "app");
        InstallRequestFilter(_site, "site");
        InstallAutoplayGrant();
        InstallFilePicker();
        InstallAppOriginLock();
#if DEBUG
        InstallPageConsole();
        await InstallSpikeAsync();
#endif
        _page.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
        _site.CoreWebView2.NavigationCompleted += OnSiteNavigationCompleted;
        StartSidecar();
        _portTimeout.Start();
    }

    /// <summary>
    /// Both of the window's WebView2 controls, created against one environment so
    /// they share a browser process: §14's autoplay policy is process-wide, and in
    /// a Debug build one loopback CDP port then lists both views as targets.
    /// </summary>
    private async Task EnsureViewsAsync()
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
            await _site.EnsureCoreWebView2Async(debugEnvironment);
            return;
        }
#endif
        CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
            null, null, new CoreWebView2EnvironmentOptions(autoplayPolicy));
        await _page.EnsureCoreWebView2Async(environment);
        await _site.EnsureCoreWebView2Async(environment);
    }

    private void InstallRequestFilter(WebView2 view, string name)
    {
        CoreWebView2 core = view.CoreWebView2;

        // The three-argument form: the two-argument one is documented not to
        // behave as expected for iframes, and cross-origin player frames are the
        // normal case (ADR-034).
        core.AddWebResourceRequestedFilter(
            "*",
            CoreWebView2WebResourceContext.All,
            CoreWebView2WebResourceRequestSourceKinds.All);
        core.WebResourceRequested += OnWebResourceRequested;

        HostLog.Write(
            $"request filter installed on the {name} view; temporary list has {BlockedHosts.Length} host(s)");
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        // The view the request came from, whose environment must build the
        // response: the app view serves the picked file, the site view's copy
        // exists so a blocked host is cancelled wherever it is asked for.
        CoreWebView2 core = (CoreWebView2)sender!;
        string uri = e.Request.Uri;

        // T9a2: the page measuring the file it just picked. Only the one path the
        // dialog returned, and only while the measurement is in flight.
        if (Uri.TryCreate(uri, UriKind.Absolute, out Uri? probe)
            && string.Equals(probe.Host, FilePick.MediaHost, StringComparison.OrdinalIgnoreCase))
        {
            e.Response = ProbeResponse(core.Environment, probe);
            return;
        }

        if (!IsBlocked(uri)) return;

        // An empty 403 replaces the response, which cancels the request: the page
        // never receives bytes from the blocked host.
        e.Response = core.Environment.CreateWebResourceResponse(
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

    /// <summary>
    /// ADR-038: the app view is the room's only client and may not navigate. A
    /// document that is not the sidecar's own origin is cancelled here, so a
    /// third-party page never gets the picker bridge's messages. The host's own
    /// failure page arrives as <c>about:blank</c> and stays allowed.
    /// </summary>
    private void InstallAppOriginLock()
    {
        _page.CoreWebView2.NavigationStarting += OnAppViewNavigationStarting;
        HostLog.Write("app view: navigation lock installed; only the sidecar's own origin is allowed");
    }

    private void OnAppViewNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (IsAppOrigin(e.Uri)) return;

        e.Cancel = true;
        HostLog.Write($"app view blocked a navigation to {e.Uri}");
    }

    /// <summary>The sidecar's own origin, or the failure page the host writes itself.</summary>
    private bool IsAppOrigin(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? target)) return false;
        if (target.Scheme == "about") return true;

        return _appPort is int port
            && target.Scheme == Uri.UriSchemeHttp
            && string.Equals(target.Host, "127.0.0.1", StringComparison.Ordinal)
            && target.Port == port;
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
    /// never injects a script and never navigates the site view anywhere at all.
    ///
    /// It hangs on the site view, because that view is where the page in the room
    /// loads (ADR-038); the app view keeps the picker's messages alone.
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
            await _site.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(probe);
            // The engine's own documentation says `CoreWebView2.WebMessageReceived`
            // is raised for the top-level document, and that an iframe's message
            // arrives on that frame's event instead. Subscribing here is what
            // lets a cross-origin player frame be heard at all; a frame that
            // already existed would be missed, and before the first navigation
            // there is none.
            _site.CoreWebView2.FrameCreated += OnSpikeFrameCreated;
            _site.CoreWebView2.WebMessageReceived += OnSpikeWebMessageReceived;
            _spikeUrl = url;
            HostLog.Write($"spike: probe registered for every document; the site view will open {url}");
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
        // Destroyed is the engine's own notice that this handle can no longer be
        // posted to; without it a command would be sent to a dead iframe.
        frame.Destroyed += (_, _) => _spikeFrames.Remove(frame);
        _spikeFrames.Add(frame);
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

    /// <summary>
    /// E10's command path, asked for through the Debug DevTools endpoint: a
    /// <c>spikeSetTime</c> message on the top document is forwarded to every
    /// child frame with <c>CoreWebView2Frame.PostWebMessageAsJson</c>, which the
    /// engine documents as posting to that iframe's own <c>window.chrome.webview</c>
    /// message event. The probe in the frame sets <c>currentTime</c> on the
    /// largest video it sees. Inert unless the spike armed: <c>_spikeUrl</c> is
    /// null in every normal run.
    ///
    /// A frame that refuses the post is a log line carrying the engine's error
    /// code, never a thrown window: the command exists to be measured.
    /// </summary>
    private void ForwardSpikeSetTime(CoreWebView2WebMessageReceivedEventArgs message)
    {
        if (_spikeUrl is null) return;
        double t;
        try
        {
            using JsonDocument parsed = JsonDocument.Parse(message.WebMessageAsJson);
            JsonElement root = parsed.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("t", out JsonElement value)
                || value.ValueKind != JsonValueKind.Number
                || !value.TryGetDouble(out t))
            {
                HostLog.Write("spike: command ignored — no numeric t");
                return;
            }
        }
        catch (JsonException)
        {
            HostLog.Write("spike: command ignored — unreadable payload");
            return;
        }

        string payload = JsonSerializer.Serialize(new { kind = "spikeSetTime", t });
        int posted = 0;
        foreach (CoreWebView2Frame frame in _spikeFrames.ToArray())
        {
            try
            {
                frame.PostWebMessageAsJson(payload);
                posted++;
            }
            catch (Exception error)
            {
                HostLog.Write(
                    $"spike: command to frame failed: {error.Message} (HRESULT 0x{error.HResult:X8})");
            }
        }

        // The top document too: a site whose player lives on its own page (4 of
        // E2's 11) needs the same command, and its probe ignores a document with
        // no video.
        try
        {
            _site.CoreWebView2.PostWebMessageAsJson(payload);
            HostLog.Write($"spike: command posted to {posted} child frame(s) and the top document for t={t}");
        }
        catch (Exception error)
        {
            HostLog.Write(
                $"spike: command to the top document failed: {error.Message} (HRESULT 0x{error.HResult:X8}); "
                + $"{posted} child frame(s) posted");
        }
    }

    /// <summary>
    /// E10's top-document half, on the site view: the probe in the page the room
    /// opened posts here, and the shell's command arrives here too. The app view
    /// keeps only the picker's own messages.
    /// </summary>
    private void OnSpikeWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        switch (MessageKind(e.WebMessageAsJson))
        {
            case "spike":
                LogSpikeMessage(null, e);
                break;
            case "spikeSetTime":
                ForwardSpikeSetTime(e);
                break;
        }
    }
#endif

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string? kind = MessageKind(e.WebMessageAsJson);
        string? contentType = null;
        try
        {
            using JsonDocument message = JsonDocument.Parse(e.WebMessageAsJson);
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
        }
    }

    /// <summary>A message's <c>kind</c>, or null for anything not one of ours.</summary>
    private static string? MessageKind(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            if (message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("kind", out JsonElement value)
                && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }
        }
        catch (JsonException)
        {
            // Not one of ours: ignored, the same rule §5 keeps for unknown frames.
        }

        return null;
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
    private CoreWebView2WebResourceResponse ProbeResponse(
        CoreWebView2Environment environment, Uri uri)
    {
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

#if DEBUG
        if (SpikeFilterArmed)
        {
            foreach (string host in SpikeBlockedHosts)
            {
                if (string.Equals(parsed.Host, host, StringComparison.OrdinalIgnoreCase)) return true;
            }
        }
#endif

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
        // The app view's own URL, plus `?join=` carrying the launched link whole
        // and encoded. This line is the record of where the window went (T2b
        // check 2). The port is the app view's whole origin: its navigation lock
        // allows this address and nothing else (ADR-038).
        _appPort = port;
        string url = LaunchLink.PageUrl($"http://127.0.0.1:{port}/", _launchArgs);
        HostLog.Write($"parsed sidecar PORT {port}; navigating to {url}");
        _navigated = true;
        _page.CoreWebView2.Navigate(url);
#if DEBUG
        // E10's stand-in for "the room has a page": the measuring build's site
        // view opens the address the variable names, and file mode is what every
        // run without it shows.
        if (_spikeUrl is not null)
        {
            ShowSiteView();
            HostLog.Write($"spike: the site view is navigating to {_spikeUrl}");
            _site.CoreWebView2.Navigate(_spikeUrl);
        }
#endif
    }

    /// <summary>
    /// ADR-038's page mode: the app view becomes a fixed sidebar on the right and
    /// the site column takes the rest, with the top strip reserved above the site.
    /// Called only when the room has a page — until 03 sets one, that is the
    /// measuring build's <c>WATCHPARTY_SPIKE_URL</c> alone.
    /// </summary>
    private void ShowSiteView()
    {
        if (_siteColumn.Visible) return;

        _page.Dock = DockStyle.Right;
        _page.Width = SidebarWidth;
        _siteColumn.Visible = true;
        HostLog.Write(
            $"layout: page mode — site view left of a {SidebarWidth} px app view, top strip {TopStripHeight} px");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        HostLog.Write(
            $"navigation completed {_page.CoreWebView2.Source} success={e.IsSuccess} " +
            $"status={e.HttpStatusCode} error={e.WebErrorStatus}");
    }

    private void OnSiteNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        HostLog.Write(
            $"site navigation completed {_site.CoreWebView2.Source} success={e.IsSuccess} " +
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
