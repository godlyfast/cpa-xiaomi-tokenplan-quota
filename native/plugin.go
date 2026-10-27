// Native C ABI plugin for CLIProxyAPI v8.0.44 (ABI 1, schema 6).
package main

import (
	_ "embed"
	"encoding/json"
	"errors"
	"io"
	"math/big"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"

	"gopkg.in/yaml.v3"
)

const pluginID = "xiaomi-tokenplan-quota"
const version = "0.2.1"
const maxSnapshot = 32768
const snapshotPath = "/v0/management/plugins/" + pluginID + "/snapshot"
const resourcePath = "/v0/resource/plugins/" + pluginID + "/quota"

//go:embed quota.html
var quotaHTML []byte
var decimal = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?$`)
var unavailable = errors.New("collector unavailable")

type config struct {
	CollectorURL string `yaml:"collector_url"`
	AuthIndex    string `yaml:"auth_index"`
}

func parseConfig(b []byte) (config, error) {
	var c config
	if err := yaml.Unmarshal(b, &c); err != nil {
		return c, errors.New("invalid plugin configuration")
	}
	u, err := url.Parse(c.CollectorURL)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || u.Path != "/v1/quota" || strings.TrimSpace(c.AuthIndex) == "" || len(c.AuthIndex) > 128 {
		return c, errors.New("collector_url must be an HTTP(S) /v1/quota URL without credentials/query; auth_index is required")
	}
	return c, nil
}

type plugin struct {
	mu     sync.RWMutex
	config config
	client *http.Client
	now    func() time.Time
}

func newPlugin() *plugin {
	return &plugin{now: time.Now, client: &http.Client{Timeout: 2 * time.Second, Transport: &http.Transport{Proxy: nil, MaxIdleConns: 2, MaxIdleConnsPerHost: 2, IdleConnTimeout: 30 * time.Second}, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (p *plugin) setConfig(c config) { p.mu.Lock(); p.config = c; p.mu.Unlock() }
func (p *plugin) getConfig() config  { p.mu.RLock(); defer p.mu.RUnlock(); return p.config }

type pool struct {
	ID               string  `json:"id"`
	Label            string  `json:"label"`
	Unit             string  `json:"unit"`
	Used             string  `json:"used"`
	Limit            string  `json:"limit"`
	Remaining        string  `json:"remaining"`
	RemainingPercent *string `json:"remainingPercent"`
}
type snapshot struct {
	SchemaVersion int     `json:"schemaVersion"`
	Region        string  `json:"region"`
	AccountLabel  string  `json:"accountLabel"`
	PlanName      *string `json:"planName"`
	Pools         []pool  `json:"pools"`
	FetchedAt     *string `json:"fetchedAt"`
	ExpiresAt     *string `json:"expiresAt"`
	Expired       *bool   `json:"expired"`
	ResetsAt      *string `json:"resetsAt"`
	Stale         bool    `json:"stale"`
	Error         *string `json:"error"`
}

func textOK(s string) bool { return len(s) <= 256 && strings.IndexFunc(s, unicode.IsControl) == -1 }
func number(s string) (*big.Rat, error) {
	if len(s) > 128 || !decimal.MatchString(s) {
		return nil, unavailable
	}
	r, ok := new(big.Rat).SetString(s)
	if !ok {
		return nil, unavailable
	}
	return r, nil
}
func decodeSnapshot(b []byte, now time.Time) (snapshot, error) {
	var s snapshot
	if len(b) > maxSnapshot {
		return s, unavailable
	}
	if json.Unmarshal(b, &s) != nil || s.SchemaVersion != 1 || s.Region != "sgp" || s.AccountLabel == "" || !textOK(s.AccountLabel) || (s.PlanName != nil && !textOK(*s.PlanName)) || s.ResetsAt != nil || len(s.Pools) > 3 {
		return s, unavailable
	}
	if s.Error != nil && *s.Error != "auth_required" && *s.Error != "unavailable" && *s.Error != "schema_changed" {
		return s, unavailable
	}
	ids := map[string]bool{}
	for _, v := range s.Pools {
		if (v.ID != "plan" && v.ID != "monthly" && v.ID != "compensation") || ids[v.ID] || v.Unit != "credits" || v.Label == "" || !textOK(v.Label) {
			return s, unavailable
		}
		ids[v.ID] = true
		used, e1 := number(v.Used)
		limit, e2 := number(v.Limit)
		left, e3 := number(v.Remaining)
		if e1 != nil || e2 != nil || e3 != nil {
			return s, unavailable
		}
		expected := new(big.Rat).Sub(limit, used)
		if expected.Sign() < 0 {
			expected.SetInt64(0)
		}
		if expected.Cmp(left) != 0 {
			return s, unavailable
		}
		if v.RemainingPercent != nil {
			r, err := number(*v.RemainingPercent)
			if err != nil || r.Cmp(big.NewRat(100, 1)) > 0 {
				return s, unavailable
			}
		}
	}
	if s.FetchedAt == nil {
		if len(s.Pools) != 0 || !s.Stale || s.Error == nil {
			return s, unavailable
		}
	} else {
		at, err := time.Parse(time.RFC3339Nano, *s.FetchedAt)
		if err != nil {
			return s, unavailable
		}
		age := now.Sub(at)
		s.Stale = s.Stale || age < 0 || age > 10*time.Minute
		if len(s.Pools) == 0 || s.Expired == nil {
			return s, unavailable
		}
	}
	if s.ExpiresAt != nil {
		at, err := time.Parse(time.RFC3339Nano, *s.ExpiresAt)
		if err != nil {
			return s, unavailable
		}
		expired := (s.Expired != nil && *s.Expired) || !now.Before(at)
		s.Expired = &expired
	}
	return s, nil
}
func (p *plugin) snapshot(c config) (snapshot, error) {
	if c.CollectorURL == "" {
		return snapshot{}, unavailable
	}
	// No request headers, tokens, cookies, auth files, or environment proxy credentials forwarded.
	req, err := http.NewRequest(http.MethodGet, c.CollectorURL, nil)
	if err != nil {
		return snapshot{}, unavailable
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return snapshot{}, unavailable
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return snapshot{}, unavailable
	}
	b, err := io.ReadAll(io.LimitReader(resp.Body, maxSnapshot+1))
	if err != nil {
		return snapshot{}, unavailable
	}
	return decodeSnapshot(b, p.now())
}
func ok(v any) []byte { b, _ := json.Marshal(map[string]any{"ok": true, "result": v}); return b }
func fail(code, message string) []byte {
	b, _ := json.Marshal(map[string]any{"ok": false, "error": map[string]string{"code": code, "message": message}})
	return b
}
func (p *plugin) handle(method string, b []byte) []byte {
	switch method {
	case "plugin.register", "plugin.reconfigure":
		var req struct {
			ConfigYAML []byte `json:"config_yaml"`
		}
		if json.Unmarshal(b, &req) != nil {
			return fail("invalid_config", "invalid configuration")
		}
		c, err := parseConfig(req.ConfigYAML)
		if err != nil {
			return fail("invalid_config", err.Error())
		}
		p.setConfig(c)
		return ok(map[string]any{"schema_version": 6, "metadata": map[string]any{"Name": "Xiaomi Token Plan Quota", "Version": version, "Author": "godlyfast", "GitHubRepository": "https://github.com/godlyfast/cpa-xiaomi-tokenplan-quota", "ConfigFields": []map[string]string{{"Name": "collector_url", "Type": "string", "Description": "Private collector /v1/quota URL; no credentials or query parameters."}, {"Name": "auth_index", "Type": "string", "Description": "CPA auth-index for the one Xiaomi account explicitly matched to the collector."}}}, "capabilities": map[string]bool{"management_api": true, "quota_provider": true}})
	case "plugin.quiesce":
		return ok(map[string]any{})
	case "quota.identifier":
		return ok(map[string]string{"identifier": "xiaomi"})
	case "quota.describe":
		return ok(map[string]any{"supported_providers": []string{"xiaomi", "openai-compatible-xiaomi"}, "display_name": "Xiaomi Token Plan Credits", "supports_reset": false})
	case "quota.fetch":
		var req struct {
			AuthIndex string `json:"auth_index"`
			Provider  string `json:"provider"`
		}
		c := p.getConfig()
		if json.Unmarshal(b, &req) != nil || req.AuthIndex != c.AuthIndex || req.AuthIndex == "" || !(strings.EqualFold(req.Provider, "xiaomi") || strings.EqualFold(req.Provider, "openai-compatible-xiaomi")) {
			return fail("account_mismatch", "quota is bound to one configured Xiaomi account")
		}
		s, err := p.snapshot(c)
		if err != nil {
			return fail("quota_unavailable", "collector unavailable")
		}
		if s.Stale || s.Error != nil || s.Expired == nil || *s.Expired {
			return fail("quota_unavailable", "quota is stale, expired, or requires collector reauthentication; open plugin page for status")
		}
		return ok(normalize(s))
	case "quota.reset":
		return fail("unsupported", "quota reset is not supported")
	case "management.register":
		return ok(map[string]any{"routes": []map[string]string{{"Method": "GET", "Path": snapshotPath}}, "resources": []map[string]string{{"Path": "/quota", "Menu": "Xiaomi Token Plan", "Description": "Singapore Credits, freshness, and session status (management authentication required)."}}})
	case "management.handle":
		var r struct {
			Method, Path string
			Query        url.Values
			Body         []byte
		}
		if json.Unmarshal(b, &r) != nil {
			return fail("invalid_request", "invalid request")
		}
		if r.Method != "GET" || len(r.Query) != 0 || len(r.Body) != 0 {
			return response(400, "application/json", []byte(`{"error":"invalid_request"}`))
		}
		if r.Path == resourcePath {
			return response(200, "text/html; charset=utf-8", quotaHTML)
		}
		if r.Path != snapshotPath {
			return response(404, "application/json", []byte(`{"error":"not_found"}`))
		}
		s, err := p.snapshot(p.getConfig())
		if err != nil {
			return response(503, "application/json", []byte(`{"error":"unavailable"}`))
		}
		raw, _ := json.Marshal(s)
		return response(200, "application/json", raw)
	default:
		return fail("unknown_method", "unsupported method")
	}
}
func response(status int, contentType string, body []byte) []byte {
	return ok(map[string]any{"StatusCode": status, "Headers": http.Header{"Content-Type": {contentType}, "Cache-Control": {"no-store"}, "X-Content-Type-Options": {"nosniff"}, "Referrer-Policy": {"no-referrer"}, "Content-Security-Policy": {"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; base-uri 'none'; frame-ancestors 'self'"}}, "Body": body})
}
func normalize(s snapshot) map[string]any {
	groups := []map[string]any{}
	summary := []map[string]any{}
	for _, v := range s.Pools {
		left, _ := number(v.Remaining)
		limit, _ := number(v.Limit)
		fraction := 0.0
		if limit.Sign() > 0 {
			fraction, _ = new(big.Rat).Quo(left, limit).Float64()
		}
		expiry := "unknown"
		if s.ExpiresAt != nil {
			expiry = *s.ExpiresAt
		}
		groups = append(groups, map[string]any{"displayName": v.Label, "buckets": []map[string]any{{"window": "subscription", "remainingFraction": fraction, "description": "Credits; subscription expiry is not a reset. Expires " + expiry}}})
		for _, m := range []struct{ key, label, amount string }{{"remaining", "Remaining", v.Remaining}, {"used", "Used", v.Used}, {"limit", "Limit", v.Limit}} {
			n, _ := number(m.amount)
			// Native metrics use float64: do not silently round large/precise Credits. The plugin page retains exact decimal strings.
			f, exact := n.Float64()
			if exact && n.Cmp(big.NewRat(9007199254740991, 1)) <= 0 {
				summary = append(summary, map[string]any{"key": v.ID + "_" + m.key, "label": v.Label + " " + m.label, "value": f, "unit": "Credits", "format": "number"})
			}
		}
	}
	subscription := map[string]any{"plan": "Xiaomi Token Plan", "tierName": "Singapore"}
	if s.PlanName != nil {
		subscription["plan"] = *s.PlanName
	}
	return map[string]any{"subscription": subscription, "summary": summary, "groups": groups}
}

// Keep C ABI buffers separate from the pure Go protocol handler (testable without CPA).
var runtimePlugin = newPlugin()
