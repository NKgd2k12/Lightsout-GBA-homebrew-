# Launch VisualBoyAdvance-M, press buttons and grab the emulator window.
# Run `node vbacheck.js vbaD_*.png` afterwards to read the lamp grid / cursor.
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;
public class VCap {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool f);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr SetActiveWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, IntPtr extra);
  [DllImport("user32.dll")] public static extern uint MapVirtualKey(uint code, uint map);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L,T,R,B; }
  // The process also owns tiny hidden helper windows; pick the big visible one.
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
}
"@
$dir="C:\Users\Admin\Documents\Default Project\lightsout-gba"
$exe="C:\Users\Admin\Desktop\visualboyadvance-m.exe"

function Tap($vk,$hold=170,$ext=$false){
  $sc=[byte][VCap]::MapVirtualKey($vk,0)
  $f=[uint32]0; if($ext){$f=1}
  [VCap]::keybd_event([byte]$vk,$sc,$f,[IntPtr]::Zero)
  Start-Sleep -Milliseconds $hold
  [VCap]::keybd_event([byte]$vk,$sc,($f -bor 2),[IntPtr]::Zero)
  Start-Sleep -Milliseconds 700
}

$p=Start-Process -FilePath $exe -ArgumentList "`"$dir\lightsout.gba`"" -PassThru
Start-Sleep -Seconds 3
if($p.HasExited){ throw "VBA-M exited" }
$h=[VCap]::FindMain($p.Id)
$r=New-Object VCap+RECT; [VCap]::GetWindowRect($h,[ref]$r)|Out-Null
Write-Output "window at $($r.L),$($r.T) size $($r.R-$r.L)x$($r.B-$r.T) hwnd=$h"

# Bring to the foreground once; position is left to the emulator.
$fg=[VCap]::GetForegroundWindow(); $pf=0
$tf=[VCap]::GetWindowThreadProcessId($fg,[ref]$pf); $tc=[VCap]::GetCurrentThreadId()
[VCap]::AttachThreadInput($tc,$tf,$true)|Out-Null
[VCap]::SetForegroundWindow($h)|Out-Null
[VCap]::BringWindowToTop($h)|Out-Null
[VCap]::SetActiveWindow($h)|Out-Null
[VCap]::AttachThreadInput($tc,$tf,$false)|Out-Null
Start-Sleep -Milliseconds 900

function Cap($name){
  $r=New-Object VCap+RECT; [VCap]::GetWindowRect($h,[ref]$r)|Out-Null
  $w=$r.R-$r.L; $ht=$r.B-$r.T
  if($w -lt 200 -or $ht -lt 200){ Write-Output "WARN $name window ${w}x${ht} at $($r.L),$($r.T)"; return }
  $bmp=New-Object System.Drawing.Bitmap $w,$ht
  $gr=[System.Drawing.Graphics]::FromImage($bmp)
  $gr.CopyFromScreen($r.L,$r.T,0,0,$bmp.Size)
  $bmp.Save("$dir\$name.png",[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  Write-Output "captured $name ${w}x${ht} at $($r.L),$($r.T)"
}

Cap "vbaD_1_title"
Tap 0x0D; Cap "vbaD_2_play"          # START
Tap 0x4C; Cap "vbaD_3_flip"          # A = L
Tap 0x4B; Cap "vbaD_4_reset"         # B = K
Tap 0x27 170 $true; Cap "vbaD_5_right"
Tap 0x0D; Cap "vbaD_6_new"           # START
Write-Output ("title=" + $p.MainWindowTitle)
Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
