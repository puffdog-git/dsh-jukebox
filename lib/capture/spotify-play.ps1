# dsh-jukebox：在 Spotify 桌面版目前顯示的頁面上，直接按某一首歌那一列的播放鈕。
#
# 用播放連結（spotify:track:…）叫它播歌時，Spotify 會把自己從縮小叫出來並拿走前景。
# 如果那首歌就在它現在顯示的頁面上（例如剛搜尋完的結果頁），改成對那一列的播放鈕下指令：
# 這是介面元件的指令，不需要視窗在前面，也不會把它從縮小叫出來（2026-11 實測）。
# 找法：頁面上連到這首歌的連結（網址裡有 /track/<編號>）→ 往上找到它所在的那一列 → 那一列裡的第一顆按鈕。
# 只按這一顆按鈕。頁面上沒有這首歌就回報 not-on-page，由呼叫端改用播放連結。
# 用法：spotify-play.ps1 <曲目編號>
# 輸出：一行 JSON：{ ok, button（按下去的按鈕文字）} 或 { ok:false, error }
param([string]$TrackId = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Done($value) { [Console]::Out.Write((ConvertTo-Json $value -Compress)); exit 0 }
try {
  if ($TrackId -notmatch '^[A-Za-z0-9]{22}$') { Done @{ ok = $false; error = 'bad-id' } }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  Add-Type @'
using System; using System.Runtime.InteropServices;
public class JbFocus {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
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
  $Type = [System.Windows.Automation.ControlType]
  $process = Get-Process -Name Spotify -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $process) { Done @{ ok = $false; error = 'not-running' } }
  $root = $Element::FromHandle($process.MainWindowHandle)
  $links = $root.FindAll($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, $Type::Hyperlink)))
  $target = $null
  foreach ($link in $links) {
    $v = ''
    try { $v = $link.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern).Current.Value } catch {}
    if ($v -and $v.Contains('/track/' + $TrackId)) { $target = $link; break }
  }
  if (-not $target) { Done @{ ok = $false; error = 'not-on-page' } }
  # 往上找到這首歌所在的那一列（清單項目）；最多往上 8 層。
  $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
  $row = $target
  for ($i = 0; $i -lt 8 -and $row; $i++) {
    $row = $walker.GetParent($row)
    if ($row -and $row.Current.ControlType -eq $Type::DataItem) {
      $invokable = $false
      try { [void]$row.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern); $invokable = $true } catch {}
      if ($invokable) { break }
    }
  }
  if (-not $row -or $row.Current.ControlType -ne $Type::DataItem) { Done @{ ok = $false; error = 'no-row' } }
  $button = $row.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, $Type::Button)))
  if (-not $button) { Done @{ ok = $false; error = 'no-button' } }
  $label = ($button.Current.Name -replace '\s+', ' ').Trim()
  # 第一顆按鈕應該是播放鈕：清單裡的文字是「播放 歌手 的 歌名」（帶著歌名），最上面那一格只有「播放」兩個字。
  # 文字很長又不帶歌名的不要按（可能是「新增至已按讚的歌曲」之類會改到使用者資料的按鈕）。
  $title = ($target.Current.Name -replace '\s+', ' ').Trim()
  $looksLikePlay = ($title -and $label.Contains($title)) -or ($label.Length -gt 0 -and $label.Length -le 6)
  if (-not $looksLikePlay) { Done @{ ok = $false; error = 'unexpected-button'; button = $label } }
  # 按下去之後，前景會跑到 Spotify 一個看不見的子視窗上（實測；畫面沒變，但使用者打字會沒反應）。
  # 所以先記下原本在前面的視窗，按完馬上還回去（看兩次，間隔 120 毫秒）。
  $front = [JbFocus]::GetForegroundWindow()
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  for ($i = 0; $i -lt 2; $i++) { Start-Sleep -Milliseconds 120; if ([JbFocus]::GetForegroundWindow() -ne $front) { [JbFocus]::GiveBack($front) } }
  Done @{ ok = $true; button = $label }
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false; error = [string]$_.Exception.Message } -Compress))
  exit 1
}
