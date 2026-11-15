package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestCompareSemver(t *testing.T) {
	cases := []struct {
		a, b string
		want int
		ok   bool
	}{
		{"2.11.0", "2.11.0", 0, true}, {"v2.12.0", "2.11.0", 1, true}, {"2.9.0", "2.11.0", -1, true},
		{"2.11.1", "2.11", 1, true}, {"3", "2.99.99", 1, true}, {"2.11.0-beta.1", "2.11.0", -1, true},
		{"2.11.0+build5", "2.11.0", 0, true}, {"latest", "2.11.0", 0, false}, {"1.2.3.4", "1.0.0", 0, false},
	}
	for _, c := range cases {
		got, ok := compareSemver(c.a, c.b)
		if got != c.want || ok != c.ok {
			t.Errorf("compare(%q,%q) = %d,%v want %d,%v", c.a, c.b, got, ok, c.want, c.ok)
		}
	}
}

func TestTrimNotes(t *testing.T) {
	long := strings.Repeat("line of notes\n", 300)
	got := trimNotes(long, 100)
	if len([]rune(got)) > 110 || !strings.HasSuffix(got, "…") {
		t.Errorf("not trimmed: %d runes", len([]rune(got)))
	}
	if trimNotes("a\r\nb", 100) != "a\nb" {
		t.Error("CRLF not normalised")
	}
}

func releaseServer(t *testing.T, tag string, hits *int32, ua *string) *httptest.Server {
	t.Helper()
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		atomic.AddInt32(hits, 1)
		*ua = r.Header.Get("User-Agent")
		if r.URL.Path != "/repos/LectorLector/fono-console/releases/latest" {
			http.NotFound(w, r)
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"tag_name": tag, "html_url": "https://github.com/LectorLector/fono-console/releases/tag/" + tag, "body": "## Changes\r\n- one\r\n- two"})
	}))
}

func TestUpdateCheckCacheAndForce(t *testing.T) {
	var hits int32
	var ua string
	srv := releaseServer(t, "v99.0.0", &hits, &ua)
	defer srv.Close()
	a, _ := newTestApp(t)
	a.updateBase = srv.URL
	h := a.routes()

	r := do(h, "GET", "/api/update/check", "")
	if r.Code != 200 {
		t.Fatalf("check: %d %s", r.Code, r.Body)
	}
	var res updateResult
	json.Unmarshal(r.Body.Bytes(), &res)
	if res.Latest != "99.0.0" || res.Current != appVersion || !res.Newer || !strings.HasPrefix(res.URL, "https://github.com/") || strings.Contains(res.Notes, "\r") {
		t.Errorf("bad result %+v", res)
	}
	if ua != "FonoConsole/"+appVersion {
		t.Errorf("User-Agent %q", ua)
	}
	do(h, "GET", "/api/update/check", "")
	if hits != 1 {
		t.Errorf("second call within 24h hit the network (%d)", hits)
	}
	do(h, "GET", "/api/update/check?force=1", "")
	if hits != 2 {
		t.Errorf("force did not hit the network (%d)", hits)
	}
	// expired cache -> network again
	old := updateCache{Checked: time.Now().Add(-25 * time.Hour).Unix(), Latest: "v1.0.0", URL: releasesPageFallb}
	b, _ := json.Marshal(old)
	os.WriteFile(filepath.Join(a.dataDir, updateCacheFile), b, 0o644)
	r = do(h, "GET", "/api/update/check", "")
	if hits != 3 || !strings.Contains(r.Body.String(), `"latest":"99.0.0"`) {
		t.Errorf("expired cache not refreshed: hits=%d %s", hits, r.Body)
	}
}

