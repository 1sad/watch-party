namespace WatchParty.Host;

internal static class Program
{
    /// <summary>
    /// <paramref name="args"/> is how a clicked <c>watchparty://</c> link arrives:
    /// Windows runs <c>"&lt;exe&gt;" "%1"</c>, so the whole link is one argument
    /// that the window forwards to the page (T2b).
    /// </summary>
    [STAThread]
    private static void Main(string[] args)
    {
        Application.SetHighDpiMode(HighDpiMode.PerMonitorV2);
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        Application.Run(new MainForm(args));
    }
}
