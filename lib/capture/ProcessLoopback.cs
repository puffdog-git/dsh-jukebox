// dsh-jukebox 的單一程式音訊擷取工具（Windows 10 2004 以上）。
//
// 用 Windows 內建的 process loopback 只擷取「指定程式（含它的子程序）」播出來的聲音，
// 不擷取整台電腦的聲音，也不擷取麥克風。輸出是未壓縮的 PCM：48000 Hz、雙聲道、16 位元，寫到標準輸出。
// 程式沒有聲音時補上靜音，讓輸出的時間軸和真實時間一致。
//
// 用法：
//   jukebox-capture list <程式名稱> [<程式名稱>…]     列出正在執行的（名稱<TAB>PID）
//   jukebox-capture capture <程式名稱或 PID> [最長秒數] [--mute] [--watch-stdin]
//       開始擷取，標準錯誤印出 READY 後開始輸出。
//       --mute：擷取期間讓這個程式在喇叭上幾乎聽不到，結束時還原。
//         做法：把它在 Windows 音量混音器的音量調到千分之一，擷取用 32 位元浮點格式再放大一千倍。
//         （實測：直接按「靜音」的話擷取到的聲音也會消失，所以不能用靜音。）
//       --watch-stdin：標準輸入被關閉時正常結束（讓呼叫端可以要求它收尾並還原靜音）。
//   jukebox-capture audio                                   列出目前有音訊工作階段的程序（PID、名稱、是否正在出聲、音量）；診斷用
//   jukebox-capture fg                                      印出目前在最前面的視窗代號
//   jukebox-capture fg <視窗代號>                           把那個視窗帶回最前面（操作播放器之後把焦點還給使用者原本的視窗）
//   jukebox-capture key <play_pause|next|previous|stop>   送出一個媒體鍵（和鍵盤上的媒體鍵相同，由系統決定哪個播放器收到）
//   jukebox-capture unmute <程式名稱或 PID>            把這個程式在音量混音器的音量調回 100%（意外中斷後的補救）
// 結束碼：0 正常結束、2 參數錯誤、3 找不到程式或程式已結束、4 Windows 不支援或擷取失敗
//
// 由插件在第一次使用時用 Windows 內建的 C# 編譯器（.NET Framework 4 的 csc.exe）編譯。只用 C# 5 的語法。
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

