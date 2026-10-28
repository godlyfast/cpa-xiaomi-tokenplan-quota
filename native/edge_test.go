package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestVendorExpiryAndUnknownExpiryArePreserved(t *testing.T) {
	for _, test := range []struct {
		name, body string
		expired    bool
	}{
		{"vendor-expired-future", strings.Replace(fixture, `"expired":false`, `"expired":true`, 1), true},
		{"vendor-active-past", strings.Replace(fixture, `2026-11-27T12:00:00Z`, `2026-10-26T12:00:00Z`, 1), true},
		{"active-unknown", strings.Replace(fixture, `"expiresAt":"2026-11-27T12:00:00Z"`, `"expiresAt":null`, 1), false},
		{"expired-unknown", strings.Replace(strings.Replace(fixture, `"expiresAt":"2026-11-27T12:00:00Z"`, `"expiresAt":null`, 1), `"expired":false`, `"expired":true`, 1), true},
	} {
		t.Run(test.name, func(t *testing.T) {
			s, err := decodeSnapshot([]byte(test.body), testTime)
			if err != nil || s.Expired == nil || *s.Expired != test.expired {
				t.Fatal("lost vendor expiry or rejected unknown timestamp", s, err)
			}
			p := testPlugin(t, test.body)
			raw := p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"xiaomi"}`))
			var response struct {
				OK bool `json:"ok"`
			}
			if json.Unmarshal(raw, &response) != nil || response.OK == test.expired {
				t.Fatalf("incorrect expiry gate: %s", raw)
			}
		})
	}
}
func TestCapturedConfigurationCannotSwitchAccountOnReconfigure(t *testing.T) {
	p := testPlugin(t, fixture)
	captured := p.getConfig()
	other := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("request crossed into the newly configured account")
		_, _ = w.Write([]byte(strings.Replace(fixture, "Test <account>", "OTHER", 1)))
	}))
	defer other.Close()
	// This change can race a quota request after its auth_index validation. The snapshot operation must use that request's captured config, not reread mutable state.
	p.setConfig(config{CollectorURL: other.URL + "/v1/quota", AuthIndex: "other-auth"})
	s, err := p.snapshot(captured)
	if err != nil || s.AccountLabel != "Test <account>" {
		t.Fatal("captured account was not retained", s, err)
	}
}

func fetchFailure(t *testing.T, p *plugin) string {
	t.Helper()
	var r struct {
		OK    bool `json:"ok"`
		Error struct{ Code, Message string }
	}
	if err := json.Unmarshal(p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"xiaomi"}`)), &r); err != nil || r.OK || r.Error.Code != "quota_unavailable" {
		t.Fatalf("expected quota_unavailable: %+v %v", r, err)
	}
	m := r.Error.Message
	if len(m) > 400 || !strings.HasSuffix(m, "Details: Plugins → Xiaomi Token Plan.") || strings.Contains(m, "<nil>") || strings.Contains(m, "%!") || strings.Contains(m, "  ") || strings.Contains(strings.ToLower(m), "log out") {
		t.Fatalf("unbounded or malformed message (%d bytes): %s", len(m), m)
	}
	return m
}
func TestQuotaFetchFailuresAreSpecificAndActionable(t *testing.T) {
	auth := edit(t, fixture, map[string]any{"stale": true, "error": "auth_required"})
	expired := sessionBlock("expired", "2026-10-27T11:00:00.000Z")
	agent := func(result, checkedAt string) map[string]any {
		return map[string]any{"session": expired, "renewal": renewalBlock(result, checkedAt, "bun refresher/refresh-session.ts")}
	}
	for _, test := range []struct {
		name, body string
		later      time.Duration
		want, not  []string
	}{
		{"expired-no-agent", edit(t, auth, map[string]any{"session": expired}), 0, []string{"rejected the collector session at 2026-10-27T11:00:00Z", "sessions have lasted ~24 h", "refresher/refresh-session.ts", "single-file pre-0.3.0 mounts: restart the collector"}, []string{"lifetime", "then restart"}},
		{"expired-signin", edit(t, auth, agent("signin_required", "2026-10-27T11:58:00.000Z")), 0, []string{"Renewal agent on synthetic-host", "11:58:00Z", "not signed in", "sign in at the Xiaomi console", "Run on synthetic-host: `bun refresher/refresh-session.ts`."}, nil},
		{"expired-renewed", edit(t, auth, map[string]any{"session": expired, "renewal": with(renewalBlock("renewed", "2026-10-27T11:58:00.000Z", "bun refresher/refresh-session.ts"), "renewedAt", "2026-10-27T11:57:59.000Z")}), 0, []string{"installed a new session at 2026-10-27T11:57:59Z", "waiting for the collector"}, []string{"Run on"}},
		{"expired-browser", edit(t, auth, agent("browser_unavailable", "2026-10-27T11:58:00.000Z")), 0, []string{"renewal browser is not running", "start it"}, nil},
		{"expired-vendor", edit(t, auth, agent("vendor_unavailable", "2026-10-27T11:58:00.000Z")), 0, []string{"could not reach Xiaomi", "next run"}, nil},
		{"expired-error", edit(t, auth, agent("error", "2026-10-27T11:58:00.000Z")), 0, []string{"failed unexpectedly", "rerun"}, nil},
		{"expired-not-needed", edit(t, auth, agent("not_needed", "2026-10-27T11:58:00.000Z")), 0, []string{"saw no session rejection", "next run should renew"}, []string{"healthy"}},
		{"expired-account-mismatch", edit(t, auth, agent("account_mismatch", "2026-10-27T11:58:00.000Z")), 0, []string{"Renewal agent on synthetic-host refused", "signed in to a different Xiaomi account than the collector session", "no account id", "Sign that browser into the bound account and rerun", "--rebind", "update the collector's account label"}, []string{"failed unexpectedly", "installed", "renew"}},
		{"expired-agent-stale", edit(t, auth, agent("not_needed", "2026-10-27T10:30:00.000Z")), 0, []string{"silent since 2026-10-27T10:30:00Z", "asleep", "timer", "cannot reach the collector or write its status", "ssh/sudo/Docker", "--check", "unit journal", "replace the session file by hand"}, []string{"renews the session", "likely"}},
		{"expired-agent-before-rejection", edit(t, auth, map[string]any{"session": sessionBlock("expired", "2026-10-27T11:59:00.000Z"), "renewal": renewalBlock("not_needed", "2026-10-27T11:55:00.000Z", nil)}), 0, []string{"before the rejection", "next run"}, nil},
		{"missing", edit(t, auth, map[string]any{"session": with(sessionBlock("missing", "2026-10-27T11:00:00.000Z"), "nextAttemptAt", nil)}), 0, []string{"session file is missing", "since 2026-10-27T11:00:00Z", "owner-only regular file", "Cookie header"}, []string{"lifetime"}},
		{"invalid-file", edit(t, auth, map[string]any{"session": sessionBlock("invalid_file", "2026-10-27T11:00:00.000Z")}), 0, []string{"cannot use its Xiaomi session file", "owner-only regular file", "symlink", "printable-ASCII"}, nil},
		{"old-collector-auth", auth, 0, []string{"rejected", "sessions have lasted ~24 h", "restart", "pre-0.3.0"}, []string{"lifetime"}},
		{"schema-changed", edit(t, fixture, map[string]any{"stale": true, "error": "schema_changed", "session": sessionBlock("ok", nil)}), 0, []string{"API changed", "at 2026-10-27T12:00:30Z", "collector code is updated"}, []string{"session file"}},
		{"unavailable", edit(t, fixture, map[string]any{"stale": true, "error": "unavailable", "session": sessionBlock("ok", nil)}), 0, []string{"could not reach Xiaomi", "at 2026-10-27T12:00:30Z", "retries every 5 min", "next ~2026-10-27T12:05:30Z"}, nil},
		{"unavailable-next-due", edit(t, fixture, map[string]any{"stale": true, "error": "unavailable", "session": sessionBlock("ok", nil)}), 5 * time.Minute, []string{"could not reach Xiaomi", "retries every 5 min."}, []string{"next ~"}},
		{"unavailable-next-null", edit(t, fixture, map[string]any{"stale": true, "error": "unavailable", "session": with(sessionBlock("unknown", nil), "nextAttemptAt", nil)}), 0, []string{"retries every 5 min."}, []string{"next ~"}},
		{"unavailable-first-poll", edit(t, fixture, map[string]any{"stale": true, "error": "unavailable", "pools": []any{}, "fetchedAt": nil, "expired": nil}), 0, []string{"could not reach Xiaomi", "No quota fetched yet"}, nil},
		{"stale-no-error", fixture, time.Hour, []string{"No completed collector poll in over 10 min", "Last good quota: 2026-10-27T12:00:00Z", "running", "clock"}, nil},
		{"subscription-expired", edit(t, fixture, map[string]any{"expiresAt": "2026-10-27T11:00:00Z"}), 0, []string{"subscription expired at 2026-10-27T11:00:00Z", "Renew", "Xiaomi console"}, nil},
		{"subscription-flagged-expired", edit(t, fixture, map[string]any{"expired": true}), 0, []string{"reports the Token Plan subscription as expired (listed expiry 2026-11-27T12:00:00Z)", "Renew"}, []string{"expired at"}},
	} {
		t.Run(test.name, func(t *testing.T) {
			p := testPlugin(t, test.body)
			p.now = func() time.Time { return testTime.Add(test.later) }
			m := fetchFailure(t, p)
			for _, want := range test.want {
				if !strings.Contains(m, want) {
					t.Errorf("missing %q in %s", want, m)
				}
			}
			for _, not := range test.not {
				if strings.Contains(m, not) {
					t.Errorf("unexpected %q in %s", not, m)
				}
			}
		})
	}
}
func TestQuotaFetchExplainsCollectorFailureWithoutLeakingIt(t *testing.T) {
	for name, handler := range map[string]http.HandlerFunc{
		"http-503": func(w http.ResponseWriter, _ *http.Request) {
			http.Error(w, "secret-internal-detail", http.StatusServiceUnavailable)
		},
		"invalid": func(w http.ResponseWriter, _ *http.Request) {
			_, _ = w.Write([]byte(`{"secret-internal-detail":true}`))
		},
	} {
		server := httptest.NewServer(handler)
		p := newPlugin()
		p.setConfig(config{CollectorURL: server.URL + "/v1/quota", AuthIndex: "synthetic-auth"})
		m := fetchFailure(t, p)
		server.Close()
		if !strings.Contains(m, "collector_url") || !strings.Contains(m, "not running") || strings.Contains(m, "secret") || strings.Contains(m, server.URL) {
			t.Fatalf("%s: unhelpful or leaking collector failure: %s", name, m)
		}
	}
}
func TestQuotaFetchMessageStaysBoundedForLongestValidFields(t *testing.T) {
	long := renewalBlock("signin_required", "2026-10-27T11:58:00.000Z", strings.Repeat("x", 160))
	long["host"] = "h" + strings.Repeat("x", 63)
	p := testPlugin(t, edit(t, fixture, map[string]any{"stale": true, "error": "auth_required", "session": sessionBlock("expired", "2026-10-27T11:00:00.000Z"), "renewal": long}))
	m := fetchFailure(t, p)
	if !strings.HasPrefix(m, "Xiaomi rejected the collector session at 2026-10-27T11:00:00Z") || !strings.Contains(m, "Renewal agent on h"+strings.Repeat("x", 63)) {
		t.Fatalf("essential guidance dropped: %s", m)
	}
	// Each branch's cause and fix must survive the longest host, command and state head.
	for name, test := range map[string]struct {
		state, result, checkedAt string
		want                     []string
	}{
		"stale":             {"invalid_file", "account_mismatch", "2026-10-27T10:00:00.000Z", []string{"cannot reach the collector or write its status", "--check", "unit journal"}},
		"account-mismatch":  {"expired", "account_mismatch", "2026-10-27T11:58:00.000Z", []string{"different Xiaomi account", "no account id"}},
		"mismatch-unusable": {"invalid_file", "account_mismatch", "2026-10-27T11:58:00.000Z", []string{"unusable or names another Xiaomi account", "--rebind"}},
		"mismatch-no-file":  {"missing", "account_mismatch", "2026-10-27T11:58:00.000Z", []string{"no installed session file to compare accounts with", "--rebind"}},
		"not-needed":        {"invalid_file", "not_needed", "2026-10-27T11:58:00.000Z", []string{"saw no session rejection"}},
	} {
		r := renewalBlock(test.result, test.checkedAt, strings.Repeat("x", 160))
		r["host"] = "h" + strings.Repeat("x", 63)
		m := fetchFailure(t, testPlugin(t, edit(t, fixture, map[string]any{"stale": true, "error": "auth_required", "session": sessionBlock(test.state, "2026-10-27T11:00:00.000Z"), "renewal": r})))
		for _, want := range test.want {
			if !strings.Contains(m, want) {
				t.Errorf("%s: dropped %q: %s", name, want, m)
			}
		}
	}
	m = fetchFailure(t, testPlugin(t, edit(t, fixture, map[string]any{"stale": true, "error": "auth_required", "session": sessionBlock("invalid_file", "2026-10-27T11:00:00.000Z")})))
	for _, want := range []string{"cannot use its Xiaomi session file", "printable-ASCII Cookie header line", "No renewal agent reports", "single-file pre-0.3.0 mounts: restart the collector"} {
		if !strings.Contains(m, want) {
			t.Errorf("no-agent: dropped %q: %s", want, m)
		}
	}
}
