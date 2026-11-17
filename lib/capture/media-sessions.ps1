# dsh-jukebox：透過 Windows 的系統媒體控制（就是鍵盤媒體鍵與音量浮層用的那一套）讀取與控制播放器。
#
# 用法：
#   media-sessions.ps1 list
#       列出所有媒體工作階段：來源程式、播放狀態、曲名、歌手、專輯。
#   media-sessions.ps1 <pause|play|toggle|next|previous|stop> <比對字串>
#       對「來源程式名稱包含比對字串」的工作階段送出動作（不分大小寫）。
# 輸出：一行 JSON。只做這幾個動作，不讀取音訊，也不碰其他程式。
param([string]$Action = 'list', [string]$Match = '')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
    })[0]
  function Await($operation, [Type]$type) {
    $task = $asTask.MakeGenericMethod($type).Invoke($null, @($operation))
    if (-not $task.Wait(8000)) { throw 'timeout' }
    $task.Result
  }
  $managerType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $manager = Await ($managerType::RequestAsync()) $managerType
  $rows = @()
  foreach ($session in $manager.GetSessions()) {
    $app = [string]$session.SourceAppUserModelId
    $row = [ordered]@{ app = $app; status = ''; title = ''; artist = ''; album = '' }
    try { $row.status = [string]$session.GetPlaybackInfo().PlaybackStatus } catch {}
    try {
      $p = Await ($session.TryGetMediaPropertiesAsync()) $propsType
      $row.title = [string]$p.Title; $row.artist = [string]$p.Artist; $row.album = [string]$p.AlbumTitle
    } catch {}
    if ($Action -ne 'list') {
      if (-not $Match -or $app.ToLowerInvariant().IndexOf($Match.ToLowerInvariant()) -lt 0) { continue }
      $operation = switch ($Action) {
        'pause' { $session.TryPauseAsync() }
        'play' { $session.TryPlayAsync() }
        'toggle' { $session.TryTogglePlayPauseAsync() }
        'next' { $session.TrySkipNextAsync() }
        'previous' { $session.TrySkipPreviousAsync() }
        'stop' { $session.TryStopAsync() }
        default { throw 'unknown-action' }
      }
      $row.done = [bool](Await $operation ([bool]))
    }
    $rows += [pscustomobject]$row
  }
  [Console]::Out.Write((ConvertTo-Json @{ ok = $true; sessions = @($rows) } -Depth 4 -Compress))
} catch {
  [Console]::Out.Write((ConvertTo-Json @{ ok = $false; error = [string]$_.Exception.Message } -Compress))
  exit 1
}
