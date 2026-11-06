package main

// Music services and online data: Spotify Web API (PKCE), YouTube Music desktop
// API (pear-desktop api-server), public YouTube Music browse, AutoEq results.

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var netClient = &http.Client{Timeout: 25 * time.Second}

// ---------------------------------------------------------------- Spotify

type spotifyCfg struct {
	ClientID     string `json:"clientId"`
	RedirectURI  string `json:"redirectUri"`
	AccessToken  string `json:"accessToken,omitempty"`
	RefreshToken string `json:"refreshToken,omitempty"`
	Expiry       int64  `json:"expiry,omitempty"`
}

type spotify struct {
	mu       sync.Mutex
	path     string
	verifier string
	state    string
}

func (s *spotify) load() spotifyCfg {
	var c spotifyCfg
	b, _ := os.ReadFile(s.path)
	json.Unmarshal(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), &c)
	if c.RedirectURI == "" {
		c.RedirectURI = "http://" + listenAddr + "/api/spotify/callback"
	}
	return c
}

func (s *spotify) save(c spotifyCfg) {
	b, _ := json.MarshalIndent(c, "", "  ")
	os.WriteFile(s.path, b, 0o600)
}

func randString(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return base64.RawURLEncoding.EncodeToString(b)
}

const spotifyScopes = "user-read-playback-state user-modify-playback-state user-read-currently-playing playlist-read-private playlist-read-collaborative user-library-read"

func (s *spotify) tokenRequest(form url.Values) (spotifyCfg, error) {
	c := s.load()
	form.Set("client_id", c.ClientID)
	resp, err := netClient.PostForm("https://accounts.spotify.com/api/token", form)
	if err != nil {
		return c, err
	}
	defer resp.Body.Close()
	var t struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		Desc         string `json:"error_description"`
	}
	json.NewDecoder(resp.Body).Decode(&t)
	if t.AccessToken == "" {
		return c, fmt.Errorf("spotify token: %s %s", t.Error, t.Desc)
	}
	c.AccessToken = t.AccessToken
	if t.RefreshToken != "" {
		c.RefreshToken = t.RefreshToken
	}
	c.Expiry = time.Now().Unix() + t.ExpiresIn - 60
	s.save(c)
	return c, nil
}

func (s *spotify) token() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.load()
	if c.AccessToken != "" && time.Now().Unix() < c.Expiry {
		return c.AccessToken, nil
	}
	if c.RefreshToken == "" {
		return "", errors.New("not-connected")
	}
	c, err := s.tokenRequest(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {c.RefreshToken}})
	if err != nil {
		return "", err
	}
	return c.AccessToken, nil
}