[ComImport, Guid("72A22D78-CDE4-431D-B8CC-843A71199B6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceAsyncOperation
{
    void GetActivateResult(out int activateResult, [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
}

[ComImport, Guid("41D949AB-9862-444A-80F6-C261334DA5EB"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IActivateAudioInterfaceCompletionHandler
{
    void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation);
}

[ComImport, Guid("94EA2B94-E9CC-49E0-C0FF-EE64CA8F5B90"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAgileObject
{
}

[ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioClient
{
    [PreserveSig] int Initialize(int shareMode, uint streamFlags, long bufferDuration, long periodicity, IntPtr format, IntPtr sessionGuid);
    [PreserveSig] int GetBufferSize(out uint frames);
    [PreserveSig] int GetStreamLatency(out long latency);
    [PreserveSig] int GetCurrentPadding(out uint padding);
    [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    [PreserveSig] int GetMixFormat(out IntPtr format);
    [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
    [PreserveSig] int Start();
    [PreserveSig] int Stop();
    [PreserveSig] int Reset();
    [PreserveSig] int SetEventHandle(IntPtr handle);
    [PreserveSig] int GetService([MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId, [MarshalAs(UnmanagedType.IUnknown)] out object service);
}

[ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioCaptureClient
{
    [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devicePosition, out ulong qpcPosition);
    [PreserveSig] int ReleaseBuffer(uint frames);
    [PreserveSig] int GetNextPacketSize(out uint frames);
}

[ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
class MMDeviceEnumerator
{
}

[ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator
{
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IMMDeviceCollection devices);
}

[ComImport, Guid("0BD7A1BE-7A1A-44DB-8397-CC5392387B5E"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceCollection
{
    [PreserveSig] int GetCount(out uint count);
    [PreserveSig] int Item(uint index, out IMMDevice device);
}

[ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice
{
    [PreserveSig] int Activate([MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId, int context, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object instance);
}

[ComImport, Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionManager2
{
    [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, int flags, out IntPtr control);
    [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, int flags, out IntPtr volume);
    [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
}

[ComImport, Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionEnumerator
{
    [PreserveSig] int GetCount(out int count);
    [PreserveSig] int GetSession(int index, out IAudioSessionControl2 session);
}

[ComImport, Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioSessionControl2
{
    [PreserveSig] int GetState(out int state);
    [PreserveSig] int GetDisplayName(out IntPtr name);
    [PreserveSig] int SetDisplayName(IntPtr name, IntPtr context);
    [PreserveSig] int GetIconPath(out IntPtr path);
    [PreserveSig] int SetIconPath(IntPtr path, IntPtr context);
    [PreserveSig] int GetGroupingParam(out Guid group);
    [PreserveSig] int SetGroupingParam(IntPtr group, IntPtr context);
    [PreserveSig] int RegisterAudioSessionNotification(IntPtr notifications);
    [PreserveSig] int UnregisterAudioSessionNotification(IntPtr notifications);
    [PreserveSig] int GetSessionIdentifier(out IntPtr id);
    [PreserveSig] int GetSessionInstanceIdentifier(out IntPtr id);
    [PreserveSig] int GetProcessId(out uint processId);
}

[ComImport, Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface ISimpleAudioVolume
{
    [PreserveSig] int SetMasterVolume(float level, IntPtr context);
    [PreserveSig] int GetMasterVolume(out float level);
    [PreserveSig] int SetMute(bool mute, IntPtr context);
    [PreserveSig] int GetMute(out bool mute);
}

class ActivationHandler : IActivateAudioInterfaceCompletionHandler, IAgileObject
{
    public readonly ManualResetEvent Done = new ManualResetEvent(false);
    public int Result = -1;
    public object Client;

    public void ActivateCompleted(IActivateAudioInterfaceAsyncOperation operation)
    {
        try
        {
            operation.GetActivateResult(out Result, out Client);
        }
        catch (Exception e)
        {
            Result = Marshal.GetHRForException(e);
        }
        Done.Set();
    }
}

static class Program
{
    const int Rate = 48000;
    const int BlockAlign = 4;

    [DllImport("Mmdevapi.dll", ExactSpelling = true, PreserveSig = true)]
    static extern int ActivateAudioInterfaceAsync([MarshalAs(UnmanagedType.LPWStr)] string deviceInterfacePath, [MarshalAs(UnmanagedType.LPStruct)] Guid interfaceId, IntPtr activationParams, IActivateAudioInterfaceCompletionHandler completionHandler, out IActivateAudioInterfaceAsyncOperation operation);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ProcessEntry
    {
        public uint Size;
        public uint Usage;
        public uint ProcessId;
        public IntPtr DefaultHeapId;
        public uint ModuleId;
        public uint Threads;
        public uint ParentProcessId;
        public int PriorityBase;
        public uint Flags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)] public string ExeFile;
    }

    [DllImport("user32.dll")]
    static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool BringWindowToTop(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool ShowWindow(IntPtr window, int command);

    [DllImport("user32.dll")]
    static extern bool SetWindowPos(IntPtr window, IntPtr insertAfter, int x, int y, int width, int height, uint flags);
    delegate bool EnumWindowsCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindowsCallback callback, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern int GetWindowTextLength(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr window, int index);
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);

    // 畫面上最上層、看得到的一般視窗（找不到回 IntPtr.Zero）。
    static IntPtr TopVisibleWindow()
    {
        IntPtr found = IntPtr.Zero;
        EnumWindows(delegate(IntPtr window, IntPtr parameter)
        {
            if (!IsWindowVisible(window) || IsIconic(window) || GetWindowTextLength(window) == 0) return true;
            if ((GetWindowLongPtr(window, -20).ToInt64() & 0x80) != 0) return true; // 工具視窗
            int cloaked;
            DwmGetWindowAttribute(window, 14, out cloaked, 4);
            if (cloaked != 0) return true; // 在別的虛擬桌面或被系統藏起來
            found = window;
            return false;
        }, IntPtr.Zero);
        return found;
    }

    // 某個程式的主視窗（依程序名稱找；找不到回 IntPtr.Zero）。
    static IntPtr MainWindowOf(string name)
    {
        foreach (System.Diagnostics.Process p in System.Diagnostics.Process.GetProcessesByName(name))
        {
            try { if (p.MainWindowHandle != IntPtr.Zero) return p.MainWindowHandle; } catch { }
        }
        return IntPtr.Zero;
    }
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32FirstW")]
    static extern bool Process32First(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, EntryPoint = "Process32NextW")]
    static extern bool Process32Next(IntPtr snapshot, ref ProcessEntry entry);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    // 目標程序與它所有子孫程序的 PID。
    static HashSet<uint> Tree(int root)
    {
        var parents = new Dictionary<uint, uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        var tree = new HashSet<uint>();
        tree.Add((uint)root);
        if (snapshot == new IntPtr(-1)) return tree;
        try
        {
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (Process32First(snapshot, ref entry))
            {
                do
                {
                    parents[entry.ProcessId] = entry.ParentProcessId;
                } while (Process32Next(snapshot, ref entry));
            }
        }
        finally
        {
            CloseHandle(snapshot);
        }
        bool grew = true;
        while (grew)
        {
            grew = false;
            foreach (var pair in parents)
            {
                if (!tree.Contains(pair.Key) && tree.Contains(pair.Value) && pair.Key != 0)
                {
                    tree.Add(pair.Key);
                    grew = true;
                }
            }
        }
        return tree;
    }

    const float QuietLevel = 0.001f;

    // 走過目標程序樹在所有輸出裝置上的音訊工作階段。
    //   mode 0：把還沒調小的調到 QuietLevel，原本的音量記在 originals。回傳「還沒調小的有幾個」（0 表示全部都已經是小音量）。
    //   mode 1：把 originals 裡記的還原。
    //   mode 2：把被調到小音量的一律調回 100%（補救用）。
    // total 回傳找到幾個工作階段。
    static int Sessions(int root, int mode, Dictionary<string, float> originals, out int total)
    {
        int changed = 0;
        total = 0;
        try
        {
            var tree = Tree(root);
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(0, 1, out devices) < 0) return 0;
            uint deviceCount;
            devices.GetCount(out deviceCount);
            for (uint d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) < 0) continue;
                object instance;
                if (device.Activate(typeof(IAudioSessionManager2).GUID, 23, IntPtr.Zero, out instance) < 0) continue;
                IAudioSessionEnumerator sessions;
                if (((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions) < 0) continue;
                int count;
                sessions.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl2 session;
                    if (sessions.GetSession(i, out session) < 0) continue;
                    uint owner;
                    if (session.GetProcessId(out owner) < 0 || !tree.Contains(owner)) continue;
                    var volume = session as ISimpleAudioVolume;
                    if (volume == null) continue;
                    total++;
                    string key = d + ":" + owner;
                    float level;
                    if (volume.GetMasterVolume(out level) < 0) continue;
                    bool quiet = level <= QuietLevel * 1.5f;
                    if (mode == 0)
                    {
                        if (quiet) continue;
                        changed++;
                        if (!originals.ContainsKey(key)) originals[key] = level;
                        volume.SetMasterVolume(QuietLevel, IntPtr.Zero);
                    }
                    else if (mode == 1)
                    {
                        float original;
                        if (quiet && originals.TryGetValue(key, out original) && volume.SetMasterVolume(original, IntPtr.Zero) >= 0) changed++;
                    }
                    else if (quiet && volume.SetMasterVolume(1f, IntPtr.Zero) >= 0) changed++;
                }
            }
        }
        catch
        {
        }
        return changed;
    }

    // 列出所有輸出裝置上的音訊工作階段：PID、程序名稱、狀態（1＝正在出聲）、音量。
    static void ListAudio()
    {
        try
        {
            var enumerator = (IMMDeviceEnumerator)new MMDeviceEnumerator();
            IMMDeviceCollection devices;
            if (enumerator.EnumAudioEndpoints(0, 1, out devices) < 0) return;
            uint deviceCount;
            devices.GetCount(out deviceCount);
            for (uint d = 0; d < deviceCount; d++)
            {
                IMMDevice device;
                if (devices.Item(d, out device) < 0) continue;
                object instance;
                if (device.Activate(typeof(IAudioSessionManager2).GUID, 23, IntPtr.Zero, out instance) < 0) continue;
                IAudioSessionEnumerator sessions;
                if (((IAudioSessionManager2)instance).GetSessionEnumerator(out sessions) < 0) continue;
                int count;
                sessions.GetCount(out count);
                for (int i = 0; i < count; i++)
                {
                    IAudioSessionControl2 session;
                    if (sessions.GetSession(i, out session) < 0) continue;
                    uint owner;
                    session.GetProcessId(out owner);
                    int state;
                    session.GetState(out state);
                    float level = -1f;
                    var volume = session as ISimpleAudioVolume;
                    if (volume != null) volume.GetMasterVolume(out level);
                    string name = "?";
                    try { name = Process.GetProcessById((int)owner).ProcessName; } catch { }
                    Console.Out.WriteLine(d + "\t" + owner + "\t" + name + "\t" + state + "\t" + level.ToString("0.###"));
                }
            }
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("FAILED " + e.GetType().Name);
        }
    }

    // 找某個名稱的「最上層」程序：同名程序裡，父程序不是同名的那一個。擷取它就會包含所有子程序。
    static int FindRoot(string name)
    {
        string wanted = name.EndsWith(".exe", StringComparison.OrdinalIgnoreCase) ? name : name + ".exe";
        var parents = new Dictionary<uint, uint>();
        var matches = new List<uint>();
        IntPtr snapshot = CreateToolhelp32Snapshot(2, 0);
        if (snapshot == new IntPtr(-1)) return 0;
        try
        {
            var entry = new ProcessEntry();
            entry.Size = (uint)Marshal.SizeOf(typeof(ProcessEntry));
            if (!Process32First(snapshot, ref entry)) return 0;
            do
            {
                parents[entry.ProcessId] = entry.ParentProcessId;
                if (string.Equals(entry.ExeFile, wanted, StringComparison.OrdinalIgnoreCase)) matches.Add(entry.ProcessId);
            } while (Process32Next(snapshot, ref entry));
        }
        finally
        {
            CloseHandle(snapshot);
        }
        foreach (uint pid in matches)
        {
            uint parent;
            if (!parents.TryGetValue(pid, out parent) || !matches.Contains(parent)) return (int)pid;
        }
        return matches.Count > 0 ? (int)matches[0] : 0;
    }

    static bool Alive(int pid)
    {
        try
        {
            return !Process.GetProcessById(pid).HasExited;
        }
        catch
        {
            return false;
        }
    }

    [MTAThread]
    static int Main(string[] args)
    {
        // fg heal：前景落在「已經縮小或看不見的視窗」上時（等於沒有任何視窗拿到鍵盤；叫播放器做事之後實測發生過），
        // 把前景交給畫面上最上層的視窗。印出 HEALED 或 OK。
        if (args.Length == 2 && args[0] == "fg" && args[1] == "heal")
        {
            // 「沒有人拿到鍵盤」的兩種樣子（都實測到過）：前景是已經縮小的視窗；
            // 或前景是一個看不見的視窗（在背景對 Spotify 的按鈕下指令後，前景會跑到它看不見的子視窗上）。
            IntPtr stuck = GetForegroundWindow();
            if (stuck == IntPtr.Zero || (!IsIconic(stuck) && IsWindowVisible(stuck))) { Console.Out.WriteLine("OK"); return 0; }
            IntPtr next = TopVisibleWindow();
            if (next == IntPtr.Zero) { Console.Out.WriteLine("OK"); return 0; }
            uint unused;
            uint owner = GetWindowThreadProcessId(stuck, out unused), self = GetCurrentThreadId();
            AttachThreadInput(self, owner, true);
            SetForegroundWindow(next);
            BringWindowToTop(next);
            AttachThreadInput(self, owner, false);
            Console.Out.WriteLine("HEALED");
            return 0;
        }
        if (args.Length >= 1 && args[0] == "fg")
        {
            if (args.Length == 1)
            {
                Console.Out.WriteLine(GetForegroundWindow().ToInt64());
                return 0;
            }
            long handle;
            if (!long.TryParse(args[1], out handle) || handle <= 0) return 2;
            IntPtr target = new IntPtr(handle);
            if (!IsWindow(target)) return 3;
            IntPtr current = GetForegroundWindow();
            if (current == target) return 0;
            // Windows 只允許「目前在前面的程式」換前景視窗，所以先暫時接上它的輸入佇列。
            uint ignored;
            uint front = GetWindowThreadProcessId(current, out ignored), me = GetCurrentThreadId();
            AttachThreadInput(me, front, true);
            SetForegroundWindow(target);
            BringWindowToTop(target);
            AttachThreadInput(me, front, false);
            Console.Out.WriteLine(GetForegroundWindow() == target ? "RESTORED" : "NOT_RESTORED");
            return 0;
        }
        // win <程序名稱>：印出主視窗是不是縮小的（MINIMIZED／NORMAL／NONE）。
        // win <程序名稱> minimize：把主視窗縮回工作列，不改變目前在前面的視窗。
        // win <程序名稱> behind：見下面。
        if (args.Length >= 2 && args[0] == "win")
        {
            IntPtr window = MainWindowOf(args[1]);
            if (window == IntPtr.Zero) { Console.Out.WriteLine("NONE"); return 0; }
            // 它正好在最前面時用「縮小並啟用下一個視窗」（6）；只縮小不啟用（7）的話前景會留在已縮小的視窗上，
            // 等於沒有任何視窗拿到鍵盤（實測發生過）。
            if (args.Length >= 3 && args[2] == "minimize") ShowWindow(window, GetForegroundWindow() == window ? 6 : 7);
            // behind：把縮小的視窗叫出來但不啟用，並放到所有視窗的最底層（使用者有開著別的視窗時看不到它）。
            // 給「縮小時介面元件不能操作」的播放器用（Apple Music 實測：縮小時選單叫不出來）。
            if (args.Length >= 3 && args[2] == "behind" && IsIconic(window))
            {
                ShowWindow(window, 4);
                SetWindowPos(window, new IntPtr(1), 0, 0, 0, 0, 0x13);
            }
            Console.Out.WriteLine(IsIconic(window) ? "MINIMIZED" : "NORMAL");
            return 0;
        }
        if (args.Length >= 1 && args[0] == "audio")
        {
            ListAudio();
            return 0;
        }
        if (args.Length >= 2 && args[0] == "key")
        {
            byte key = args[1] == "play_pause" ? (byte)0xB3 : args[1] == "next" ? (byte)0xB0 : args[1] == "previous" ? (byte)0xB1 : args[1] == "stop" ? (byte)0xB2 : (byte)0;
            if (key == 0) return 2;
            keybd_event(key, 0, 0, UIntPtr.Zero);
            keybd_event(key, 0, 2, UIntPtr.Zero);
            Console.Out.WriteLine("SENT " + args[1]);
            return 0;
        }
        if (args.Length >= 2 && args[0] == "list")
        {
            for (int i = 1; i < args.Length; i++)
            {
                int found = FindRoot(args[i]);
                if (found != 0) Console.Out.WriteLine(args[i] + "\t" + found);
            }
            return 0;
        }
        if (args.Length >= 2 && args[0] == "unmute")
        {
            int target;
            if (!int.TryParse(args[1], out target)) target = FindRoot(args[1]);
            if (target <= 0) return 3;
            int ignored;
            Console.Out.WriteLine("RESTORED " + Sessions(target, 2, null, out ignored));
            return 0;
        }
        if (args.Length < 2 || args[0] != "capture")
        {
            Console.Error.WriteLine("usage: list <name>... | capture <name|pid> [seconds]");
            return 2;
        }
        int pid;
        if (!int.TryParse(args[1], out pid)) pid = FindRoot(args[1]);
        if (pid <= 0 || !Alive(pid))
        {
            Console.Error.WriteLine("NOT_RUNNING");
            return 3;
        }
        double maxSeconds = 0;
        bool mute = false, watchStdin = false;
        for (int i = 2; i < args.Length; i++)
        {
            if (args[i] == "--mute") mute = true;
            else if (args[i] == "--watch-stdin") watchStdin = true;
            else double.TryParse(args[i], out maxSeconds);
        }
        if (watchStdin)
        {
            var watcher = new Thread(delegate()
            {
                try
                {
                    Stream input = Console.OpenStandardInput();
                    byte[] one = new byte[16];
                    while (input.Read(one, 0, one.Length) > 0) { }
                }
                catch
                {
                }
                stopRequested = true;
            });
            watcher.IsBackground = true;
            watcher.Start();
        }
        var originals = mute ? new Dictionary<string, float>() : null;
        try
        {
            return Capture(pid, maxSeconds, originals);
        }
        catch (IOException)
        {
            return 0; // 接收端關掉了管線：正常結束。
        }
        catch (Exception e)
        {
            Console.Error.WriteLine("FAILED " + e.GetType().Name + " 0x" + Marshal.GetHRForException(e).ToString("X8"));
            return 4;
        }
        finally
        {
            // 把這次調小的音量還原成原本的值。
            int ignored;
            if (originals != null && originals.Count > 0) Sessions(pid, 1, originals, out ignored);
        }
    }

    static volatile bool stopRequested;

    static int Capture(int pid, double maxSeconds, Dictionary<string, float> originals)
    {
        // AUDIOCLIENT_ACTIVATION_PARAMS：類型 1＝程序 loopback；模式 0＝包含目標程序的整棵子程序樹。
        IntPtr parameters = Marshal.AllocHGlobal(12);
        Marshal.WriteInt32(parameters, 0, 1);
        Marshal.WriteInt32(parameters, 4, pid);
        Marshal.WriteInt32(parameters, 8, 0);
        // PROPVARIANT（64 位元）：vt＝VT_BLOB(65)，位移 8 是大小，位移 16 是資料指標。
        IntPtr variant = Marshal.AllocHGlobal(24);
        for (int i = 0; i < 24; i++) Marshal.WriteByte(variant, i, 0);
        Marshal.WriteInt16(variant, 0, 65);
        Marshal.WriteInt32(variant, 8, 12);
        Marshal.WriteIntPtr(variant, 16, parameters);

        var handler = new ActivationHandler();
        IActivateAudioInterfaceAsyncOperation operation;
        int hr = ActivateAudioInterfaceAsync("VAD\\Process_Loopback", typeof(IAudioClient).GUID, variant, handler, out operation);
        if (hr < 0) return Fail("activate", hr);
        if (!handler.Done.WaitOne(10000)) return Fail("activate-timeout", -1);
        if (handler.Result < 0 || handler.Client == null) return Fail("activate-result", handler.Result);
        var client = (IAudioClient)handler.Client;

        // WAVEFORMATEX：32 位元浮點、雙聲道、48000 Hz。用浮點是為了把調小的聲音放大回來時不損失精細度。
        const int InBlock = 8;
        IntPtr format = Marshal.AllocHGlobal(18);
        Marshal.WriteInt16(format, 0, 3);
        Marshal.WriteInt16(format, 2, 2);
        Marshal.WriteInt32(format, 4, Rate);
        Marshal.WriteInt32(format, 8, Rate * InBlock);
        Marshal.WriteInt16(format, 12, InBlock);
        Marshal.WriteInt16(format, 14, 32);
        Marshal.WriteInt16(format, 16, 0);

        const uint Loopback = 0x00020000, EventCallback = 0x00040000, AutoConvert = 0x80000000, DefaultQuality = 0x08000000;
        hr = client.Initialize(0, Loopback | EventCallback | AutoConvert | DefaultQuality, 0, 0, format, IntPtr.Zero);
        if (hr < 0) return Fail("initialize", hr);

        var ready = new AutoResetEvent(false);
        hr = client.SetEventHandle(ready.SafeWaitHandle.DangerousGetHandle());
        if (hr < 0) return Fail("event", hr);
        object service;
        hr = client.GetService(typeof(IAudioCaptureClient).GUID, out service);
        if (hr < 0) return Fail("service", hr);
        var capture = (IAudioCaptureClient)service;
        hr = client.Start();
        if (hr < 0) return Fail("start", hr);

        Stream output = Console.OpenStandardOutput();
        Console.Error.WriteLine("READY " + pid);
        Console.Error.Flush();
        var clock = Stopwatch.StartNew();
        long written = 0; // 已輸出的取樣框數
        long lastAliveCheck = -1000, lastQuietCheck = -1000, boostAt = -1;
        float gain = 1f;
        float[] samples = new float[Rate * 2 / 5];
        byte[] buffer = new byte[Rate * BlockAlign / 5];
        byte[] silence = new byte[Rate * BlockAlign / 5];
        try
        {
            while (true)
            {
                ready.WaitOne(20);
                uint frames;
                while (capture.GetNextPacketSize(out frames) >= 0 && frames > 0)
                {
                    IntPtr data;
                    uint flags;
                    ulong devicePosition, qpcPosition;
                    hr = capture.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    if (hr < 0) return Fail("buffer", hr);
                    int bytes = (int)frames * BlockAlign, values = (int)frames * 2;
                    if (bytes > buffer.Length) buffer = new byte[bytes];
                    if (values > samples.Length) samples = new float[values];
                    if ((flags & 2) != 0) Array.Clear(buffer, 0, bytes);
                    else
                    {
                        Marshal.Copy(data, samples, 0, values);
                        float use = gain;
                        if (use > 1f)
                        {
                            // 保險：放大中卻出現正常音量的聲音（程式開了新的音訊工作階段），這一包不放大，並立刻重新檢查。
                            float peak = 0f;
                            for (int i = 0; i < values; i++)
                            {
                                float a = samples[i] < 0 ? -samples[i] : samples[i];
                                if (a > peak) peak = a;
                            }
                            if (peak > QuietLevel * 4f)
                            {
                                use = 1f;
                                gain = 1f;
                                boostAt = -1;
                                lastQuietCheck = -1000;
                            }
                        }
                        for (int i = 0; i < values; i++)
                        {
                            float v = samples[i] * use * 32767f;
                            short s = v > 32767f ? (short)32767 : v < -32768f ? (short)-32768 : (short)v;
                            buffer[i * 2] = (byte)s;
                            buffer[i * 2 + 1] = (byte)(s >> 8);
                        }
                    }
                    capture.ReleaseBuffer(frames);
                    output.Write(buffer, 0, bytes);
                    written += frames;
                }
                // 程式沒在播放時不會有資料：落後真實時間超過 100 毫秒就補靜音到只落後 20 毫秒。
                long expected = clock.ElapsedMilliseconds * Rate / 1000;
                if (expected - written > Rate / 10)
                {
                    long pad = expected - written - Rate / 50;
                    while (pad > 0)
                    {
                        int chunk = (int)Math.Min(pad, silence.Length / BlockAlign);
                        output.Write(silence, 0, chunk * BlockAlign);
                        written += chunk;
                        pad -= chunk;
                    }
                }
                output.Flush();
                if (stopRequested || (maxSeconds > 0 && clock.Elapsed.TotalSeconds >= maxSeconds)) return 0;
                if (originals != null)
                {
                    long nowMs = clock.ElapsedMilliseconds;
                    // 程式開始播放後才會出現音訊工作階段，所以持續檢查（每 0.1 秒）有沒有還沒調小的。
                    if (nowMs - lastQuietCheck >= 100)
                    {
                        lastQuietCheck = nowMs;
                        int total;
                        int loud = Sessions(pid, 0, originals, out total);
                        if (loud > 0)
                        {
                            // 剛調小：已經在路上的聲音還是原本的音量，先不放大，等 80 毫秒再開始放大（寧可短暫變小聲，不要爆音）。
                            gain = 1f;
                            boostAt = nowMs + 80;
                        }
                        else if (total > 0 && gain == 1f && boostAt < 0) boostAt = nowMs + 80;
                    }
                    if (boostAt >= 0 && nowMs >= boostAt)
                    {
                        gain = 1f / QuietLevel;
                        boostAt = -1;
                    }
                }
                if (clock.ElapsedMilliseconds - lastAliveCheck >= 1000)
                {
                    lastAliveCheck = clock.ElapsedMilliseconds;

                    if (!Alive(pid))
                    {
                        Console.Error.WriteLine("EXITED");
                        return 3;
                    }
                }
            }
        }
        finally
        {
            client.Stop();
        }
    }

    static int Fail(string step, int hr)
    {
        Console.Error.WriteLine("FAILED " + step + " 0x" + hr.ToString("X8"));
        return 4;
    }
}
