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
