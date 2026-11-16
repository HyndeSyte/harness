// pcw-jobrun: the PC worker's Windows containment helper. One file of C#, compiled once on
// the PC with the .NET Framework's own compiler (csc.exe, part of Windows), by the worker
// itself (worker.ts, ensureJobHelper), into the worker folder.
//
//   pcw-jobrun.exe run <program> [args...]
//     Puts itself in a new Windows Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and
//     without JOB_OBJECT_LIMIT_BREAKAWAY_OK or JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK, then
//     starts <program> with its own standard input, output and error. Every process the
//     program starts, and every process those start, is in the job; none can leave it (a
//     CreateProcess asking to break away fails). When the program exits, the helper exits
//     with its exit code, and Windows ends whatever is still in the job as the job's last
//     handle closes. When the helper is ended (the worker's timeout, STOP or exit handler),
//     the same happens at once: a detached grandchild whose parent already exited is
//     ended too, which a process-tree kill can miss.
//   pcw-jobrun.exe holders <path> [paths...]
//     Asks the Restart Manager which processes hold any of the files, and prints one line
//     per process: "<pid> <parent pid> <image name>". Nothing else. Exit 0 when it could ask
//     (no lines: none found), 1 when it couldn't.
//   pcw-jobrun.exe version
//     Prints the helper's protocol version.
//
// Exit codes of its own: 120 (bad arguments), 121 (the job object couldn't be made or
// joined), 122 (the program couldn't be started). The worker reads 121 and 122 as
// containment_unavailable.
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class PcwJobRun {
  const string VERSION = "pcw-jobrun 1";

  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_BASIC_LIMIT_INFORMATION {
    public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags;
    public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit;
    public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IO_COUNTERS { public ulong a, b, c, d, e, f; }
  [StructLayout(LayoutKind.Sequential)]
  struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION {
    public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation; public IO_COUNTERS IoInfo;
    public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed;
  }
  const int JobObjectExtendedLimitInformation = 9;
  const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();

  // The Restart Manager, for "holders".
  [StructLayout(LayoutKind.Sequential)]
  struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct RM_PROCESS_INFO {
    public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)] public string strAppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable;
  }
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmStartSession(out uint handle, int flags, StringBuilder key);
  [DllImport("rstrtmgr.dll")]
  static extern int RmEndSession(uint handle);
  [DllImport("rstrtmgr.dll", CharSet = CharSet.Unicode)]
  static extern int RmRegisterResources(uint handle, uint nFiles, string[] files, uint nApps, RM_UNIQUE_PROCESS[] apps, uint nServices, string[] services);
  [DllImport("rstrtmgr.dll")]
  static extern int RmGetList(uint handle, out uint needed, ref uint count, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);

  // One argument, quoted the way CommandLineToArgvW reads it back.
  static string Quote(string a) {
    if (a.Length > 0 && a.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0) return a;
    var sb = new StringBuilder("\"");
    for (int i = 0; i < a.Length; i++) {
      int slashes = 0;
      while (i < a.Length && a[i] == '\\') { slashes++; i++; }
      if (i == a.Length) { sb.Append('\\', slashes * 2); break; }
      if (a[i] == '"') { sb.Append('\\', slashes * 2 + 1); sb.Append('"'); }
      else { sb.Append('\\', slashes); sb.Append(a[i]); }
    }
    return sb.Append('"').ToString();
  }

  static int Run(string[] args) {
    if (args.Length < 2) return 120;
    IntPtr job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { Console.Error.WriteLine("pcw-jobrun: no job object"); return 121; }
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    // Kill on close, and nothing else: no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK.
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
      Console.Error.WriteLine("pcw-jobrun: job limits refused"); return 121;
    }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) { Console.Error.WriteLine("pcw-jobrun: couldn't join the job"); return 121; }
    var rest = new List<string>();
    for (int i = 2; i < args.Length; i++) rest.Add(Quote(args[i]));
    var psi = new ProcessStartInfo(args[1], string.Join(" ", rest.ToArray())) { UseShellExecute = false };
    Process p;
    try { p = Process.Start(psi); } catch (Exception) { Console.Error.WriteLine("pcw-jobrun: couldn't start the program"); return 122; }
    if (p == null) return 122;
    p.WaitForExit();
    // The job's handle closes as this process exits: Windows ends whatever is left in it.
    GC.KeepAlive(job);
    return p.ExitCode;
  }

  static int Holders(string[] args) {
    if (args.Length < 2) return 120;
    var files = new string[args.Length - 1];
    Array.Copy(args, 1, files, 0, files.Length);
    uint h;
    if (RmStartSession(out h, 0, new StringBuilder(64)) != 0) return 1;
    try {
      if (RmRegisterResources(h, (uint)files.Length, files, 0, null, 0, null) != 0) return 1;
      uint needed = 0, count = 0, reasons = 0;
      int r = RmGetList(h, out needed, ref count, null, ref reasons);
      if (r == 0) return 0;
      if (r != 234) return 1;            // ERROR_MORE_DATA: there are holders
      var list = new RM_PROCESS_INFO[needed];
      count = needed;
      if (RmGetList(h, out needed, ref count, list, ref reasons) != 0) return 1;
      for (int i = 0; i < count; i++) {
        int pid = list[i].Process.dwProcessId;
        string image = "unknown"; int parent = -1;
        try { image = Process.GetProcessById(pid).ProcessName + ".exe"; } catch (Exception) { }
        parent = ParentOf(pid);
        Console.WriteLine(pid + " " + parent + " " + image.Replace(' ', '_'));
      }
      return 0;
    } finally { RmEndSession(h); }
  }

  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_BASIC_INFORMATION { public IntPtr r1; public IntPtr peb; public IntPtr r2a; public IntPtr r2b; public IntPtr pid; public IntPtr parent; }
  [DllImport("ntdll.dll")]
  static extern int NtQueryInformationProcess(IntPtr process, int cls, ref PROCESS_BASIC_INFORMATION info, int size, out int got);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll")]
  static extern bool CloseHandle(IntPtr h);
  static int ParentOf(int pid) {
    IntPtr h = OpenProcess(0x1000, false, pid);   // PROCESS_QUERY_LIMITED_INFORMATION
    if (h == IntPtr.Zero) return -1;
    try {
      var pbi = new PROCESS_BASIC_INFORMATION(); int got;
      return NtQueryInformationProcess(h, 0, ref pbi, Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION)), out got) == 0 ? pbi.parent.ToInt32() : -1;
    } finally { CloseHandle(h); }
  }

  public static int Main(string[] args) {
    if (args.Length == 0) return 120;
    switch (args[0]) {
      case "run": return Run(args);
      case "holders": return Holders(args);
      case "version": Console.WriteLine(VERSION); return 0;
      default: return 120;
    }
  }
}
