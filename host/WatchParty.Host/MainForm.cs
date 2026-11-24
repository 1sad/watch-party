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
    /// never reflows the site. ADR-047 removes the empty 48 px band the host used
    /// to reserve above the site view, so the site view's top is the form's own
    /// client top and the host has no vertical furniture at all.
    /// </summary>
    private const int SidebarWidth = 380;

    /// <summary>
    /// T94, ADR-047 ("one threshold, owned by the host"): the window's client
    /// width, in CSS pixels, at or above which the page puts the chat beside the
    /// picture and below which it puts it under. The app view's own width cannot
    /// say this - it is the docked column whatever the window is - so the measure
    /// is the form's client width, which is what the page sees as <c>innerWidth</c>.
    /// </summary>
    private const int WideLayoutMinCssWidth = 900;

    /// <summary>
    /// T107, ADR-047 ("window narrower than 900 px"): in page mode the app view is
    /// docked along the bottom rather than the right, and it takes this share of the
    /// form's client height so the picture keeps the rest. The minimum below applies
    /// when the share would be smaller - the chat column must stay usable.
    /// </summary>
    private const double NarrowDockHeightShare = 0.4;
    private const int NarrowDockMinHeight = 240;

    /// <summary>
    /// T08 item 3: how long an <c>enter</c> that arrives while the layout is
    /// already full is read as the echo of the press that filled it rather than
    /// as a second press. One press can be named twice — by the page's intent
    /// message and by the engine's event — and a page can ask twice for it.
    /// </summary>
    private const int FullscreenEchoMs = 500;

    /// <summary>
    /// T08, ADR-028: whether the site view is filling the column right now. The
    /// layout is ours, so this is the only place that knows: nothing here reads
    /// it back from the engine, which refuses the site view's requests anyway.
    /// </summary>
    private bool _siteFull;

    /// <summary>The instant of the last fullscreen transition (T08's echo window).</summary>
    private DateTime _siteFullAt = DateTime.MinValue;

    /// <summary>
    /// T26: the site view was cleared on purpose because the room took a file, so
    /// the blank document it now holds is the host's own act: its navigation is
    /// not a <c>site:</c> line and nothing it says is relayed. The next real
    /// address (<see cref="NavigateSite"/>) clears this again.
    /// </summary>
    private bool _siteCleared;

    private readonly WebView2 _page = new() { Dock = DockStyle.Fill };
    private readonly WebView2 _site = new() { Dock = DockStyle.Fill };
    private readonly System.Windows.Forms.Timer _portTimeout = new() { Interval = 20_000 };

    // Command-line arguments, untouched: when the app was opened from a clicked
    // invite link, one of them is that link (T2b).
    private readonly string[] _launchArgs;

    private Process? _sidecar;
    private string _root = string.Empty;
    /// <summary>
    /// T93, ADR-047 ("window size"): the browser profile folder, resolved once so
    /// the window's saved rectangle sits inside the same folder the log names -
    /// <c>&lt;exe folder&gt;\profile</c> in a packaged copy (ADR-043),
    /// <c>%TEMP%\watchparty-dev-&lt;port&gt;</c> in a dev window. Null when this
    /// build has no profile at all, and then nothing is saved.
    /// </summary>
    private string? _profileFolder;
    private bool _closing;

    /// <summary>
    /// T113, ADR-047 ("room end"): how long a closing window waits for the
    /// sidecar's own <c>[room] over</c> line before it closes anyway. A person
    /// shutting a window must not wait on a goodbye.
    /// </summary>
    private const int RoomGoodbyeBudgetMs = 1_500;
    /// <summary>
    /// T113: the sidecar prints this line itself once it has broadcast its one
    /// <c>roomOver</c> frame and closed the guest sockets. It is the signal that
    /// the room has spoken, and the sidecar may stop after it - never before.
    /// </summary>
    private readonly TaskCompletionSource<bool> _roomOverSpoken =
        new(TaskCreationOptions.RunContinuationsAsynchronously);
    /// <summary>The goodbye is in flight: a second close click waits for it.</summary>
    private bool _goodbyeStarted;
    /// <summary>The goodbye finished and the close this class asked for is the next one.</summary>
    private bool _goodbyeDone;
    /// <summary>
    /// T127, ADR-047 ("room end"): the page has said this window entered **its
    /// own** room, the only window whose sidecar prints <c>[room] over</c> when it
    /// closes. It is a window-local UI fact, exactly like <c>data-layout</c>, and
    /// never room state the host reads (ADR-034). False until the page says so -
    /// and false for a guest, whose own sidecar has no owner to lose.
    /// </summary>
    private bool _ownRoomOpen;

    /// <summary>
    /// T94: the layout last published to the page (<c>wide</c> or <c>narrow</c>),
    /// so a resize of one pixel after another publishes nothing; null until the
    /// page has been told once.
    /// </summary>
    private string? _publishedLayout;
    /// <summary>
    /// T99: the panel last published to the page - <c>chat</c> while the app view
    /// is the docked column, null when it is not - so a dock change is published
    /// even when the window's width did not change.
    /// </summary>
    private string? _publishedPanel;
    /// <summary>
    /// T121: which layout read is the newest. Reading the page's own width is a
    /// round trip, so a resize can overtake the one before it; a read that is no
    /// longer the newest publishes nothing and the newer one does the work.
    /// </summary>
    private int _layoutRead;
    /// <summary>
    /// T128: the layout published once the app view has the whole window and its
    /// resize has landed. The WebView2 content resize is asynchronous, so the
    /// viewport read right after <c>HideSiteView</c> can still be the docked
    /// column (380 px, or a pixel short of the width that decides the 900 px
    /// threshold); this one-shot tick asks again once the page has settled.
    /// Stopped in the close, so it never runs on a disposing form.
    /// </summary>
    private readonly System.Windows.Forms.Timer _layoutSettle = new() { Interval = 120 };
    /// <summary>
    /// T107: the page-mode dock shape last logged (<c>wide</c> or <c>narrow</c>), so
    /// a resize inside one shape writes no second line and a shape change writes
    /// exactly one. Null when the window is not in page mode.
    /// </summary>
    private string? _pageDockShape;
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

    /// <summary>
    /// T05's whitelist, counted: how many site messages it has dropped, and how
    /// many of those are worth one log line each. A page can post once a second
    /// forever, and a log that repeats has stopped being evidence.
    /// </summary>
    private const int RelayDropLines = 5;
    private int _relayDropped;

    /// <summary>The <c>seq</c> every site event carries: one count, so one order.</summary>
    private long _siteSeq;

    /// <summary>
    /// T06: the child frames of the site view, by the URL their messages came
    /// from. A command must reach the frame the elected player lives in — on 6
    /// of 11 sites that is a cross-origin child frame, and the top document
    /// cannot pass it on — so the host remembers which frame sent each report
    /// and posts a <c>playerCommand</c> straight to that one. The entry is only
    /// ever written from a frame's own message, never from the page.
    /// </summary>
    private readonly Dictionary<string, CoreWebView2Frame> _playerFrames = new();

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

    /// <summary>
    /// T04b: which navigations of the site view the popup events belong to. The
    /// page's one notice is "one per host per page", and the page has no other
    /// way to tell one page from the next, so the count travels with each event.
    /// </summary>
    private int _siteNav;
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
        // before the control that takes space off it: the app view takes its
        // width from the right in page mode, and the site view keeps the rest.
        //
        // The site view is a child of the form itself (T08 attempt 2): nested in
        // an intermediate panel it was refused every fullscreen request
        // (`TypeError: not granted`) while the same page in the app view — a
        // direct child — was granted. The layout is otherwise unchanged.
        //
        // T99 / ADR-047: there is no strip above the site view any more. The
        // old empty 48 px band held nothing, and the address bar is drawn by the
        // page inside the app view, so the site view's top is the form's client
        // top (this is the `site ... at 0,0` reading in `layout:`).
        Controls.Add(_site);
        Controls.Add(_page);

        // ADR-038: with no page there is no site view. A window opens with no
        // room, so this is file mode until something sets a page (03), and the
        // app view fills the window exactly as in M1.
        _site.Visible = false;

        Load += OnLoad;
        FormClosing += OnFormClosing;
        FormClosed += OnFormClosed;
        _portTimeout.Tick += OnPortTimeout;
        _layoutSettle.Tick += OnLayoutSettle;
        // T94, ADR-047: a resize is the form's client size changing, which is
        // also the one event a monitor's DPI change arrives as - and the width in
        // CSS pixels changes only when the client size does.
        // T107: in page mode the same event moves the app view between the right
        // dock and the bottom one, so the two views always match the published
        // layout attribute.
        // T129: the formula's shape goes on at once, so the views never wait on a
        // round trip; it is quiet, because the read in PublishLayout names the
        // settled shape the log reports.
        ClientSizeChanged += (_, _) =>
        {
            ApplyPageDock(CurrentLayout(), quiet: true);
            PublishLayout();
            SettleLayout();
        };
    }

    private async void OnLoad(object? sender, EventArgs e)
    {
        try
        {
            _root = ProgramRoot.Find();
            // ADR-043: the host log lives in the folder the exe sits in, one level
            // above the unpacked payload. A developer build keeps the log beside
            // the repository's package.json, exactly as before.
            HostLog.Open(Payload.IsPresent ? Payload.Folder : _root);
        }
        catch (Payload.FolderNotWritableException error)
        {
            // Nothing in the folder can be written, so no log file exists: the one
            // sentence on the window is the record (ADR-043, T46c item 3).
            ShowFolderSentence(error.Message);
            return;
        }
        catch (Exception error)
        {
            ShowFailure("Watch Party could not find its own program folder.");
            HostLog.Write($"startup: {error.Message}");
            return;
        }

        HostLog.Write($"host started; program folder {_root}");

        // T93, ADR-047 ("window size"): the saved size belongs to the profile, so
        // the file sits inside the profile folder the log names, and this window
        // opens the way the last one on that profile was closed - maximised on a
        // first run with no file.
        _profileFolder = ProfileFolder();
        RestoreWindowState();

        // Packaged only (ADR-043): the one line that says which unpacked payload
        // this window is running, and the folder it sits in - which is also where
        // the log file and the profile are.
        if (Payload.IsPresent)
        {
            HostLog.Write($"payload: runtime folder {_root}; program folder {Payload.Folder}");
            // The one-time extraction may have applied Microsoft's Windows 10 grants to a
            // fixed engine folder; it had no log yet, so its lines are written here.
            foreach (string note in Payload.LastExtractionNotes) HostLog.Write(note);
        }

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
        catch (WebView2RuntimeNotFoundException)
        {
            // T47b: neither engine can be used. One plain sentence names both ways
            // forward; the engine line EnsureViewsAsync wrote names what was tried.
            ShowFailure("Watch Party cannot open its browser window because its engine is missing: "
                + "use the larger build that carries its own engine, or install the WebView2 runtime "
                + "from Microsoft.");
            return;
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
        InstallPopupRefusal();
        InstallRelay();
        InstallFullscreenIntercept();
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
    /// T93: the one browser profile this window opens, named in the log as
    /// <c>profile:</c>. A packaged copy keeps it at <c>&lt;exe folder&gt;\profile</c>
    /// (T46, ADR-043), and a developer build asked for a CDP port keeps its
    /// <c>%TEMP%\watchparty-dev-&lt;port&gt;</c> folder - its own profile, because
    /// WebView2 refuses a second controller in the browser process another window
    /// already owns (0x8007139F), and two windows on one debugging port could not
    /// be told apart. Null when this build has no profile: no payload and no port.
    /// </summary>
    private static string? ProfileFolder()
    {
        if (Payload.IsPresent)
        {
            string folder = Payload.ProfileFolder;
            Directory.CreateDirectory(folder);
            return folder;
        }
#if DEBUG
        string? debugPort = Environment.GetEnvironmentVariable("WATCHPARTY_CDP_PORT");
        if (debugPort is not null)
        {
            return Path.Combine(Path.GetTempPath(), $"watchparty-dev-{debugPort}");
        }
#endif
        return null;
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
        }
#else
        string? debugPort = null;
#endif

        // The engine's own profile (T46, moved by ADR-043). A packaged copy keeps
        // it at <exe folder>\profile: the whole app is the folder it was copied
        // into, so the site's cookies travel with the folder, and a returning host
        // stays signed in - a fresh pid-keyed folder every evening is what signed
        // it out. One folder is one installation, so two copies in the same folder
        // share this profile by design. A developer build asked for a CDP port
        // keeps its %TEMP%\watchparty-dev-<port> folder (parity with every earlier
        // ticket).
        string? userData = ProfileFolder();

        if (userData is not null) HostLog.Write($"profile: {userData}");

        // ADR-041: the two builds differ only here. `portable-full` carries a fixed runtime
        // inside its payload, so the folder holding `msedgewebview2.exe` is named to the
        // engine before either view loads a page; `portable` and every developer build have
        // no such folder and use the machine's runtime, exactly as before. Both lines are
        // written before the engine starts, so they are in the log even when it fails - and
        // each names the engine actually used, plus the machine's evergreen version when
        // there is one, so the two flavours are told apart by the log (T47).
        string? fixedEngine = WebView2Engine.FindFixed(_root);
        string? evergreen = WebView2Engine.EvergreenVersion();
        HostLog.Write(evergreen is null
            ? "engine: evergreen none"
            : $"engine: evergreen version={evergreen}");
        HostLog.Write(fixedEngine is null
            ? $"engine: folder=none (machine runtime) version={evergreen ?? "unknown"}"
            : $"engine: folder={fixedEngine} version={WebView2Engine.VersionOf(fixedEngine) ?? "unknown"}");

        // One environment for both controls, so they share one browser process
        // (§14's autoplay policy is process-wide, and a Debug build's one
        // loopback CDP port then lists both views as targets).
        string options = debugPort is null
            ? autoplayPolicy
            : $"{autoplayPolicy} --remote-debugging-port={debugPort}".Trim();
        CoreWebView2Environment environment;
        try
        {
            environment = await CoreWebView2Environment.CreateAsync(
                fixedEngine, userData, new CoreWebView2EnvironmentOptions(options));
            await _page.EnsureCoreWebView2Async(environment);
            await _site.EnsureCoreWebView2Async(environment);
        }
        catch (WebView2RuntimeNotFoundException error)
        {
            // T47b: no engine at all. One ASCII line names the folder this start
            // looked for - the absent fixed folder, or the one it found - beside
            // the machine's runtime, so the sentence OnLoad shows can be read back
            // from the log too. A localized engine message is flattened to ASCII.
            string fixedTried = fixedEngine is null
                ? $"{WebView2Engine.FixedFolder(_root)} (absent)"
                : fixedEngine;
            HostLog.Write($"engine: none usable; fixed folder={fixedTried}; "
                + $"evergreen={evergreen ?? "none"}; {HostLog.Ascii(error.Message)}");
            throw;
        }
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
    /// third-party page never gets the picker bridge's messages. <c>about:</c>
    /// stays allowed because the engine's own initial document is
    /// <c>about:blank</c>; the host's failure sentence does not navigate at all
    /// (T114 - <c>NavigateToString</c>'s <c>data:</c> document was refused here).
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

    /// <summary>The sidecar's own origin, or the engine's initial blank document.</summary>
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
    /// T04b, R37: a site's popup is cancelled before the engine can open one.
    /// This window is the only window the app has — a second one would sit
    /// outside the relay, the layout and the room — so nothing is opened, queued
    /// or retried. Only the *event* is the host's business: the page is told
    /// which host asked, and which navigation asked it in, and ADR-038 leaves
    /// the sentence to the page.
    ///
    /// The app view is not wired here: our own page opens no windows (R37's
    /// notice is about the site's), and its navigation lock already keeps it on
    /// the sidecar's origin.
    /// </summary>
    private void InstallPopupRefusal()
    {
        _site.CoreWebView2.NewWindowRequested += OnSiteNewWindowRequested;
        HostLog.Write("site view: popups cancelled; a second window is never opened");
    }

    /// <summary>
    /// One popup the page asked for. <c>Handled</c> is the whole refusal — the
    /// SDK's own words are "in which case WebView2 does not open a window" — and
    /// it is set before anything else, so no path through here leaves it unset.
    /// </summary>
    private void OnSiteNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;

        // The host the page asked for. A popup with no address of its own (an
        // `about:blank` the page fills in later) has no host to name, so the
        // sentence says "the page" rather than starting with a blank.
        string host = Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? target) && target.Host.Length > 0
            ? target.Host
            : "the page";

        // T04b: the measuring build's line, one per popup. ASCII only (AGENTS.md
        // rule 10): a quoted line stops being evidence once it reads as garbage.
#if DEBUG
        if (_measuring)
        {
            HostLog.Write($"site: popup cancelled host={host} url={e.Uri}");
        }
#endif

        try
        {
            PostToPage(new { kind = "popupCancelled", host, nav = _siteNav });
        }
        catch (Exception error)
        {
            // The window already refused it; a page that did not hear of it is a
            // missing line, never a second window.
            HostLog.Write($"relay: a popup event could not reach the app view: {error.Message}");
        }
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
        _site.CoreWebView2.FrameCreated += OnSiteFrameCreated;
        HostLog.Write("relay installed: site events (top document and every frame) to the app view, commands to the site view");
    }

    /// <summary>
    /// One frame of the site view, as it is created. Its messages arrive on its
    /// own event and nowhere else (01 measured this on a cross-origin player
    /// frame), so every frame the page builds is wired here.
    /// </summary>
    private void OnSiteFrameCreated(object? sender, CoreWebView2FrameCreatedEventArgs e)
    {
        // The frame object, not its URL: only this handler knows which frame a
        // later message came from, and only the frame can be posted to (T06).
        CoreWebView2Frame frame = e.Frame;
        frame.WebMessageReceived += (_, args) => RelaySiteEvent(frame, args.Source, args.WebMessageAsJson);
    }

    /// <summary>
    /// One message from the site view's top-level document. It is wrapped, not
    /// read: the host adds where it came from and a sequence number, and nothing
    /// else.
    /// </summary>
    private void OnSiteMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        RelaySiteEvent(null, e.Source, e.WebMessageAsJson);
    }

    /// <summary>
    /// T05's whitelist, and the one place a site message becomes a site event.
    /// A page can run the bridge's own script too, so a frame is not trusted
    /// with any kind it likes: only <c>playerReport</c>, <c>playerEvent</c> and
    /// T104's <c>pageAddress</c> cross to the app view, and anything else is
    /// dropped here rather than taught to the app view. A <c>pageAddress</c> is
    /// relayed only when the sender is the top document: a player frame is often
    /// another origin (E2: 6 of 11 sites), so a frame's address is never the
    /// room's page (ADR-048). T08's <c>fullscreen</c> is handled above and never
    /// crosses either. The one exception is 02b's relay self-test, which
    /// exists only in the measuring build with the test armed.
    /// </summary>
    private void RelaySiteEvent(CoreWebView2Frame? frame, string source, string json)
    {
        string? kind = MessageKind(json);

        // T26 / ADR-038: with no site view there is nothing of the site to hear.
        // A report already in flight when the room took a file, or a word from
        // the document being unloaded, is not the room's news.
        if (!_site.Visible) return;

        // T08, ADR-028: the page's fullscreen intent is the host's own business
        // - the layout is a window decision - so it is read here and goes no
        // further. The relay's whitelist below has no reason to learn this kind.
        if (kind == "fullscreen")
        {
            OnFullscreenIntent(json);
            return;
        }

        if (!IsRelayable(kind))
        {
            // A page that posts junk every second would otherwise fill the log:
            // the first few say what happened, the rest are counted nowhere.
            if (++_relayDropped <= RelayDropLines)
            {
                HostLog.Write($"relay: dropped a site message of kind {kind ?? "(none)"}; "
                    + "a frame may post playerReport and playerEvent, and the host reads fullscreen itself");
            }
            return;
        }

        // T104, ADR-048: only the top document may name the room's page. The
        // sender is the frame object this handler knows, not the page's claim
        // about itself: a player frame's address is its own and never the
        // room's, so it is dropped and counted like an unknown kind.
        if (kind == "pageAddress" && frame is not null)
        {
            if (++_relayDropped <= RelayDropLines)
            {
                HostLog.Write("relay: dropped a pageAddress from a frame; only the top document may name the page");
            }
            return;
        }

        // T06: a frame that reports is the frame the elected player may live in,
        // and a command for that URL has to be posted to it, not to the top
        // document. Remembered from the frame's own message; the page cannot
        // name itself into this table.
        if (frame is not null && kind == "playerReport") _playerFrames[source] = frame;

#if DEBUG
        // T05's evidence line, measuring build only: every second of a live page
        // is one line per frame, and the shipped log keeps none of them.
        if (_measuring) LogBridgeMessage(source, json);
#endif

        string relayed;
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            relayed = "{\"kind\":\"siteEvent\",\"source\":" + JsonSerializer.Serialize(source)
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
            // T104, ADR-048: one line per relayed address, in every build. The
            // host holds no decision about it - it says where the site went, and
            // the page decides what that means (ADR-034).
            if (kind == "pageAddress") HostLog.Write($"relay: pageAddress {PageAddressHref(json) ?? source}");
            MaybeLogRelayOk();
        }
        catch (Exception error)
        {
            HostLog.Write($"relay: a site event could not reach the app view: {error.Message}");
        }
    }

    /// <summary>
    /// Whether a site message may cross to the app view. This is the line the
    /// ticket's Safety claim rests on: nothing else leaves a frame.
    /// </summary>
    private bool IsRelayable(string? kind)
    {
#if DEBUG
        if (_selfTestArmed && kind == "relaySelfTest") return true;
#endif
        // T104: `pageAddress` is the top document's own address (ADR-048). The
        // frame check in RelaySiteEvent is what keeps a frame's out.
        return kind is "playerReport" or "playerEvent" or "pageAddress";
    }

    /// <summary>
    /// One <c>siteCommand</c> from the app view. Its payload is forwarded as it
    /// arrived, except two the host owns: a <c>navigate</c> payload loads that
    /// address (nothing else may move the site view), and a <c>playerCommand</c>
    /// is posted to the frame its <c>source</c> names, because a cross-origin
    /// player frame cannot be reached through the top document (T01b measured
    /// that it can be reached directly; T06 is the first caller).
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
            if (TryReadPlayerSource(payload, out string source)
                && _playerFrames.TryGetValue(source, out CoreWebView2Frame? playerFrame)
                && playerFrame is not null
                && playerFrame.IsDestroyed() == 0)
            {
                // The elected player's own frame. The bridge there checks the
                // href again, so a stale entry cannot move a different document.
                playerFrame.PostWebMessageAsJson(forwarded);
                _relayOut++;
                MaybeLogRelayOk();
                return;
            }

            // No frame of that URL (a top-document player, or a page that has
            // just reloaded): the top document is the only place left, and the
            // bridge's href guard stops a command landing in the wrong one.
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
    /// The second payload field the host reads: a <c>playerCommand</c>'s
    /// <c>source</c>, the frame URL the app view elected (T06).
    /// </summary>
    private static bool TryReadPlayerSource(JsonElement payload, out string source)
    {
        source = string.Empty;
        if (payload.ValueKind != JsonValueKind.Object) return false;
        if (!payload.TryGetProperty("kind", out JsonElement kind)
            || kind.ValueKind != JsonValueKind.String
            || kind.GetString() != "playerCommand") return false;
        if (!payload.TryGetProperty("source", out JsonElement value)
            || value.ValueKind != JsonValueKind.String) return false;

        source = value.GetString() ?? string.Empty;
        return source.Length > 0;
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
        // T26: a real address ends the cleared state HideSiteView left behind.
        _siteCleared = false;
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
    /// T05: one line per bridge message, measuring build only — the frame's own
    /// candidate list, as it arrived. A live page reports once a second per
    /// frame, which is why the shipped build has none of these.
    /// </summary>
    private void LogBridgeMessage(string source, string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            JsonElement root = message.RootElement;
            string kind = StringField(root, "kind") ?? "(none)";
            int seq = IntField(root, "seq");

            if (kind == "playerEvent")
            {
                HostLog.Write($"site: bridge event frame={source} seq={seq} event={StringField(root, "event") ?? "(none)"}");
                return;
            }

            // T104: a pageAddress has its own line in every build; there is
            // nothing here to measure about it.
            if (kind != "playerReport") return;

            List<string> candidates = new();
            if (root.TryGetProperty("candidates", out JsonElement list) && list.ValueKind == JsonValueKind.Array)
            {
                foreach (JsonElement candidate in list.EnumerateArray()) candidates.Add(CandidateText(candidate));
            }

            string shown = candidates.Count == 0 ? "none" : string.Join(" ", candidates);
            HostLog.Write($"site: bridge report frame={source} seq={seq} count={candidates.Count} [{shown}]");
        }
        catch (JsonException)
        {
            HostLog.Write($"site: a bridge message from {source} was not JSON");
        }
    }

    /// <summary>One reported `<video>`: the six fields the scoring reads, in one token each.</summary>
    private static string CandidateText(JsonElement candidate)
    {
        return $"id={IntField(candidate, "id")} {IntField(candidate, "w")}x{IntField(candidate, "h")}"
            + $" readyState={IntField(candidate, "readyState")}"
            + $" src={(BoolField(candidate, "hasSrc") ? 1 : 0)}"
            + $" playing={(BoolField(candidate, "playing") ? 1 : 0)}"
            + $" duration={SecondsField(candidate, "duration"):F1} t={SecondsField(candidate, "t"):F1}";
    }
