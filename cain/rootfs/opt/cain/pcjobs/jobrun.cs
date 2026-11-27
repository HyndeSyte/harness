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
//     ended too, which a process-tree kill can miss. After joining, and before it starts
//     anything, it reads the job back (IsProcessInJob, QueryInformationJobObject): it must be
//     in that very job, with kill-on-close set and neither breakaway flag; otherwise it
//     starts nothing and exits 121.
//   pcw-jobrun.exe holders <path> [paths...]
//     Asks the Restart Manager which processes hold any of the files, and prints one line
//     per process: "<pid> <parent pid> <image name>". Nothing else. Exit 0 when it could ask
//     (no lines: none found), 1 when it couldn't.
//   pcw-jobrun.exe inspect
//     The probe's read-back check (job_readback): prints "outer=<0|1> readback=<ok|failed>",
//     whether it already ran inside an outer job and whether its own job, made, joined and
//     read back as a run's is, held there. Starts nothing. Exit 0 when it held, 121 when not.
//   pcw-jobrun.exe edge-launch <worker pid> <msedge.exe> [args...]   (Cain 0.20.0)
//     Starts the jobs Edge with --remote-debugging-pipe's two pipes and no other handle. Both
//     anonymous pipes are made non-inheritable; Edge's two ends (the read end of the worker-to-Edge
//     pipe, the write end of the Edge-to-worker pipe) are made inheritable only for the one
//     CreateProcess call, which lists exactly those two in PROC_THREAD_ATTRIBUTE_HANDLE_LIST and
//     passes them as CRT file descriptors 3 and 4 in STARTUPINFO's lpReserved2 (Edge's C runtime
//     turns the descriptors into handles; no handle value is passed on its command line). The
//     helper closes its copies of Edge's ends at once, then hands the worker's two ends to the
//     worker by DuplicateHandle into the worker's process, not inheritable, and only when the
//     worker's process id is this helper's parent. It prints one line,
//     {"pid":<Edge's pid>,"read":<h>,"write":<h>,"edge_read":<h>,"edge_write":<h>}, the first two
//     valid in the worker, the last two in Edge (what pipe-scan compares against), and exits 0;
//     123 when Edge couldn't be started that way, 124 when the hand-off failed (Edge is ended).
//   pcw-jobrun.exe pipe-scan <worker pid> <h> <h> <edge pid> <h> <h> -- <pid> [pid...]   (Cain 0.20.0)
//     Every handle the system lists for the given processes (the claude.exe tree), duplicated into
//     this helper and compared as an object (CompareObjectHandles) with the four pipe ends (the
//     worker's two, duplicated from the worker, and Edge's two, from Edge). Prints
//     {"handles":<n>,"hits":[{"pid":<p>,"handle":"<h>"}],"undup":<n>} and exits 0; 1 when it
//     couldn't read the system's handle list or a pipe end.
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
  const string VERSION = "pcw-jobrun 4";

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
  const uint JOB_OBJECT_LIMIT_BREAKAWAY_OK = 0x0800;
  const uint JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK = 0x1000;

  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern IntPtr CreateJobObject(IntPtr attrs, string name);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool SetInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")]
  static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool QueryInformationJobObject(IntPtr job, int cls, ref JOBOBJECT_EXTENDED_LIMIT_INFORMATION info, uint size, out uint got);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);

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

  // Makes the job, joins it and reads it back (in this job, kill on close, no breakaway of
  // either kind): 0 with the job, or 121.
  static int MakeJob(out IntPtr job) {
    job = CreateJobObject(IntPtr.Zero, null);
    if (job == IntPtr.Zero) { Console.Error.WriteLine("pcw-jobrun: no job object"); return 121; }
    var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION();
    // Kill on close, and nothing else: no BREAKAWAY_OK, no SILENT_BREAKAWAY_OK.
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    if (!SetInformationJobObject(job, JobObjectExtendedLimitInformation, ref info, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)))) {
      Console.Error.WriteLine("pcw-jobrun: job limits refused"); return 121;
    }
    if (!AssignProcessToJobObject(job, GetCurrentProcess())) { Console.Error.WriteLine("pcw-jobrun: couldn't join the job"); return 121; }
    // Read it back: in this job, kill on close, no breakaway of either kind.
    bool inJob;
    if (!IsProcessInJob(GetCurrentProcess(), job, out inJob) || !inJob) { Console.Error.WriteLine("pcw-jobrun: not in the job"); return 121; }
    var back = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION(); uint got;
    if (!QueryInformationJobObject(job, JobObjectExtendedLimitInformation, ref back, (uint)Marshal.SizeOf(typeof(JOBOBJECT_EXTENDED_LIMIT_INFORMATION)), out got)) {
      Console.Error.WriteLine("pcw-jobrun: job limits unreadable"); return 121;
    }
    uint flags = back.BasicLimitInformation.LimitFlags;
    if ((flags & JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE) == 0 || (flags & (JOB_OBJECT_LIMIT_BREAKAWAY_OK | JOB_OBJECT_LIMIT_SILENT_BREAKAWAY_OK)) != 0) {
      Console.Error.WriteLine("pcw-jobrun: job allows breakaway"); return 121;
    }
    return 0;
  }

  // The probe's read-back check: whether this process already ran inside a job (an outer
  // one: a terminal, a scheduler or a CI runner can put it there), then the same job, join
  // and read-back a run does. Prints one line, "outer=<0|1> readback=<ok|failed>"; exit 0
  // when the read-back held, 121 when it didn't. Starts nothing.
  static int Inspect() {
    bool outer;
    if (!IsProcessInJob(GetCurrentProcess(), IntPtr.Zero, out outer)) outer = false;
    IntPtr job;
    int r = MakeJob(out job);
    Console.WriteLine("outer=" + (outer ? "1" : "0") + " readback=" + (r == 0 ? "ok" : "failed"));
    GC.KeepAlive(job);
    return r;
  }

  static int Run(string[] args) {
    if (args.Length < 2) return 120;
    IntPtr job;
    int made = MakeJob(out job);
    if (made != 0) return made;
    var parts = new List<string>();
    for (int i = 1; i < args.Length; i++) parts.Add(Quote(args[i]));
    // Only the three standard handles are passed on, by a handle list.
    IntPtr i0 = GetStdHandle(STD_INPUT), i1 = GetStdHandle(STD_OUTPUT), i2 = GetStdHandle(STD_ERROR);
    var list = new List<IntPtr>();
    foreach (var h in new[] { i0, i1, i2 }) {
      if (h == IntPtr.Zero || h == INVALID || list.Contains(h)) continue;
      uint fl; if (!GetHandleInformation(h, out fl)) continue;
      if (!SetHandleInformation(h, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) continue;
      list.Add(h);
    }
    PROCESS_INFORMATION pi;
    if (!Spawn(null, string.Join(" ", parts.ToArray()), list.ToArray(), i0, i1, i2, null, out pi)) {
      Console.Error.WriteLine("pcw-jobrun: couldn't start the program"); return 122;
    }
    CloseHandle(pi.hThread);
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint exit; if (!GetExitCodeProcess(pi.hProcess, out exit)) exit = 1;
    CloseHandle(pi.hProcess);
    // The job's handle closes as this process exits: Windows ends whatever is left in it.
    GC.KeepAlive(job);
    return (int)exit;
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


  // ---- Spawning with a handle list (version 4) ---------------------------------------------------
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags;
    public short wShowWindow; public short cbReserved2; public IntPtr lpReserved2;
    public IntPtr hStdInput, hStdOutput, hStdError;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct STARTUPINFOEX { public STARTUPINFO StartupInfo; public IntPtr lpAttributeList; }
  [StructLayout(LayoutKind.Sequential)]
  struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [StructLayout(LayoutKind.Sequential)]
  struct SECURITY_ATTRIBUTES { public int nLength; public IntPtr lpSecurityDescriptor; public int bInheritHandle; }
  const uint EXTENDED_STARTUPINFO_PRESENT = 0x00080000, CREATE_UNICODE_ENVIRONMENT = 0x00000400, CREATE_NO_WINDOW = 0x08000000;
  const int STARTF_USESTDHANDLES = 0x100;
  static readonly IntPtr PROC_THREAD_ATTRIBUTE_HANDLE_LIST = (IntPtr)0x20002;
  const uint HANDLE_FLAG_INHERIT = 1, INFINITE = 0xFFFFFFFF, DUPLICATE_SAME_ACCESS = 2, DUPLICATE_CLOSE_SOURCE = 1;
  const int STD_INPUT = -10, STD_OUTPUT = -11, STD_ERROR = -12;
  static readonly IntPtr INVALID = new IntPtr(-1);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, int flags, ref IntPtr size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attr, IntPtr value, IntPtr size, IntPtr prev, IntPtr retSize);
  [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
  static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFOEX si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SECURITY_ATTRIBUTES sa, uint size);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetHandleInformation(IntPtr h, uint mask, uint flags);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetHandleInformation(IntPtr h, out uint flags);
  [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int which);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateProcess(IntPtr h, uint code);
  [DllImport("kernel32.dll", SetLastError = true)]
  static extern bool DuplicateHandle(IntPtr srcProc, IntPtr src, IntPtr dstProc, out IntPtr dst, uint access, bool inherit, uint options);
  [DllImport("kernelbase.dll")] static extern bool CompareObjectHandles(IntPtr a, IntPtr b);
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int size, out int got);

  // CreateProcess with exactly these handles inherited (each must already be inheritable), and, when reserved2 is given, that
  // block as STARTUPINFO's lpReserved2 (the C runtime's descriptor table for the child).
  static bool Spawn(string app, string cmd, IntPtr[] inherit, IntPtr si0, IntPtr si1, IntPtr si2, byte[] reserved2, out PROCESS_INFORMATION pi) {
    pi = new PROCESS_INFORMATION();
    IntPtr size = IntPtr.Zero;
    InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
    IntPtr attrs = Marshal.AllocHGlobal(size);
    IntPtr handles = Marshal.AllocHGlobal(IntPtr.Size * Math.Max(1, inherit.Length));
    IntPtr res2 = IntPtr.Zero;
    bool listed = false;
    try {
      if (!InitializeProcThreadAttributeList(attrs, 1, 0, ref size)) return false;
      listed = true;
      for (int i = 0; i < inherit.Length; i++) Marshal.WriteIntPtr(handles, i * IntPtr.Size, inherit[i]);
      if (inherit.Length > 0 && !UpdateProcThreadAttribute(attrs, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, (IntPtr)(IntPtr.Size * inherit.Length), IntPtr.Zero, IntPtr.Zero)) return false;
      var si = new STARTUPINFOEX();
      si.StartupInfo.cb = Marshal.SizeOf(typeof(STARTUPINFOEX));
      si.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
      si.StartupInfo.hStdInput = si0; si.StartupInfo.hStdOutput = si1; si.StartupInfo.hStdError = si2;
      si.lpAttributeList = attrs;
      if (reserved2 != null) {
        res2 = Marshal.AllocHGlobal(reserved2.Length);
        Marshal.Copy(reserved2, 0, res2, reserved2.Length);
        si.StartupInfo.cbReserved2 = (short)reserved2.Length;
        si.StartupInfo.lpReserved2 = res2;
      }
      // With no handle to pass, nothing is inherited at all.
      return CreateProcess(app, new StringBuilder(cmd), IntPtr.Zero, IntPtr.Zero, inherit.Length > 0, EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero, null, ref si, out pi);
    } finally {
      if (listed) DeleteProcThreadAttributeList(attrs);
      Marshal.FreeHGlobal(attrs); Marshal.FreeHGlobal(handles);
      if (res2 != IntPtr.Zero) Marshal.FreeHGlobal(res2);
    }
  }
  // The C runtime's descriptor block for five descriptors: 0 to 2 closed, 3 and 4 open pipes (FOPEN | FPIPE), laid out as
  // an int count, one flag byte per descriptor, then one handle per descriptor, packed.
  static byte[] FdBlock(IntPtr fd3, IntPtr fd4) {
    const int n = 5;
    var b = new byte[4 + n + n * IntPtr.Size];
    BitConverter.GetBytes(n).CopyTo(b, 0);
    for (int i = 0; i < n; i++) {
      bool open = i == 3 || i == 4;
      b[4 + i] = (byte)(open ? 0x09 : 0x00);
      long h = i == 3 ? fd3.ToInt64() : i == 4 ? fd4.ToInt64() : -1;
      byte[] hb = IntPtr.Size == 8 ? BitConverter.GetBytes(h) : BitConverter.GetBytes((int)h);
      hb.CopyTo(b, 4 + n + i * IntPtr.Size);
    }
    return b;
  }
  static string J(IntPtr h) { return "\"" + h.ToInt64().ToString() + "\""; }

  static int EdgeLaunch(string[] args) {
    if (args.Length < 3) return 120;
    int worker;
    if (!int.TryParse(args[1], out worker) || worker <= 0) return 120;
    if (ParentOf(Process.GetCurrentProcess().Id) != worker) { Console.Error.WriteLine("pcw-jobrun: the worker isn't this helper's parent"); return 120; }
    var sa = new SECURITY_ATTRIBUTES(); sa.nLength = Marshal.SizeOf(typeof(SECURITY_ATTRIBUTES)); sa.bInheritHandle = 0;
    IntPtr toEdgeR, toEdgeW, fromEdgeR, fromEdgeW;
    if (!CreatePipe(out toEdgeR, out toEdgeW, ref sa, 1 << 20)) return 123;
    if (!CreatePipe(out fromEdgeR, out fromEdgeW, ref sa, 1 << 20)) return 123;
    // Edge's ends become inheritable for the one call; ours never do.
    if (!SetHandleInformation(toEdgeR, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT) || !SetHandleInformation(fromEdgeW, HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT)) return 123;
    var parts = new List<string>();
    for (int i = 2; i < args.Length; i++) parts.Add(Quote(args[i]));
    PROCESS_INFORMATION pi;
    bool ok = Spawn(args[2], string.Join(" ", parts.ToArray()), new[] { toEdgeR, fromEdgeW }, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, FdBlock(toEdgeR, fromEdgeW), out pi);
    // The child's handle values are the same as ours (inherited handles keep their values): kept for pipe-scan.
    string edgeRead = J(toEdgeR), edgeWrite = J(fromEdgeW);
    CloseHandle(toEdgeR); CloseHandle(fromEdgeW);
    if (!ok) { CloseHandle(toEdgeW); CloseHandle(fromEdgeR); Console.Error.WriteLine("pcw-jobrun: Edge couldn't be started"); return 123; }
    CloseHandle(pi.hThread);
    IntPtr wp = OpenProcess(0x0040, false, worker);   // PROCESS_DUP_HANDLE
    IntPtr wRead = IntPtr.Zero, wWrite = IntPtr.Zero;
    bool handed = wp != IntPtr.Zero;
    if (handed) handed = DuplicateHandle(GetCurrentProcess(), fromEdgeR, wp, out wRead, 0, false, DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE);
    if (handed) handed = DuplicateHandle(GetCurrentProcess(), toEdgeW, wp, out wWrite, 0, false, DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE);
    if (!handed) { TerminateProcess(pi.hProcess, 1); CloseHandle(pi.hProcess); if (wp != IntPtr.Zero) CloseHandle(wp); return 124; }
    CloseHandle(wp);
    Console.WriteLine("{\"pid\":" + pi.dwProcessId + ",\"read\":" + J(wRead) + ",\"write\":" + J(wWrite) + ",\"edge_read\":" + edgeRead + ",\"edge_write\":" + edgeWrite + "}");
    CloseHandle(pi.hProcess);
    return 0;
  }

  // SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX: Object, UniqueProcessId, HandleValue (pointer-sized), then GrantedAccess (4),
  // CreatorBackTraceIndex (2), ObjectTypeIndex (2), HandleAttributes (4), Reserved (4).
  static int PipeScan(string[] args) {
    int dash = Array.IndexOf(args, "--");
    if (dash != 7 || args.Length < 9) return 120;
    var refs = new List<IntPtr>();
    for (int k = 0; k < 2; k++) {
      int pid; if (!int.TryParse(args[k == 0 ? 1 : 4], out pid)) return 120;
      IntPtr src = OpenProcess(0x0040, false, pid);
      if (src == IntPtr.Zero) return 1;
      for (int j = 0; j < 2; j++) {
        long hv; if (!long.TryParse(args[(k == 0 ? 2 : 5) + j], out hv)) return 120;
        IntPtr d; if (!DuplicateHandle(src, new IntPtr(hv), GetCurrentProcess(), out d, 0, false, DUPLICATE_SAME_ACCESS)) { CloseHandle(src); return 1; }
        refs.Add(d);
      }
      CloseHandle(src);
    }
    var pids = new HashSet<long>();
    for (int i = dash + 1; i < args.Length; i++) { long p; if (long.TryParse(args[i], out p)) pids.Add(p); }
    int size = 1 << 20, got; IntPtr buf = IntPtr.Zero; int st;
    for (;;) {
      buf = Marshal.AllocHGlobal(size);
      st = NtQuerySystemInformation(64, buf, size, out got);
      if (st != unchecked((int)0xC0000004)) break;
      Marshal.FreeHGlobal(buf); size *= 2; if (size > (1 << 30)) return 1;
    }
    if (st != 0) { Marshal.FreeHGlobal(buf); return 1; }
    int ps = IntPtr.Size, entry = ps * 3 + 16;
    long count = ps == 8 ? Marshal.ReadInt64(buf) : Marshal.ReadInt32(buf);
    var open = new Dictionary<long, IntPtr>();
    int handles = 0, undup = 0;
    var hits = new List<string>();
    for (long i = 0; i < count; i++) {
      IntPtr e = new IntPtr(buf.ToInt64() + ps * 2 + i * entry);
      long pid = Marshal.ReadIntPtr(e, ps).ToInt64();
      if (!pids.Contains(pid)) continue;
      IntPtr hv = Marshal.ReadIntPtr(e, ps * 2);
      handles++;
      IntPtr src;
      if (!open.TryGetValue(pid, out src)) { src = OpenProcess(0x0040, false, (int)pid); open[pid] = src; }
      IntPtr d;
      if (src == IntPtr.Zero || !DuplicateHandle(src, hv, GetCurrentProcess(), out d, 0, false, DUPLICATE_SAME_ACCESS)) { undup++; continue; }
      foreach (var r in refs) if (CompareObjectHandles(d, r)) { hits.Add("{\"pid\":" + pid + ",\"handle\":" + J(hv) + "}"); break; }
      CloseHandle(d);
    }
    foreach (var h in open.Values) if (h != IntPtr.Zero) CloseHandle(h);
    foreach (var r in refs) CloseHandle(r);
    Marshal.FreeHGlobal(buf);
    Console.WriteLine("{\"handles\":" + handles + ",\"hits\":[" + string.Join(",", hits.ToArray()) + "],\"undup\":" + undup + "}");
    return 0;
  }

  public static int Main(string[] args) {
    if (args.Length == 0) return 120;
    switch (args[0]) {
      case "run": return Run(args);
      case "holders": return Holders(args);
      case "inspect": return Inspect();
      case "edge-launch": return EdgeLaunch(args);
      case "pipe-scan": return PipeScan(args);
      case "version": Console.WriteLine(VERSION); return 0;
      default: return 120;
    }
  }
}
