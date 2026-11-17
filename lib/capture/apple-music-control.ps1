# dsh-jukebox：按 Apple Music（Windows 版）視窗下方的播放控制鍵。
#
# Apple Music 還沒播過歌時不會出現在 Windows 的系統媒體控制裡，這時只剩鍵盤的媒體鍵可用，
# 而媒體鍵由系統決定給哪個播放器（實測可能控制到別的播放器）。所以改成直接對 Apple Music
# 自己的按鈕下指令：TransportControl_PlayPauseStop／SkipForward／SkipBack（2026-11 實測到的元件代號）。
# 只對這三個按鈕下指令，不動滑鼠，不需要把視窗拉到前面。
# 用法：apple-music-control.ps1 <toggle|next|previous>
# 輸出：一行 JSON：{ ok, label（按下之前按鈕上的文字）} 或 { ok:false, error }
param([string]$Action = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
function Done($value) { [Console]::Out.Write((ConvertTo-Json $value -Compress)); exit 0 }
try {
  $ids = @{ toggle = 'TransportControl_PlayPauseStop'; next = 'TransportControl_SkipForward'; previous = 'TransportControl_SkipBack' }
  if (-not $ids.ContainsKey($Action)) { Done @{ ok = $false; error = 'bad-action' } }
  Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
  $Element = [System.Windows.Automation.AutomationElement]
  $process = Get-Process -Name AppleMusic -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
  if (-not $process) { Done @{ ok = $false; error = 'not-running' } }
  $root = $Element::FromHandle($process.MainWindowHandle)
  $button = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition($Element::AutomationIdProperty, $ids[$Action])))
  if (-not $button) { Done @{ ok = $false; error = 'no-button' } }
  if (-not $button.Current.IsEnabled) { Done @{ ok = $false; error = 'disabled'; label = $button.Current.Name } }
  $label = $button.Current.Name
  $button.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  Done @{ ok = $true; label = $label }
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false; error = [string]$_.Exception.Message } -Compress))
  exit 1
}
