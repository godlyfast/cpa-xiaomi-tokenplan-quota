package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
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
