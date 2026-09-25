#!/usr/bin/env bash
# The APK, started on an emulator and walked through its screens without a
# livegeo server: nothing in CI can serve the map over https for it. What it
# proves is that the app installs, starts, takes a link the way Telegram
# shares one, tells a dead map from a live page, gets past its loading
# screen, and never crashes on the way. Run by .github/workflows/android.yml.
set -euo pipefail

pkg=org.livegeo.app
apk=$(ls livegeo-*.apk | head -n 1)
shots=${SHOTS:-shots}
mkdir -p "$shots"

dump() {
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  adb shell cat /sdcard/ui.xml 2>/dev/null || true
}
shot() { adb exec-out screencap -p > "$shots/$1.png" || true; }
alive() { adb shell pidof "$pkg" >/dev/null; }
crashed() { adb logcat -d | grep -E "FATAL EXCEPTION|Process: $pkg, PID" && return 0 || return 1; }
fail() {
  echo "::error::$1"
  dump | grep -o 'text="[^"]*"' | head -40 || true
  adb logcat -d | grep -E "$pkg|AndroidRuntime|chromium" | tail -80 || true
  exit 1
}
# Waits up to $2 seconds for the screen to show text matching $1.
await_text() {
  for _ in $(seq 1 "$2"); do
    if dump | grep -Eq "$1"; then return 0; fi
    sleep 1
  done
  return 1
}
share() {
  adb shell "am start -W -a android.intent.action.SEND -t text/plain --es android.intent.extra.TEXT '$1' -n $pkg/.MainActivity" >/dev/null
}

adb install -r "$apk"
adb logcat -c

echo '--- first run: nothing known yet, so the connect screen'
adb shell am start -W -n "$pkg/.MainActivity" >/dev/null
await_text 'CONNECT YOUR MAP' 30 || fail 'first run did not show the connect screen'
shot 1-connect

echo '--- a link, shared the way Telegram shares it, to a map that is gone'
share 'https://gone-map.invalid.example/auth/test Opens once, within 10 minutes.'
await_text 'YOUR MAP MOVED|MAP NOT ANSWERING|NO CONNECTION' 45 || fail 'an unreachable map did not say so'
shot 2-unreachable

echo '--- a page that answers: past the loading screen, onto the page'
share 'https://example.com/auth/test'
await_text 'Example Domain' 60 || fail 'a page that loads did not get past the loading screen'
dump | grep -q 'LIVEGEO' && fail 'the loading screen stayed up over a loaded page'
shot 3-page

echo '--- rotated, and back to the front: still the same page'
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 3
adb shell settings put system user_rotation 0
adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell am start -W -n "$pkg/.MainActivity" >/dev/null
await_text 'Example Domain' 30 || fail 'the page did not survive rotation and a trip to the home screen'

alive || fail 'the app is not running'
crashed && fail 'the app crashed'
echo 'Smoke: installs, first run, a dead map, a live page, rotation, home and back; no crash.'
