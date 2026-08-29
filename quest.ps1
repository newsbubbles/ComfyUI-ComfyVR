# quest.ps1 - wire a USB-connected Quest to the local comfyvr server.
# WebXR needs a secure context; adb reverse makes localhost:8189 exist ON
# the headset, and localhost is exempt. Run this, then open
# http://localhost:8189 in the Quest Browser and press ENTER VR.

$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) { $adb = "$env:USERPROFILE\scoop\apps\android-clt\current\platform-tools\adb.exe" }
if (-not (Test-Path $adb)) { Write-Host "no adb found - install platform-tools (scoop install android-clt)"; exit 1 }

Write-Host "waiting for the Quest over USB..." -ForegroundColor Cyan
Write-Host "  (developer mode on, cable in, and accept 'Allow USB debugging' inside the headset)"
while ($true) {
    $lines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\S" }
    $dev = $lines | Where-Object { $_ -match "\tdevice$" }
    $unauth = $lines | Where-Object { $_ -match "unauthorized" }
    if ($dev) { break }
    if ($unauth) { Write-Host "  headset says unauthorized - put it on and accept the USB debugging prompt" -ForegroundColor Yellow }
    Start-Sleep -Seconds 2
}
Write-Host "quest connected." -ForegroundColor Green

& $adb reverse tcp:8189 tcp:8189
& $adb reverse tcp:8188 tcp:8188   # direct ComfyUI too, in case you want its own UI in-headset
Write-Host "reverse tunnels:" -ForegroundColor Green
& $adb reverse --list

Write-Host ""
Write-Host "now, in the headset:" -ForegroundColor Cyan
Write-Host "  1. open the Quest Browser -> http://localhost:8189"
Write-Host "  2. press the '* ENTER VR' button (bottom right)"
Write-Host "  3. hands: enable Settings -> Movement tracking -> Hand and body"
Write-Host "     tracking, then put the controllers down. pinch = click."
Write-Host "  4. controllers: left stick fly, right stick snap-turn/height,"
Write-Host "     trigger = click, hold trigger on a title bar to move a node,"
Write-Host "     on a port dot to rewire."
Write-Host ""
Write-Host "note: with hands, PINCH EMPTY SPACE AND PULL to drag yourself"
Write-Host "through the void (works with triggers too); pinch sigils/panels"
Write-Host "to teleport-dock. the tunnel survives until the cable is out."
