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
const version = "0.3.0"
const maxSnapshot = 32768
const snapshotPath = "/v0/management/plugins/" + pluginID + "/snapshot"
const resourcePath = "/v0/resource/plugins/" + pluginID + "/quota"

//go:embed quota.html
var quotaHTML []byte
var decimal = regexp.MustCompile(`^(0|[1-9][0-9]*)(\.[0-9]+)?$`)
var unavailable = errors.New("collector unavailable")

// Session/renewal timestamps exactly as Date#toISOString() emits them (UTC only).
var utcStamp = regexp.MustCompile(`^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d{1,3})?Z$`)
var hostLabel = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$`)
var sessionStates = map[string]bool{"unknown": true, "ok": true, "expired": true, "missing": true, "invalid_file": true}
var renewalResults = map[string]bool{"not_needed": true, "renewed": true, "signin_required": true, "browser_unavailable": true, "vendor_unavailable": true, "error": true}

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
type sessionInfo struct {
	State         string  `json:"state"`
	UpdatedAt     *string `json:"updatedAt"`
	RejectedAt    *string `json:"rejectedAt"`
	LastAttemptAt *string `json:"lastAttemptAt"`
	NextAttemptAt *string `json:"nextAttemptAt"`
}
type renewalInfo struct {
	CheckedAt     string  `json:"checkedAt"`
	Result        string  `json:"result"`
	RenewedAt     *string `json:"renewedAt"`
	Host          string  `json:"host"`
	ManualCommand *string `json:"manualCommand"`
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
	// v0.3.0 collectors; absent and null are identical (older collectors omit both).
	Session *sessionInfo `json:"session,omitempty"`
	Renewal *renewalInfo `json:"renewal,omitempty"`
}

func textOK(s string) bool { return len(s) <= 256 && strings.IndexFunc(s, unicode.IsControl) == -1 }
func stamp(s *string, nullable bool) bool {
	if s == nil {
		return nullable
	}
	_, err := time.Parse(time.RFC3339Nano, *s)
	return err == nil && utcStamp.MatchString(*s)
}
func command(s *string) bool {
	if s == nil {
		return true
	}
	if len(*s) == 0 || len(*s) > 160 {
		return false
	}
	for i := 0; i < len(*s); i++ {
		if (*s)[i] < 0x20 || (*s)[i] > 0x7e {
			return false
		}
	}
	return true
}
func (v *sessionInfo) valid() bool {
	return v == nil || (sessionStates[v.State] && stamp(v.UpdatedAt, true) && stamp(v.RejectedAt, true) && stamp(v.LastAttemptAt, true) && stamp(v.NextAttemptAt, true))
}
func (v *renewalInfo) valid() bool {
	return v == nil || (renewalResults[v.Result] && stamp(&v.CheckedAt, false) && stamp(v.RenewedAt, true) && hostLabel.MatchString(v.Host) && command(v.ManualCommand))
}
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
	if (s.Error != nil && *s.Error != "auth_required" && *s.Error != "unavailable" && *s.Error != "schema_changed") || !s.Session.valid() || !s.Renewal.valid() {
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
			return fail("quota_unavailable", message("The plugin could not read a valid snapshot from its collector_url: the collector is not running, not on the gateway's network, or returned an invalid snapshot (collector/plugin version mismatch). No quota is asserted."))
		}
		if s.Stale || s.Error != nil || s.Expired == nil || *s.Expired {
			return fail("quota_unavailable", explain(s, p.now()))
		}
		return ok(normalize(s))
	case "quota.reset":
		return fail("unsupported", "quota reset is not supported")
	case "management.register":
		return ok(map[string]any{"routes": []map[string]string{{"Method": "GET", "Path": snapshotPath}}, "resources": []map[string]string{{"Path": "/quota", "Menu": "Xiaomi Token Plan", "Description": "Singapore Credits, freshness, session and renewal guidance (management authentication required)."}}})
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

const detailsTail = "Details: Plugins → Xiaomi Token Plan."

// Single-line quota.fetch guidance from validated snapshot fields only. Sentences keep their order;
// any that would push the message past 400 bytes (including the fixed tail) is skipped.
func message(parts ...string) string {
	out := ""
	for _, part := range parts {
		if part != "" && len(out)+len(part)+1+len(detailsTail) <= 400 {
			out += part + " "
		}
	}
	return out + detailsTail
}

// Validated timestamp, normalized to second-precision UTC to save message space.
func utc(s string) string {
	t, _ := time.Parse(time.RFC3339Nano, s)
	return t.UTC().Format("2006-01-02T15:04:05Z")
}
func opt(prefix string, s *string, suffix string) string {
	if s == nil {
		return ""
	}
	return prefix + utc(*s) + suffix
}
func deref(s *string) string {
	if s == nil {
		return ""
	}
	return *s
}
func explain(s snapshot, now time.Time) string {
	last := "No quota fetched yet."
	if s.FetchedAt != nil {
		last = "Last good quota: " + utc(*s.FetchedAt) + "."
	}
	var attempt, next *string
	if s.Session != nil {
		attempt, next = s.Session.LastAttemptAt, s.Session.NextAttemptAt
	}
	switch {
	case s.Error != nil && *s.Error == "auth_required":
		return explainSession(s, now, last)
	case s.Error != nil && *s.Error == "schema_changed":
		return message("Xiaomi's console API changed: the collector rejected an unexpected response"+opt(" at ", attempt, "")+".", "Quota stays unavailable until the collector code is updated; check the plugin repository for a release.", last)
	case s.Error != nil:
		return message("The collector could not reach Xiaomi (or got a non-auth error) on its last attempt"+opt(" at ", attempt, "")+"; it retries every 5 min"+opt(", next ~", next, "")+".", last, "If this persists, check the collector's outbound network.")
	case s.Expired != nil && *s.Expired:
		head := "Xiaomi reports the Token Plan subscription as expired" + opt(" (listed expiry ", s.ExpiresAt, ")") + "."
		if at, err := time.Parse(time.RFC3339Nano, deref(s.ExpiresAt)); err == nil && !now.Before(at) {
			head = "Xiaomi Token Plan subscription expired at " + utc(*s.ExpiresAt) + "."
		}
		return message(head, "Renew it in the Xiaomi console (platform.xiaomimimo.com); quota returns on the collector's next poll (every 5 min).", last)
	default:
		return message("No completed collector poll in over 10 min.", last, "Check that the collector is running (it polls Xiaomi every 5 min) and that its clock matches CPA's.")
	}
}
func explainSession(s snapshot, now time.Time, last string) string {
	v := s.Session
	if v == nil {
		return message("Xiaomi rejected the collector session or the collector cannot read its session file (~24 h lifetime).", "Replace the session file with fresh cookies from a browser signed in to the Xiaomi console, then restart this pre-0.3.0 collector: it stops polling after a rejection.", last)
	}
	head, fix := "Xiaomi rejected the collector session"+opt(" at ", v.RejectedAt, "")+" (~24 h lifetime).", ""
	switch v.State {
	case "missing":
		head, fix = "The collector's Xiaomi session file is missing"+opt(" (since ", v.RejectedAt, ")")+".", "It must be an owner-only regular file holding one Cookie header line."
	case "invalid_file":
		head, fix = "The collector cannot use its Xiaomi session file"+opt(" (since ", v.RejectedAt, ")")+".", "It must be an owner-only regular file (no symlink) owned by the collector user, holding one Cookie header line."
	}
	agent, run := renewalAdvice(v, s.Renewal, now)
	return message(head, fix, agent, run, "The collector resumes within seconds of a new session file.", last)
}
func renewalAdvice(v *sessionInfo, r *renewalInfo, now time.Time) (string, string) {
	if r == nil {
		return "No renewal agent reports: run refresher/refresh-session.ts where a browser is signed in to the Xiaomi console, or replace the session file.", ""
	}
	checked, _ := time.Parse(time.RFC3339Nano, r.CheckedAt)
	on, at, run := "Renewal agent on "+r.Host, utc(r.CheckedAt), ""
	if r.ManualCommand != nil {
		run = "Run on " + r.Host + ": `" + *r.ManualCommand + "`."
	}
	if now.Sub(checked) > 15*time.Minute {
		return on + " last reported at " + at + " (" + r.Result + "): host likely asleep or its timer stopped.", run
	}
	if v.RejectedAt != nil {
		if rejected, _ := time.Parse(time.RFC3339Nano, *v.RejectedAt); checked.Before(rejected) {
			return on + " last checked at " + at + ", before the rejection; its next run should renew the session.", run
		}
	}
	switch r.Result {
	case "renewed":
		if r.RenewedAt != nil {
			at = utc(*r.RenewedAt)
		}
		return on + " installed a new session at " + at + "; waiting for the collector to pick it up.", ""
	case "signin_required":
		return on + " (" + at + "): browser not signed in to Xiaomi; sign in at the Xiaomi console there, then rerun the refresher.", run
	case "browser_unavailable":
		return on + " (" + at + "): renewal browser is not running; start it, then rerun the refresher.", run
	case "vendor_unavailable":
		return on + " (" + at + ") could not reach Xiaomi; it retries on its next run.", run
	case "not_needed":
		return on + " (" + at + ") found its browser session healthy; rerun the refresher with --force.", run
	default:
		return on + " (" + at + ") failed unexpectedly; check its output, then rerun the refresher.", run
	}
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
