// Fono Console — local audio control desk.
// A tiny local server (127.0.0.1) that serves the UI, bridges Windows media
// sessions / Core Audio through PowerShell, writes Equalizer APO configs and
// proxies the REW API. The UI opens in an Edge/Chrome "app" window.
package main

import (
	"bufio"
	"bytes"
	"embed"
	"encoding/base64"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const (
	appName    = "Fono Console"
	appVersion = "2.9.4"
)

// listenAddr is fixed unless FONO_ADDR overrides it (used by tests/ui-sweep.mjs so it never attaches to a developer's running instance).
var listenAddr = func() string {
	if a := os.Getenv("FONO_ADDR"); a != "" {
		return a
	}
	return "127.0.0.1:47811"
}()

//go:embed web
var webFS embed.FS

//go:embed docs
var docsFS embed.FS

//go:embed assets/bridge.ps1
var bridgeScript []byte

//go:embed assets/icon.ico
var iconICO []byte

var (
	demoMode  = flag.Bool("demo", false, "run with simulated media/devices")
	noWindow  = flag.Bool("no-window", false, "do not open the UI window")
	doInstall = flag.Bool("install", false, "install to this computer")
	doUninst  = flag.Bool("uninstall", false, "remove from this computer")
	eapoDirFl = flag.String("eapo-dir", "", "override Equalizer APO config directory")
)

// ---------------------------------------------------------------- SSE hub

type hub struct {
	mu       sync.Mutex
	clients  map[chan []byte]struct{}
	cache    map[string][]byte // last message per type (media, devices, init)
	ever     bool
	lastZero time.Time
}

func newHub() *hub {
	return &hub{clients: map[chan []byte]struct{}{}, cache: map[string][]byte{}, lastZero: time.Now()}
}

func (h *hub) add() chan []byte {
	c := make(chan []byte, 64)
	h.mu.Lock()
	h.clients[c] = struct{}{}
	h.ever = true
	for _, m := range h.cache {
		select {
		case c <- m:
		default:
		}
	}
	h.mu.Unlock()
	return c
}

func (h *hub) remove(c chan []byte) {
	h.mu.Lock()
	delete(h.clients, c)
	if len(h.clients) == 0 {
		h.lastZero = time.Now()
	}
	h.mu.Unlock()
}

func (h *hub) broadcast(kind string, msg []byte, keep bool) {
	h.mu.Lock()
	if keep {
		h.cache[kind] = msg
	}
	for c := range h.clients {
		select {
		case c <- msg:
		default: // slow client: drop
		}
	}
	h.mu.Unlock()
}

func (h *hub) idleFor() time.Duration {
	h.mu.Lock()
	defer h.mu.Unlock()
	if len(h.clients) > 0 {
		return 0
	}
	return time.Since(h.lastZero)
}

// ---------------------------------------------------------------- app

type app struct {
	hub      *hub
	bridge   bridge
	artMu    sync.Mutex
	art      map[string]artItem
	artOrder []string
	eapoDir  string
	eapoMu   sync.Mutex
	dataDir  string
	demo     bool
}

type artItem struct {
	mime string
	data []byte
}

type bridge interface {
	Send(cmd map[string]any)
	Close()
}

func (a *app) onBridgeLine(line []byte) {
	line = bytes.TrimPrefix(bytes.TrimSpace(line), []byte("\xef\xbb\xbf"))
	if len(line) == 0 || line[0] != '{' {
		return
	}
	var head struct {
		T    string `json:"t"`
		Key  string `json:"key"`
		Mime string `json:"mime"`
		B64  string `json:"b64"`
		Cfg  string `json:"eapoConfig"`
	}
	if err := json.Unmarshal(line, &head); err != nil {
		return
	}
	switch head.T {
	case "art":
		data, err := base64.StdEncoding.DecodeString(head.B64)
		if err != nil || len(data) == 0 {
			return
		}
		a.artMu.Lock()
		if _, ok := a.art[head.Key]; !ok {
			a.artOrder = append(a.artOrder, head.Key)
			if len(a.artOrder) > 60 {
				delete(a.art, a.artOrder[0])
				a.artOrder = a.artOrder[1:]
			}
		}
		mime := head.Mime
		if mime == "" {
			mime = sniffMime(data)
		}
		a.art[head.Key] = artItem{mime: mime, data: data}
		a.artMu.Unlock()
		msg, _ := json.Marshal(map[string]string{"t": "art", "key": head.Key})
		a.hub.broadcast("art", msg, false)
	case "init":
		if head.Cfg != "" && *eapoDirFl == "" {
			a.eapoMu.Lock()
			a.eapoDir = head.Cfg
			a.eapoMu.Unlock()
		}
		a.hub.broadcast("init", line, true)
	case "media", "devices", "bt":
		a.hub.broadcast(head.T, line, true)
	default: // meter, log
		a.hub.broadcast(head.T, line, false)
	}
}

func sniffMime(b []byte) string {
	ct := http.DetectContentType(b)
	if strings.HasPrefix(ct, "image/") {
		return ct
	}
	return "image/jpeg"
}

func (a *app) configDir() string {
	a.eapoMu.Lock()
	defer a.eapoMu.Unlock()
	return a.eapoDir
}

// ---------------------------------------------------------------- helpers

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func errJSON(w http.ResponseWriter, code int, kind string, err error) {
	msg := ""
	if err != nil {
		msg = err.Error()
	}
	writeJSON(w, code, map[string]string{"error": kind, "detail": msg})
}

func isPerm(err error) bool {
	return errors.Is(err, fs.ErrPermission) || (err != nil && strings.Contains(strings.ToLower(err.Error()), "access is denied"))
}

// safeJoin keeps writes inside the EAPO config dir.
func safeJoin(base, rel string) (string, error) {
	rel = filepath.FromSlash(strings.ReplaceAll(rel, "\\", "/"))
	if rel == "" || filepath.IsAbs(rel) || strings.Contains(rel, "..") {
		return "", errors.New("bad path")
	}
	return filepath.Join(base, rel), nil
}

func dirWritable(dir string) bool {
	if dir == "" {
		return false
	}
	f, err := os.CreateTemp(dir, ".fono-probe-*")
	if err != nil {
		return false
	}
	name := f.Name()
	f.Close()
	os.Remove(name)
	return true
}

const includeLine = "Include: fono_console.txt"

func includeStatus(dir string) (exists bool, included bool, content string) {
	b, err := os.ReadFile(filepath.Join(dir, "config.txt"))
	if err != nil {
		return false, false, ""
	}
	content = string(b)
	for _, l := range strings.Split(content, "\n") {
		t := strings.TrimSpace(strings.TrimPrefix(l, "\ufeff"))
		if strings.EqualFold(strings.Join(strings.Fields(t), " "), includeLine) {
			return true, true, content
		}
	}
	return true, false, content
}

// ---------------------------------------------------------------- HTTP

func (a *app) routes() http.Handler {
	mux := http.NewServeMux()
	sub, _ := fs.Sub(webFS, "web")
	static := http.FileServer(http.FS(sub))
	mux.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-cache")
		if r.URL.Path == "/favicon.ico" {
			w.Header().Set("Content-Type", "image/x-icon")
			w.Write(iconICO)
			return
		}
		static.ServeHTTP(w, r)
	})

	docsSub, _ := fs.Sub(docsFS, "docs")
	mux.Handle("/guide/", http.StripPrefix("/guide/", http.FileServer(http.FS(docsSub))))
	mux.HandleFunc("/api/events", a.handleEvents)
	mux.HandleFunc("/api/system", a.handleSystem)
	mux.HandleFunc("/api/state", a.handleState)
	mux.HandleFunc("/api/media", func(w http.ResponseWriter, r *http.Request) {
		var cmd map[string]any
		if err := json.NewDecoder(r.Body).Decode(&cmd); err != nil {
			errJSON(w, 400, "bad-json", err)
			return
		}
		a.bridge.Send(cmd)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/art/", func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.URL.Path, "/api/art/")
		a.artMu.Lock()
		it, ok := a.art[key]
		a.artMu.Unlock()
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", it.mime)
		w.Header().Set("Cache-Control", "max-age=3600")
		w.Write(it.data)
	})
	mux.HandleFunc("/api/eapo/file", a.handleEapoFile)
	mux.HandleFunc("/api/eapo/console", a.handleEapoConsole)
	mux.HandleFunc("/api/eapo/takeover", a.handleEapoTakeover)
	mux.HandleFunc("/api/eapo/fixperm", func(w http.ResponseWriter, r *http.Request) {
		dir := a.configDir()
		if dir == "" {
			errJSON(w, 404, "no-eapo", nil)
			return
		}
		err := grantWrite(dir)
		if err != nil {
			errJSON(w, 500, "elevate-failed", err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "writable": dirWritable(dir)})
	})
	mux.HandleFunc("/api/custom-ir", func(w http.ResponseWriter, r *http.Request) {
		p := filepath.Join(a.dataDir, "custom_ir.bin")
		if r.Method == http.MethodPost {
			b, err := io.ReadAll(io.LimitReader(r.Body, 32<<20))
			if err != nil {
				errJSON(w, 400, "read", err)
				return
			}
			if err := os.WriteFile(p, b, 0o644); err != nil {
				errJSON(w, 500, "write-failed", err)
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		b, err := os.ReadFile(p)
		if err != nil {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/octet-stream")
		w.Write(b)
	})
	a.wallpaperRoutes(mux)
	a.spotifyRoutes(mux)
	a.ytmRoutes(mux)
	a.autoeqRoutes(mux)
	a.systemRoutes(mux)
	a.setupRoutes(mux)
	mux.HandleFunc("/api/rew/", a.handleRew)
	mux.HandleFunc("/api/rew-launch", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ Path string }
		json.NewDecoder(r.Body).Decode(&req)
		if err := launchREW(req.Path); err != nil {
			errJSON(w, 500, "launch-failed", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/open", func(w http.ResponseWriter, r *http.Request) {
		var req struct{ URL string }
		json.NewDecoder(r.Body).Decode(&req)
		u := req.URL
		if !(strings.HasPrefix(u, "https://") || strings.HasPrefix(u, "spotify:") || strings.HasPrefix(u, "ms-settings:")) {
			errJSON(w, 400, "bad-url", nil)
			return
		}
		openExternal(u)
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/open-folder", func(w http.ResponseWriter, r *http.Request) {
		openFolder(a.configDir())
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/install", func(w http.ResponseWriter, r *http.Request) {
		if err := installSelf(); err != nil {
			errJSON(w, 500, "install-failed", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/quit", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, 200, map[string]bool{"ok": true})
		go func() { time.Sleep(300 * time.Millisecond); a.bridge.Close(); os.Exit(0) }()
	})
	return mux
}

func (a *app) handleEvents(w http.ResponseWriter, r *http.Request) {
	fl, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "no stream", 500)
		return
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Connection", "keep-alive")
	c := a.hub.add()
	defer a.hub.remove(c)
	fmt.Fprint(w, ": hi\n\n")
	fl.Flush()
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case m := <-c:
			w.Write([]byte("data: "))
			w.Write(m)
			w.Write([]byte("\n\n"))
			fl.Flush()
		case <-ping.C:
			fmt.Fprint(w, ": ping\n\n")
			fl.Flush()
		}
	}
}

func (a *app) handleSystem(w http.ResponseWriter, r *http.Request) {
	dir := a.configDir()
	_, statErr := os.Stat(dir)
	exists, included, cfg := includeStatus(dir)
	writeJSON(w, 200, map[string]any{
		"version":     appVersion,
		"platform":    runtime.GOOS,
		"demo":        *demoMode || runtime.GOOS != "windows",
		"installed":   isInstalled(),
		"eapoDir":     dir,
		"eapoFound":   dir != "" && statErr == nil,
		"writable":    dirWritable(dir),
		"configFound": exists,
		"included":    included,
		"configTxt":   cfg,
	})
}

func (a *app) statePath() string { return filepath.Join(a.dataDir, "settings.json") }

func (a *app) handleState(w http.ResponseWriter, r *http.Request) {
	switch r.Method {
	case http.MethodGet:
		b, err := os.ReadFile(a.statePath())
		if err != nil {
			writeJSON(w, 200, map[string]any{})
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Cache-Control", "no-store")
		w.Write(b)
	case http.MethodPost:
		b, err := io.ReadAll(io.LimitReader(r.Body, 8<<20))
		if err != nil || !json.Valid(b) {
			errJSON(w, 400, "bad-json", err)
			return
		}
		tmp := a.statePath() + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			errJSON(w, 500, "write-failed", err)
			return
		}
		os.Rename(tmp, a.statePath())
		writeJSON(w, 200, map[string]bool{"ok": true})
	default:
		w.WriteHeader(405)
	}
}

// writeInPlace truncates and rewrites (no rename) — Equalizer APO watches the
// files and an atomic rename briefly makes them disappear.
func writeInPlace(path string, data []byte) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return err
	}
	if old, err := os.ReadFile(path); err == nil && bytes.Equal(old, data) {
		return nil
	}
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	return err
}

