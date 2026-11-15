package main

// Update check (opt-in from the UI, no auto-download): asks the GitHub releases API for the latest release, compares
// versions with appVersion and caches the answer in the data dir for 24 hours. Also: the server log ring buffer
// (/api/log) and the sanitized settings backup (/api/backup) used by the bug-report bundle.

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

const (
	githubAPI         = "https://api.github.com"
	releasesRepo      = "LectorLector/fono-console"
	updateTTL         = 24 * time.Hour
	updateTimeout     = 5 * time.Second
	updateNotesMax    = 1200
	updateCacheFile   = "update_check.json"
	releasesPageFallb = "https://github.com/" + releasesRepo + "/releases"
)

type updateResult struct {
	Latest  string `json:"latest"`
	Current string `json:"current"`
	Newer   bool   `json:"newer"`
	URL     string `json:"url"`
	Notes   string `json:"notes"`
	Stale   bool   `json:"stale,omitempty"`   // network failed, this is the cached answer
	Demo    bool   `json:"demo,omitempty"`    // canned answer (demo mode)
	Checked int64  `json:"checked,omitempty"` // unix seconds of the last real check
}

type updateCache struct {
	Checked int64  `json:"checked"`
	Latest  string `json:"latest"`
	URL     string `json:"url"`
	Notes   string `json:"notes"`
}

var updateMu sync.Mutex

// parseSemver reads "v1.2.3", "1.2", "2.11.0-beta.1+build"; pre is "" for a release.
func parseSemver(s string) (nums [3]int, pre string, ok bool) {
	s = strings.TrimSpace(strings.TrimPrefix(strings.TrimPrefix(strings.TrimSpace(s), "v"), "V"))
	if i := strings.IndexByte(s, '+'); i >= 0 {
		s = s[:i]
	}
	if i := strings.IndexByte(s, '-'); i >= 0 {
		s, pre = s[:i], s[i+1:]
	}
	parts := strings.Split(s, ".")
	if s == "" || len(parts) > 3 {
		return nums, "", false
	}
	for i, p := range parts {
		n, err := strconv.Atoi(p)
		if err != nil || n < 0 {
			return nums, "", false
		}
		nums[i] = n
	}
	return nums, pre, true
}

// compareSemver returns -1, 0, 1 (a < b, equal, a > b); a pre-release sorts before its release. ok=false when either is unparsable.
func compareSemver(a, b string) (int, bool) {
	an, ap, aok := parseSemver(a)
	bn, bp, bok := parseSemver(b)
	if !aok || !bok {
		return 0, false
	}
	for i := 0; i < 3; i++ {
		if an[i] != bn[i] {
			if an[i] < bn[i] {
				return -1, true
			}
			return 1, true
		}
	}
	switch {
	case ap == bp:
		return 0, true
	case ap == "":
		return 1, true
	case bp == "":
		return -1, true
	case ap < bp:
		return -1, true
	}
	return 1, true
}

// trimNotes keeps release notes short and plain: CRLF -> LF, at most max runes, cut at a line end when possible.
func trimNotes(s string, max int) string {
	s = strings.TrimSpace(strings.ReplaceAll(s, "\r\n", "\n"))
	if utf8.RuneCountInString(s) <= max {
		return s
	}
	r := []rune(s)[:max]
	out := string(r)
	if i := strings.LastIndexByte(out, '\n'); i > max/2 {
		out = out[:i]
	}
	return strings.TrimSpace(out) + "\n…"
}

func (a *app) updateCachePath() string { return filepath.Join(a.dataDir, updateCacheFile) }

func (a *app) readUpdateCache() (updateCache, bool) {
	var c updateCache
	b, err := os.ReadFile(a.updateCachePath())
	if err != nil || json.Unmarshal(b, &c) != nil || c.Latest == "" {
		return c, false
	}
	return c, true
}

func (a *app) buildUpdateResult(c updateCache) updateResult {
	r := updateResult{Latest: strings.TrimPrefix(c.Latest, "v"), Current: appVersion, URL: c.URL, Notes: c.Notes, Checked: c.Checked}
	if cmp, ok := compareSemver(c.Latest, appVersion); ok && cmp > 0 {
		r.Newer = true
	}
	return r
}

