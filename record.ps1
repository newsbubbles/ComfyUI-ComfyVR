# record.ps1 - switch the Quest's built-in capture to real HD before recording.
#
# By default the headset records a low-bitrate square video. These developer
# properties switch it to 1920x1080 at 60fps with a healthy bitrate. They
# reset when the headset reboots, so run this before each recording session.
# Needs USB debugging once; offers to enable wireless adb so future runs
# need no cable.

$adb = (Get-Command adb -ErrorAction SilentlyContinue).Source
if (-not $adb) { $adb = "$env:USERPROFILE\scoop\apps\android-clt\current\platform-tools\adb.exe" }
if (-not (Test-Path $adb)) { Write-Host "no adb found - install platform-tools"; exit 1 }

Write-Host "waiting for the Quest (USB cable, or wireless if already paired)..." -ForegroundColor Cyan
while ($true) {
    $lines = & $adb devices | Select-Object -Skip 1 | Where-Object { $_ -match "\S" }
    $dev = $lines | Where-Object { $_ -match "\tdevice$" }
    if ($dev) { break }
    if ($lines | Where-Object { $_ -match "unauthorized" }) {
        Write-Host "  accept the 'Allow USB debugging' prompt inside the headset" -ForegroundColor Yellow
    }
    Start-Sleep -Seconds 2
}
Write-Host "quest connected." -ForegroundColor Green

& $adb shell setprop debug.oculus.capture.width 1920
& $adb shell setprop debug.oculus.capture.height 1080
& $adb shell setprop debug.oculus.capture.fps 60
& $adb shell setprop debug.oculus.fullRateCapture 1
& $adb shell setprop debug.oculus.capture.bitrate 30000000
Write-Host "capture set to 1920x1080 @ 60fps, 30 Mbps." -ForegroundColor Green

# offer the wireless upgrade so the flaky cable is only ever needed once
$usb = & $adb devices -l | Select-String "usb:"
if ($usb) {
    $ip = (& $adb shell ip route | Select-String "wlan0" | Select-Object -First 1) -replace ".*src (\S+).*", '$1'
    if ($ip) {
        & $adb tcpip 5555 | Out-Null
        Start-Sleep -Seconds 2
        & $adb connect "${ip}:5555" | Out-Null
        Write-Host "wireless adb enabled at ${ip}:5555 - next time, no cable:" -ForegroundColor Green
        Write-Host "  adb connect ${ip}:5555"
    }
}

Write-Host ""
Write-Host "to record, in the headset:" -ForegroundColor Cyan
Write-Host "  1. open the universal menu (palm up, pinch the logo) -> Camera"
Write-Host "  2. in the Camera app, toggle the MICROPHONE ON to narrate"
Write-Host "  3. Record video, then get back into the comfyvr tab"
Write-Host ""
Write-Host "recordings land in the headset at /sdcard/Oculus/VideoShots"
Write-Host "pull the newest one to this PC with:"
Write-Host '  adb shell ls -t /sdcard/Oculus/VideoShots'
Write-Host '  adb pull "/sdcard/Oculus/VideoShots/<name>.mp4" .'
