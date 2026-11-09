# Drive the game in mGBA and read its variables through the GDB stub over one
# persistent connection.  This proves input handling on a real emulator.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName Microsoft.VisualBasic
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class Pad4 {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  public static IntPtr FindMain(int pid) {
    IntPtr best = IntPtr.Zero; long bestArea = 0;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      uint wp; GetWindowThreadProcessId(h, out wp);
      if (wp != (uint)pid || !IsWindowVisible(h)) return true;
      RECT r; if (!GetWindowRect(h, out r)) return true;
      long w = r.R - r.L, hh = r.B - r.T;
      if (w >= 200 && hh >= 200 && w * hh > bestArea) { bestArea = w * hh; best = h; }
      return true;
    }, IntPtr.Zero);
    return best;
  }
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint map);
}
"@
$dir = "C:\Users\Admin\Documents\Default Project\lightsout-gba"
$exe = "C:\Users\Admin\Desktop\mGBA.exe"

function ForceFocus($h) {
  try { [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id) } catch { }
  $fg = [Pad4]::GetForegroundWindow(); $pidFg = 0
  $tidFg = [Pad4]::GetWindowThreadProcessId($fg, [ref]$pidFg)
  $tidCur = [Pad4]::GetCurrentThreadId()
  [Pad4]::AttachThreadInput($tidCur, $tidFg, $true) | Out-Null
  [Pad4]::SetForegroundWindow($h) | Out-Null
  [Pad4]::BringWindowToTop($h) | Out-Null
  [Pad4]::SetActiveWindow($h) | Out-Null
  [Pad4]::AttachThreadInput($tidCur, $tidFg, $false) | Out-Null
}
function Tap($vk, $hold = 160) {
  $scan = [byte][Pad4]::MapVirtualKey($vk, 0)
  [Pad4]::keybd_event([byte]$vk, $scan, 0, [IntPtr]::Zero)
  Start-Sleep -Milliseconds $hold
  [Pad4]::keybd_event([byte]$vk, $scan, 2, [IntPtr]::Zero)
  Start-Sleep -Milliseconds 500
}

# ---------------- minimal GDB remote-serial-protocol client ----------------
$client = $null; $stream = $null
function ConnectGDB {
  for ($i = 0; $i -lt 20; $i++) {
    try { $script:client = New-Object System.Net.Sockets.TcpClient('127.0.0.1', 2345); $script:stream = $script:client.GetStream(); return }
    catch { Start-Sleep -Milliseconds 300 }
  }
  throw "could not connect to the GDB stub"
}
function ReadPacket {
  while ($true) {
    $b = $script:stream.ReadByte()
    if ($b -lt 0) { throw "GDB connection closed" }
    if ($b -eq 36) {
      $sb = New-Object System.Text.StringBuilder
      while ($true) {
        $c = $script:stream.ReadByte()
        if ($c -lt 0) { throw "GDB connection closed" }
        if ($c -eq 35) { break }
        [void]$sb.Append([char]$c)
      }
      $null = $script:stream.ReadByte(); $null = $script:stream.ReadByte()   # checksum
      return $sb.ToString()
    }
  }
}
function SendCmd($cmd) {
  $sum = 0
  foreach ($ch in $cmd.ToCharArray()) { $sum = ($sum + [int][char]$ch) -band 0xFF }
  $pkt = '$' + $cmd + '#' + $sum.ToString('x2')
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($pkt)
  $script:stream.Write($bytes, 0, $bytes.Length)
  $script:stream.Flush()
  return (ReadPacket)
}
function ContinueGDB {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes('$c#63')
  $script:stream.Write($bytes, 0, $bytes.Length)
  $script:stream.Flush()
}
function HaltGDB {
  $script:stream.WriteByte(3)
  $script:stream.Flush()
  return (ReadPacket)
}
function ReadVars {
  $hex = SendCmd 'm03007000,6c'
  if ($hex.Length -lt 0x6c * 2) { throw "bad memory reply: $hex" }
  $v = New-Object uint32[] 27
  for ($i = 0; $i -lt 27; $i++) {
    $val = [uint32]0
    for ($b = 0; $b -lt 4; $b++) {
      $byte = [Convert]::ToByte($hex.Substring(($i * 4 + $b) * 2, 2), 16)
      $val = $val -bor ([uint32]$byte -shl (8 * $b))
    }
    $v[$i] = $val
  }
  return $v
}
function State($label) {
  $fgok = ([Pad4]::GetForegroundWindow() -eq $script:mgbaHwnd)
  $null = HaltGDB
  $v = ReadVars
  ContinueGDB
  $name = @('LIGHTS','START','CX','CY','MOVES','LEVEL','SEED','FRAME','KEYS','PREV','PRESS','STATE','SOLVEDT','SOUND','COUNT','FB','NEED','ONES','T0')
  Write-Output ("{0,-9} fg={1} state={2} level={3} moves={4} cx={5} cy={6} lights=0x{7:x} count={8} sound={9} yaw={10} frame={11}" -f `
    $label, $fgok, $v[11], $v[5], $v[4], $v[2], $v[3], $v[0], $v[14], $v[13], $v[26], $v[7])
}

$p = Start-Process -FilePath $exe -ArgumentList "--gdb","`"$dir\lightsout.gba`"" -PassThru
Start-Sleep -Seconds 3
$script:mgbaHwnd = [IntPtr]::Zero
for ($i = 0; $i -lt 20; $i++) {
  $proc = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  if ($proc -and $proc.MainWindowHandle -ne [IntPtr]::Zero) { $script:mgbaHwnd = $proc.MainWindowHandle; break }
  if ($script:mgbaHwnd -eq [IntPtr]::Zero) { $script:mgbaHwnd = [Pad4]::FindMain($p.Id) }
  Start-Sleep -Milliseconds 300
}
[Pad4]::ShowWindow($script:mgbaHwnd, 9) | Out-Null
Start-Sleep -Milliseconds 400
for ($i = 0; $i -lt 8; $i++) {
  ForceFocus $script:mgbaHwnd
  Start-Sleep -Milliseconds 500
  if ([Pad4]::GetForegroundWindow() -eq $script:mgbaHwnd) { break }
}
if ([Pad4]::GetForegroundWindow() -ne $script:mgbaHwnd) { throw "could not focus mGBA" }

ConnectGDB
$null = SendCmd '?'
$null = ReadVars            # core is halted at reset
State "reset"
ContinueGDB
Start-Sleep -Seconds 2
State "title"
Tap 0x0D; State "start"
Tap 0x27; State "right1"
Tap 0x27; State "right2"
Tap 0x27; State "right3"
Tap 0x41; State "tiltL"
Tap 0x53; State "tiltR"
Tap 0x25; State "left"
Tap 0x28; State "down"
Tap 0x26; State "up"
Tap 0x58; State "flipA"
Tap 0x5A; State "resetB"
Tap 0x0D; State "newStart"
Tap 0x08; State "soundOff"
Tap 0x58; State "flipA2"
Write-Output ("title: " + $p.MainWindowTitle)
ContinueGDB
$script:client.Close()
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