func (a *app) handleEapoFile(w http.ResponseWriter, r *http.Request) {
	dir := a.configDir()
	if dir == "" {
		errJSON(w, 404, "no-eapo", nil)
		return
	}
	p, err := safeJoin(dir, r.URL.Query().Get("name"))
	if err != nil {
		errJSON(w, 400, "bad-path", err)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 64<<20))
	if err != nil {
		errJSON(w, 400, "read", err)
		return
	}
	a.eapoMu.Lock()
	err = writeInPlace(p, b)
	a.eapoMu.Unlock()
	if err != nil {
		code := 500
		kind := "write-failed"
		if isPerm(err) {
			code, kind = 403, "permission"
		}
		errJSON(w, code, kind, err)
		return
	}
	writeJSON(w, 200, map[string]any{"ok": true, "bytes": len(b)})
}

func (a *app) handleEapoConsole(w http.ResponseWriter, r *http.Request) {
	dir := a.configDir()
	if dir == "" {
		errJSON(w, 404, "no-eapo", nil)
		return
	}
	b, err := io.ReadAll(io.LimitReader(r.Body, 4<<20))
	if err != nil {
		errJSON(w, 400, "read", err)
		return
	}
	text := strings.ReplaceAll(strings.ReplaceAll(string(b), "\r\n", "\n"), "\n", "\r\n")
	a.eapoMu.Lock()
	defer a.eapoMu.Unlock()
	if err := writeInPlace(filepath.Join(dir, "fono_console.txt"), []byte(text)); err != nil {
		if isPerm(err) {
			errJSON(w, 403, "permission", err)
		} else {
			errJSON(w, 500, "write-failed", err)
		}
		return
	}
	added := false
	if r.URL.Query().Get("ensure") == "1" {
		exists, included, content := includeStatus(dir)
		if !included {
			cfgPath := filepath.Join(dir, "config.txt")
			if exists {
				bk := filepath.Join(dir, "config.before-fono.txt")
				if _, err := os.Stat(bk); err != nil {
					os.WriteFile(bk, []byte(content), 0o644)
				}
			}
			nc := strings.TrimRight(content, "\r\n")
			if nc != "" {
				nc += "\r\n"
			}
			nc += includeLine + "\r\n"
			if err := writeInPlace(cfgPath, []byte(nc)); err != nil {
				errJSON(w, 403, "permission", err)
				return
			}
			added = true
		}
	}
	writeJSON(w, 200, map[string]any{"ok": true, "includeAdded": added})
}

