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
    // The app view's list, unchanged since T1: the dev page requests
    // https://blocked.invalid/p.png, which gives the app view's filter something to
    // cancel. The site view uses the bundled ad list instead (T04, AdHosts); this
    // one stays so the app view keeps exactly the filtering it had.
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

    /// <summary>
    /// The relay's two directions, counted: <c>in</c> is a site message wrapped
    /// and posted to the app view, <c>out</c> is an app command posted to the
    /// site view. Only the measuring build's self-test ever logs them.
    /// </summary>
    private long _relayIn;
    private long _relayOut;

    /// <summary>The <c>seq</c> every site event carries: one count, so one order.</summary>
    private long _siteSeq;

    /// <summary>
    /// T04: the site view's list, read once at startup from <c>data/ad-hosts.txt</c>.
    /// The app view never consults it — its filtering is T1's, so the file-mode
    /// probe keeps working.
    /// </summary>
    private HashSet<string> _adHosts = new(StringComparer.OrdinalIgnoreCase);

    /// <summary>
    /// T04: what the site view has cancelled since the current navigation started —
    /// the count, and the first three distinct hostnames — so the log has one
    /// <c>site:</c> line per navigation that says what the filter did.
    /// </summary>
    private int _siteCancelled;
    private readonly List<string> _siteCancelledHosts = new();
#if DEBUG
    /// <summary>
    /// T8d: whether this window is the measuring one — the window <c>dev:debug</c>
    /// opened, which is also the one that loads the development page. Only that
    /// page has the dev log lines to forward, so only that window asks for them.
    /// </summary>
    private bool _measuring;

    /// <summary>
    /// The address the measuring build's <em>site view</em> opens, when
    /// <c>WATCHPARTY_SPIKE_URL</c> names one — it stands in for "the room has a
    /// page" until 03 sets a real one. Null in every normal run, which keeps the
    /// window in file mode and hides the site view.
    /// </summary>
    private string? _spikeUrl;

    /// <summary>
    /// The relay self-test (<c>WATCHPARTY_RELAY_SELFTEST=1</c>): armed only in a
    /// measuring build that also has a site view. <c>_appLoaded</c> and
    /// <c>_siteLoaded</c> are the first navigation of each view; the two
    /// completion sources are the two host acts the self-test must see happen —
    /// the relay carrying a message each way, and the navigate command the host
    /// owns — so the log's order is the evidence rather than a race.
    /// </summary>
    private bool _selfTestArmed;
    private bool _selfTestStarted;
    private bool _relayOkLogged;
    private bool _appLoaded;
    private bool _siteLoaded;
    private readonly TaskCompletionSource _selfTestRelayDone =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    private readonly TaskCompletionSource _selfTestNavigate =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
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

        // R20's list, before either view can ask for a request (T04). The file is
        // data that ships beside the program; an unreadable one is a log line and
        // an empty set, so the window still opens.
        _adHosts = AdHosts.Load(_root);

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
        InstallRequestFilter(_page, "app", $"temporary list has {BlockedHosts.Length} host(s)");
        InstallRequestFilter(_site, "site", $"ad list has {_adHosts.Count} host(s) from {AdHosts.RelativePath}");
        InstallAutoplayGrant();
        InstallFilePicker();
        InstallAppOriginLock();
        InstallRelay();
#if DEBUG
        InstallPageConsole();
        ArmSpikeUrl();
        ArmRelaySelfTest();