func (a *app) spotifyRoutes(mux *http.ServeMux) {
	sp := &spotify{path: filepath.Join(a.dataDir, "spotify.json")}
	mux.HandleFunc("/api/spotify/status", func(w http.ResponseWriter, r *http.Request) {
		c := sp.load()
		mock := os.Getenv("FONO_SPOTIFY_API") != ""
		writeJSON(w, 200, map[string]any{"configured": c.ClientID != "" || mock, "connected": c.RefreshToken != "" || mock, "redirectUri": c.RedirectURI})
	})
	mux.HandleFunc("/api/spotify/config", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ ClientID string }
		json.NewDecoder(r.Body).Decode(&req)
		id := strings.TrimSpace(req.ClientID)
		if len(id) != 32 {
			errJSON(w, 400, "bad-client-id", nil)
			return
		}
		c := sp.load()
		if c.ClientID != id {
			c = spotifyCfg{ClientID: id, RedirectURI: c.RedirectURI}
		}
		sp.save(c)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/spotify/login", func(w http.ResponseWriter, r *http.Request) {
		c := sp.load()
		if c.ClientID == "" {
			http.Error(w, "Spotify Client ID not set", 400)
			return
		}
		sp.mu.Lock()
		sp.verifier = randString(48)
		sp.state = randString(12)
		sum := sha256.Sum256([]byte(sp.verifier))
		q := url.Values{
			"client_id": {c.ClientID}, "response_type": {"code"}, "redirect_uri": {c.RedirectURI},
			"code_challenge_method": {"S256"}, "code_challenge": {base64.RawURLEncoding.EncodeToString(sum[:])},
			"state": {sp.state}, "scope": {spotifyScopes},
		}
		sp.mu.Unlock()
		http.Redirect(w, r, "https://accounts.spotify.com/authorize?"+q.Encode(), http.StatusFound)
	})
	mux.HandleFunc("/api/spotify/callback", func(w http.ResponseWriter, r *http.Request) {
		sp.mu.Lock()
		ver, st := sp.verifier, sp.state
		sp.mu.Unlock()
		msg := "已連接 Spotify"
		if e := r.URL.Query().Get("error"); e != "" {
			msg = "Spotify 授權被取消：" + e
		} else if r.URL.Query().Get("state") != st || ver == "" {
			msg = "授權狀態不符，請重新連接"
		} else if _, err := sp.tokenRequest(url.Values{"grant_type": {"authorization_code"}, "code": {r.URL.Query().Get("code")}, "redirect_uri": {sp.load().RedirectURI}, "code_verifier": {ver}}); err != nil {
			msg = "Spotify 連接失敗：" + err.Error()
		}
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		fmt.Fprintf(w, `<!doctype html><meta charset="utf-8"><body style="font-family:sans-serif;background:#141110;color:#eadfce;display:grid;place-items:center;height:100vh"><div>%s，正在返回 Fono Console…</div><script>setTimeout(()=>location.href='/#library',900)</script>`, msg)
	})
	mux.HandleFunc("/api/spotify/logout", func(w http.ResponseWriter, r *http.Request) {
		c := sp.load()
		sp.save(spotifyCfg{ClientID: c.ClientID, RedirectURI: c.RedirectURI})
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/spotify/api/", func(w http.ResponseWriter, r *http.Request) {
		base, tok := os.Getenv("FONO_SPOTIFY_API"), "mock"
		if base == "" {
			base = "https://api.spotify.com/v1/"
			var err error
			if tok, err = sp.token(); err != nil {
				errJSON(w, 401, "spotify-auth", err)
				return
			}
		}
		target := base + strings.TrimPrefix(r.URL.Path, "/api/spotify/api/")
		if r.URL.RawQuery != "" {
			target += "?" + r.URL.RawQuery
		}
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		req, _ := http.NewRequestWithContext(r.Context(), r.Method, target, bytes.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+tok)
		if len(body) > 0 {
			req.Header.Set("Content-Type", "application/json")
		}
		resp, err := netClient.Do(req)
		if err != nil {
			errJSON(w, 502, "spotify-unreachable", err)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", resp.Header.Get("Content-Type"))
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
}

// ---------------------------------------------------------------- YouTube Music desktop

type ytmClient struct {
	mu    sync.Mutex
	path  string
	token string
}

const ytmBase = "http://127.0.0.1:26538"

func (y *ytmClient) getToken(force bool) (string, error) {
	y.mu.Lock()
	defer y.mu.Unlock()
	if y.token == "" && !force {
		var t struct{ AccessToken string }
		b, _ := os.ReadFile(y.path)
		json.Unmarshal(bytes.TrimPrefix(b, []byte("\xef\xbb\xbf")), &t)
		y.token = t.AccessToken
	}
	if y.token != "" && !force {
		return y.token, nil
	}
	// AUTH_AT_FIRST: the first request asks the user inside YouTube Music;
	// once allowed, this client id is remembered there.
	c := &http.Client{Timeout: 90 * time.Second, Transport: &http.Transport{Proxy: nil}}
	resp, err := c.Post(ytmBase+"/auth/fono-console", "application/json", nil)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	var t struct{ AccessToken string }
	json.NewDecoder(resp.Body).Decode(&t)
	if t.AccessToken == "" {
		return "", errors.New("auth-denied")
	}
	y.token = t.AccessToken
	b, _ := json.Marshal(map[string]string{"accessToken": t.AccessToken})
	os.WriteFile(y.path, b, 0o600)
	return y.token, nil
}

var localClient = &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}}

