using System;
using System.Diagnostics;
using System.IO;
using System.Linq;

internal static class InjectVencord
{
    private const string Workspace = @"D:\Projects\Vencord";

    private static int Main(string[] args)
    {
        bool checkOnly = args.Length == 1 && args[0] == "--check";
        int result = 0;
        try
        {
            if (args.Length != 0 && !checkOnly)
                throw new InvalidOperationException("Usage: InjectVencord.exe [--check]");

            string installer = Path.Combine(Workspace, @"dist\Installer\VencordInstallerCli.exe");
            if (!File.Exists(installer))
                throw new FileNotFoundException("The Vencord installer is missing.", installer);

            foreach (string bundle in new[] { "renderer.js", "patcher.js" })
            {
                string file = Path.Combine(Workspace, "dist", bundle);
                if (!File.Exists(file) || !File.ReadAllText(file).Contains("NotificationOverlay"))
                    throw new InvalidOperationException("NotificationOverlay is missing from " + file + ". Run pnpm build in the workspace first.");
            }

            var startInfo = new ProcessStartInfo(installer, "-install -branch ptb")
            {
                WorkingDirectory = Workspace,
                UseShellExecute = false
            };
            startInfo.EnvironmentVariables["VENCORD_USER_DATA_DIR"] = Workspace;
            startInfo.EnvironmentVariables["VENCORD_DEV_INSTALL"] = "1";

            Console.Title = "InjectVencord - Discord PTB repair";
            Console.WriteLine("Discord PTB repair");
            Console.WriteLine("Workspace: " + startInfo.WorkingDirectory);
            Console.WriteLine("Installer: " + startInfo.FileName);
            Console.WriteLine("Arguments: " + startInfo.Arguments);
            Console.WriteLine("VENCORD_USER_DATA_DIR=" + startInfo.EnvironmentVariables["VENCORD_USER_DATA_DIR"]);
            Console.WriteLine("VENCORD_DEV_INSTALL=" + startInfo.EnvironmentVariables["VENCORD_DEV_INSTALL"]);

            if (checkOnly)
            {
                Console.WriteLine("PASS: installer and overlay bundles are available. No changes made.");
                return 0;
            }

            Console.WriteLine();
            Console.WriteLine("Fully quit Discord PTB before continuing. Stable will not be modified.");
            Console.WriteLine("Press Enter to repair PTB, or close this window to cancel.");
            if (Console.ReadLine() == null)
                return 1;

            using (Process installerProcess = Process.Start(startInfo))
            {
                installerProcess.WaitForExit();
                if (installerProcess.ExitCode != 0)
                    throw new InvalidOperationException("The installer failed. See its output above. Quit PTB completely before retrying.");
            }

            VerifyLoader();
            Console.WriteLine();
            Console.WriteLine("SUCCESS: Discord PTB now loads the workspace build with NotificationOverlay.");
            Console.WriteLine("Reopen Discord PTB. Enable NotificationOverlay in the plugin list if needed.");
        }
        catch (Exception error)
        {
            Console.Error.WriteLine("ERROR: " + error.Message);
            result = 1;
        }

        if (!checkOnly && !Console.IsInputRedirected)
        {
            Console.WriteLine("Press any key to close.");
            Console.ReadKey(true);
        }
        return result;
    }

    private static void VerifyLoader()
    {
        string clientRoot = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "DiscordPTB");
        string app = Directory.GetDirectories(clientRoot, "app-*")
            .OrderByDescending(directory => new Version(Path.GetFileName(directory).Substring(4)))
            .FirstOrDefault();
        if (app == null)
            throw new InvalidOperationException("No Discord PTB app directory was found.");

        string bootstrap = Path.Combine(app, @"resources\app.asar");
        string patcher = Path.Combine(Workspace, @"dist\patcher.js").Replace("\\", "\\\\");
        if (!File.Exists(bootstrap) || new FileInfo(bootstrap).Length > 1024 * 1024
            || !File.ReadAllText(bootstrap).Contains("require(\"" + patcher + "\")"))
            throw new InvalidOperationException("The PTB loader was not updated to this workspace. Review the installer output above and quit PTB completely before retrying.");

        Console.WriteLine("Verified loader: " + bootstrap);
    }
}