func (a *app) handleEapoTakeover(w http.ResponseWriter, r *http.Request) {
	dir := a.configDir()
	if dir == "" {
		errJSON(w, 404, "no-eapo", nil)
		return
	}
	a.eapoMu.Lock()
	defer a.eapoMu.Unlock()
	cfgPath := filepath.Join(dir, "config.txt")
	if old, err := os.ReadFile(cfgPath); err == nil {
		stamp := time.Now().Format("20060102-150405")
		os.WriteFile(filepath.Join(dir, "config.backup-"+stamp+".txt"), old, 0o644)
	}
	body := "# Managed by Fono Console. Previous content was backed up as config.backup-*.txt\r\n" + includeLine + "\r\n"
	if err := writeInPlace(cfgPath, []byte(body)); err != nil {
		if isPerm(err) {
			errJSON(w, 403, "permission", err)
		} else {
			errJSON(w, 500, "write-failed", err)
		}
		return
	}
	writeJSON(w, 200, map[string]bool{"ok": true})
}

var rewClient = &http.Client{Timeout: 20 * time.Second, Transport: &http.Transport{Proxy: nil}}

func (a *app) handleRew(w http.ResponseWriter, r *http.Request) {
	port := r.Header.Get("X-Rew-Port")
	if port == "" {
		port = "4735"
	}
	for _, ch := range port {
		if ch < '0' || ch > '9' {
			errJSON(w, 400, "bad-port", nil)
			return
		}
	}
	path := strings.TrimPrefix(r.URL.Path, "/api/rew")
	target := "http://127.0.0.1:" + port + path
	if r.URL.RawQuery != "" {
		target += "?" + r.URL.RawQuery
	}
	req, err := http.NewRequestWithContext(r.Context(), r.Method, target, r.Body)
	if err != nil {
		errJSON(w, 400, "bad-request", err)
		return
	}
	if ct := r.Header.Get("Content-Type"); ct != "" {
		req.Header.Set("Content-Type", ct)
	}
	req.Header.Set("Accept", "application/json")
	resp, err := rewClient.Do(req)
	if err != nil {
		errJSON(w, 502, "rew-unreachable", err)
		return
	}
	defer resp.Body.Close()
	if ct := resp.Header.Get("Content-Type"); ct != "" {
		w.Header().Set("Content-Type", ct)
	}
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(resp.StatusCode)
	io.Copy(w, resp.Body)
}