func (a *app) ytmRoutes(mux *http.ServeMux) {
	y := &ytmClient{path: filepath.Join(a.dataDir, "ytm-token.json")}
	mux.HandleFunc("/api/ytm/status", func(w http.ResponseWriter, r *http.Request) {
		resp, err := localClient.Get(ytmBase + "/doc")
		ok := err == nil && resp.StatusCode == 200
		if resp != nil {
			resp.Body.Close()
		}
		writeJSON(w, 200, map[string]any{"running": ok, "installed": ytmExe() != "" || ok})
	})
	mux.HandleFunc("/api/ytm/api/", func(w http.ResponseWriter, r *http.Request) {
		path := "/api/v1/" + strings.TrimPrefix(r.URL.Path, "/api/ytm/api/")
		body, _ := io.ReadAll(io.LimitReader(r.Body, 1<<20))
		do := func(force bool) (*http.Response, error) {
			tok, err := y.getToken(force)
			if err != nil {
				return nil, err
			}
			req, _ := http.NewRequestWithContext(r.Context(), r.Method, ytmBase+path, bytes.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+tok)
			if len(body) > 0 {
				req.Header.Set("Content-Type", "application/json")
			}
			return localClient.Do(req)
		}
		resp, err := do(false)
		if err == nil && (resp.StatusCode == 401 || resp.StatusCode == 403) {
			resp.Body.Close()
			resp, err = do(true)
		}
		if err != nil {
			errJSON(w, 502, "ytm-unreachable", err)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
	// Public album / playlist pages (no login needed).
	mux.HandleFunc("/api/ytm/browse", func(w http.ResponseWriter, r *http.Request) {
		id := r.URL.Query().Get("id")
		if id == "" || len(id) > 80 || strings.ContainsAny(id, "\"\\") {
			errJSON(w, 400, "bad-id", nil)
			return
		}
		payload := `{"context":{"client":{"clientName":"WEB_REMIX","clientVersion":"1.20251015.03.00","hl":"zh-TW","gl":"TW"}},"browseId":"` + id + `"}`
		browseURL := "https://music.youtube.com/youtubei/v1/browse?prettyPrint=false"
		if b := os.Getenv("FONO_YTM_BROWSE"); b != "" {
			browseURL = b
		}
		req, _ := http.NewRequestWithContext(r.Context(), "POST", browseURL, strings.NewReader(payload))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Origin", "https://music.youtube.com")
		req.Header.Set("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
		resp, err := netClient.Do(req)
		if err != nil {
			errJSON(w, 502, "ytm-browse", err)
			return
		}
		defer resp.Body.Close()
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(resp.StatusCode)
		io.Copy(w, resp.Body)
	})
}

// ---------------------------------------------------------------- AutoEq

func (a *app) autoeqRoutes(mux *http.ServeMux) {
	cache := filepath.Join(a.dataDir, "autoeq")
	os.MkdirAll(cache, 0o755)
	fetch := func(rel string, maxAge time.Duration) ([]byte, error) {
		name := strings.NewReplacer("/", "_", "\\", "_", ":", "_").Replace(rel)
		if len(name) > 180 {
			sum := sha256.Sum256([]byte(rel))
			name = fmt.Sprintf("%x", sum[:12])
		}
		cp := filepath.Join(cache, name)
		if st, err := os.Stat(cp); err == nil && time.Since(st.ModTime()) < maxAge {
			return os.ReadFile(cp)
		}
		u := "https://raw.githubusercontent.com/jaakkopasanen/AutoEq/master/results/" + rel
		resp, err := netClient.Get(u)
		if err != nil {
			if b, e2 := os.ReadFile(cp); e2 == nil {
				return b, nil
			}
			return nil, err
		}
		defer resp.Body.Close()
		if resp.StatusCode != 200 {
			return nil, fmt.Errorf("autoeq %d", resp.StatusCode)
		}
		b, err := io.ReadAll(io.LimitReader(resp.Body, 8<<20))
		if err == nil {
			os.WriteFile(cp, b, 0o644)
		}
		return b, err
	}
	mux.HandleFunc("/api/autoeq/index", func(w http.ResponseWriter, r *http.Request) {
		b, err := fetch("INDEX.md", 7*24*time.Hour)
		if err != nil {
			errJSON(w, 502, "autoeq", err)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(b)
	})
	mux.HandleFunc("/api/autoeq/file", func(w http.ResponseWriter, r *http.Request) {
		rel := r.URL.Query().Get("path")
		if rel == "" || strings.Contains(rel, "..") || strings.HasPrefix(rel, "/") {
			errJSON(w, 400, "bad-path", nil)
			return
		}
		parts := strings.Split(rel, "/")
		for i, p := range parts {
			parts[i] = url.PathEscape(p)
		}
		b, err := fetch(strings.Join(parts, "/"), 30*24*time.Hour)
		if err != nil {
			errJSON(w, 502, "autoeq", err)
			return
		}
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.Write(b)
	})
}

// ---------------------------------------------------------------- misc system actions

func (a *app) systemRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/launch", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ App string }
		json.NewDecoder(r.Body).Decode(&req)
		if err := launchApp(req.App); err != nil {
			errJSON(w, 500, "launch-failed", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/bt/hfp", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			ID     string
			Enable bool
		}
		json.NewDecoder(r.Body).Decode(&req)
		if !strings.HasPrefix(strings.ToUpper(req.ID), "BTHENUM\\") && !strings.HasPrefix(strings.ToUpper(req.ID), "BTHHFENUM\\") {
			errJSON(w, 400, "bad-id", nil)
			return
		}
		if err := setPnpEnabled(req.ID, req.Enable); err != nil {
			errJSON(w, 500, "pnp-failed", err)
			return
		}
		a.bridge.Send(map[string]any{"c": "bt"})
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/eapo/selector", func(w http.ResponseWriter, r *http.Request) {
		if err := launchDeviceSelector(); err != nil {
			errJSON(w, 500, "launch-failed", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
}
