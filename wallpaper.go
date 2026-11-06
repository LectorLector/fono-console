package main

// User wallpapers: stored in <data dir>/wallpapers, validated by magic bytes.

import (
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
)

const (
	wallMaxBytes = 8 << 20
	wallMaxFiles = 60
)

var wallNameOK = regexp.MustCompile(`^[\p{L}\p{N}_][\p{L}\p{N}_. -]{0,95}\.(png|jpg|webp|gif)$`)
var wallBad = regexp.MustCompile(`[^\p{L}\p{N}_ -]+`)

// wallSniff returns the file extension for allowed image types, or "".
func wallSniff(b []byte) string {
	switch {
	case len(b) >= 8 && string(b[:8]) == "\x89PNG\r\n\x1a\n":
		return ".png"
	case len(b) >= 3 && b[0] == 0xFF && b[1] == 0xD8 && b[2] == 0xFF:
		return ".jpg"
	case len(b) >= 6 && (string(b[:6]) == "GIF87a" || string(b[:6]) == "GIF89a"):
		return ".gif"
	case len(b) >= 12 && string(b[:4]) == "RIFF" && string(b[8:12]) == "WEBP":
		return ".webp"
	}
	return ""
}

var wallMime = map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif"}

// wallStem turns an uploaded file name into a safe stem (no path, no dots, no control characters).
func wallStem(name string) string {
	name = strings.ReplaceAll(name, "\\", "/")
	if i := strings.LastIndex(name, "/"); i >= 0 {
		name = name[i+1:]
	}
	if i := strings.LastIndex(name, "."); i > 0 {
		name = name[:i]
	}
	name = strings.TrimSpace(wallBad.ReplaceAllString(name, "_"))
	r := []rune(name)
	if len(r) > 48 {
		r = r[:48]
	}
	name = strings.Trim(string(r), " _-")
	if name == "" {
		name = "wallpaper"
	}
	return name
}

func (a *app) wallDir() string { return filepath.Join(a.dataDir, "wallpapers") }

// wallPath resolves a file name inside the wallpaper directory; ok is false for anything that is not a plain stored name.
func (a *app) wallPath(name string) (string, bool) {
	if !wallNameOK.MatchString(name) || name != filepath.Base(name) || strings.ContainsAny(name, `/\`) || strings.Contains(name, "..") {
		return "", false
	}
	dir := a.wallDir()
	p := filepath.Join(dir, name)
	if rel, err := filepath.Rel(dir, p); err != nil || strings.HasPrefix(rel, "..") || rel != name {
		return "", false
	}
	return p, true
}

func (a *app) wallpaperRoutes(mux *http.ServeMux) {
	mux.HandleFunc("/api/wallpaper", func(w http.ResponseWriter, r *http.Request) {
		switch r.Method {
		case http.MethodGet:
			out := []map[string]any{}
			ents, _ := os.ReadDir(a.wallDir())
			sort.Slice(ents, func(i, j int) bool { return ents[i].Name() < ents[j].Name() })
			for _, e := range ents {
				if _, ok := a.wallPath(e.Name()); !ok || e.IsDir() {
					continue
				}
				if fi, err := e.Info(); err == nil && fi.Mode().IsRegular() {
					out = append(out, map[string]any{"name": e.Name(), "size": fi.Size()})
				}
			}
			writeJSON(w, 200, out)
		case http.MethodPost:
			a.wallUpload(w, r)
		default:
			w.WriteHeader(405)
		}
	})
	mux.HandleFunc("/api/wallpaper/", func(w http.ResponseWriter, r *http.Request) {
		name := strings.TrimPrefix(r.URL.Path, "/api/wallpaper/")
		p, ok := a.wallPath(name)
		if !ok {
			http.NotFound(w, r)
			return
		}
		switch r.Method {
		case http.MethodGet, http.MethodHead:
			f, err := os.Open(p)
			if err != nil {
				http.NotFound(w, r)
				return
			}
			defer f.Close()
			fi, err := f.Stat()
			if err != nil || !fi.Mode().IsRegular() {
				http.NotFound(w, r)
				return
			}
			w.Header().Set("Content-Type", wallMime[strings.ToLower(filepath.Ext(name))])
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Cache-Control", "no-cache")
			http.ServeContent(w, r, name, fi.ModTime(), f)
		case http.MethodDelete:
			if err := os.Remove(p); err != nil && !errors.Is(err, os.ErrNotExist) {
				errJSON(w, 500, "delete-failed", err)
				return
			}
			writeJSON(w, 200, map[string]bool{"ok": true})
		default:
			w.WriteHeader(405)
		}
	})
}

func (a *app) wallUpload(w http.ResponseWriter, r *http.Request) {
	r.Body = http.MaxBytesReader(w, r.Body, wallMaxBytes+(1<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		errJSON(w, 400, "bad-multipart", err)
		return
	}
	for {
		part, err := mr.NextPart()
		if err != nil {
			errJSON(w, 400, "no-file", errors.New("missing form field \"file\""))
			return
		}
		if part.FormName() != "file" {
			continue
		}
		b, err := io.ReadAll(io.LimitReader(part, wallMaxBytes+1))
		if err != nil {
			errJSON(w, 400, "read", err)
			return
		}
		if len(b) > wallMaxBytes {
			errJSON(w, 413, "too-large", errors.New("max 8 MB"))
			return
		}
		ext := wallSniff(b)
		if ext == "" {
			errJSON(w, 415, "bad-type", errors.New("only PNG, JPEG, WebP, GIF"))
			return
		}
		dir := a.wallDir()
		if err := os.MkdirAll(dir, 0o755); err != nil {
			errJSON(w, 500, "write-failed", err)
			return
		}
		if ents, _ := os.ReadDir(dir); len(ents) >= wallMaxFiles {
			errJSON(w, 409, "too-many", errors.New("too many wallpapers"))
			return
		}
		stem := wallStem(part.FileName())
		name := stem + ext
		for i := 2; ; i++ {
			if _, err := os.Stat(filepath.Join(dir, name)); errors.Is(err, os.ErrNotExist) {
				break
			}
			name = stem + "-" + strconv.Itoa(i) + ext
		}
		p, ok := a.wallPath(name)
		if !ok {
			errJSON(w, 400, "bad-name", errors.New("bad name"))
			return
		}
		tmp := p + ".tmp"
		if err := os.WriteFile(tmp, b, 0o644); err != nil {
			errJSON(w, 500, "write-failed", err)
			return
		}
		if err := os.Rename(tmp, p); err != nil {
			os.Remove(tmp)
			errJSON(w, 500, "write-failed", err)
			return
		}
		writeJSON(w, 200, map[string]any{"ok": true, "name": name, "size": len(b)})
		return
	}
}
