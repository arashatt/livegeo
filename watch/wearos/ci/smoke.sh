#!/usr/bin/env bash
# The watch APK, started on a Wear OS emulator: that it installs and starts,
# asks which map before anything else, can open the watch's own text input
# for the map's name, keeps nothing it was not given, and never crashes on the
# way. Run by .github/workflows/watch.yml.
set -euo pipefail

pkg=org.livegeo.watch
apk=$(ls livegeo-watch-*.apk | head -n 1)
shots=${SHOTS:-shots}
mkdir -p "$shots"

# The job's own output, which fail() writes to even from inside a call whose
# output is thrown away.
exec 3>&1 4>&2

# Every adb call has a time limit, as in android/ci/smoke.sh: one that never
# returns fails the run, saying which, instead of holding the job.
ADB=$(command -v adb)
adb() {
  local status=0 limit=120
  if [ -n "${failing:-}" ]; then limit=20; fi
  timeout "$limit" "$ADB" "$@" || status=$?
  if [ "$status" = 124 ] && [ -z "${failing:-}" ]; then fail "adb $* did not answer within $limit s"; fi
  return "$status"
}

dump() {
  adb shell rm -f /sdcard/ui.xml >/dev/null 2>&1 || true
  adb shell uiautomator dump /sdcard/ui.xml >/dev/null 2>&1 || true
  adb shell cat /sdcard/ui.xml 2>/dev/null || true
}
shot() { adb exec-out screencap -p > "$shots/$1.png" || true; }
alive() { adb shell pidof "$pkg" >/dev/null; }
crashed() { adb logcat -d | grep -E "FATAL EXCEPTION|Process: $pkg, PID" && return 0 || return 1; }
fail() {
  trap - ERR
  failing=1
  {
    echo "::error::$1"
    shot fail
    echo '--- on screen'
    dump | grep -o 'text="[^"]*"' | head -40 || true
    echo '--- crashes'
    adb logcat -d -b crash | tail -n 60 || true
    # The app's own lines and what the system did with it; not the
    # AndroidRuntime lines every uiautomator dump writes.
    echo '--- the app'
    adb logcat -d | grep -E "org\.livegeo|ActivityTaskManager|ActivityManager|E AndroidRuntime" | grep -v uiautomator | tail -n 60 || true
  } >&3 2>&4
  if [ "$BASHPID" != "$$" ]; then kill -TERM "$$"; fi
  exit 1
}
trap 'status=$? line=$LINENO; fail "stopped at line $line (exit $status): $(sed -n "${line}p" "$0" | sed "s/^ *//")"' ERR
# Waits up to $2 seconds for the screen to show text matching $1.
await_text() {
  for _ in $(seq 1 "$2"); do
    if dump | grep -Eq "$1"; then return 0; fi
    sleep 1
  done
  return 1
}
# Taps the middle of the first thing on screen whose text is exactly $1.
tap_text() {
  local bounds
  bounds=$(dump | tr '>' '\n' | grep -F "text=\"$1\"" | grep -o 'bounds="\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]"' | head -n 1 || true)
  [ -n "$bounds" ] || return 1
  set -- $(printf '%s' "$bounds" | grep -o '[0-9]*')
  adb shell input tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
launch() {
  local said
  said=$(adb shell am start -W -n "$pkg/.MainActivity" 2>&1) || fail "the app could not be started: $said"
  case "$said" in *Error*|*Exception*) fail "the app could not be started: $said" ;; esac
}

adb install -r "$apk"
adb logcat -c
# A watch goes back to its face when the screen goes off, which on an emulator
# nobody touches is a few seconds in: kept on and awake for the test.
adb shell svc power stayon true || true
adb shell settings put system screen_off_timeout 1800000 || true
adb shell input keyevent KEYCODE_WAKEUP || true

echo '--- first run: it asks which map before anything else'
launch
await_text 'Which map\?' 60 || fail 'first run did not ask which map'
dump | grep -q 'Send /pair to the bot' || fail 'it did not say where the map name comes from'
shot 1-which-map

echo "--- the watch's own text input opens for the map's name"
tap_text 'Enter its name' || fail 'no button to enter the map name'
sleep 4
shot 2-input
dump | grep -q 'no keyboard for apps' && fail 'this Wear OS has no text input the app can use'
# The input can take a back of its own (a keyboard over it) before it closes.
adb shell input keyevent KEYCODE_BACK
if ! await_text 'Which map\?' 10; then
  adb shell input keyevent KEYCODE_BACK
  await_text 'Which map\?' 20 || fail 'back from the text input did not return to the app'
fi

echo '--- nothing was kept: started again, it asks again'
adb shell am force-stop "$pkg"
launch
await_text 'Which map\?' 60 || fail 'after a restart it did not ask which map'
shot 3-again

alive || fail 'the app is not running'
crashed && fail 'the app crashed'
echo 'Smoke: installs and starts on Wear OS, asks which map first, opens the text input for its name, keeps nothing unasked; no crash.'
