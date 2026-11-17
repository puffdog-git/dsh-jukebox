# dsh-jukebox：用 Spotify 桌面版自己的搜尋找歌（不用登入 Spotify 的開發者接口，免費版可用）。
#
# 2026-11 實測：Spotify 桌面版（網頁技術做的）會公開它的介面元件。
# 做法：打開 Spotify 自己的搜尋連結 spotify:search:<關鍵字>（和在它的搜尋框打字一樣），
#       等搜尋頁出現，再讀結果裡每首歌的連結（裡面有曲目編號）與後面跟著的歌手名稱。
# 只讀，不按任何東西，不動滑鼠。直接對搜尋框填值、在背景把字寄給它，實測都沒有用，所以用搜尋連結。
#
# 打開連結時 Spotify 會把自己從縮小叫出來並拿走前景，這個擋不掉。實測過而且都不行的做法：
#   改它還原後的位置（它不理）、設成透明（無效）、一出來就立刻縮回去或把前景拿走
#   （它就不換頁，要等下一次叫它才換）、反覆把它縮回去（和它拉扯，還會弄亂它的視窗位置）。
# 所以這裡做的是把時間壓到最短：每 50 毫秒看一次分頁標題，一換成這次的搜尋、結果讀到了，
# 就把它縮回去並把前景還給原本的視窗。原本就不是縮小的視窗不會被縮小，只會把前景還回去。
# 用法：spotify-search.ps1 <關鍵字> [最多幾首]
# 輸出：一行 JSON：{ ok, tracks:[{id,title,artist}], shownMs } 或 { ok:false, error }
param([string]$Query = '', [int]$Limit = 10)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Done($value) { [Console]::Out.Write((ConvertTo-Json $value -Compress -Depth 4)); exit 0 }
try {
  $Query = $Query.Trim()
  if (-not $Query) { Done @{ ok = $false; error = 'empty-query' } }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type @'
using System; using System.Runtime.InteropServices;
public class JbWin {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static uint OwnerOf(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr h);
  [DllImport("user32.dll", EntryPoint="GetWindowLongPtrW")] public static extern IntPtr GetLong(IntPtr h, int i);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int attr, out int value, int size);
  // 畫面上最上層、看得到、不是指定程序的一般視窗（找不到回 IntPtr.Zero）。
  public static IntPtr TopVisible(uint[] skip) {
    IntPtr found = IntPtr.Zero;
    EnumWindows((h, x) => {
      if (!IsWindowVisible(h) || IsIconic(h) || GetWindowTextLength(h) == 0) return true;
      if ((GetLong(h, -20).ToInt64() & 0x80) != 0) return true;
      int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4); if (cloaked != 0) return true;
      if (Array.IndexOf(skip, OwnerOf(h)) >= 0) return true;
      found = h; return false;
    }, IntPtr.Zero);
    return found;
  }
  // 把前景還給指定的視窗。Windows 只讓「目前在前面的程式」換前景，所以先暫時接上它的輸入佇列。
  public static void GiveBack(IntPtr target) {
    IntPtr now = GetForegroundWindow();
    if (now == target || target == IntPtr.Zero || !IsWindow(target)) return;
    uint ignored; uint front = GetWindowThreadProcessId(now, out ignored), me = GetCurrentThreadId();
    AttachThreadInput(me, front, true); SetForegroundWindow(target); BringWindowToTop(target); AttachThreadInput(me, front, false);
  }
}
'@
  $Element = [System.Windows.Automation.AutomationElement]
  $Scope = [System.Windows.Automation.TreeScope]
  $process = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $process) { Done @{ ok = $false; error = 'not-running' } }
  $window = $process.MainWindowHandle
  $ownPids = @(Get-Process -Name Spotify | ForEach-Object { [uint32]$_.Id })
  $root = $Element::FromHandle($window)
  $linkCondition = New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, [System.Windows.Automation.ControlType]::Hyperlink)
  $docCondition = New-Object System.Windows.Automation.PropertyCondition($Element::AutomationIdProperty, 'RootWebArea')
  function LinkValue($link) { try { $link.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch { '' } }
  function SpotifyInFront { return ($ownPids -contains [JbWin]::OwnerOf([JbWin]::GetForegroundWindow())) }
  # 確認頁面已經換成這次的搜尋：頁面上有帶著這次關鍵字的搜尋分頁連結（網址是 /search/<關鍵字>/…）。
  # 不能看分頁標題：正在播歌時標題會變成「歌名 • 歌手」（實測），就看不出是不是搜尋頁了。
  function OnSearchPage {
    foreach ($link in $root.FindAll($Scope::Descendants, $linkCondition)) {
      $v = LinkValue $link
      if ($v -and $v -match '/search/' -and ([uri]::UnescapeDataString($v) -replace '\+', ' ').Contains('/search/' + $Query)) { return $true }
    }
    return $false
  }
  # 讀搜尋結果裡的歌曲。搜尋分頁（網址有 /search/）之前的連結是「現正播放」等，和這次搜尋無關。
  # 分頁標題會比結果清單早換（實測：太早讀會讀到上一次搜尋留下來的歌），
  # 所以要看到「這次關鍵字」的搜尋分頁連結之後才開始收；看到的是別的關鍵字就一首都不收。
  function ReadTracks {
    $found = @(); $current = $null; $started = $false
    foreach ($link in $root.FindAll($Scope::Descendants, $linkCondition)) {
      $v = LinkValue $link
      if (-not $v) { continue }
      if ($v -match '/search/') { $started = ([uri]::UnescapeDataString($v) -replace '\+', ' ').Contains('/search/' + $Query); continue }
      if (-not $started) { continue }
      $name = ($link.Current.Name -replace '\s+', ' ').Trim()
      if ($v -match '/track/([A-Za-z0-9]{22})') {
        $current = @{ id = $Matches[1]; title = $name; artist = '' }
        if ($name -and -not ($found | Where-Object { $_.id -eq $current.id })) { $found += , $current } else { $current = $null }
      } elseif ($v -match '/artist/' -and $current -and $name) {
        $current.artist = if ($current.artist) { $current.artist + ', ' + $name } else { $name }
      } else { $current = $null }
    }
    return , $found
  }

  $front = [JbWin]::GetForegroundWindow()
  $wasMinimized = [JbWin]::IsIconic($window)
  $frontWasSpotify = SpotifyInFront
  $shown = New-Object System.Diagnostics.Stopwatch
  function TuckAway {
    # 它在前面時用「縮小並啟用下一個視窗」（6）：只縮小不啟用（7）的話，前景會留在已經縮小的 Spotify 上，
    # 等於沒有任何視窗拿到鍵盤（實測發生過）。
    if ($wasMinimized -and -not [JbWin]::IsIconic($window)) { [void][JbWin]::ShowWindow($window, $(if (SpotifyInFront) { 6 } else { 7 })) }
    if (-not $frontWasSpotify -and (SpotifyInFront)) { [JbWin]::GiveBack($front) }
    # 最後的保險：前景還在「已經縮小的 Spotify」上，就交給畫面上最上層的視窗。
    if ((SpotifyInFront) -and [JbWin]::IsIconic($window)) { $next = [JbWin]::TopVisible([uint32[]]$ownPids); if ($next -ne [IntPtr]::Zero) { [JbWin]::GiveBack($next) } }
    $shown.Stop()
  }
  try {
    # Spotify 縮小閒置一陣子之後反應會變慢，所以最多試兩輪：每輪重新打開一次搜尋連結，等 7 秒。
    $ready = $false
    for ($round = 0; $round -lt 2 -and -not $ready; $round++) {
      Start-Process rundll32.exe -ArgumentList 'url.dll,FileProtocolHandler', ('spotify:search:' + [uri]::EscapeDataString($Query)) -WindowStyle Hidden
      for ($i = 0; $i -lt 140 -and -not $ready; $i++) {
        Start-Sleep -Milliseconds 50
        if (-not $shown.IsRunning -and (($wasMinimized -and -not [JbWin]::IsIconic($window)) -or (-not $frontWasSpotify -and (SpotifyInFront)))) { $shown.Start() }
        $ready = OnSearchPage
      }
    }
    if (-not $ready) { Done @{ ok = $false; error = 'no-search-page' } }
    # 結果是分批出現的：每 100 毫秒讀一次，有結果而且數量不再增加就收工（最多 3 秒）。
    $tracks = @(); $last = -1
    for ($i = 0; $i -lt 30; $i++) {
      Start-Sleep -Milliseconds 100
      $tracks = ReadTracks
      if ($tracks.Count -gt 0 -and $tracks.Count -eq $last) { break }
      $last = $tracks.Count
    }
    TuckAway
    Done @{ ok = $true; tracks = @($tracks | Select-Object -First $Limit); shownMs = [int]$shown.ElapsedMilliseconds }
  } finally {
    TuckAway
  }
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false; error = [string]$_.Exception.Message } -Compress))
  exit 1
}