// fetchLatestRelease asks GitHub (base is injectable for tests). Only the release page URL on github.com is passed on to the UI.
func (a *app) fetchLatestRelease(base string) (updateCache, error) {
	var c updateCache
	req, err := http.NewRequest("GET", strings.TrimRight(base, "/")+"/repos/"+releasesRepo+"/releases/latest", nil)
	if err != nil {
		return c, err
	}
	req.Header.Set("User-Agent", "FonoConsole/"+appVersion)
	req.Header.Set("Accept", "application/vnd.github+json")
	cl := &http.Client{Timeout: updateTimeout}
	resp, err := cl.Do(req)
	if err != nil {
		return c, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return c, fmt.Errorf("github: HTTP %d", resp.StatusCode)
	}
	var rel struct {
		Tag        string `json:"tag_name"`
		HTML       string `json:"html_url"`
		Body       string `json:"body"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&rel); err != nil {
		return c, err
	}
	if rel.Tag == "" {
		return c, errors.New("github: no tag_name")
	}
	if _, _, ok := parseSemver(rel.Tag); !ok {
		return c, errors.New("github: tag is not a version: " + rel.Tag)
	}
	u := rel.HTML
	if !strings.HasPrefix(u, "https://github.com/") {
		u = releasesPageFallb
	}
	return updateCache{Checked: time.Now().Unix(), Latest: rel.Tag, URL: u, Notes: trimNotes(rel.Body, updateNotesMax)}, nil
}

// handleUpdateCheck: GET /api/update/check[?force=1]
func (a *app) handleUpdateCheck(w http.ResponseWriter, r *http.Request) {
	force := r.URL.Query().Get("force") == "1"
	base := a.updateBase
	if base == "" {
		if a.demo {
			// demo / mock: a canned newer release so the banner can be seen; nothing leaves the machine
			n, _, _ := parseSemver(appVersion)
			writeJSON(w, 200, updateResult{Latest: fmt.Sprintf("%d.%d.0", n[0], n[1]+1), Current: appVersion, Newer: true, URL: releasesPageFallb, Notes: "- (demo) Example release notes\n- Update check, correction profiles, backup and bug-report bundle", Demo: true})
			return
		}
		base = githubAPI
	}
	updateMu.Lock()
	defer updateMu.Unlock()
	cached, have := a.readUpdateCache()
	if have && !force && time.Since(time.Unix(cached.Checked, 0)) < updateTTL && time.Unix(cached.Checked, 0).Before(time.Now().Add(time.Minute)) {
		writeJSON(w, 200, a.buildUpdateResult(cached))
		return
	}
	fresh, err := a.fetchLatestRelease(base)
	if err != nil {
		if have {
			res := a.buildUpdateResult(cached)
			res.Stale = true
			writeJSON(w, 200, res)
			return
		}
		errJSON(w, 502, "update-unreachable", err)
		return
	}
	if b, err := json.Marshal(fresh); err == nil {
		os.WriteFile(a.updateCachePath(), b, 0o644)
	}
	writeJSON(w, 200, a.buildUpdateResult(fresh))
}

// ---------------------------------------------------------------- server log ring buffer

type logRing struct {
	mu    sync.Mutex
	lines []string
	part  string
	max   int
}

func newLogRing(max int) *logRing { return &logRing{max: max} }

// Write implements io.Writer so it can sit behind log.SetOutput (io.MultiWriter with the log file).
func (l *logRing) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	s := l.part + string(p)
	parts := strings.Split(s, "\n")
	l.part = parts[len(parts)-1]
	for _, ln := range parts[:len(parts)-1] {
		ln = strings.TrimRight(ln, "\r")
		if len(ln) > 1000 {
			ln = ln[:1000] + "…"
		}
		l.lines = append(l.lines, ln)
	}
	if len(l.lines) > l.max {
		l.lines = append([]string(nil), l.lines[len(l.lines)-l.max:]...)
	}
	return len(p), nil
}

func (l *logRing) Last(n int) []string {
	l.mu.Lock()
	defer l.mu.Unlock()
	if n <= 0 || n > len(l.lines) {
		n = len(l.lines)
	}
	return append([]string(nil), l.lines[len(l.lines)-n:]...)
}

var serverLog = newLogRing(500)

// GET /api/log -> text/plain, the last 500 server log lines.
func (a *app) handleLog(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	fmt.Fprint(w, strings.Join(serverLog.Last(500), "\n"))
}

// ---------------------------------------------------------------- settings backup

var secretKey = regexp.MustCompile(`(?i)token|secret|password|passwd|authorization|api[_-]?key|refresh|credential`)

// stripSecrets removes every key that looks like a credential, at any depth.
func stripSecrets(v any) any {
	switch x := v.(type) {
	case map[string]any:
		out := make(map[string]any, len(x))
		for k, val := range x {
			if secretKey.MatchString(k) {
				continue
			}
			out[k] = stripSecrets(val)
		}
		return out
	case []any:
		out := make([]any, len(x))
		for i, val := range x {
			out[i] = stripSecrets(val)
		}
		return out
	}
	return v
}

const backupVersion = 1

// GET /api/backup: the saved settings without credentials. Spotify tokens live in spotify.json and are never read here.
func (a *app) handleBackup(w http.ResponseWriter, r *http.Request) {
	settings := map[string]any{}
	if b, err := os.ReadFile(a.statePath()); err == nil {
		json.Unmarshal(b, &settings)
	}
	writeJSON(w, 200, map[string]any{
		"kind":          "fono-backup",
		"backupVersion": backupVersion,
		"app":           appName,
		"appVersion":    appVersion,
		"created":       time.Now().UTC().Format(time.RFC3339),
		"settings":      stripSecrets(settings),
	})
}

func (a *app) updateRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/update/check", a.handleUpdateCheck)
	mux.HandleFunc("/api/log", a.handleLog)
	mux.HandleFunc("/api/backup", a.handleBackup)
}