#endif
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
            case "hideSite":
                HideSiteView();
                break;
            case "ownRoom":
                ReadOwnRoom(e.WebMessageAsJson);
                break;
            case "playerElected":
                LogPlayerElection(e.WebMessageAsJson);
                break;
            case "playerApplied":
                LogPlayerApplied(e.WebMessageAsJson);
                break;
            case "playerDrift":
                LogPlayerDrift(e.WebMessageAsJson);
                break;
        }
    }

    /// <summary>
    /// T127, ADR-047 ("room end"): the page's <c>ownRoom</c> message says whether
    /// this window has entered its own room. The close waits for the sidecar's
    /// goodbye only then; a guest's window, and a window still on its own first
    /// screen, has none to hear and closes at once. One line per change, ASCII only
    /// (AGENTS.md rule 10).
    /// </summary>
    private void ReadOwnRoom(string json)
    {
        bool own;
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            own = message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("own", out JsonElement value)
                && value.ValueKind == JsonValueKind.True;
        }
        catch (JsonException)
        {
            return;
        }

        if (own == _ownRoomOpen) return;
        _ownRoomOpen = own;
        HostLog.Write(own
            ? "room: this window is in its own room - the close waits for the room's goodbye"
            : "room: this window is not in its own room - the close waits for no goodbye");
    }

    /// <summary>
    /// T05's one line, one per election: `player: frame <href> <w>x<h>
    /// duration=<s> reason=<why>`, or `player: none reason=<why>`. The app view
    /// decides and this only writes it, which is why the line is in the log
    /// whether the page is a production build or the measuring one. ASCII only
    /// (AGENTS.md rule 10), so `w x h` is written with an `x`.
    /// </summary>
    private void LogPlayerElection(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            JsonElement root = message.RootElement;
            string reason = StringField(root, "reason") ?? "(none)";
            if (root.TryGetProperty("frame", out JsonElement frame) && frame.ValueKind == JsonValueKind.Object)
            {
                HostLog.Write($"player: frame {StringField(frame, "href") ?? "(unknown)"} "
                    + $"{IntField(frame, "w")}x{IntField(frame, "h")} "
                    + $"duration={SecondsField(frame, "duration"):F1} reason={reason}");
                return;
            }
            HostLog.Write($"player: none reason={reason}");
        }
        catch (JsonException)
        {
            HostLog.Write("player: an election from the app view was not JSON");
        }
    }

    /// <summary>
    /// T06: one line per command the bridge carried out —
    /// <c>player: applied reason=pause target=83.500 from=84.010</c>. Unlike the
    /// measuring build's <c>site:</c> lines, this one is written in both builds:
    /// it is the live check's evidence that the room moved the site's player,
    /// and where the playhead was when it did. ASCII only (AGENTS.md rule 10).
    /// </summary>
    private void LogPlayerApplied(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            JsonElement root = message.RootElement;
            HostLog.Write($"player: applied reason={StringField(root, "reason") ?? "(none)"} "
                + $"target={SecondsField(root, "target"):F3} from={SecondsField(root, "from"):F3}");
        }
        catch (JsonException)
        {
            HostLog.Write("player: an applied command from the app view was not JSON");
        }
    }

    /// <summary>
    /// T06: the drift line 09 quotes —
    /// <c>player: drift expected=83.500 actual=83.610 delta=110</c>. The app view
    /// writes at most one a second (the bridge reports twice as often while the
    /// site plays), so a run's worst number is the largest <c>delta</c> on these
    /// lines. Millis, whole, so no reader has to know a unit.
    /// </summary>
    private void LogPlayerDrift(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            JsonElement root = message.RootElement;
            HostLog.Write($"player: drift expected={SecondsField(root, "expected"):F3} "
                + $"actual={SecondsField(root, "actual"):F3} delta={IntField(root, "deltaMs")}");
        }
        catch (JsonException)
        {
            HostLog.Write("player: a drift line from the app view was not JSON");
        }
    }

    /// <summary>
    /// One field of a message object, or the empty answer: every reader in this
    /// file treats a missing or wrongly-typed field as absent rather than as an
    /// error, because the sender is a page.
    /// </summary>
    private static string? StringField(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.String
            ? value.GetString()
            : null;
    }

    private static int IntField(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) && value.TryGetInt32(out int number) ? number : 0;
    }

    private static bool BoolField(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;
    }

    private static double SecondsField(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) && value.TryGetDouble(out double number) ? number : 0;
    }

    /// <summary>
    /// T104, ADR-048: the address a <c>pageAddress</c> message names, or null
    /// when it names none. Read only for the log line; the relay forwards the
    /// message as it arrived.
    /// </summary>
    private static string? PageAddressHref(string json)
    {
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            if (message.RootElement.ValueKind == JsonValueKind.Object
                && message.RootElement.TryGetProperty("href", out JsonElement value)
                && value.ValueKind == JsonValueKind.String)
            {
                return value.GetString();
            }
        }
        catch (JsonException)
        {
            // Not one of ours: the relay refuses it the same way it refuses junk.
        }

        return null;
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
            start = new ProcessStartInfo(NodePath.Resolve(_root))
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

        // ADR-042: a packaged copy runs the production sidecar. `main.ts` reads
        // NODE_ENV only to decide whether to print its `[dev]` diagnostic lines,
        // which the production page does not need (the bridge line is the host's).
        // T48: the measuring flavour (`npm run portable:debug`) is the exception -
        // the two-window gate quotes its `[dev] correction` lines, so a packaged
        // Debug host asks for the sidecar's development branch. A developer build
        // carries no payload (`Payload.IsPresent` is false) and inherits the
        // environment, exactly as before.
        if (Payload.IsPresent)
        {
#if DEBUG
            start.Environment["NODE_ENV"] = "development";
#else
            start.Environment["NODE_ENV"] = "production";
#endif
        }

        Process sidecar = new() { StartInfo = start, EnableRaisingEvents = true };
        sidecar.OutputDataReceived += (_, line) =>
        {
            if (line.Data is null) return;
            HostLog.Write($"sidecar: {line.Data}");
            // T113: the room said its own last word; the window may now close.
            // T130: the sidecar's line is `[room] over reason=owner_left id=...`
            // (src/server/socket.ts:683), so the match is its prefix, not a substring:
            // a picked file named "[room] over ..." logs a [media] line that merely
            // contains those words, and that must not stand in for the goodbye.
            if (RoomOverLine.Is(line.Data))
            {
                _roomOverSpoken.TrySetResult(true);
            }
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

        // T05: the bridge first, the site view's first document after it. A
        // script added after a document exists misses that document, so this
        // order is the whole point of doing it here rather than at random.
        _ = OpenSiteViewAsync(port);
    }

    /// <summary>
    /// Puts the bridge into the site view and only then lets it load anything,
    /// so no document of the site ever runs without it (ADR-038). In a normal
    /// run that is all it does: the site view has no address until the room sets
    /// one (03c), and this is the call that makes that address bridged.
    /// </summary>
    private async Task OpenSiteViewAsync(int port)
    {
        await InjectBridgeAsync(port);
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
    /// ADR-038's one script. Its text is the sidecar's own `/bridge.js`, fetched
    /// over loopback: one asset, so the bytes the window runs are the bytes the
    /// tests read, and the page build has nothing to copy. A failure is a log
    /// line - the window still opens and the site still plays, it just has no
    /// player to follow.
    /// </summary>
    private async Task InjectBridgeAsync(int port)
    {
        string? script = null;
        try
        {
            using HttpClient http = new() { Timeout = TimeSpan.FromSeconds(5) };
            script = await http.GetStringAsync($"http://127.0.0.1:{port}/bridge.js");
        }
        catch (Exception error)
        {
            HostLog.Write($"bridge: /bridge.js could not be read from the sidecar: {error.Message}");
        }

        if (string.IsNullOrWhiteSpace(script)) return;

        try
        {
            await _site.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync(script);
            HostLog.Write($"bridge: /bridge.js injected into every frame of the site view ({script.Length} chars)");
        }
        catch (Exception error)
        {
            HostLog.Write($"bridge: injection failed: {error.Message}");
        }
    }

    /// <summary>
    /// ADR-038's page mode, as ADR-047 amends it: the site view appears and the
    /// app view becomes the docked column - on the right, or along the bottom when
    /// the window is narrow (T107) - from the form's own client top; the empty
    /// band above it is gone. Called only when the room has a page, and on every
    /// dock change it tells the page it is the column (`data-panel="chat"`,
    /// ADR-047's "the host's dock wins").
    /// </summary>
    private void ShowSiteView()
    {
        if (_site.Visible) return;

        _site.Visible = true;
        // Docking follows Visible, but not before the message returns, so the
        // rectangles the dock logs are the ones the window is about to show.
        // T107: which dock that is depends on the window's width - the app view
        // is the right-hand column when wide and the bottom one when narrow.
        // T129: the formula's guess is quiet and provisional, so the site view is
        // never left with no room for a frame; the page's own width (T121) lands
        // through PublishLayout and its shape is the one logged.
        ApplyPageDock(CurrentLayout(), quiet: true);
        PublishLayout();
        SettleLayout();
    }

    /// <summary>
    /// T26 and ADR-038's other half: with no page there is no site view. The room
    /// took a file, so the pane goes and the app view fills the window exactly as
    /// in M1. The site view is not drawn and its document is unloaded, so nothing
    /// of the page is left running beside the file; the view is shown and
    /// navigated again only when the room sets another page (03c).
    /// </summary>
    private void HideSiteView()
    {
        if (!_site.Visible) return;

        // ADR-028: a window that was full has no full layout to come back to once
        // the site view is gone, so the exit is taken first and logged as one.
        if (_siteFull) SetFullscreenLayout(false);

        _site.Visible = false;
        // The app view takes the whole window back (ADR-038's file-mode picture).
        _page.Dock = DockStyle.Fill;
        // T107: page mode is over, so the next page mode logs its own shape line.
        _pageDockShape = null;
        // Docking follows Visible, but not before the message returns.
        PerformLayout();
        HostLog.Write($"layout: file mode - site view hidden, the {_page.Width} px app view fills the window");
        // T99: the dock changed, so the page stops being the column.
        // T128: publish the host's own post-layout width now, because the page
        // is still the 380 px column for at least one frame after this message
        // returns (the WebView2 content resize is asynchronous) and a read then
        // would publish the column's `narrow` and keep it - nothing changes the
        // form's client size afterwards, so no resize would correct it. The
        // page's own width is ADR-047's measure while the app view fills the
        // window; it gets the last word on the settle tick below.
        PublishLayout(fromHostWidth: true);
        SettleLayout();

        // T26: the player goes with the pane. A hidden engine keeps running its
        // page - its timers, its reports and, if it was playing, its sound - so
        // the site's document is unloaded rather than merely not drawn. The room
        // has no page and this view has nothing of one left; the room's next page
        // navigates it again (`NavigateSite`).
        _siteCleared = true;
        _site.CoreWebView2?.Navigate("about:blank");
    }

    /// <summary>
    /// ADR-028: fullscreen is a layout decision and the app owns it (T08). The
    /// picture fills our window and our UI stays: the app column on the right
    /// stays visible and no window is created. ADR-047 removed the 48 px band
    /// above the site view, so there is nothing left for fullscreen to take or
    /// give back - the dock is the same in both states and only the transition is
    /// recorded. No window is created and the window's state is never touched.
    ///
    /// Two things name the same transition. The page's own intent arrives from
    /// the bridge as a <c>fullscreen</c> message (<see cref="OnFullscreenIntent"/>),
    /// which is the one that fires: the engine refuses the site view's request
    /// (measured twice in this ticket), so <c>ContainsFullScreenElementChanged</c>
    /// never fires for it. That event is still honoured once when it does fire -
    /// in the app view it does - and the layout state below is what stops one
    /// press toggling twice.
    /// </summary>
    private void InstallFullscreenIntercept()
    {
        // The site view alone (ADR-038): the app view's own page is ours, and it
        // can no more go fullscreen than it can navigate.
        _site.CoreWebView2.ContainsFullScreenElementChanged += OnSiteFullScreenChanged;
        HostLog.Write("site: fullscreen intercept installed; the app owns the layout, no window, no window state");
    }

    /// <summary>
    /// The engine's half of the trigger (T08 item 3). It says what is true, not
    /// what to do, so it is idempotent: the page's intent may have filled the
    /// layout a moment before the engine agreed, and that must not toggle back.
    /// </summary>
    private void OnSiteFullScreenChanged(object? sender, object e)
    {
        SetFullscreenLayout(_site.CoreWebView2.ContainsFullScreenElement);
    }

    /// <summary>
    /// One <c>fullscreen</c> message from a frame of the site view: the page
    /// asking to go fullscreen, or to come back (T08 items 1 and 2). It is obeyed
    /// whether or not the engine granted the request - owning the layout is the
    /// point of ADR-028 - and it is never relayed to the app view.
    ///
    /// A press toggles: an <c>enter</c> while the layout is already full gives it
    /// back. The one exception is a second <c>enter</c> inside
    /// <see cref="FullscreenEchoMs"/>, the same press heard twice, which leaves
    /// the layout where it is.
    /// </summary>
    private void OnFullscreenIntent(string json)
    {
        // No site view, no layout to own: an intent from a hidden view is noise.
        if (!_site.Visible) return;

        string? state;
        try
        {
            using JsonDocument message = JsonDocument.Parse(json);
            state = StringField(message.RootElement, "state");
        }
        catch (JsonException)
        {
            return;
        }

        if (state == "enter")
        {
            bool echo = _siteFull && (DateTime.UtcNow - _siteFullAt).TotalMilliseconds < FullscreenEchoMs;
            if (echo) return;
            SetFullscreenLayout(!_siteFull);
        }
        else if (state == "exit")
        {
            SetFullscreenLayout(false);
        }
    }

    /// <summary>
    /// The one place the fullscreen layout changes (T08 item 4), so there is one
    /// line per transition and never two for one press. The sizes are read after
    /// <c>PerformLayout</c>, which is what makes them describe the layout being
    /// announced rather than the one before it — a check can be read from the log
    /// without eyes on the window.
    /// </summary>
    private void SetFullscreenLayout(bool full)
    {
        if (full == _siteFull) return;

        _siteFull = full;
        _siteFullAt = DateTime.UtcNow;
        // ADR-047: the band above the site view is gone, so the dock is the same
        // in both states. Laid out anyway, so the sizes logged below are the ones
        // the window shows.
        PerformLayout();

        HostLog.Write($"site: fullscreen={(full ? "enter" : "exit")} w={_site.Width} h={_site.Height}");
    }

    private void OnNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        HostLog.Write(
            $"navigation completed {_page.CoreWebView2.Source} success={e.IsSuccess} " +
            $"status={e.HttpStatusCode} error={e.WebErrorStatus}");
        // T94, ADR-047: a new document has neither the attribute nor the
        // variable, so the window tells it again rather than waiting for a resize.
        PublishLayout(afterLoad: true);
#if DEBUG
        _appLoaded = true;
        MaybeRunRelaySelfTest();
#endif
    }

    private void OnSiteNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        // T26: the blank document HideSiteView loads is the host's own teardown,
        // not a site navigation, so it borrows no popup's count and writes nothing.
        if (_siteCleared) return;
        // T04: a navigation is the unit the count is reported in, so the tally
        // restarts here, before the new document asks for anything.
        _siteCancelled = 0;
        _siteCancelledHosts.Clear();
        // T04b: and it is the unit a popup notice is said once in.
        _siteNav++;
    }

    private void OnSiteNavigationCompleted(object? sender, CoreWebView2NavigationCompletedEventArgs e)
    {
        // T26: the cleared view's blank document (see HideSiteView) says nothing.
        if (_siteCleared) return;
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

    /// <summary>
    /// T94, ADR-047 ("one threshold, owned by the host"): the form's client width
    /// in CSS pixels, turned into the page's two layout names.
    ///
    /// T121: it is not exact. The client width times 96/dpi is a whole number with
    /// its own rounding while the page's viewport is the WebView2 view's width, and
    /// at a fractional scaling the two are a pixel apart (measured 2026-11-24 on
    /// 125%: outer 1142 is 900 CSS px on the page and 899 here).
    ///
    /// T129: so this is the **provisional** shape and the fallback - the dock the
    /// window puts on while the page's own width is being read, and the one it
    /// keeps when the page cannot answer. The settled shape comes from
    /// <see cref="ReadWindowCssWidth"/> in both modes, page mode included; the
    /// formula is never the answer when the page can speak.
    /// </summary>
    private string CurrentLayout()
    {
        // The form's client width in CSS pixels, which is what the page sees as
        // innerWidth when it fills the window (ADR-047). Not the app view's width,
        // which is the docked column at every window size, and not the outer
        // width, which the border and - at any scaling but 100% - the DPI factor
        // keep apart from it.
        int dpi = DeviceDpi;
        int cssWidth = dpi > 0 ? (int)Math.Round(ClientSize.Width * 96.0 / dpi) : ClientSize.Width;
        return LayoutFor(cssWidth);
    }

    /// <summary>
    /// T94, ADR-047 ("one threshold, owned by the host"): a width in CSS pixels
    /// turned into the page's two layout names. The one comparison, shared by the
    /// formula's provisional answer and the page's own width, so the fallback and
    /// the measure can never disagree about where 900 px is.
    /// </summary>
    private static string LayoutFor(int cssWidth) =>
        cssWidth >= WideLayoutMinCssWidth ? "wide" : "narrow";

    /// <summary>
    /// T121, ADR-047 ("the form's client width in CSS pixels ... which is what the
    /// page sees as innerWidth"): the width the page actually has, asked from the
    /// page - <c>window.innerWidth</c>, the same number a check reads. Only
    /// meaningful for a view that fills the window; <see cref="ReadWindowCssWidth"/>
    /// is what callers want in page mode, where this view is the docked column.
    /// </summary>
    private Task<int?> ReadPageCssWidth() => ReadViewCssWidth(_page, "page");

    /// <summary>
    /// One view's <c>window.innerWidth</c>, or null when it cannot be read so the
    /// caller keeps the client-width formula. A failure is one log line, never a
    /// thrown resize.
    /// </summary>
    private async Task<int?> ReadViewCssWidth(WebView2 view, string name)
    {
        if (_closing || view.CoreWebView2 is null) return null;
        try
        {
            // ExecuteScriptAsync hands back the value as JSON; innerWidth is
            // always a whole number of CSS pixels, so the JSON is that number.
            string raw = await view.CoreWebView2.ExecuteScriptAsync("window.innerWidth");
            return int.TryParse(raw, out int width) && width > 0 ? width : null;
        }
        catch (Exception error)
        {
            HostLog.Write($"layout: could not read the {name}'s width: {error.Message}");
            return null;
        }
    }

    /// <summary>
    /// T129, ADR-047 ("One threshold, owned by the host ... In page mode the
    /// measure is the window's own width"): the window's width in CSS pixels,
    /// asked of the page and the same number the published attribute uses - in
    /// page mode as well as file mode. In file mode the app view fills the window,
    /// so it is that view's own viewport (T121). In page mode the two views tile
    /// the client area with nothing beside them: the site view takes the whole
    /// width when the app view is docked along the bottom (T107's narrow shape),
    /// and the width less the column when it is docked on the right, so adding the
    /// app view's viewport to the site's is the window's width in either shape.
    /// Null when the views cannot answer, and the caller keeps the formula.
    /// </summary>
    private async Task<int?> ReadWindowCssWidth()
    {
        if (!_site.Visible) return await ReadPageCssWidth();

        int? site = await ReadViewCssWidth(_site, "site view");
        if (site is null) return null;
        if (_page.Dock != DockStyle.Right) return site;

        int? column = await ReadViewCssWidth(_page, "app view");
        return column is null ? null : site + column;
    }

    /// <summary>
    /// T107, ADR-047 ("window narrower than 900 px"): in page mode the dock has two
    /// shapes. Wide is T99's - the app view is a 380 px column on the right and the
    /// site view takes the rest. Narrow puts the app view along the bottom at
    /// <c>max(240, 40% of the client height)</c> and the site view above it, so the
    /// picture is never squeezed beside the chat. Called on every resize and when
    /// page mode starts; one ASCII line per shape change carries the numbers the
    /// window actually used, read after <see cref="Control.PerformLayout"/>, so a
    /// check can read the log without eyes on the window. Fullscreen does not call
    /// this: it changes nothing but the window's size.
    ///
    /// T129: <paramref name="quiet"/> applies the shape without claiming it, for
    /// the provisional formula pass a resize makes before the page has answered.
    /// The read that follows names the settled shape and writes the one log line,
    /// so a pixel's disagreement between the formula and the page cannot leave a
    /// second, wrong shape in the log.
    /// </summary>
    private void ApplyPageDock(string layout, bool quiet = false)
    {
        // No page mode, no dock to apply; a minimised window has no client area to
        // share and is laid out again when it is restored.
        if (!_site.Visible || WindowState == FormWindowState.Minimized) return;

        if (layout == "narrow")
        {
            int height = Math.Max(
                NarrowDockMinHeight,
                (int)Math.Round(ClientSize.Height * NarrowDockHeightShare));
            _page.Dock = DockStyle.Bottom;
            _page.Height = height;
        }
        else
        {
            _page.Dock = DockStyle.Right;
            _page.Width = SidebarWidth;
        }

        // Docking follows these properties, but not before the message returns, so
        // the rectangles below are the ones the window is about to show.
        PerformLayout();

        if (quiet) return;
        if (layout == _pageDockShape) return;
        _pageDockShape = layout;
        HostLog.Write(layout == "narrow"
            ? $"layout: page mode narrow - site {_site.Width}x{_site.Height} above a {_page.Height} px app view"
            : $"layout: page mode - site {_site.Width}x{_site.Height} left of a {SidebarWidth} px app view");
    }

    /// <summary>
    /// T94, ADR-047 ("one threshold, owned by the host"): the window tells the
    /// page which layout it is and how wide the chat column is, both on the app
    /// view's root element - the page's CSS reads the attribute for the threshold
    /// and the variable for the width and spells neither number itself. Sent on a
    /// change only, and once after the app view loads because a new document has
    /// lost it; a failure is a log line and never stops a resize.
    ///
    /// T99, ADR-047 ("the host's dock wins"): the same script carries
    /// <c>data-panel="chat"</c> while the app view is the docked column, and
    /// removes the attribute when it is not. The page then draws the chat column
    /// alone, and the attribute beats <c>data-layout</c>. Called after every dock
    /// change (<see cref="ShowSiteView"/>, <see cref="HideSiteView"/>) and once
    /// after the app view loads, so a fresh document never paints the wrong
    /// column for a frame.
    ///
    /// T128: <paramref name="fromHostWidth"/> publishes the host's own
    /// post-layout width instead of asking the page. <see cref="HideSiteView"/>
    /// uses it because the app view has just grown from the 380 px column to the
    /// whole window and the page's viewport has not been resized yet; its settle
    /// tick then publishes ADR-047's measure, the page's own width.
    ///
    /// T129: the width is the window's in **both** modes (<see
    /// cref="ReadWindowCssWidth"/>), and the dock's shape is taken from that same
    /// number here rather than from a second copy of it, so the views and the
    /// attribute cannot disagree about which side of 900 px the window is on.
    /// </summary>
    private async void PublishLayout(bool afterLoad = false, bool fromHostWidth = false)
    {
        if (_closing || _page.CoreWebView2 is null) return;

        string layout = CurrentLayout();
        // T121: the page is the measure ADR-047 names, not a width derived from
        // the client size that can be a pixel low. T129: in page mode that is the
        // site view plus the column, because the app view on its own is the
        // column and says nothing about the window.
        int read = ++_layoutRead;
        if (!fromHostWidth)
        {
            int? width = await ReadWindowCssWidth();
            // A newer resize is already reading; it owns the attribute and the dock.
            if (read != _layoutRead || _closing) return;
            if (width is int cssWidth) layout = LayoutFor(cssWidth);
        }

        // Before the change gate: a shape that corrects inside one published
        // layout must still move the views (T129).
        ApplyPageDock(layout);

        // The host's dock, not the width, decides the panel (ADR-047): a page-mode
        // window is the column at every width, so the page must not fall back to
        // its picture-and-chat layout because the window is narrow.
        string? panel = _site.Visible ? "chat" : null;
        if (!afterLoad && layout == _publishedLayout && panel == _publishedPanel) return;

        // Claimed before the await: a second change while this one runs publishes
        // nothing, and a failure gives the value back so the next resize retries.
        string? previous = _publishedLayout;
        string? previousPanel = _publishedPanel;
        _publishedLayout = layout;
        _publishedPanel = panel;
        // The one column width travels with it, from the same constant the dock
        // uses, so the page's chat column and the host's app view cannot drift
        // apart (ADR-047, "one column width, owned by the host too").
        string script =
            "(()=>{const r=document.documentElement;"
            + $"r.dataset.layout='{layout}';"
            + (panel is null ? "delete r.dataset.panel;" : $"r.dataset.panel='{panel}';")
            + $"r.style.setProperty('--chat-column','{SidebarWidth}px');}})();";
        try
        {
            await _page.CoreWebView2.ExecuteScriptAsync(script);
            if (layout != previous)
            {
                // The window's own size, which is what the camera asks for and
                // prints; the threshold above reads the window's width from the
                // page in both modes - the app view's own viewport when it fills
                // the window, the site view plus the column when it is docked
                // (T121, T129) - and takes the client-width formula only when the
                // page cannot answer. One line per change, never per pixel.
                HostLog.Write($"layout: window {Width}x{Height} {layout}");
            }
        }
        catch (Exception error)
        {
            _publishedLayout = previous;
            _publishedPanel = previousPanel;
            HostLog.Write($"layout: could not tell the page: {error.Message}");
        }
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

    /// <summary>
    /// T128: the app view has had the whole window for a moment now, so the page
    /// has been resized and <c>window.innerWidth</c> is the width ADR-047 says to
    /// measure. One publish; the change gate keeps it to one line and to nothing
    /// at all when the host's width already gave the same answer.
    ///
    /// T129: the same tick is how a resize settles in page mode. The views are
    /// resized in the message, but WebView2 resizes its content afterwards, so a
    /// width read in the same message can still be the old one; this is the read
    /// that gets the last word on both the dock's shape and the attribute.
    /// </summary>
    private void OnLayoutSettle(object? sender, EventArgs e)
    {
        _layoutSettle.Stop();
        PublishLayout();
    }

    /// <summary>
    /// T129: asks again once the views' own contents have caught up with the
    /// resize that just happened. Restarted on every resize rather than left to
    /// fire, so a drag makes one settled read at its end and none in between.
    /// </summary>
    private void SettleLayout()
    {
        _layoutSettle.Stop();
        _layoutSettle.Start();
    }

    /// <summary>
    /// ADR-043, T46c item 3: the folder cannot be written, so nothing - not even
    /// the log - can be created. The one plain sentence is drawn on the window
    /// itself and the window stops there, rather than half-running.
    /// </summary>
    private void ShowFolderSentence(string sentence)
    {
        ShowSentence(sentence);
    }

    /// <summary>
    /// The one plain sentence drawn on a window no view can draw in: the title and
    /// the body both name it, so it is legible and can be photographed. Used by the
    /// folder failure (T46c), the no-engine failure (T47b) and every other failure
    /// page (T114).
    /// </summary>
    private void ShowSentence(string sentence)
    {
        Text = sentence;
        _page.Visible = false;
        _site.Visible = false;
        Label notice = new()
        {
            Dock = DockStyle.Fill,
            TextAlign = ContentAlignment.MiddleCenter,
            ForeColor = Color.FromArgb(0xE9, 0xE9, 0xEF),
            BackColor = Color.FromArgb(0x14, 0x15, 0x1A),
            Font = new Font("Segoe UI", 12f),
            Padding = new Padding(32),
            Text = sentence,
        };
        Controls.Add(notice);
        notice.BringToFront();
    }

    /// <summary>
    /// ADR-043 ("a copy that fails says so") and ADR-034: the sentence is drawn by
    /// the host, never by the room's page. It goes on the window itself, exactly as
    /// the folder and no-engine failures do (T46c, T47b).
    ///
    /// T114, measured: <c>NavigateToString</c> produces a <c>data:</c> document,
    /// and the app view's navigation lock contradicts it - the sentence was logged
    /// as `failure page:` and then refused as
    /// `app-view navigation refused text/html;charset=utf-8;base64,...`, so nobody
    /// saw it. Widening the lock to <c>data:</c> would let the room's own page
    /// navigate there too. Drawing it here needs no navigation at all: the lock
    /// keeps its single rule (the sidecar's origin, ADR-038), and a dead sidecar
    /// leaves the room's page nothing to say. The window still waits for the person
    /// to close it, and closing it still exits at once.
    /// </summary>
    private void ShowFailure(string sentence)
    {
        HostLog.Write($"failure page: {sentence}");
        ShowSentence(sentence);
    }

    /// <summary>
    /// T93, ADR-047 ("window size"): the first launch of a copy is maximised;
    /// after that the window reopens at the rectangle and state it was closed at,
    /// clamped to the virtual screen that exists and never smaller than the
    /// existing <see cref="Form.MinimumSize"/>, and falls back to maximised when
    /// the saved rectangle is off every screen. One ASCII log line per launch.
    /// </summary>
    private void RestoreWindowState()
    {
        WindowPlacement.Saved? saved = _profileFolder is null
            ? null
            : WindowPlacement.TryRead(WindowPlacement.PathIn(_profileFolder));

        if (saved is null)
        {
            WindowState = FormWindowState.Maximized;
            HostLog.Write("window: first run maximised");
            return;
        }

        Rectangle rectangle = new(saved.X, saved.Y, saved.Width, saved.Height);
        if (!Screen.AllScreens.Any(screen => screen.Bounds.IntersectsWith(rectangle)))
        {
            // The screen that held it is gone, and off-screen would hide the
            // window: it opens the way a first run does.
            WindowState = FormWindowState.Maximized;
            HostLog.Write($"window: restored {rectangle.Width}x{rectangle.Height} maximised=true "
                + "(the saved rectangle was off every screen)");
            return;
        }

        Rectangle allowed = ClampToVirtualScreen(rectangle);
        StartPosition = FormStartPosition.Manual;
        Bounds = allowed;
        if (saved.Maximised) WindowState = FormWindowState.Maximized;
        HostLog.Write($"window: restored {allowed.Width}x{allowed.Height} "
            + $"maximised={saved.Maximised.ToString().ToLowerInvariant()}");
    }

    /// <summary>
    /// T93 item 2: a saved rectangle never hides the window on a smaller monitor
    /// and is never smaller than <see cref="Form.MinimumSize"/>.
    /// </summary>
    private Rectangle ClampToVirtualScreen(Rectangle rectangle)
    {
        Rectangle screen = SystemInformation.VirtualScreen;
        int minWidth = MinimumSize.Width;
        int minHeight = MinimumSize.Height;
        int width = Math.Clamp(rectangle.Width, minWidth, Math.Max(screen.Width, minWidth));
        int height = Math.Clamp(rectangle.Height, minHeight, Math.Max(screen.Height, minHeight));
        int x = Math.Clamp(rectangle.X, screen.Left, Math.Max(screen.Left, screen.Right - width));
        int y = Math.Clamp(rectangle.Y, screen.Top, Math.Max(screen.Top, screen.Bottom - height));
        return new Rectangle(x, y, width, height);
    }

    /// <summary>
    /// T93: remember the rectangle and state the window is closed at. A maximised
    /// close saves <see cref="Form.RestoreBounds"/> - the normal rectangle it must
    /// come back from - and the fact it was maximised. One ASCII log line says
    /// what was saved; nothing here can refuse the close. T113: when the window
    /// holds a room, the close is held back by one bounded goodbye instead, so the
    /// sidecar can say the room ended before it stops (ADR-047). T127: that wait
    /// belongs to the window in its **own** room; a guest's close is immediate.
    /// </summary>
    private void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        // The close this class asked for once the goodbye finished.
        if (_goodbyeDone) return;

        // A second click while the room is saying goodbye: wait for the close the
        // goodbye itself makes, rather than cutting it short.
        if (_goodbyeStarted)
        {
            e.Cancel = true;
            return;
        }

        if (_profileFolder is not null)
        {
            Rectangle rectangle = WindowState == FormWindowState.Normal ? Bounds : RestoreBounds;
            if (rectangle.Width <= 0 || rectangle.Height <= 0) rectangle = Bounds;
            bool maximised = WindowState == FormWindowState.Maximized;
            string file = WindowPlacement.PathIn(_profileFolder);
            WindowPlacement.Write(file,
                new WindowPlacement.Saved(rectangle.X, rectangle.Y, rectangle.Width, rectangle.Height, maximised));
            HostLog.Write($"window: saved {rectangle.Width}x{rectangle.Height} "
                + $"maximised={maximised.ToString().ToLowerInvariant()} at {file}");
        }

        // T113, ADR-047 ("room end"): the evening ends in the room's own words, so
        // the page's socket closes while the sidecar still runs and the sidecar
        // gets to broadcast its one `roomOver` frame before it stops. A person
        // closing the window takes this route: a click on the close box arrives as
        // `UserClosing`, and a posted WM_CLOSE as `TaskManagerClosing` (measured -
        // `Process.CloseMainWindow()` reports that one). Windows shutting the
        // session down is on a clock and gets no goodbye, and a window with no room
        // on screen (no port yet, or the fault path, where the sidecar is already
        // gone) simply closes.
        HostLog.Write($"closing: reason={e.CloseReason} appPort={(_appPort?.ToString() ?? "none")} "
            + $"sidecar={(_sidecar is null ? "none" : _sidecar.HasExited ? "exited" : "running")} "
            + $"engine={(_page.CoreWebView2 is not null).ToString().ToLowerInvariant()}");
        if (e.CloseReason is CloseReason.WindowsShutDown or CloseReason.None) return;
        if (_appPort is null || _sidecar is null || _sidecar.HasExited || _page.CoreWebView2 is null) return;

        // T127: only the room's owner's window hears `[room] over` when its page
        // unloads; a guest's own sidecar never says it (`src/server/room.ts` has no
        // owner), so waiting there is 1,500 ms spent on a line that cannot come.
        // The page says which window this is - a window-local fact like
        // `data-layout`, never room state (ADR-034). The sidecar still stops in
        // OnFormClosed either way.
        if (!_ownRoomOpen)
        {
            HostLog.Write("closing: no room of this window's own to end; the close does not wait");
            return;
        }

        e.Cancel = true;
        _goodbyeStarted = true;
        HostLog.Write("closing: window closing; the room speaks before the sidecar stops");
        _ = EndRoomThenCloseAsync();
    }

    /// <summary>
    /// T113, ADR-047 ("room end"): unload the room's page while its sidecar is
    /// still running, so the owner's socket closes, the sidecar broadcasts its one
    /// <c>roomOver</c> frame to every guest and closes their sockets, and only then
    /// does the form close (and, in <see cref="OnFormClosed"/>, the sidecar stop).
    /// The wait is bounded by <see cref="RoomGoodbyeBudgetMs"/>; a goodbye that
    /// never arrives is a log line, not a hung window.
    /// </summary>
    private async Task EndRoomThenCloseAsync()
    {
        try
        {
            // about:blank is what the app view's navigation lock allows besides the
            // sidecar's own origin, and the unload is what closes the socket.
            _page.CoreWebView2?.Navigate("about:blank");
            await Task.WhenAny(_roomOverSpoken.Task, Task.Delay(RoomGoodbyeBudgetMs));
            HostLog.Write(_roomOverSpoken.Task.IsCompleted
                ? "closing: the room said its goodbye"
                : $"closing: the room said no goodbye inside {RoomGoodbyeBudgetMs} ms");
        }
        catch (Exception error)
        {
            HostLog.Write($"closing: the room could not say goodbye: {error.Message}");
        }
        finally
        {
            _goodbyeDone = true;
            if (!IsDisposed && IsHandleCreated) BeginInvoke(Close);
        }
    }

    private void OnFormClosed(object? sender, FormClosedEventArgs e)
    {
        _closing = true;
        _portTimeout.Stop();
        _layoutSettle.Stop();
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