#endif
        _page.CoreWebView2.NavigationCompleted += OnNavigationCompleted;
        _site.CoreWebView2.NavigationStarting += OnSiteNavigationStarting;
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

    private void InstallRequestFilter(WebView2 view, string name, string listNote)
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

        HostLog.Write($"request filter installed on the {name} view; {listNote}");
    }

    private void OnWebResourceRequested(object? sender, CoreWebView2WebResourceRequestedEventArgs e)
    {
        // The view the request came from, whose environment must build the
        // response: the app view serves the picked file, the site view's copy
        // exists so a blocked host is cancelled wherever it is asked for.
        CoreWebView2 core = (CoreWebView2)sender!;
        string uri = e.Request.Uri;
        bool siteView = ReferenceEquals(core, _site.CoreWebView2);

        // T9a2: the page measuring the file it just picked. Only the one path the
        // dialog returned, and only while the measurement is in flight.
        if (Uri.TryCreate(uri, UriKind.Absolute, out Uri? probe)
            && string.Equals(probe.Host, FilePick.MediaHost, StringComparison.OrdinalIgnoreCase))
        {
            e.Response = ProbeResponse(core.Environment, probe);
            return;
        }

        // T04: two lists, one per view. The app view keeps T1's, so the file-mode
        // probe and the dev page's own blocked request behave exactly as before;
        // the site view gets the bundled ad list.
        bool blocked = siteView ? IsAdHost(uri) : IsBlocked(uri);
        if (!blocked) return;

        // An empty 403 replaces the response, which cancels the request: the page
        // never receives bytes from the blocked host.
        e.Response = core.Environment.CreateWebResourceResponse(
            new MemoryStream(Array.Empty<byte>()), 403, "Blocked", "Content-Type: text/plain");

        if (siteView)
        {
            NoteSiteCancelled(uri);
        }
        else
        {
            HostLog.Write($"blocked {uri}");
        }
    }

    /// <summary>
    /// T04: one cancellation on the site view, for the navigation's tally. Nothing
    /// is logged per request: the navigation's own line carries the count and the
    /// first three hostnames, and a per-request line in every window's log would
    /// bury the rest of it. The measuring build is the exception — its log is the
    /// one a person reads while asking "did this host get caught", so there a host
    /// line per cancellation is what is wanted.
    /// </summary>
    private void NoteSiteCancelled(string uri)
    {
        _siteCancelled++;

        string host = Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed) ? parsed.Host : uri;
        if (_siteCancelledHosts.Count < 3 && !_siteCancelledHosts.Contains(host))
        {
            _siteCancelledHosts.Add(host);
        }
#if DEBUG
        if (_measuring)
        {
            HostLog.Write($"site: cancelled {host}: {uri}");
        }