// ---------------------------------------------------------------- main

func main() {
	flag.Parse()
	if *doInstall {
		if err := installSelf(); err != nil {
			fatalBox("安裝失敗：" + err.Error())
		}
		return
	}
	if *doUninst {
		if err := uninstallSelf(); err != nil {
			fatalBox("移除失敗：" + err.Error())
		}
		return
	}

	ln, err := net.Listen("tcp", listenAddr)
	if err != nil {
		// Already running: just bring up another window.
		if !*noWindow {
			openAppWindow("http://" + listenAddr + "/")
		}
		return
	}

	cfgDir, _ := os.UserConfigDir()
	dataDir := filepath.Join(cfgDir, "FonoConsole")
	os.MkdirAll(dataDir, 0o755)
	logf, _ := os.OpenFile(filepath.Join(dataDir, "fono.log"), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o644)
	if logf != nil {
		log.SetOutput(logf)
	}

	a := &app{hub: newHub(), art: map[string]artItem{}, dataDir: dataDir}
	a.demo = *demoMode || runtime.GOOS != "windows"
	a.eapoDir = defaultEapoDir()
	if *eapoDirFl != "" {
		a.eapoDir = *eapoDirFl
	}
	if *demoMode || runtime.GOOS != "windows" {
		a.bridge = startDemoBridge(a)
	} else {
		a.bridge = startPSBridge(a, dataDir)
	}

	srv := &http.Server{Handler: a.routes(), ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := srv.Serve(ln); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Println("serve:", err)
		}
	}()
	url := "http://" + listenAddr + "/"
	log.Println("listening", url)
	if !*noWindow {
		openAppWindow(url)
	}

	// Exit when the window has been closed for a while.
	if !*noWindow {
		start := time.Now()
		for {
			time.Sleep(3 * time.Second)
			a.hub.mu.Lock()
			ever := a.hub.ever
			a.hub.mu.Unlock()
			idle := a.hub.idleFor()
			if (ever && idle > 12*time.Second) || (!ever && time.Since(start) > 120*time.Second) {
				break
			}
		}
		a.bridge.Close()
		return
	}
	select {}
}

// lineReader feeds bridge stdout lines to the app (large lines allowed: album art).
func lineReader(r io.Reader, fn func([]byte)) {
	br := bufio.NewReaderSize(r, 1<<20)
	for {
		line, err := br.ReadBytes('\n')
		if len(line) > 0 {
			fn(line)
		}
		if err != nil {
			return
		}
	}
}
