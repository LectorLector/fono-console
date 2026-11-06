package main

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func do(h http.Handler, method, url, body string) *httptest.ResponseRecorder {
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(method, url, strings.NewReader(body)))
	return rec
}

func TestSafeJoin(t *testing.T) {
	base := t.TempDir()
	for _, bad := range []string{"", "..", "../x", "a/../../x", "/etc/passwd", `..\x`} {
		if _, err := safeJoin(base, bad); err == nil {
			t.Errorf("safeJoin accepted %q", bad)
		}
	}
	p, err := safeJoin(base, "ir/fl.wav")
	if err != nil || !strings.HasPrefix(p, base) {
		t.Errorf("good path rejected: %v %v", p, err)
	}
}

func TestStateRoundTrip(t *testing.T) {
	_, h := newTestApp(t)
	if r := do(h, "GET", "/api/state", ""); r.Code != 200 || strings.TrimSpace(r.Body.String()) != "{}" {
		t.Fatalf("empty state: %d %q", r.Code, r.Body)
	}
	if r := do(h, "POST", "/api/state", "{not json"); r.Code != 400 {
		t.Errorf("bad json accepted: %d", r.Code)
	}
	if r := do(h, "POST", "/api/state", `{"v":1,"名":"x"}`); r.Code != 200 {
		t.Fatal("post", r.Code)
	}
	if r := do(h, "GET", "/api/state", ""); !strings.Contains(r.Body.String(), `"v":1`) {
		t.Errorf("state not persisted: %s", r.Body)
	}
}

func TestEapoConsoleAndFile(t *testing.T) {
	a, h := newTestApp(t)
	r := do(h, "POST", "/api/eapo/console?ensure=1", "Preamp: -3 dB\nFilter: ON PK Fc 100 Hz Gain 1 dB Q 1\n")
	if r.Code != 200 || !strings.Contains(r.Body.String(), `"includeAdded":true`) {
		t.Fatalf("console: %d %s", r.Code, r.Body)
	}
	b, _ := os.ReadFile(filepath.Join(a.eapoDir, "fono_console.txt"))
	if !strings.Contains(string(b), "\r\n") || strings.Contains(strings.ReplaceAll(string(b), "\r\n", ""), "\n") {
		t.Errorf("line endings not CRLF: %q", b)
	}
	cfg, _ := os.ReadFile(filepath.Join(a.eapoDir, "config.txt"))
	if strings.Count(string(cfg), includeLine) != 1 {
		t.Errorf("config.txt: %q", cfg)
	}
	do(h, "POST", "/api/eapo/console?ensure=1", "Preamp: -3 dB\n")
	cfg, _ = os.ReadFile(filepath.Join(a.eapoDir, "config.txt"))
	if strings.Count(string(cfg), includeLine) != 1 {
		t.Errorf("Include duplicated: %q", cfg)
	}
	if r := do(h, "POST", "/api/eapo/file?name=..%2Fx.txt", "x"); r.Code != 400 {
		t.Errorf("file traversal: %d", r.Code)
	}
	if r := do(h, "POST", "/api/eapo/file?name=ir_test.wav", "abc"); r.Code != 200 {
		t.Errorf("file write: %d", r.Code)
	}
}

func TestIncludeStatus(t *testing.T) {
	d := t.TempDir()
	if e, i, _ := includeStatus(d); e || i {
		t.Error("missing config")
	}
	os.WriteFile(filepath.Join(d, "config.txt"), []byte("\ufeff  Include:   fono_console.txt \r\n"), 0o644)
	if _, i, _ := includeStatus(d); !i {
		t.Error("tolerant include detection failed")
	}
}

func TestCustomIR(t *testing.T) {
	_, h := newTestApp(t)
	if r := do(h, "GET", "/api/custom-ir", ""); r.Code != 404 {
		t.Error("expected 404")
	}
	do(h, "POST", "/api/custom-ir", "abc")
	if r := do(h, "GET", "/api/custom-ir", ""); r.Body.String() != "abc" {
		t.Error("IR round trip")
	}
}

func TestStaticAndGuide(t *testing.T) {
	_, h := newTestApp(t)
	for _, u := range []string{"/", "/js/app.js", "/style.css", "/wall/index.json", "/i18n/en.json", "/guide/"} {
		if r := do(h, "GET", u, ""); r.Code != 200 {
			t.Errorf("%s -> %d", u, r.Code)
		}
	}
}
