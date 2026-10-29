#!/bin/sh
# Example XQ_BROWSER_LAUNCH launcher for Hyprland with the Lua config provider
# (verified with 0.56.2). It starts the renewal browser from its desktop entry on
# a hidden special workspace without taking focus. Hyprland, not this script, is
# the browser's parent, so the browser outlives the refresher's oneshot unit.
#
# Contract (docs/session-renewal.md, "Starting the renewal browser"):
#   no arguments  request a start and exit within 5 s; 0 = requested
#   --check       exit 0 only if a start is possible now; no side effects
# Exit 3 (both modes): the profile is already in use. A second start would only
# hand over to that browser, which the refresher must never close as its own.
# The refresher never shows this script's output.
#
# Install a copy owned by you, mode 700 (never group- or world-writable), and
# point XQ_BROWSER_LAUNCH at it. Set id to the renewal browser's desktop entry:
# $XDG_DATA_HOME/applications/<id>.desktop, or ~/.local/share/applications.
# Its Exec line must name the profile with --user-data-dir=<absolute path>
# (Chrome ignores the DevTools port on its default profile).
set -eu
LC_ALL=C
export LC_ALL
id=google-chrome-agents
workspace=special:xiaomi-renewal

case ${XDG_DATA_HOME-} in
  /*) data=$XDG_DATA_HOME ;;
  *) data=$HOME/.local/share ;;
esac
entry=$data/applications/$id.desktop

# Sets cmd to the Exec line of the [Desktop Entry] group (never a [Desktop Action]
# group), without field codes such as %U, and profile to its --user-data-dir
# (the last one, as Chrome reads it). Only plain words pass: the line is
# embedded in a Lua string and run by Hyprland.
exec_line() {
  [ -f "$entry" ] && [ -r "$entry" ] || return 1
  line=$(awk '/^\[/ { main = ($0 == "[Desktop Entry]"); next }
    main && /^Exec=/ { sub(/^Exec=/, ""); print; exit }' "$entry") || return 1
  line=$(printf '%s\n' "$line" |
    sed -e 's/%[A-Za-z]//g' -e 's/[[:space:]][[:space:]]*/ /g' -e 's/^ //' -e 's/ $//')
  case $line in
    '' | *[!A-Za-z0-9\ ./=_:,-]*) return 1 ;;
  esac
  profile=
  # Plain words only (checked above), so splitting cannot glob.
  for word in $line; do
    case $word in --user-data-dir=*) profile=${word#--user-data-dir=} ;; esac
  done
  case $profile in /?*) ;; *) return 1 ;; esac
  cmd=$line
}

# True while the profile's SingletonLock (a symlink to "<host>-<pid>") names a
# live process on this host. Chrome takes it early in start-up, before the
# DevTools port answers. A lock naming another host, or one that does not
# parse, counts as in use; one whose process is gone is stale (Chrome replaces it).
in_use() {
  lock=$(readlink "$profile/SingletonLock" 2>/dev/null) || return 1
  pid=${lock##*-}
  case $pid in '' | *[!0-9]*) return 0 ;; esac
  [ "${lock%-*}" = "$(uname -n)" ] || return 0
  kill -0 "$pid" 2>/dev/null
}

case $# in
  0) ;;
  1)
    [ "$1" = --check ] || exit 2
    exec_line || exit 1
    ! in_use || exit 3
    hyprctl version >/dev/null 2>&1 || exit 1
    exit 0
    ;;
  *) exit 2 ;;
esac
exec_line || exit 1
! in_use || exit 3
# The legacy form "dispatch exec [workspace ... silent] cmd" fails on the Lua provider.
out=$(hyprctl dispatch "hl.dsp.exec_cmd(\"$cmd\", { workspace = \"$workspace silent\" })" 2>/dev/null) || exit 1
[ "$out" = ok ] || exit 1
