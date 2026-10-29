# v0.3.1 — refresher-only release

Only the optional laptop-side refresher (`refresher/`) changes. The collector image (`src/`, `deploy/`) and the native plugin and page (`native/`) are unchanged since v0.3.0; the plugin still reports version 0.3.0. The renewal status file stays schema v1 with the same keys and `result` enum, so a v0.3.0 collector and plugin read v0.3.1 reports unchanged, and the reverse.

## Changes

- **Start the renewal browser on demand.** Optional `XQ_BROWSER_LAUNCH` names a launcher with a small contract (no arguments: request a start within 5 s; `--check`: is a start possible now, no side effects). When a renewal is needed and nothing listens on the DevTools port (connection refused), the refresher runs it and waits up to 20 s for the endpoint; a port that accepts but answers late or with another status is never launched over. A browser the run started is closed with `Browser.close` at the end of its browser step (after a lost connection only if the same browser process answers); one that was already running is never closed. Launcher files are checked at every use (regular file, owner, not group/world-writable, executable), run without a shell, with a minimal environment and discarded output. Example for Hyprland's Lua config provider: `refresher/examples/launch-browser-hyprland.sh`; it requires `--user-data-dir` in the desktop entry and refuses (exit 3) while that profile is in use, so a browser that is still starting never receives a second start.
- **Early warning.** Healthy runs check the discovery endpoint (loopback only; no tab, cookie or Xiaomi request), else `launcher --check`, and report `browser_unavailable` when the browser is neither running nor startable, or its port accepts but does not answer. The page already shows that as an early warning. `--check` prints the same readiness.
- **Desktop notifications.** Optional `XQ_NOTIFY=desktop`: one critical `notify-send` notification when a run enters or changes to a result that needs a person (`signin_required`, `account_mismatch`, `browser_unavailable`, vendor change), one recovery notification afterwards, nothing while unchanged.
- **Clearer failures.** `collector_unreachable (<cause>)` names ssh, sudo, the container, the collector's HTTP status or unrecognised output. A console that loaded but whose cookies are missing or rejected is `error (… (vendor change?))` instead of `signin_required`.
- **Backoff.** Timer runs wait 15, 30, 60, 60 … minutes after repeated `signin_required`, `account_mismatch` or vendor-change failures, unless the collector's session changed; they rewrite the last result without browser, Xiaomi or push work. The timer now starts its own unit, `xiaomi-session-refresh-scheduled.service`, which sets `XQ_TIMER_RUN=1`. `xiaomi-session-refresh.service` becomes the manual retry: it unsets that variable and never backs off, so the v0.3.0 `XQ_MANUAL_COMMAND` (`systemctl --user start xiaomi-session-refresh.service`) still works as shown. Direct `bun` runs and `--force` never back off either. `TRIGGER_UNIT` is not used, because systemd.exec(5) calls it best-effort and lossy. Both units read the `XQ_*` settings from one file, `~/.config/xiaomi-session-refresh/env` (example `refresher/systemd/env.example`).
- **Missing session.** A collector that reports the installed file `missing` or `invalid_file` gives `account_mismatch (installed session file missing or unusable; reinstall with --rebind)` at once, unless `--rebind` is set.
- **Bounded ssh calls.** After ssh exits or is killed, its output pipes are read for at most 250 ms more, so a helper process that inherited them cannot hold a run.
- **One run at a time.** A non-blocking `flock(2)` on `$XDG_RUNTIME_DIR/xiaomi-session-refresh.lock`; a second run prints `busy (another run is in progress)` and exits 1 without writing. `--check` takes no lock.
- **Writer race.** The remote writer's `push` mode reads the installed session and its size through one descriptor, so a concurrent rename can no longer cause a spurious `account_mismatch` (exit 8).
- **Local state** in `~/.local/state/xiaomi-session-refresh-state/state.json` (0600 in a 0700 directory): results, counts and collector timestamps only.
- **Timing.** Run deadline 120 s (was 100 s); `TimeoutStartSec=180` (was 150) in both units covers the deadline plus tab close, `Browser.close`, the final status write and one notification. Both units add `StateDirectory=xiaomi-session-refresh-state` and `StateDirectoryMode=0700`.

## Upgrade and compatibility

Follow [upgrading the refresher to v0.3.1](deployment.md#upgrading-the-refresher-to-v031): it adds a unit, changes the timer's `Unit=` and keeps the settings in one environment file. Nothing changes on the collector host. Healthy runs can now report `browser_unavailable` while the browser is down, which earlier versions never did. Timer runs now log under `xiaomi-session-refresh-scheduled.service`. The run lock needs Linux with glibc (`libc.so.6`).

Details: [session renewal](session-renewal.md); evidence: [verification](verification.md#v031--2026-10-29-branch-featv031-refresher).

## v0.3.2

Fix only. `StateDirectory=xiaomi-session-refresh` collided with the identically
named `~/.config/xiaomi-session-refresh`: systemd 253+ makes the state path a
compatibility symlink into the config directory, so the state write failed with
`; state not saved`. Both units now use `StateDirectory=xiaomi-session-refresh-state`.
No behaviour change otherwise; found on the first install of v0.3.1.