func TestUpdateCheckNotNewerAndOffline(t *testing.T) {
	var hits int32
	var ua string
	srv := releaseServer(t, "v"+appVersion, &hits, &ua)
	a, _ := newTestApp(t)
	a.updateBase = srv.URL
	h := a.routes()
	if r := do(h, "GET", "/api/update/check?force=1", ""); !strings.Contains(r.Body.String(), `"newer":false`) {
		t.Errorf("same version reported newer: %s", r.Body)
	}
	srv.Close() // offline: cached answer comes back flagged stale
	r := do(h, "GET", "/api/update/check?force=1", "")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"stale":true`) {
		t.Errorf("offline with cache: %d %s", r.Code, r.Body)
	}
	b, _ := newTestApp(t)
	b.updateBase = srv.URL
	if r := do(b.routes(), "GET", "/api/update/check", ""); r.Code != 502 {
		t.Errorf("offline without cache: %d", r.Code)
	}
}

func TestUpdateCheckBadResponses(t *testing.T) {
	for name, body := range map[string]string{"junk": "not json", "no tag": `{"tag_name":""}`, "bad tag": `{"tag_name":"nightly"}`} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(body)) }))
		a, _ := newTestApp(t)
		a.updateBase = srv.URL
		if r := do(a.routes(), "GET", "/api/update/check", ""); r.Code != 502 {
			t.Errorf("%s: %d", name, r.Code)
		}
		srv.Close()
	}
	// a release page outside github.com is not passed on
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"tag_name":"v99.1.0","html_url":"https://evil.example/x","body":""}`))
	}))
	defer srv.Close()
	a, _ := newTestApp(t)
	a.updateBase = srv.URL
	if r := do(a.routes(), "GET", "/api/update/check", ""); !strings.Contains(r.Body.String(), releasesPageFallb) {
		t.Errorf("foreign URL passed through: %s", r.Body)
	}
}

func TestUpdateDemoCanned(t *testing.T) {
	_, h := newTestApp(t) // demo = true, no base URL -> no network
	r := do(h, "GET", "/api/update/check", "")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"demo":true`) || !strings.Contains(r.Body.String(), `"newer":true`) {
		t.Errorf("demo: %d %s", r.Code, r.Body)
	}
}

func TestLogRing(t *testing.T) {
	l := newLogRing(500)
	for i := 0; i < 700; i++ {
		l.Write([]byte("line " + strings.Repeat("x", i%3) + "\n"))
	}
	l.Write([]byte("partial"))
	got := l.Last(0)
	if len(got) != 500 {
		t.Errorf("ring holds %d lines", len(got))
	}
	l.Write([]byte(" done\n"))
	if last := l.Last(1)[0]; last != "partial done" {
		t.Errorf("split write: %q", last)
	}
	_, h := newTestApp(t)
	serverLog.Write([]byte("hello-from-test\n"))
	if r := do(h, "GET", "/api/log", ""); !strings.Contains(r.Body.String(), "hello-from-test") {
		t.Errorf("/api/log: %s", r.Body)
	}
}

func TestBackupNeverContainsSecrets(t *testing.T) {
	a, h := newTestApp(t)
	// Spotify credentials live server-side in spotify.json
	sp := `{"clientId":"0123456789abcdef0123456789abcdef","accessToken":"ACCESS-SECRET-1","refreshToken":"REFRESH-SECRET-2","expiry":1}`
	os.WriteFile(filepath.Join(a.dataDir, "spotify.json"), []byte(sp), 0o600)
	// even if a client ever saved something credential-shaped into settings.json it must not come out
	state := `{"v":1,"fx":{"on":true},"ui":{"lang":"en","spotify":{"accessToken":"LEAK-A","client_secret":"LEAK-B"},"list":[{"apiKey":"LEAK-C","name":"x"}]},"authToken":"LEAK-D"}`
	do(h, "POST", "/api/state", state)
	r := do(h, "GET", "/api/backup", "")
	if r.Code != 200 {
		t.Fatalf("backup: %d", r.Code)
	}
	body := r.Body.String()
	for _, s := range []string{"ACCESS-SECRET-1", "REFRESH-SECRET-2", "LEAK-A", "LEAK-B", "LEAK-C", "LEAK-D", "0123456789abcdef", "accessToken", "refreshToken"} {
		if strings.Contains(body, s) {
			t.Errorf("backup contains %q", s)
		}
	}
	var j struct {
		Kind          string
		BackupVersion int
		Settings      map[string]any
	}
	if err := json.Unmarshal(r.Body.Bytes(), &j); err != nil || j.Kind != "fono-backup" || j.BackupVersion != 1 || j.Settings["v"] == nil {
		t.Errorf("shape: %v %+v", err, j)
	}
	if !strings.Contains(body, `"name":"x"`) || !strings.Contains(body, `"lang":"en"`) {
		t.Errorf("ordinary settings were dropped: %s", body)
	}
}
