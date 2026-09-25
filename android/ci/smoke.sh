#!/usr/bin/env bash
# The APK, started on an emulator and walked through its screens: that it
# installs and starts, takes a link the way Telegram shares one, refuses and
# forgets a link to a website that is not a map, tells a dead map apart, and,
# when the workflow could put a real LiveGeo server behind a quick tunnel
# (map-link.txt), opens that map over https with Go live on it. It never
# crashes on the way. Run by .github/workflows/android.yml.
set -euo pipefail

pkg=org.livegeo.app
apk=$(ls livegeo-*.apk | head -n 1)
shots=${SHOTS:-shots}
mkdir -p "$shots"

# What is on screen, the web view's page included. A dump that fails (the
# screen never idle) says nothing, rather than what the last one said.
dump() {
  adb shell rm -f /sdcard/ui.xml >/dev/null 2>&1 || true
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
for webview in com.android.webview com.google.android.webview; do
  version=$(adb shell dumpsys package "$webview" 2>/dev/null | grep -m 1 -o 'versionName=[^ ]*' || true)
  [ -n "$version" ] && echo "web view: $webview $version"
done

echo '--- first run: nothing known yet, so the connect screen'
adb shell am start -W -n "$pkg/.MainActivity" >/dev/null
await_text 'CONNECT YOUR MAP' 30 || fail 'first run did not show the connect screen'
shot 1-connect

echo '--- a link to a website that is not a map: refused, and not kept'
share 'https://example.com/'
await_text 'NOT YOUR MAP|NO CONNECTION' 45 || fail 'a link to another website was not refused'
shot 2-not-a-map
adb shell am force-stop "$pkg"
adb shell am start -W -n "$pkg/.MainActivity" >/dev/null
await_text 'CONNECT YOUR MAP' 30 || fail 'a link to another website was kept as the map'
dump | grep -q 'Example Domain' && fail 'the app opened another website as the map'

echo '--- a link, shared the way Telegram shares it, to a map that is gone'
share 'https://gone-map.invalid.example/auth/test Opens once, within 10 minutes.'
await_text 'YOUR MAP MOVED|MAP NOT ANSWERING|NO CONNECTION' 45 || fail 'an unreachable map did not say so'
shot 3-unreachable

# A real LiveGeo server (bin/selfcheck.mjs) behind a quick tunnel, when the
# workflow could make one: the map page itself, over https, in the app.
if [ -s map-link.txt ]; then
  echo '--- a real map: past the loading screen, onto the map, with Go live on it'
  share "$(cat map-link.txt)"
  # The page's HUD sets its labels in capitals; what a dump reads may be either.
  here='[Gg][Oo] [Ll][Ii][Vv][Ee]'
  await_text "$here" 120 || fail 'the map did not load with Go live on it'
  # The page is in the dump as soon as it is loaded, under the loading
  # screen too: it has to be gone as well.
  for _ in $(seq 1 30); do
    dump | grep -Eq 'CONNECTING TO YOUR MAP|LOADING THE CITY|PLACING PEOPLE|CHECKING THE LINK' || break
    sleep 1
  done
  dump | grep -Eq 'CONNECTING TO YOUR MAP|LOADING THE CITY|PLACING PEOPLE|CHECKING THE LINK' && fail 'the loading screen stayed up over the map'
  dump | grep -q 'NOT YOUR MAP' && fail 'a LiveGeo map was refused as not one'
  shot 4-map
  # Whether the page ran on this web view without throwing: the web view
  # writes the page's console to the log.
  errors=$(adb logcat -d -s chromium:I | grep -E 'CONSOLE.*Uncaught' || true)
  if [ -n "$errors" ]; then
    printf '%s\n' "$errors" | tail -n 20
    printf '%s\n' "$errors" | grep -v 'in promise' | grep -q . && fail 'the map page threw an error on this web view'
    echo '::warning::the map page left a promise rejection unhandled on this web view (above)'
  fi
else
  echo '::warning::no quick tunnel this time, so the app was not tried against a live map'
  here='YOUR MAP MOVED|MAP NOT ANSWERING|NO CONNECTION'
fi

echo '--- rotated, and back to the front: still the same screen'
adb shell settings put system accelerometer_rotation 0
adb shell settings put system user_rotation 1
sleep 3
shot 5-landscape
adb shell settings put system user_rotation 0
adb shell input keyevent KEYCODE_HOME
sleep 2
adb shell am start -W -n "$pkg/.MainActivity" >/dev/null
await_text "$here" 45 || fail 'the screen did not survive rotation and a trip to the home screen'

alive || fail 'the app is not running'
crashed && fail 'the app crashed'
echo 'Smoke: installs, first run, a website refused and not kept, a dead map, a live map when there is one (without a page error), rotation, home and back; no crash.'
