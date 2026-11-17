# dsh-jukebox：在 Apple Music（Windows 版）裡搜尋並播放一首歌。
#
# 2026-11 在有訂閱的 Apple Music（Windows 版）上實測可以播出聲音。
# Apple Music 沒有可以直接叫它播歌的連結（實測：打開歌曲連結不會開始播），
# 所以這裡用 Windows 的「使用者介面自動化」操作它自己的視窗：
#   在搜尋框填入關鍵字 → 按下搜尋建議 → 在結果裡找到第一首「歌曲」→ 按下它。
# 只操作 Apple Music 的視窗，只碰搜尋框、搜尋建議與歌曲結果；不讀也不改帳號、資料庫或設定。
# 用法：apple-music-play.ps1 <關鍵字> [希望的歌名]
# 輸出：一行 JSON：{ ok, picked（實際按下的結果文字）} 或 { ok:false, error }
param([string]$Query = '', [string]$Title = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Done($value) { [Console]::Out.Write((ConvertTo-Json $value -Compress)); exit 0 }
try {
  if (-not $Query.Trim()) { Done @{ ok = $false; error = 'empty-query' } }
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
  # 對 Apple Music 的元件下指令時，它會拿走前景（實測；畫面不一定有變化，但使用者打字會沒反應）。
  # 記下原本在前面的視窗，每一步做完就還回去；只有「更多」選單開著的那一小段不還（還了選單會關掉）。
  $front = [JbFocus]::GetForegroundWindow()
  function Back { Start-Sleep -Milliseconds 80; if ([JbFocus]::GetForegroundWindow() -ne $front) { [JbFocus]::GiveBack($front) } }
  $Element = [System.Windows.Automation.AutomationElement]
  $Scope = [System.Windows.Automation.TreeScope]
  $process = Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $process) { Done @{ ok = $false; error = 'not-running' } }
  $root = $Element::FromHandle($process.MainWindowHandle)
  $listItem = New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)
  function Items { $root.FindAll($Scope::Descendants, $listItem) }

  # 1. 搜尋框
  function ById($id) { $root.FindFirst($Scope::Descendants, (New-Object System.Windows.Automation.PropertyCondition($Element::AutomationIdProperty, $id))) }
  # 視窗剛從縮小叫出來時元件要一點時間才準備好（實測：偶爾第一次找不到搜尋框），所以最多等約 5 秒。
  # 視窗比較窄時側邊欄會收起來，搜尋框變成一顆「按一下以搜尋」的按鈕（實測）；按它就會展開（每一秒最多按一次）。
  $box = $null
  for ($i = 0; $i -lt 20 -and -not $box; $i++) {
    $box = ById 'TextBox'
    if ($box) { break }
    if ($i % 4 -eq 0) {
      $open = ById 'Search_Button'
      if ($open) { try { $open.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {} }
    }
    Start-Sleep -Milliseconds 250
  }
  if (-not $box) { Done @{ ok = $false; error = 'no-search-box' } }
  $value = $box.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)

  # Apple Music 會把建議改寫過：英文變小寫、空白有時變成連字號（實測：「YOASOBI アイドル」的建議是
  # 「yoasobi-アイドル」），所以不能要求一模一樣。比對方式：去掉空白與標點、不分大小寫後相同的優先；
  # 沒有的話，挑第一個「關鍵字的每個詞都出現在裡面」的建議。清單後面的「最近搜尋」「瀏覽類別」這類
  # 區塊標題不含關鍵字的詞，所以不會被選到。
  function Squash([string]$text) { return ([regex]::Replace($text.ToLowerInvariant(), '[\s\p{P}\p{S}]', '')) }
  $wantSquashed = Squash $Query
  $wantWords = @($Query.ToLowerInvariant() -split '\s+' | Where-Object { $_ -match '[\p{L}\p{N}]' })
  function PickSuggestion {
    $loose = $null
    foreach ($item in (Items)) {
      if ($item.Current.ClassName -ne 'ListViewItem') { continue }
      $name = [string]$item.Current.Name
      if (-not $name) { continue }
      if ((Squash $name) -eq $wantSquashed) { return $item }
      if (-not $loose) {
        $lower = $name.ToLowerInvariant(); $all = $true
        foreach ($word in $wantWords) { if (-not $lower.Contains($word)) { $all = $false; break } }
        if ($all) { $loose = $item }
      }
    }
    return $loose
  }

  # 2. 搜尋建議裡和關鍵字一樣的那一項。程式剛開的時候建議可能出不來（實測），
  #    所以最多試兩輪：每輪重新填一次關鍵字，等 5 秒。
  $suggestion = $null
  for ($round = 0; $round -lt 2 -and -not $suggestion; $round++) {
    if ($round -gt 0) { $value.SetValue(''); Start-Sleep -Milliseconds 400 }
    $value.SetValue($Query)
    for ($i = 0; $i -lt 10 -and -not $suggestion; $i++) {
      Start-Sleep -Milliseconds 500
      $suggestion = PickSuggestion
    }
  }
  if (-not $suggestion) { Done @{ ok = $false; error = 'no-suggestion' } }
  $suggestion.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Back

  # 3. 結果裡的歌曲：名稱是「歌名 歌曲 · 歌手」（中間的空白是各種 Unicode 空白，實測如此）。
  #    介面語言不同時「歌曲」那個字不同，所以列了幾種。
  $pattern = '^(.+?)\s+(歌曲|Song|曲|곡)\s*·\s*(.+)$'
  $songs = @()
  for ($i = 0; $i -lt 16 -and $songs.Count -eq 0; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($item in (Items)) {
      if ($item.Current.ClassName -ne 'GridViewItem') { continue }
      $m = [regex]::Match($item.Current.Name, $pattern)
      if ($m.Success) { $songs += , @($item, $m.Groups[1].Value.Trim(), $m.Groups[3].Value.Trim()) }
    }
  }
  if ($songs.Count -eq 0) { Done @{ ok = $false; error = 'no-song-result' } }

  # 4. 有給希望的歌名就優先挑歌名完全相同的；否則用第一首。
  $pick = $songs[0]
  if ($Title.Trim()) { foreach ($song in $songs) { if ($song[1] -eq $Title.Trim()) { $pick = $song; break } } }
  $pick[0].GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Back

  # 5. 按下歌曲結果只會打開它的專輯頁（實測），要再按專輯頁裡那一首的音軌列才會開始播。
  #    音軌列的名稱是「音軌 8 告白氣球 3 分鐘，36 秒」這種形式：以歌名比對。
  $wanted = $pick[1]
  $row = $null
  for ($i = 0; $i -lt 16 -and -not $row; $i++) {
    Start-Sleep -Milliseconds 500
    foreach ($item in (Items)) {
      $m = [regex]::Match($item.Current.Name, '^\D{1,12}\d{1,3}\s+(.+?)\s+\d')
      if ($m.Success -and $m.Groups[1].Value.Trim() -eq $wanted) { $row = $item; break }
    }
  }
  if (-not $row) { Done @{ ok = $false; error = 'no-track-row'; picked = ($pick[1] + ' — ' + $pick[2]) } }

  # 6. 直接按音軌列只會選取、不會播（實測）。改按那一列的「更多」，選單裡有「播放「歌名」」這一項。
  #    這樣全程都是對元件下指令，不需要滑鼠，也不需要把視窗拉到前面。
  $button = New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $more = $row.FindFirst($Scope::Descendants, $button)
  if (-not $more) { Done @{ ok = $false; error = 'no-more-button'; picked = ($pick[1] + ' — ' + $pick[2]) } }
  $more.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  $byProcess = New-Object System.Windows.Automation.PropertyCondition($Element::ProcessIdProperty, $process.Id)
  $menuItem = New-Object System.Windows.Automation.PropertyCondition($Element::ControlTypeProperty, [System.Windows.Automation.ControlType]::MenuItem)
  $play = $null
  for ($i = 0; $i -lt 10 -and -not $play; $i++) {
    Start-Sleep -Milliseconds 300
    # 選單可能是同一個程序的另一個最上層視窗，所以從桌面往下找這個程序的視窗。
    foreach ($top in $Element::RootElement.FindAll($Scope::Children, $byProcess)) {
      foreach ($item in $top.FindAll($Scope::Descendants, $menuItem)) {
        # 「播放「歌名」」：選單裡只有這一項帶著歌名。
        if ($item.Current.Name.Contains($wanted)) { $play = $item; break }
      }
      if ($play) { break }
    }
  }
  if (-not $play) {
    # 找不到就把選單關掉，不留一個開著的選單在畫面上。
    try { $more.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke() } catch {}
    Back
    Done @{ ok = $false; error = 'no-play-item'; picked = ($pick[1] + ' — ' + $pick[2]) }
  }
  $play.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Back
  Done @{ ok = $true; picked = ($pick[1] + ' — ' + $pick[2]); title = $pick[1]; results = $songs.Count }
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false; error = [string]$_.Exception.Message } -Compress))
  exit 1
}
