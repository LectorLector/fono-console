# Fono Console bridge: Windows media sessions (SMTC), Core Audio meter and
# default-device switching. Talks JSON lines over stdin/stdout. ASCII only.
$ErrorActionPreference = 'Continue'
$utf8 = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = $utf8
$script:out = [Console]::Out

function Emit($o) {
  try { $script:out.WriteLine(($o | ConvertTo-Json -Compress -Depth 6)); $script:out.Flush() } catch {}
}
function Log($m) { Emit @{ t = 'log'; msg = "$m" } }

# ------------------------------------------------------------ Core Audio (C#)
$cs = @"
using System;
using System.Runtime.InteropServices;
namespace Fono {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] internal class MMDeviceEnumeratorComObject { }
  [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDeviceEnumerator {
    [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
    [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    [PreserveSig] int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
  }
  [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IMMDevice {
    [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    [PreserveSig] int OpenPropertyStore(int access, out IntPtr props);
    [PreserveSig] int GetId([MarshalAs(UnmanagedType.LPWStr)] out string id);
    [PreserveSig] int GetState(out int state);
  }
  [Guid("C02216F6-8C67-4B5B-9D00-D008E73E0064"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IAudioMeterInformation {
    [PreserveSig] int GetPeakValue(out float peak);
    [PreserveSig] int GetMeteringChannelCount(out int count);
    [PreserveSig] int GetChannelsPeakValues(int count, [Out, MarshalAs(UnmanagedType.LPArray, SizeParamIndex = 0)] float[] peaks);
    [PreserveSig] int QueryHardwareSupport(out int mask);
  }
  [Guid("F8679F50-850A-41CF-9C72-430F290290C8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  internal interface IPolicyConfig {
    [PreserveSig] int GetMixFormat();
    [PreserveSig] int GetDeviceFormat();
    [PreserveSig] int ResetDeviceFormat();
    [PreserveSig] int SetDeviceFormat();
    [PreserveSig] int GetProcessingPeriod();
    [PreserveSig] int SetProcessingPeriod();
    [PreserveSig] int GetShareMode();
    [PreserveSig] int SetShareMode();
    [PreserveSig] int GetPropertyValue();
    [PreserveSig] int SetPropertyValue();
    [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    [PreserveSig] int SetEndpointVisibility();
  }
  [ComImport, Guid("870AF99C-171D-4F9E-AF0D-E63DF40C2BC9")] internal class CPolicyConfigClient { }

  public static class Audio {
    static IMMDeviceEnumerator en;
    static IAudioMeterInformation meter;
    static string meterId = "";
    static int calls = 0;
    static IMMDeviceEnumerator En() { if (en == null) en = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject()); return en; }
    public static string DefaultId() {
      IMMDevice d;
      if (En().GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return "";
      string id; d.GetId(out id);
      return id == null ? "" : id;
    }
    public static float[] Peaks() {
      calls++;
      if (meter == null || calls % 15 == 0) {
        string cur = DefaultId();
        if (meter == null || cur != meterId) {
          meter = null; meterId = cur;
          IMMDevice d;
          if (En().GetDefaultAudioEndpoint(0, 1, out d) != 0 || d == null) return null;
          Guid iid = typeof(IAudioMeterInformation).GUID;
          object o;
          if (d.Activate(ref iid, 23, IntPtr.Zero, out o) != 0) return null;
          meter = (IAudioMeterInformation)o;
        }
      }
      int n;
      if (meter.GetMeteringChannelCount(out n) != 0 || n <= 0) return null;
      float[] p = new float[n];
      if (meter.GetChannelsPeakValues(n, p) != 0) return null;
      return p;
    }
    public static bool SetDefault(string guid) {
      string id = guid.StartsWith("{0.0.0") ? guid : "{0.0.0.00000000}." + guid;
      IPolicyConfig pc = (IPolicyConfig)(new CPolicyConfigClient());
      int r = pc.SetDefaultEndpoint(id, 0);
      pc.SetDefaultEndpoint(id, 1);
      pc.SetDefaultEndpoint(id, 2);
      meter = null;
      return r == 0;
    }
  }
}
"@
$script:audioOk = $false
try { Add-Type -TypeDefinition $cs -Language CSharp -ErrorAction Stop; $script:audioOk = $true } catch { Log ("audio helper: " + $_.Exception.Message) }

# ------------------------------------------------------------ WinRT media sessions
function Await($op, [Type]$type, [int]$ms = 4000) {
  $m = $script:asTaskGeneric.MakeGenericMethod($type)
  $task = $m.Invoke($null, @($op))
  if ($task.Wait($ms)) { return $task.Result }
  return $null
}

$script:winrtOk = $false
$script:mgr = $null
try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $script:asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1' })[0]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IInputStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $script:asStreamForRead = [System.IO.WindowsRuntimeStreamExtensions].GetMethod('AsStreamForRead', [type[]]@([Windows.Storage.Streams.IInputStream]))
  $mgrType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]
  $script:mgr = Await ($mgrType::RequestAsync()) $mgrType 8000
  $script:winrtOk = ($null -ne $script:mgr)
} catch { Log ("winrt: " + $_.Exception.Message) }

$propsType = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties]
$streamType = [Windows.Storage.Streams.IRandomAccessStreamWithContentType]

# ------------------------------------------------------------ init
$eapoCfg = ''
try { $eapoCfg = (Get-ItemProperty -Path 'HKLM:\SOFTWARE\EqualizerAPO' -Name ConfigPath -ErrorAction Stop).ConfigPath } catch {}
Emit @{ t = 'init'; winrt = $script:winrtOk; audio = $script:audioOk; eapoConfig = "$eapoCfg"; ps = "$($PSVersionTable.PSVersion)" }

$script:md5 = [Security.Cryptography.MD5]::Create()
function Get-Key([string]$s) {
  (($script:md5.ComputeHash([Text.Encoding]::UTF8.GetBytes($s))) | ForEach-Object { $_.ToString('x2') }) -join ''
}

$script:artSent = @{}
function Send-Art([string]$key, $ref) {
  $script:artSent[$key] = $false
  try {
    $st = Await ($ref.OpenReadAsync()) $streamType 3000
    if ($null -eq $st) { return }
    # PowerShell cannot bind the WinRT stream to AsStreamForRead directly; invoke via reflection.
    $ns = $script:asStreamForRead.Invoke($null, @($st))
    $ms = New-Object System.IO.MemoryStream
    $ns.CopyTo($ms)
    $ns.Dispose()
    if ($ms.Length -gt 0) {
      Emit @{ t = 'art'; key = $key; mime = ''; b64 = [Convert]::ToBase64String($ms.ToArray()) }
      $script:artSent[$key] = $true
    }
  } catch { Log ("art: " + $_.Exception.Message) }
}

$script:sessCache = @{}
function Poll-Media {
  $list = @()
  $cur = ''
  try { $c = $script:mgr.GetCurrentSession(); if ($c) { $cur = $c.SourceAppUserModelId } } catch {}
  $sessions = @()
  try { $sessions = @($script:mgr.GetSessions()) } catch {}
  $cache = @{}
  foreach ($s in $sessions) {
    try {
      $id = "$($s.SourceAppUserModelId)"
      $cache[$id] = $s
      $p = Await ($s.TryGetMediaPropertiesAsync()) $propsType 1500
      $info = $s.GetPlaybackInfo()
      $status = "$($info.PlaybackStatus)"
      $pos = 0.0; $dur = 0.0
      try {
        $tl = $s.GetTimelineProperties()
        $pos = $tl.Position.TotalSeconds
        $dur = ($tl.EndTime - $tl.StartTime).TotalSeconds
        if ($status -eq 'Playing' -and $tl.LastUpdatedTime.Year -gt 2000) {
          $pos += ([DateTimeOffset]::Now - $tl.LastUpdatedTime).TotalSeconds
        }
        if ($dur -gt 0 -and $pos -gt $dur) { $pos = $dur }
        if ($pos -lt 0) { $pos = 0 }
      } catch {}
      $title = ''; $artist = ''; $album = ''
      if ($p) {
        $title = "$($p.Title)"; $artist = "$($p.Artist)"; $album = "$($p.AlbumTitle)"
        if (-not $artist) { $artist = "$($p.AlbumArtist)" }
      }
      $key = Get-Key "$id|$title|$artist|$album"
      if ($p -and $p.Thumbnail -and -not $script:artSent.ContainsKey($key)) { Send-Art $key $p.Thumbnail }
      $art = ''
      if ($script:artSent[$key] -eq $true) { $art = $key }
      $ctl = $info.Controls
      $list += @{
        id = $id; title = $title; artist = $artist; album = $album; status = $status
        pos = [math]::Round($pos, 2); dur = [math]::Round($dur, 2); art = $art
        canSeek = [bool]$ctl.IsPlaybackPositionEnabled; canNext = [bool]$ctl.IsNextEnabled; canPrev = [bool]$ctl.IsPreviousEnabled
      }
    } catch { Log ("session: " + $_.Exception.Message) }
  }
  $script:sessCache = $cache
  Emit @{ t = 'media'; cur = $cur; sessions = $list }
}

$script:devSig = ''
function Poll-Devices([bool]$force) {
  $list = @()
  $base = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render'
  foreach ($k in @(Get-ChildItem -Path $base -ErrorAction SilentlyContinue)) {
    try {
      $st = (Get-ItemProperty -Path $k.PSPath -Name DeviceState -ErrorAction Stop).DeviceState
      if (($st -band 1) -ne 1) { continue }
      $pp = Get-ItemProperty -Path (Join-Path $k.PSPath 'Properties') -ErrorAction Stop
      $desc = $pp.'{a45c254e-df1c-4efd-8020-67d146a850e0},2'
      $ifn = $pp.'{b3f8fa53-0004-438e-9003-51a46e139bfc},6'
      $hasEapo = $false
      try { $fx = Get-ItemProperty -Path (Join-Path $k.PSPath 'FxProperties') -ErrorAction Stop; foreach ($q in $fx.PSObject.Properties) { if ("$($q.Value)" -match 'EACD2258-FCAC-4FF4-B36D-419E924A6D79|EC1CC9CE-FAED-4822-828A-82A81A6F018F') { $hasEapo = $true; break } } } catch {}
      $list += @{ guid = "$($k.PSChildName)"; name = "$desc"; iface = "$ifn"; eapo = $hasEapo }
    } catch {}
  }
  $def = ''
  if ($script:audioOk) { try { $def = ([Fono.Audio]::DefaultId()) -replace '^\{0\.0\.0\.00000000\}\.', '' } catch {} }
  $sig = (($list | ForEach-Object { $_.guid }) -join ',') + '|' + $def
  if ($force -or $sig -ne $script:devSig) {
    $script:devSig = $sig
    Emit @{ t = 'devices'; list = $list; def = $def }
  }
}

$script:quiet = 0
function Poll-Meter {
  try {
    $p = [Fono.Audio]::Peaks()
    if ($null -eq $p) { return }
    $mx = 0.0
    foreach ($v in $p) { if ($v -gt $mx) { $mx = $v } }
    if ($mx -lt 0.0005) { $script:quiet++ } else { $script:quiet = 0 }
    if ($script:quiet -gt 3 -and ($script:quiet % 15) -ne 0) { return }
    Emit @{ t = 'meter'; p = @($p | ForEach-Object { [math]::Round([double]$_, 3) }) }
  } catch {}
}

function Poll-BT {
  $list = @()
  try {
    $devs = @(Get-PnpDevice -Class Bluetooth -ErrorAction SilentlyContinue | Where-Object { $_.InstanceId -match '^(BTHENUM\\DEV_|BTHLE\\DEV_)' })
    $hf = @(Get-PnpDevice -Class MEDIA -ErrorAction SilentlyContinue | Where-Object { $_.FriendlyName -match 'Hands-Free' -and $_.InstanceId -match '^(BTHENUM|BTHHFENUM)' -and $_.Class -eq 'MEDIA' })
    foreach ($d in $devs) {
      $bat = $null
      try { $bat = ($d | Get-PnpDeviceProperty -KeyName '{104EA319-6EE2-4701-BD47-8DDBF425BBE5} 2' -ErrorAction Stop).Data } catch {}
      $conn = $false; $last = $null
      try {
        $props = @($d | Get-PnpDeviceProperty -KeyName '{83DA6326-97A6-4088-9453-A1923F573B29} 15', 'DEVPKEY_Device_IsPresent', 'DEVPKEY_Bluetooth_LastConnectedTime' -ErrorAction Stop)
        $isConn = ($props | Where-Object { $_.KeyName -like '{83DA6326*' }).Data
        $isPres = ($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Device_IsPresent' }).Data
        $conn = if ($null -ne $isConn) { [bool]$isConn } else { [bool]$isPres }
        $lc = ($props | Where-Object { $_.KeyName -eq 'DEVPKEY_Bluetooth_LastConnectedTime' }).Data
        if ($lc) { $last = ([datetime]$lc).ToString('yyyy-MM-ddTHH:mm:ss') }
      } catch {}
      $name = "$($d.FriendlyName)"
      $h = @($hf | Where-Object { $_.FriendlyName -like "$name*" } | ForEach-Object { @{ id = "$($_.InstanceId)"; status = "$($_.Status)"; name = "$($_.FriendlyName)" } })
      $list += @{ name = $name; id = "$($d.InstanceId)"; battery = $bat; hfp = $h; connected = $conn; last = $last }
    }
  } catch { Log ("bt: " + $_.Exception.Message) }
  Emit @{ t = 'bt'; list = $list }
}

function Handle-Command($c) {
  switch ("$($c.c)") {
    'bt' { Poll-BT; return }
    'setdef' { if ($script:audioOk -and $c.id) { try { [Fono.Audio]::SetDefault("$($c.id)") | Out-Null } catch { Log ("setdef: " + $_.Exception.Message) } }; Poll-Devices $true; return }
    'devices' { Poll-Devices $true; return }
  }
  if (-not $script:winrtOk) { return }
  $s = $null
  if ($c.id -and $script:sessCache.ContainsKey("$($c.id)")) { $s = $script:sessCache["$($c.id)"] } else { $s = $script:mgr.GetCurrentSession() }
  if ($null -eq $s) { return }
  $op = $null
  switch ("$($c.c)") {
    'toggle' { $op = $s.TryTogglePlayPauseAsync() }
    'play'   { $op = $s.TryPlayAsync() }
    'pause'  { $op = $s.TryPauseAsync() }
    'next'   { $op = $s.TrySkipNextAsync() }
    'prev'   { $op = $s.TrySkipPreviousAsync() }
    'seek'   { $op = $s.TryChangePlaybackPositionAsync([long]([double]$c.pos * 10000000)) }
  }
  if ($op) { $null = Await $op ([bool]) 2500 }
  $script:nextMedia = 0
}

# ------------------------------------------------------------ main loop
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput(), $utf8)
$pending = $stdin.ReadLineAsync()
$sw = [Diagnostics.Stopwatch]::StartNew()
$script:nextMedia = 0
$nextDev = 0
$nextMeter = 0
$script:nextBT = 3000
while ($true) {
  if ($pending.IsCompleted) {
    $line = $null
    try { $line = $pending.Result } catch {}
    if ($null -eq $line) { break }
    if ($line.Trim().Length -gt 0) { try { Handle-Command ($line | ConvertFrom-Json) } catch { Log ("cmd: " + $_.Exception.Message) } }
    $pending = $stdin.ReadLineAsync()
  }
  $now = $sw.ElapsedMilliseconds
  if ($script:winrtOk -and $now -ge $script:nextMedia) { $script:nextMedia = $now + 500; Poll-Media }
  if ($now -ge $nextDev) { $nextDev = $now + 4000; Poll-Devices $false }
  if ($now -ge $script:nextBT) { $script:nextBT = $now + 60000; Poll-BT }
  if ($script:audioOk -and $now -ge $nextMeter) { $nextMeter = $now + 70; Poll-Meter }
  Start-Sleep -Milliseconds 15
}
