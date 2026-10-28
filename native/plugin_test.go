package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// All counters and labels are synthetic; no vendor cookies or credentials.
const fixture = `{"schemaVersion":1,"region":"sgp","accountLabel":"Test <account>","planName":"Pro","pools":[{"id":"plan","label":"Plan","unit":"credits","used":"60","limit":"100","remaining":"40","remainingPercent":"40.00"}],"fetchedAt":"2026-10-27T12:00:00Z","expiresAt":"2026-11-27T12:00:00Z","expired":false,"resetsAt":null,"stale":false,"error":null}`

var testTime = time.Date(2026, 10, 27, 12, 1, 0, 0, time.UTC)

func TestNativeRegistrationDoesNotInterceptInference(t *testing.T) {
	p := newPlugin()
	raw, _ := json.Marshal(map[string]any{"config_yaml": []byte("collector_url: http://xiaomi-quota:8787/v1/quota\nauth_index: synthetic-auth\n")})
	b := p.handle("plugin.register", raw)
	var r struct {
		OK     bool `json:"ok"`
		Result struct {
			Metadata     struct{ Name, Version string }
			Capabilities map[string]bool
		} `json:"result"`
	}
	if err := json.Unmarshal(b, &r); err != nil || !r.OK {
		t.Fatalf("registration: %s", b)
	}
	if r.Result.Metadata.Name == "" || r.Result.Metadata.Version == "" || !r.Result.Capabilities["management_api"] || !r.Result.Capabilities["quota_provider"] {
		t.Fatalf("missing plugin metadata/capabilities: %s", b)
	}
	for k, v := range r.Result.Capabilities {
		if v && k != "management_api" && k != "quota_provider" {
			t.Fatalf("unexpected inference capability: %s", k)
		}
	}
}
func TestConfigRejectsUnsafeURLsAndMissingBinding(t *testing.T) {
	for _, s := range []string{"collector_url: file:///etc/passwd\nauth_index: test", "collector_url: http://user:pass@host/v1/quota\nauth_index: test", "collector_url: http://host/v1/quota?token=secret\nauth_index: test", "collector_url: http://host/other\nauth_index: test", "collector_url: http://host/v1/quota"} {
		if _, err := parseConfig([]byte(s)); err == nil {
			t.Fatalf("accepted unsafe config %q", s)
		}
	}
}
func testPlugin(t *testing.T, body string) *plugin {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "GET" || r.URL.RequestURI() != "/v1/quota" || r.Header.Get("Authorization") != "" || r.Header.Get("Cookie") != "" {
			t.Errorf("credential leak or wrong request: %v", r)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	p := newPlugin()
	p.now = func() time.Time { return testTime }
	c, err := parseConfig([]byte("collector_url: " + server.URL + "/v1/quota\nauth_index: synthetic-auth\n"))
	if err != nil {
		t.Fatal(err)
	}
	p.setConfig(c)
	return p
}
func TestQuotaNormalizesCreditsNotTokensAndBindsAccount(t *testing.T) {
	p := testPlugin(t, fixture)
	b := p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"xiaomi"}`))
	var r struct {
		OK     bool `json:"ok"`
		Result struct {
			Groups []struct {
				Buckets []struct {
					RemainingFraction float64 `json:"remainingFraction"`
					Description       string
				}
			}
			Summary []struct {
				Value float64
				Unit  string
			}
		} `json:"result"`
	}
	if err := json.Unmarshal(b, &r); err != nil || !r.OK {
		t.Fatalf("quota error: %s", b)
	}
	if len(r.Result.Groups) != 1 || len(r.Result.Groups[0].Buckets) != 1 || r.Result.Groups[0].Buckets[0].RemainingFraction != 0.4 || len(r.Result.Summary) != 3 || r.Result.Summary[0].Value != 40 || r.Result.Summary[0].Unit != "Credits" {
		t.Fatalf("incorrect normalized credits: %s", b)
	}
	if b = p.handle("quota.fetch", []byte(`{"auth_index":"other","provider":"xiaomi"}`)); !strings.Contains(string(b), `"ok":false`) {
		t.Fatalf("accepted another account: %s", b)
	}
	if b = p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"codex"}`)); !strings.Contains(string(b), `"ok":false`) {
		t.Fatalf("accepted another provider: %s", b)
	}
}
func TestSnapshotRejectsMalformedAndMarksOldDataStale(t *testing.T) {
	for _, s := range []string{strings.Replace(fixture, `"remaining":"40"`, `"remaining":"99"`, 1), strings.Replace(fixture, `"used":"60"`, `"used":"NaN"`, 1), strings.Replace(fixture, `"sgp"`, `"cn"`, 1), strings.Replace(fixture, `"schemaVersion":1`, `"schemaVersion":2`, 1), fixture + "{}"} {
		if _, err := decodeSnapshot([]byte(s), testTime); err == nil {
			t.Fatalf("accepted malformed snapshot: %s", s)
		}
	}
	p := testPlugin(t, fixture)
	p.now = func() time.Time { return testTime.Add(time.Hour) }
	b := p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"xiaomi"}`))
	if !strings.Contains(string(b), `"ok":false`) {
		t.Fatalf("old quota presented as live: %s", b)
	}
	raw, err := p.snapshot(p.getConfig())
	if err != nil || !raw.Stale {
		t.Fatal("old snapshot must remain visibly stale", err)
	}
}
func TestResourceNeverExposesSnapshotWithoutManagementAuthentication(t *testing.T) {
	p := testPlugin(t, fixture)
	for _, path := range []string{"/v0/resource/plugins/xiaomi-tokenplan-quota/quota", "/v0/resource/plugins/xiaomi-tokenplan-quota/snapshot", "/v0/management/plugins/xiaomi-tokenplan-quota/snapshot"} {
		req, _ := json.Marshal(map[string]any{"Method": "GET", "Path": path, "Query": map[string][]string{}})
		b := p.handle("management.handle", req)
		var r struct {
			OK     bool `json:"ok"`
			Result struct {
				StatusCode int
				Body       []byte
			}
		}
		if json.Unmarshal(b, &r) != nil || !r.OK {
			t.Fatalf("response: %s", b)
		}
		if strings.Contains(path, "resource") && (strings.Contains(string(r.Result.Body), "Test <account>") || strings.Contains(string(r.Result.Body), "40.00")) {
			t.Fatal("public resource leaked account data")
		}
		if strings.HasSuffix(path, "/quota") && r.Result.StatusCode != 200 {
			t.Fatal("missing resource shell")
		}
		if strings.Contains(path, "resource") && strings.HasSuffix(path, "snapshot") && r.Result.StatusCode != 404 {
			t.Fatal("public snapshot route accepted")
		}
		if strings.Contains(path, "management") {
			var s struct {
				AccountLabel string `json:"accountLabel"`
			}
			if json.Unmarshal(r.Result.Body, &s) != nil || s.AccountLabel != "Test <account>" {
				t.Fatal("authenticated snapshot missing")
			}
		}
	}
	b := p.handle("quota.reset", nil)
	if !strings.Contains(string(b), `"ok":false`) {
		t.Fatal("must not offer writes/reset")
	}
}
func TestCollectorFailuresAreBoundedAndSanitized(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "http://example.invalid/secret", http.StatusFound)
	}))
	defer server.Close()
	p := newPlugin()
	p.setConfig(config{CollectorURL: server.URL + "/v1/quota", AuthIndex: "synthetic-auth"})
	b := p.handle("quota.fetch", []byte(`{"auth_index":"synthetic-auth","provider":"xiaomi"}`))
	if !strings.Contains(string(b), `"ok":false`) || strings.Contains(string(b), "secret") || strings.Contains(string(b), "example.invalid") {
		t.Fatalf("redirect followed or error leak: %s", b)
	}
	if _, err := decodeSnapshot([]byte(strings.Repeat(" ", maxSnapshot+1)), testTime); err == nil {
		t.Fatal("oversized response accepted")
	}
}

// v0.3.0 session/renewal blocks. Host labels and commands are synthetic.
var absent = &struct{}{}

func edit(t *testing.T, base string, edits map[string]any) string {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal([]byte(base), &m); err != nil {
		t.Fatal(err)
	}
	for k, v := range edits {
		if v == absent {
			delete(m, k)
		} else {
			m[k] = v
		}
	}
	b, err := json.Marshal(m)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}
func sessionBlock(state string, rejectedAt any) map[string]any {
	return map[string]any{"state": state, "updatedAt": "2026-10-27T09:00:00.000Z", "rejectedAt": rejectedAt, "lastAttemptAt": "2026-10-27T12:00:30.000Z", "nextAttemptAt": "2026-10-27T12:05:30.000Z"}
}
func renewalBlock(result, checkedAt string, command any) map[string]any {
	return map[string]any{"checkedAt": checkedAt, "result": result, "renewedAt": "2026-10-27T09:00:00.000Z", "host": "synthetic-host", "manualCommand": command}
}
func with(m map[string]any, k string, v any) map[string]any {
	c := map[string]any{}
	for key, value := range m {
		c[key] = value
	}
	if v == absent {
		delete(c, k)
	} else {
		c[k] = v
	}
	return c
}

var healthy = map[string]any{"session": sessionBlock("ok", nil), "renewal": renewalBlock("not_needed", "2026-10-27T11:58:00.000Z", "bun refresher/refresh-session.ts")}

func TestSessionAndRenewalAreValidatedStrictly(t *testing.T) {
	s, err := decodeSnapshot([]byte(edit(t, fixture, healthy)), testTime)
	if err != nil || s.Session == nil || s.Session.State != "ok" || *s.Session.UpdatedAt != "2026-10-27T09:00:00.000Z" || s.Session.RejectedAt != nil || s.Renewal == nil || s.Renewal.Result != "not_needed" || s.Renewal.Host != "synthetic-host" || *s.Renewal.ManualCommand != "bun refresher/refresh-session.ts" {
		t.Fatal("valid session/renewal rejected or lost", s, err)
	}
	for name, edits := range map[string]map[string]any{
		"absent":          {"session": absent, "renewal": absent},
		"null":            {"session": nil, "renewal": nil},
		"second-stamps":   {"session": with(sessionBlock("expired", "2026-10-27T11:00:00Z"), "updatedAt", "2026-10-27T09:00:00.5Z")},
		"nullable-fields": {"session": map[string]any{"state": "unknown", "updatedAt": nil, "rejectedAt": nil, "lastAttemptAt": nil, "nextAttemptAt": nil}, "renewal": with(with(renewalBlock("error", "2026-10-27T12:00:00Z", nil), "renewedAt", nil), "host", "a")},
		"every-state":     {"session": sessionBlock("invalid_file", "2026-10-27T11:00:00.000Z"), "renewal": renewalBlock("browser_unavailable", "2026-10-27T12:00:00.000Z", strings.Repeat("~", 160))},
		"host-max":        {"renewal": with(renewalBlock("renewed", "2026-10-27T12:00:00.000Z", nil), "host", "h"+strings.Repeat("x._-", 15)+"abc")},
	} {
		if _, err := decodeSnapshot([]byte(edit(t, fixture, edits)), testTime); err != nil {
			t.Fatalf("%s: valid snapshot rejected", name)
		}
	}
	for state := range map[string]bool{"unknown": true, "ok": true, "expired": true, "missing": true, "invalid_file": true} {
		if _, err := decodeSnapshot([]byte(edit(t, fixture, map[string]any{"session": sessionBlock(state, nil)})), testTime); err != nil {
			t.Fatalf("state %s rejected", state)
		}
	}
	for _, result := range []string{"not_needed", "renewed", "signin_required", "browser_unavailable", "vendor_unavailable", "error"} {
		if _, err := decodeSnapshot([]byte(edit(t, fixture, map[string]any{"renewal": renewalBlock(result, "2026-10-27T12:00:00.000Z", nil)})), testTime); err != nil {
			t.Fatalf("result %s rejected", result)
		}
	}
	ok, renewal := sessionBlock("ok", nil), renewalBlock("not_needed", "2026-10-27T11:58:00.000Z", nil)
	for name, edits := range map[string]map[string]any{
		"session-type":      {"session": "ok"},
		"session-state":     {"session": with(ok, "state", "renewing")},
		"session-no-state":  {"session": with(ok, "state", absent)},
		"session-offset":    {"session": with(ok, "updatedAt", "2026-10-27T09:00:00+00:00")},
		"session-no-zone":   {"session": with(ok, "rejectedAt", "2026-10-27T09:00:00")},
		"session-precision": {"session": with(ok, "lastAttemptAt", "2026-10-27T09:00:00.0000Z")},
		"session-date":      {"session": with(ok, "nextAttemptAt", "2026-02-30T09:00:00Z")},
		"session-space":     {"session": with(ok, "updatedAt", "2026-10-27 09:00:00Z")},
		"session-number":    {"session": with(ok, "updatedAt", 1761555600000)},
		"renewal-type":      {"renewal": []any{}},
		"renewal-result":    {"renewal": with(renewal, "result", "ok")},
		"renewal-checked":   {"renewal": with(renewal, "checkedAt", nil)},
		"renewal-missing":   {"renewal": with(renewal, "checkedAt", absent)},
		"renewal-renewed":   {"renewal": with(renewal, "renewedAt", "yesterday")},
		"host-empty":        {"renewal": with(renewal, "host", "")},
		"host-leading-dot":  {"renewal": with(renewal, "host", ".hidden")},
		"host-space":        {"renewal": with(renewal, "host", "a b")},
		"host-long":         {"renewal": with(renewal, "host", strings.Repeat("h", 65))},
		"host-unicode":      {"renewal": with(renewal, "host", "hôst")},
		"host-newline":      {"renewal": with(renewal, "host", "host\n")},
		"command-empty":     {"renewal": with(renewal, "manualCommand", "")},
		"command-control":   {"renewal": with(renewal, "manualCommand", "bun refresh\tnow")},
		"command-unicode":   {"renewal": with(renewal, "manualCommand", "bun rëfresh")},
		"command-long":      {"renewal": with(renewal, "manualCommand", strings.Repeat("x", 161))},
		"command-type":      {"renewal": with(renewal, "manualCommand", 7)},
	} {
		body := edit(t, fixture, edits)
		if _, err := decodeSnapshot([]byte(body), testTime); err == nil {
			t.Fatalf("%s: accepted invalid snapshot %s", name, body)
		}
		p := testPlugin(t, body)
		req, _ := json.Marshal(map[string]any{"Method": "GET", "Path": snapshotPath, "Query": map[string][]string{}})
		var r struct{ Result struct{ StatusCode int } }
		if json.Unmarshal(p.handle("management.handle", req), &r) != nil || r.Result.StatusCode != 503 {
			t.Fatalf("%s: invalid snapshot was served", name)
		}
	}
}
func TestSnapshotRoutePassesSessionAndRenewalThrough(t *testing.T) {
	read := func(body string) map[string]json.RawMessage {
		p := testPlugin(t, body)
		req, _ := json.Marshal(map[string]any{"Method": "GET", "Path": snapshotPath, "Query": map[string][]string{}})
		var r struct{ Result struct{ Body []byte } }
		var out map[string]json.RawMessage
		if json.Unmarshal(p.handle("management.handle", req), &r) != nil || json.Unmarshal(r.Result.Body, &out) != nil {
			t.Fatal("snapshot route failed")
		}
		return out
	}
	out := read(edit(t, fixture, healthy))
	var session sessionInfo
	var renewal renewalInfo
	if json.Unmarshal(out["session"], &session) != nil || json.Unmarshal(out["renewal"], &renewal) != nil || session.State != "ok" || session.RejectedAt != nil || *session.NextAttemptAt != "2026-10-27T12:05:30.000Z" || renewal.Host != "synthetic-host" || renewal.CheckedAt != "2026-10-27T11:58:00.000Z" {
		t.Fatalf("session/renewal not passed through: %s %s", out["session"], out["renewal"])
	}
	if !strings.Contains(string(out["session"]), `"rejectedAt":null`) || !strings.Contains(string(out["renewal"]), `"manualCommand":"bun refresher/refresh-session.ts"`) {
		t.Fatal("nullable fields must stay explicit inside present blocks")
	}
	for _, body := range []string{fixture, edit(t, fixture, map[string]any{"session": nil, "renewal": nil})} {
		out = read(body)
		if _, has := out["session"]; has {
			t.Fatal("older collector shape must stay without session")
		}
		if _, has := out["renewal"]; has || out["accountLabel"] == nil {
			t.Fatal("older collector shape must stay without renewal")
		}
	}
}
