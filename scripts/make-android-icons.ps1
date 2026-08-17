# One-shot Android launcher icon regenerator (Windows / System.Drawing).
# Rebuilds the full mipmap set for BOTH mobile projects from
# src-tauri/icons/icon.png — the desktop icon (white rounded rect + fish at
# 60% of the canvas).
#
# Usage: powershell -File scripts/make-android-icons.ps1
#
# Why this exists: the checked-in Android mipmaps render the fish much
# larger than the desktop icon does —
#   - legacy ic_launcher.png held the fish at ~82% of the canvas (PC: 60%),
#   - the adaptive ic_launcher_foreground.png held it at 60% of the 108dp
#     canvas, which after the launcher's mask crop (~66dp visible) reads as
#     ~90% of the visible icon.
# This script regenerates:
#   - ic_launcher.png            — the desktop icon resized as-is (fish 60%,
#                                 rounded rect + transparent corners kept)
#   - ic_launcher_round.png      — same, circle-masked
#   - ic_launcher_foreground.png — the fish alone (alpha>=250 non-white
#     pixels, so the rounded-rect AA edge is excluded) at 40% of the canvas,
#     centered: after the launcher mask crops the outer ~1/3, the fish reads
#     at ~60% of the visible icon, matching the desktop look.
#
# GDI+ (System.Drawing) is used instead of the old Electron/nativeImage
# pipeline: chroma-keying + premultiplied rescaling there produced a
# semi-transparent, blurry fish.

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$ROOT = Split-Path -Parent $PSScriptRoot
$src = [System.Drawing.Bitmap]::FromFile((Join-Path $ROOT 'src-tauri\icons\icon.png'))
$w = $src.Width
$h = $src.Height

# ---- extract the fish: opaque (alpha>=250) non-white pixels ----
$minX = $w; $minY = $h; $maxX = -1; $maxY = -1
$keep = [System.Collections.Generic.List[object]]::new()
for ($y = 0; $y -lt $h; $y++) {
  for ($x = 0; $x -lt $w; $x++) {
    $p = $src.GetPixel($x, $y)
    if ($p.A -ge 250 -and ($p.R -lt 240 -or $p.G -lt 240 -or $p.B -lt 240)) {
      $keep.Add(@($x, $y))
      if ($x -lt $minX) { $minX = $x }; if ($x -gt $maxX) { $maxX = $x }
      if ($y -lt $minY) { $minY = $y }; if ($y -gt $maxY) { $maxY = $y }
    }
  }
}
if ($maxX -lt 0) { throw 'no fish found in icon.png' }
$fw = $maxX - $minX + 1
$fh = $maxY - $minY + 1
$crop = New-Object System.Drawing.Bitmap($fw, $fh, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
foreach ($pt in $keep) {
  $p = $src.GetPixel($pt[0], $pt[1])
  $crop.SetPixel($pt[0] - $minX, $pt[1] - $minY, [System.Drawing.Color]::FromArgb(255, $p.R, $p.G, $p.B))
}
$src.Dispose()
Write-Host "fish bbox: ${fw}x$fh ($([math]::Round($fw / 512 * 100))% of the desktop icon)"

$legacySizes = @{ 48 = 'mdpi'; 72 = 'hdpi'; 96 = 'xhdpi'; 144 = 'xxhdpi'; 192 = 'xxxhdpi' }
$fgSizes = @{ 108 = 'mdpi'; 162 = 'hdpi'; 216 = 'xhdpi'; 324 = 'xxhdpi'; 432 = 'xxxhdpi' }
$fgFishRatio = 0.4 # fish width as a fraction of the foreground canvas

function Write-Scaled($source, $outPath, $size) {
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  $g.Dispose()
  $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}

function Write-CircleMasked($source, $outPath, $size) {
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $g.DrawImage($source, (New-Object System.Drawing.Rectangle(0, 0, $size, $size)))
  # circular mask: zero alpha outside the inscribed circle
  $cx = ($size - 1) / 2; $cy = ($size - 1) / 2; $r = $size / 2
  for ($y = 0; $y -lt $size; $y++) {
    for ($x = 0; $x -lt $size; $x++) {
      $dx = $x - $cx; $dy = $y - $cy
      if ($dx * $dx + $dy * $dy -gt $r * $r) {
        $canvas.SetPixel($x, $y, [System.Drawing.Color]::FromArgb(0, 0, 0, 0))
      }
    }
  }
  $g.Dispose()
  $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}

function Write-Foreground($fish, $outPath, $size) {
  $tW = [math]::Round($size * $fgFishRatio)
  $tH = [math]::Round($tW * $fish.Height / $fish.Width)
  $canvas = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($canvas)
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.Clear([System.Drawing.Color]::FromArgb(0, 0, 0, 0))
  $ox = [math]::Round(($size - $tW) / 2); $oy = [math]::Round(($size - $tH) / 2)
  $g.DrawImage($fish, (New-Object System.Drawing.Rectangle($ox, $oy, $tW, $tH)))
  $g.Dispose()
  $canvas.Save($outPath, [System.Drawing.Imaging.ImageFormat]::Png)
  $canvas.Dispose()
}

$resDirs = @(
  (Join-Path $ROOT 'src-tauri\gen\android\app\src\main\res'),
  (Join-Path $ROOT 'dsh-mobile\android\app\src\main\res')
)

$icon = [System.Drawing.Bitmap]::FromFile((Join-Path $ROOT 'src-tauri\icons\icon.png'))
foreach ($res in $resDirs) {
  foreach ($size in $legacySizes.Keys) {
    $d = "mipmap-$($legacySizes[$size])"
    Write-Scaled $icon (Join-Path $res "$d\ic_launcher.png") $size
    Write-CircleMasked $icon (Join-Path $res "$d\ic_launcher_round.png") $size
  }
  foreach ($size in $fgSizes.Keys) {
    $d = "mipmap-$($fgSizes[$size])"
    Write-Foreground $crop (Join-Path $res "$d\ic_launcher_foreground.png") $size
  }
  Write-Host "wrote mipmaps for $res"
}
$icon.Dispose()
$crop.Dispose()
Write-Host 'done'