#endif
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
            // T03b: R29's visible Paste button reads the clipboard from this
            // page. It is the app view's own grant, never the site's - the site
            // has no bridge and no button of ours.
            if (e.PermissionKind == CoreWebView2PermissionKind.ClipboardRead)
            {
                e.Handled = true;
                e.SavesInProfile = false;
                e.State = CoreWebView2PermissionState.Allow;
                HostLog.Write($"clipboard read permission for {e.Uri}: allowed");
                return;
            }

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
        // The address as asked, without scheme or trailing slash, then the form
        // the engine reported: the sentence this window's live checks read is
        // `site: app-view navigation refused <address>`.
        string shown = Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? target)
            ? $"{target.Host}{target.AbsolutePath.TrimEnd('/')}"
            : e.Uri;
        HostLog.Write($"site: app-view navigation refused {shown} (engine saw {e.Uri})");
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

    /// <summary>
    /// ADR-038's relay: one message handler per view. A message from the site is
    /// re-posted to the app view as <c>{kind:'siteEvent', source, seq, payload}</c>
    /// — <c>source</c> is the document or frame that sent it, <c>payload</c> is
    /// the message itself, untouched. A <c>{kind:'siteCommand', payload}</c> from
    /// the app view is posted to the site view, except the one command the host
    /// must own: a payload that says <c>navigate</c> loads that address in the
    /// site view, because nothing else may move it. Neither payload is read
    /// beyond that (ADR-034, ADR-038).
    ///
    /// The app view's handler is the picker's (<c>InstallFilePicker</c>): one
    /// handler per view, so the <c>siteCommand</c> case lives there beside
    /// <c>pick</c> and <c>probe</c>.
    /// </summary>
    private void InstallRelay()
    {
        // Top-level only, as measured in 01/01b: a child frame's message arrives
        // on that frame's own event (`CoreWebView2.FrameCreated` →
        // `frame.WebMessageReceived`), and a command into a frame needs
        // `frame.PostWebMessageAsJson`. The frame half is ticket 05's; this relay
        // does not assume the site's messages all come from one document.
        _site.CoreWebView2.WebMessageReceived += OnSiteMessageReceived;
        HostLog.Write("relay installed: site events to the app view, commands to the site view");
    }

    /// <summary>
    /// One message from the site view's top-level document. It is wrapped, not
    /// read: the host adds where it came from and a sequence number, and nothing
    /// else.
    /// </summary>
    private void OnSiteMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        string relayed;
        try
        {
            using JsonDocument message = JsonDocument.Parse(e.WebMessageAsJson);
            relayed = "{\"kind\":\"siteEvent\",\"source\":" + JsonSerializer.Serialize(e.Source)
                + ",\"seq\":" + (++_siteSeq)
                + ",\"payload\":" + message.RootElement.GetRawText() + "}";
        }
        catch (JsonException)
        {
            HostLog.Write("relay: a site message was not JSON, so it was not relayed");
            return;
        }

        try
        {
            _page.CoreWebView2.PostWebMessageAsJson(relayed);
            _relayIn++;
            MaybeLogRelayOk();
        }
        catch (Exception error)
        {
            HostLog.Write($"relay: a site event could not reach the app view: {error.Message}");
        }
    }

    /// <summary>
    /// One <c>siteCommand</c> from the app view. Its payload is forwarded as it
    /// arrived, except a <c>navigate</c> payload, which the host performs itself:
    /// it is the only way the site view ever moves, and nothing else may issue it.
    /// </summary>
    private void RelayToSite(string messageJson)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(messageJson);
            if (message.RootElement.ValueKind != JsonValueKind.Object
                || !message.RootElement.TryGetProperty("payload", out JsonElement payload))
            {
                HostLog.Write("relay: a site command with no payload was ignored");
                return;
            }

            if (TryReadNavigate(payload, out string address))
            {
                NavigateSite(address);
                return;
            }

            string forwarded = "{\"kind\":\"siteCommand\",\"payload\":" + payload.GetRawText() + "}";
            _site.CoreWebView2.PostWebMessageAsJson(forwarded);
            _relayOut++;
            MaybeLogRelayOk();
        }
        catch (JsonException)
        {
            HostLog.Write("relay: a site command was not JSON, so it was not relayed");
        }
        catch (Exception error)
        {
            HostLog.Write($"relay: a command could not reach the site view: {error.Message}");
        }
    }

    /// <summary>
    /// The one payload field the host reads: <c>{kind:'navigate', url}</c>. Every
    /// other command is somebody else's to interpret.
    /// </summary>
    private static bool TryReadNavigate(JsonElement payload, out string address)
    {
        address = string.Empty;
        if (payload.ValueKind != JsonValueKind.Object) return false;
        if (!payload.TryGetProperty("kind", out JsonElement kind)
            || kind.ValueKind != JsonValueKind.String
            || kind.GetString() != "navigate") return false;
        if (!payload.TryGetProperty("url", out JsonElement url)
            || url.ValueKind != JsonValueKind.String) return false;

        address = url.GetString() ?? string.Empty;
        return address.Length > 0;
    }

    /// <summary>
    /// The site view's only way to be moved (ADR-038). The address must be
    /// absolute http(s): the site view has no origin lock — that is the point of
    /// the two views — so the shape is checked here and nothing else.
    /// </summary>
    private void NavigateSite(string address)
    {
        if (!Uri.TryCreate(address, UriKind.Absolute, out Uri? target)
            || (target.Scheme != Uri.UriSchemeHttp && target.Scheme != Uri.UriSchemeHttps))
        {
            HostLog.Write($"site: navigate refused {address}: not an http(s) address");
            return;
        }

        ShowSiteView();
        HostLog.Write($"site: navigate {address}");
        _site.CoreWebView2.Navigate(address);
#if DEBUG
        // The self-test waits for this so its refusal lands after the navigate.
        _selfTestNavigate.TrySetResult();
#endif
    }

    /// <summary>
    /// One line, once, when the measuring build's self-test has seen the relay
    /// carry a message each way. Silent in every other run.
    /// </summary>
    private void MaybeLogRelayOk()
    {
#if DEBUG
        if (!_selfTestArmed || _relayOkLogged || _relayIn < 1 || _relayOut < 1) return;
        _relayOkLogged = true;
        HostLog.Write($"site: relay ok out={_relayOut} in={_relayIn}");
        _selfTestRelayDone.TrySetResult();
#endif
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
    /// The measuring build's stand-in for "the room has a page": when
    /// <c>WATCHPARTY_SPIKE_URL</c> names an address, the site view opens it when
    /// the sidecar reports its port. Unset, nothing is loaded and the window is
    /// in file mode, exactly as a normal run. This is the whole of the variable's
    /// meaning (02); the probe that used to travel with it is gone.
    /// </summary>
    private void ArmSpikeUrl()
    {
        string? url = Environment.GetEnvironmentVariable("WATCHPARTY_SPIKE_URL");
        if (string.IsNullOrWhiteSpace(url)) return;

        _spikeUrl = url;
        HostLog.Write($"spike: the site view will open {url}");
    }

    /// <summary>
    /// Arms the relay self-test, which proves the two directions and the navigate
    /// command with messages the pages really post, and proves the app view's lock
    /// with one navigation to <c>example.invalid</c> — an address nobody serves.
    /// It needs a site view, so a run without <c>WATCHPARTY_SPIKE_URL</c> says so
    /// and does nothing.
    /// </summary>
    private void ArmRelaySelfTest()
    {
        if (Environment.GetEnvironmentVariable("WATCHPARTY_RELAY_SELFTEST") != "1") return;
        _selfTestArmed = true;
        HostLog.Write("selftest: relay self-test armed (Debug build only)");
        if (_spikeUrl is null)
        {
            HostLog.Write("selftest: no site view without WATCHPARTY_SPIKE_URL, so it will not run");
        }
    }

    /// <summary>
    /// Runs once both views have finished their first navigation. The messages
    /// come from the documents themselves — a one-line script posted into each
    /// view — so the relay carries a page's message, not a host-made call.
    /// </summary>
    private void MaybeRunRelaySelfTest()
    {
        if (!_selfTestArmed || _selfTestStarted || !_appLoaded || !_siteLoaded) return;
        _selfTestStarted = true;
        _ = RunRelaySelfTestAsync();
    }

    private async Task RunRelaySelfTestAsync()
    {
        try
        {
            // In: one message from the site view's own document, which the relay
            // must wrap as a siteEvent and post to the app view.
            await _site.CoreWebView2.ExecuteScriptAsync(
                "window.chrome.webview.postMessage({kind:'relaySelfTest',from:'site'});");

            // Out: one siteCommand from our page's document, which the relay must
            // post to the site view.
            await _page.CoreWebView2.ExecuteScriptAsync(
                "window.chrome.webview.postMessage({kind:'siteCommand',payload:{kind:'relaySelfTest',from:'app'}});");

            // Waited for, so `site: relay ok` lands before the navigate line.
            await Task.WhenAny(_selfTestRelayDone.Task, Task.Delay(5_000));

            // The one command the host owns: the app view moves the site view.
            string address = _site.CoreWebView2.Source;
            await _page.CoreWebView2.ExecuteScriptAsync(
                "window.chrome.webview.postMessage({kind:'siteCommand',payload:{kind:'navigate',url:"
                + JsonSerializer.Serialize(address) + "}});");
            await Task.WhenAny(_selfTestNavigate.Task, Task.Delay(5_000));

            // The deliberate refusal, last. The line after it records that the
            // app view is still our page, which is the other half of the proof.
            _page.CoreWebView2.Navigate("https://example.invalid/");
            await Task.Delay(500);
            HostLog.Write($"site: app-view still on {_page.CoreWebView2.Source} after the refusal");
        }
        catch (Exception error)
        {
            HostLog.Write($"selftest: relay self-test failed: {error.Message}");
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
            case "siteCommand":
                RelayToSite(e.WebMessageAsJson);
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

    /// <summary>Matches a request URL's host against the app view's block list.</summary>
    internal static bool IsBlocked(string uri)
    {
        if (!Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)) return false;

        foreach (string host in BlockedHosts)
        {
            if (string.Equals(parsed.Host, host, StringComparison.OrdinalIgnoreCase)) return true;
        }

        return false;
    }

    /// <summary>Matches a request URL's host against the site view's bundled list.</summary>
    private bool IsAdHost(string uri)
    {
        return Uri.TryCreate(uri, UriKind.Absolute, out Uri? parsed)
            && AdHosts.Matches(_adHosts, parsed.Host);
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
#if DEBUG
        _appLoaded = true;
        MaybeRunRelaySelfTest();
#endif
    }

    private void OnSiteNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // T04: a navigation is the unit the count is reported in, so the tally
        // restarts here, before the new document asks for anything.
        _siteCancelled = 0;
        _siteCancelledHosts.Clear();
    }

    private void OnSiteNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        HostLog.Write(
            $"site navigation completed {_site.CoreWebView2.Source} success={e.IsSuccess} " +
            $"status={e.HttpStatusCode} error={e.WebErrorStatus}");

        // T04: the one line per navigation that says what the filter did. The
        // first three distinct hostnames, because a page can ask one ad host for
        // dozens of things and the names are the useful part, not the total.
        string hosts = _siteCancelledHosts.Count == 0 ? "none" : string.Join(",", _siteCancelledHosts);
        HostLog.Write($"site: navigation cancelled={_siteCancelled} host(s)={hosts}");
#if DEBUG
        _siteLoaded = true;
        MaybeRunRelaySelfTest();
#endif
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
