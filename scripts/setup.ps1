<#
  Fono Console 一鍵環境設定（Windows 10/11, PowerShell 5.1+）

  這支腳本把「讓 Fono Console 可以一鍵運作」需要的周邊設定做完：
    1. 安裝 Fono Console
    2. 檢查 / 安裝 Equalizer APO，開 Device Selector
    3. 選擇你的多聲道音效卡與立體聲 DAC
    4. 把 Equalizer APO 的 config.txt 交給 Fono Console 管理（自動備份）
    5. 偵測 REW
    6. Spotify：引導建立開發者 App，輸入你的 Client ID
    7. YouTube Music 桌面版：安裝（雜湊驗證）並開啟 API 伺服器
    8. （可選）Chrome 省記憶體政策
    9. 寫入 Fono Console 設定檔

  用法：
    scripts\setup.cmd                 # 互動式，全部步驟
    scripts\setup.cmd -Step 6         # 只做第 6 步（可用逗號：-Step 3,4,9）
    scripts\setup.cmd -UndoChrome     # 移除第 8 步加上的 Chrome 政策

  每一步都會先問你，按 Enter 用括號內的預設值。不會上傳任何資料。
#>
[CmdletBinding()]
param(
  [int[]]$Step = @(1, 2, 3, 4, 5, 6, 7, 8, 9),
  [switch]$UndoChrome
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
$Root = Split-Path -Parent $PSScriptRoot
$DataDir = Join-Path $env:APPDATA 'FonoConsole'
$SettingsPath = Join-Path $DataDir 'settings.json'
$SpotifyPath = Join-Path $DataDir 'spotify.json'
$Port = 47811
$Stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$Plan = @{}   # 這次要寫進 settings.json 的值

# ------------------------------------------------------------------ helpers
function Title($n, $t) { Write-Host ''; Write-Host ("=== {0}. {1} " -f $n, $t).PadRight(60, '=') -ForegroundColor Yellow }
function Info($t) { Write-Host "  $t" }
function Ok($t) { Write-Host "  ✓ $t" -ForegroundColor Green }
function Warn($t) { Write-Host "  ! $t" -ForegroundColor DarkYellow }
function Ask($q, $def = '') {
  $s = if ($def -ne '') { " [$def]" } else { '' }
  $a = Read-Host "  $q$s"
  if ([string]::IsNullOrWhiteSpace($a)) { return $def } else { return $a.Trim() }
}
function YesNo($q, [bool]$def = $true) {
  $d = if ($def) { 'Y/n' } else { 'y/N' }
  while ($true) {
    $a = Read-Host "  $q ($d)"
    if ([string]::IsNullOrWhiteSpace($a)) { return $def }
    if ($a -match '^(y|yes|是|好)$') { return $true }
    if ($a -match '^(n|no|否|不)$') { return $false }
  }
}
function Pause-Until($q) { Read-Host "  $q，完成後按 Enter" | Out-Null }
function Backup($p) { if (Test-Path $p) { $b = "$p.bak-$Stamp"; Copy-Item $p $b -Force; Info "已備份：$b" } }
function Read-Json($p) {
  if (Test-Path $p) { try { return (Get-Content $p -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { Warn "無法解析 $p，將重建" } }
  return [pscustomobject]@{}
}
function Set-Prop($obj, $name, $value) {
  if ($obj.PSObject.Properties[$name]) { $obj.$name = $value } else { $obj | Add-Member -NotePropertyName $name -NotePropertyValue $value }
}
function Write-Json($p, $obj) {
  New-Item -ItemType Directory -Force -Path (Split-Path $p) | Out-Null
  $json = $obj | ConvertTo-Json -Depth 50
  [IO.File]::WriteAllText($p, $json, (New-Object Text.UTF8Encoding $false))
}
function Run-Elevated([string]$script) {
  # 只有需要系統管理員權限的步驟才提權；其餘都以你自己的帳號執行。
  $enc = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($script))
  $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $enc)
  return $p.ExitCode
}
function Fono-Running { [bool](Get-Process FonoConsole -ErrorAction SilentlyContinue) }

# ------------------------------------------------------------------ Equalizer APO helpers
$EapoClsids = @('{EACD2258-FCAC-4FF4-B36D-419E924A6D79}', '{EC1CC9CE-FAED-4822-828A-82A81A6F018F}')
function Get-Eapo {
  try {
    $k = Get-ItemProperty 'HKLM:\SOFTWARE\EqualizerAPO' -ErrorAction Stop
    return [pscustomobject]@{ Install = $k.InstallPath; Config = $k.ConfigPath }
  } catch { return $null }
}
function Get-RenderDevices {
  $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
  $out = @()
  foreach ($k in Get-ChildItem $base -ErrorAction SilentlyContinue) {
    try { $st = (Get-ItemProperty $k.PSPath -Name DeviceState -ErrorAction Stop).DeviceState } catch { continue }
    if ($st -ne 1) { continue }
    $pp = Get-ItemProperty (Join-Path $k.PSPath 'Properties') -ErrorAction SilentlyContinue
    $fx = Get-ItemProperty (Join-Path $k.PSPath 'FxProperties') -ErrorAction SilentlyContinue
    $hasEapo = $false
    if ($fx) { foreach ($v in $fx.PSObject.Properties) { foreach ($c in $EapoClsids) { if ("$($v.Value)" -like "*$c*") { $hasEapo = $true } } } }
    $out += [pscustomobject]@{
      Guid  = $k.PSChildName
      Name  = "$($pp.'{a45c254e-df1c-4efd-8020-67d146a850e0},2')"
      Iface = "$($pp.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6')"
      Eapo  = $hasEapo
    }
  }
  return $out
}

# ================================================================== 1
function Step1 {
  Title 1 '安裝 Fono Console'
  $exe = @((Join-Path $Root 'FonoConsole.exe'), (Join-Path $Root 'dist\FonoConsole.exe'), (Join-Path $PSScriptRoot 'FonoConsole.exe')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  $installed = Join-Path $env:LOCALAPPDATA 'Programs\FonoConsole\FonoConsole.exe'
  if (-not $exe) {
    if (Test-Path $installed) { Ok "已安裝：$installed"; return }
    Warn '找不到 FonoConsole.exe。請先下載 Release 或執行 scripts\build.ps1，放到專案根目錄後再跑這一步。'
    return
  }
  if (Test-Path $installed) { if (-not (YesNo "已經安裝過，要用 $exe 更新嗎？")) { return } }
  if (Fono-Running) { Warn 'Fono Console 正在執行，先關閉它'; Pause-Until '關閉 Fono Console' }
  Start-Process $exe -ArgumentList '--install' -Wait
  if (Test-Path $installed) { Ok "已安裝到 $installed（開始選單與桌面有捷徑）" } else { Warn '安裝似乎沒有完成' }
}

# ================================================================== 2
function Step2 {
  Title 2 'Equalizer APO'
  $e = Get-Eapo
  if (-not $e) {
    Info 'Equalizer APO 是 Windows 的系統等化器，Fono Console 的所有音效都靠它。'
    Info '安裝時會跳出 Device Selector：勾選「你要校正的喇叭輸出」（例如多聲道音效卡、DAC、耳機），不要勾麥克風。'
    $bundled = Get-ChildItem (Join-Path $Root 'bundled') -Filter 'EqualizerAPO*.exe' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($bundled -and (YesNo "執行安裝包內附的官方安裝程式（$($bundled.Name)，GPLv2，來源見 bundled\SOURCES.txt）？")) { Start-Process $bundled.FullName -Wait }
    elseif (YesNo '打開官方下載頁？') { Start-Process 'https://sourceforge.net/projects/equalizerapo/files/' }
    Pause-Until '安裝 Equalizer APO（安裝完不用急著重開機，最後一次重開即可）'
    $e = Get-Eapo
    if (-not $e) { Warn '仍偵測不到 Equalizer APO，後面第 3、4 步會跳過'; return }
  }
  Ok "Equalizer APO：$($e.Install)"
  $devs = Get-RenderDevices
  $with = @($devs | Where-Object Eapo)
  Info ("已裝在 {0} 個輸出裝置上：" -f $with.Count)
  foreach ($d in $with) { Info "   • $($d.Name) ($($d.Iface))" }
  if (YesNo '要開 Device Selector 增減裝置嗎？' ($with.Count -eq 0)) {
    $ds = Join-Path $e.Install 'DeviceSelector.exe'
    if (Test-Path $ds) { Start-Process $ds -Verb RunAs; Pause-Until '在 Device Selector 勾選裝置並按 OK' }
    else { Warn "找不到 $ds" }
    Warn '有新增裝置的話，全部設定完後請重新開機一次才會生效。'
  }
}

# ================================================================== 3
function Step3 {
  Title 3 '選擇輸出裝置'
  $devs = @(Get-RenderDevices)
  if ($devs.Count -eq 0) { Warn '找不到啟用中的播放裝置'; return }
  for ($i = 0; $i -lt $devs.Count; $i++) {
    $d = $devs[$i]; $tag = if ($d.Eapo) { 'EQ APO ✓' } else { '未裝 EQ APO' }
    Write-Host ("  [{0}] {1} ({2})  — {3}" -f ($i + 1), $d.Name, $d.Iface, $tag)
  }
  Info ''
  Info '「多聲道」：接前後四顆喇叭的 USB 7.1 音效卡（四聲道模式用）。'
  Info '「立體聲」：只接前方一對喇叭的 DAC（立體聲模式用）。沒有就留空。'
  Info '只有一張卡也可以：兩個都填同一個號碼，或只填一個。'
  $pick = {
    param($label)
    while ($true) {
      $a = Ask "$label 的號碼（Enter 跳過）"
      if ($a -eq '') { return '' }
      if ($a -match '^\d+$' -and [int]$a -ge 1 -and [int]$a -le $devs.Count) { return $devs[[int]$a - 1] }
      Warn '請輸入清單中的號碼'
    }
  }
  $cm = & $pick '多聲道音效卡'
  $sp = & $pick '立體聲 DAC'
  $dev = @{}
  foreach ($x in @(@('cm', $cm), @('spark', $sp))) {
    if ($x[1]) {
      $dev[$x[0]] = $x[1].Guid
      if (-not $x[1].Eapo) { Warn "$($x[1].Name) 還沒裝 Equalizer APO：回到第 2 步用 Device Selector 勾選它" }
    }
  }
  if ($dev.Count) { $Plan['dev'] = $dev; Ok '已記下，第 9 步寫入' }
  if ($cm -and (YesNo '要幫四顆喇叭取顯示名稱嗎？（只影響畫面）' $false)) {
    $spk = @{}
    foreach ($k in 'FL', 'FR', 'SL', 'SR') {
      $label = @{ FL = '左前'; FR = '右前'; SL = '左後'; SR = '右後' }[$k]
      $n = Ask "$label ($k) 名稱，例如「書架喇叭 · 擴大機 A」"
      if ($n) { $spk[$k] = $n }
    }
    if ($spk.Count) { $Plan['spk'] = $spk }
  }
}

# ================================================================== 4
function Step4 {
  Title 4 '把 config.txt 交給 Fono Console'
  $e = Get-Eapo
  if (-not $e) { Warn '沒有 Equalizer APO，跳過'; return }
  $cfg = Join-Path $e.Config 'config.txt'
  $line = 'Include: fono_console.txt'
  $cur = if (Test-Path $cfg) { Get-Content $cfg -Raw } else { '' }
  if ($cur.Trim() -eq $line) { Ok 'config.txt 已經只引用 fono_console.txt' }
  else {
    Info '目前的 config.txt 內容：'
    ($cur -split "`r?`n" | Select-Object -First 12) | ForEach-Object { Info "   | $_" }
    Info '接下來會備份它，並改成只有一行「Include: fono_console.txt」。'
    Info '（你在 Editor 裡的舊設定會留在備份檔，Fono Console 會完全接手音效。）'
    if (-not (YesNo '繼續？')) { return }
  }
  $user = "$env:USERDOMAIN\$env:USERNAME"
  $q = { param($s) "'" + ($s -replace "'", "''") + "'" }
  $script = @"
`$ErrorActionPreference = 'Stop'
`$dir = $(& $q $e.Config)
`$cfg = Join-Path `$dir 'config.txt'
if ((Test-Path `$cfg) -and ((Get-Content `$cfg -Raw).Trim() -ne 'Include: fono_console.txt')) { Copy-Item `$cfg (Join-Path `$dir 'config.backup-$Stamp.txt') }
[IO.File]::WriteAllText(`$cfg, "Include: fono_console.txt`r`n")
`$fc = Join-Path `$dir 'fono_console.txt'
if (-not (Test-Path `$fc)) { [IO.File]::WriteAllText(`$fc, "# managed by Fono Console`r`n") }
New-Item -ItemType Directory -Force -Path (Join-Path `$dir 'fono') | Out-Null
icacls `$dir /grant $(& $q "${user}:(OI)(CI)M") /T /Q | Out-Null
"@
  Info '需要系統管理員權限（寫入 Program Files），請在 UAC 視窗按「是」。'
  $code = Run-Elevated $script
  if ($code -eq 0) { Ok "完成；並讓 $user 可以直接寫入設定資料夾" } else { Warn "提權步驟失敗（代碼 $code）" }
}

# ================================================================== 5
function Step5 {
  Title 5 'REW（Room EQ Wizard，可選）'
  Info 'Fono Console 內建一鍵量測，不一定需要 REW；REW 適合想看瀑布圖、做進階分析的人。'
  $cands = @((Join-Path $env:ProgramFiles 'REW\roomeqwizard.exe'), (Join-Path ${env:ProgramFiles(x86)} 'REW\roomeqwizard.exe'), (Join-Path $env:LOCALAPPDATA 'Programs\REW\roomeqwizard.exe'))
  $rew = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
  if ($rew) { Ok "找到 REW：$rew" }
  else {
    Info '沒找到 REW。'
    if (YesNo '打開 REW 下載頁？' $false) { Start-Process 'https://www.roomeqwizard.com/' ; Pause-Until '安裝 REW' }
    $rew = $cands | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
    if (-not $rew) { $p = Ask '如果裝在別處，輸入 roomeqwizard.exe 的完整路徑（Enter 跳過）'; if ($p -and (Test-Path $p)) { $rew = $p } }
  }
  if ($rew) {
    $Plan['rew'] = @{ exe = $rew }
    Info '要讓 Fono Console 讀取 REW 的濾波器：REW → Preferences → API → 勾選「Start server」（埠 4735）。'
  }
}

# ================================================================== 6
function Step6 {
  Title 6 'Spotify（曲庫搜尋 / 播放清單）'
  Info '播放控制（播放、暫停、進度、封面）不用任何設定就能用。'
  Info '要在 Fono Console 裡搜尋、開專輯和播放清單，需要你自己的 Spotify 開發者 App（免費，約 3 分鐘）：'
  Info '  1. 用你的 Spotify 帳號登入 developer.spotify.com/dashboard，按「Create app」'
  Info '  2. App name / description 隨意，例如「Fono Console」'
  Info "  3. Redirect URI 填入：http://127.0.0.1:$Port/api/spotify/callback  （要用 127.0.0.1，不能寫 localhost）"
  Info '  4. 「Which API/SDKs」勾 Web API，同意條款後 Save'
  Info '  5. 打開 App 的 Settings，複製 Client ID（32 個英數字）'
  Warn '目前 Spotify 規定：開發模式的 App 擁有者需要 Premium，且只有你加進 User Management 的帳號能登入。'
  $old = Read-Json $SpotifyPath
  if ($old.clientId) { Info "目前已設定 Client ID：$($old.clientId.Substring(0,6))…" }
  if (-not (YesNo '現在設定 Spotify？' (-not $old.clientId))) { return }
  if (YesNo '打開 Spotify Developer Dashboard？') { Start-Process 'https://developer.spotify.com/dashboard' }
  while ($true) {
    $id = Ask '貼上 Client ID（Enter 跳過）'
    if ($id -eq '') { return }
    if ($id -match '^[0-9a-fA-F]{32}$') { break }
    Warn 'Client ID 應該是 32 個 0-9 / a-f 字元'
  }
  if (Fono-Running) { Warn 'Fono Console 正在執行，先關閉它，避免覆寫'; Pause-Until '關閉 Fono Console' }
  $j = Read-Json $SpotifyPath
  if ($j.clientId -and $j.clientId -ne $id) { foreach ($p in 'accessToken', 'refreshToken', 'expiry') { $j.PSObject.Properties.Remove($p) } }
  Set-Prop $j 'clientId' $id.ToLower()
  Set-Prop $j 'redirectUri' "http://127.0.0.1:$Port/api/spotify/callback"
  Backup $SpotifyPath
  Write-Json $SpotifyPath $j
  Ok '已寫入。開 Fono Console → 07 設定 → Spotify →「連結帳號」完成授權。'
}

# ================================================================== 7
function Find-YtmExe { $p = Join-Path $env:LOCALAPPDATA 'Programs\youtube-music\YouTube Music.exe'; if (Test-Path $p) { $p } }
function Step7 {
  Title 7 'YouTube Music 桌面版'
  Info 'Fono Console 透過開源的 YouTube Music 桌面版（pear-desktop，原 th-ch/youtube-music）的 API 伺服器搜尋與播放。'
  $exe = Find-YtmExe
  if (-not $exe) {
    if (-not (YesNo '沒找到 YouTube Music 桌面版，要下載官方安裝檔並驗證雜湊嗎？')) { return }
    $rel = $null
    foreach ($repo in 'pear-devs/pear-desktop', 'th-ch/youtube-music') {
      try { $rel = Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest" -Headers @{ 'User-Agent' = 'fono-console-setup' }; break } catch {}
    }
    if (-not $rel) { Warn '無法連到 GitHub API。請手動從 GitHub Releases 下載「Web-Setup」安裝檔。'; return }
    $asset = $rel.assets | Where-Object { $_.name -match 'Web-Setup.*\.exe$' } | Select-Object -First 1
    if (-not $asset) { Warn "在 $($rel.tag_name) 找不到 Web-Setup 安裝檔"; return }
    $dst = Join-Path $env:TEMP $asset.name
    Info "下載 $($asset.name)（$([math]::Round($asset.size/1MB,1)) MB，$($rel.tag_name)）…"
    Invoke-WebRequest $asset.browser_download_url -OutFile $dst -UseBasicParsing
    $hash = (Get-FileHash $dst -Algorithm SHA256).Hash.ToLower()
    if ($asset.digest) {
      $want = ($asset.digest -replace '^sha256:', '').ToLower()
      if ($hash -ne $want) { Remove-Item $dst -Force; Warn "雜湊不符，已刪除下載檔（得到 $hash，應為 $want）"; return }
      Ok "SHA-256 與 GitHub 公布的一致：$hash"
    } else { Warn "GitHub 沒提供雜湊，請自行比對：$hash"; if (-not (YesNo '仍要執行安裝檔？' $false)) { return } }
    Start-Process $dst -Wait
    Start-Sleep 3
    Remove-Item $dst -Force -ErrorAction SilentlyContinue
    $exe = Find-YtmExe
    if (-not $exe) { Pause-Until '等安裝完成並登入 YouTube Music'; $exe = Find-YtmExe }
  }
  if ($exe) { Ok "找到：$exe" }

  # 開啟 API 伺服器外掛（需在 App 關閉時改設定）
  $cfg = @((Join-Path $env:APPDATA 'YouTube Music\config.json'), (Join-Path $env:APPDATA 'youtube-music\config.json'), (Join-Path $env:APPDATA 'pear-desktop\config.json')) | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $cfg) {
    Warn '還沒有設定檔：先開一次 YouTube Music、登入、再關閉，然後重跑：scripts\setup.cmd -Step 7'
    if ($exe -and (YesNo '現在開啟 YouTube Music？')) { Start-Process $exe }
    return
  }
  if (Get-Process 'YouTube Music' -ErrorAction SilentlyContinue) {
    Warn 'YouTube Music 正在執行，改設定前要完全關閉（含系統匣圖示）'
    if (YesNo '幫你關閉它？') { Get-Process 'YouTube Music' | Stop-Process -Force; Start-Sleep 2 } else { Pause-Until '關閉 YouTube Music' }
  }
  $j = Read-Json $cfg
  if (-not $j.plugins) { Set-Prop $j 'plugins' ([pscustomobject]@{}) }
  $api = $j.plugins.'api-server'
  if (-not $api) { $api = [pscustomobject]@{}; Set-Prop $j.plugins 'api-server' $api }
  Set-Prop $api 'enabled' $true
  Set-Prop $api 'hostname' '127.0.0.1'
  Set-Prop $api 'port' 26538
  Set-Prop $api 'authStrategy' 'AUTH_AT_FIRST'
  Backup $cfg
  Write-Json $cfg $j
  Ok 'API 伺服器已開啟（127.0.0.1:26538，只接受本機）'
  Info '第一次用 Fono Console 的曲庫時，YouTube Music 會跳出授權視窗，按「允許」即可。'
}

# ================================================================== 8
$ChromePol = 'HKCU:\Software\Policies\Google\Chrome'
$ChromeVals = [ordered]@{ BackgroundModeEnabled = 0; HighEfficiencyModeEnabled = 1; MemorySaverModeEnabled = 1; MemorySaverModeSavings = 1 }
function Step8 {
  Title 8 'Chrome 省記憶體（可選）'
  Info 'Chrome 一個分頁一個程序是正常設計；擴充功能（含 AI 助理類）會讓 Chrome 關視窗後仍在背景常駐。'
  Info '這一步用「目前使用者」的政策：關閉背景執行、開啟記憶體節省模式（閒置分頁自動釋放）。'
  Info '設定後 chrome://policy 會看得到，Chrome 會顯示「由你的機構管理」，這是正常的。'
  if (-not (YesNo '套用？' $false)) { return }
  New-Item -Path $ChromePol -Force | Out-Null
  foreach ($k in $ChromeVals.Keys) { New-ItemProperty -Path $ChromePol -Name $k -Value $ChromeVals[$k] -PropertyType DWord -Force | Out-Null }
  Ok '已套用，重開 Chrome 生效。要還原：scripts\setup.cmd -UndoChrome'
}
function Undo-Chrome {
  if (Test-Path $ChromePol) {
    foreach ($k in $ChromeVals.Keys) { Remove-ItemProperty -Path $ChromePol -Name $k -ErrorAction SilentlyContinue }
    if (-not (Get-Item $ChromePol).Property) { Remove-Item $ChromePol -Force }
  }
  Ok '已移除 Chrome 政策'
}

# ================================================================== 9
function Merge($obj, [hashtable]$h) {
  foreach ($k in $h.Keys) {
    $v = $h[$k]
    if ($v -is [hashtable]) {
      $sub = $obj.$k
      if (-not $sub -or $sub -isnot [pscustomobject]) { $sub = [pscustomobject]@{}; Set-Prop $obj $k $sub }
      Merge $sub $v
    } else { Set-Prop $obj $k $v }
  }
}
function Step9 {
  Title 9 '寫入 Fono Console 設定'
  if ($Plan.Count -eq 0) { Info '這次沒有需要寫入的設定'; return }
  if (Fono-Running) { Warn 'Fono Console 正在執行，關閉後再寫入（否則會被它覆蓋）'; Pause-Until '關閉 Fono Console' }
  $j = Read-Json $SettingsPath
  Merge $j $Plan
  Backup $SettingsPath
  Write-Json $SettingsPath $j
  Ok "已寫入 $SettingsPath"
}

# ================================================================== main
Write-Host ''
Write-Host '  FONO CONSOLE · 環境設定' -ForegroundColor White
Write-Host '  每一步都會先詢問；不想做的步驟直接回答 n。' -ForegroundColor DarkGray
if ($UndoChrome) { Undo-Chrome; return }
foreach ($n in ($Step | Sort-Object -Unique)) {
  try { & "Step$n" } catch { Warn "第 $n 步發生錯誤：$($_.Exception.Message)" }
}
if ($Step -contains 3 -and $Step -notcontains 9 -and $Plan.Count) { Step9 }
Write-Host ''
Ok '全部完成。若剛在 Device Selector 新增了裝置，請重新開機一次。'
Info '接著打開 Fono Console：05 量測 →「一鍵校正」，跟著畫面做即可。'
Write-Host ''
