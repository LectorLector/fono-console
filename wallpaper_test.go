package main

import (
	"bytes"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

var (
	pngHdr  = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR")
	jpgHdr  = []byte{0xFF, 0xD8, 0xFF, 0xE0, 0, 0x10, 'J', 'F', 'I', 'F'}
	gifHdr  = []byte("GIF89a\x01\x00\x01\x00")
	webpHdr = []byte("RIFF\x10\x00\x00\x00WEBPVP8 ")
)

func newTestApp(t *testing.T) (*app, http.Handler) {
	t.Helper()
	a := &app{hub: newHub(), art: map[string]artItem{}, dataDir: t.TempDir(), eapoDir: t.TempDir(), demo: true}
	return a, a.routes()
}

func upload(h http.Handler, field, fname string, body []byte) *httptest.ResponseRecorder {
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile(field, fname)
	fw.Write(body)
	mw.Close()
	req := httptest.NewRequest("POST", "/api/wallpaper", &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func TestWallSniff(t *testing.T) {
	cases := map[string][]byte{".png": pngHdr, ".jpg": jpgHdr, ".gif": gifHdr, ".webp": webpHdr, "": []byte("<svg xmlns=")}
	for want, b := range cases {
		if got := wallSniff(b); got != want {
			t.Errorf("sniff %q = %q want %q", b[:4], got, want)
		}
	}
	if wallSniff(nil) != "" || wallSniff([]byte("RIFF....WAVE")) != "" {
		t.Error("short/WAV must be rejected")
	}
}

func TestWallpaperUploadList(t *testing.T) {
	a, h := newTestApp(t)
	rec := upload(h, "file", "my pic.png", append(pngHdr, make([]byte, 100)...))
	if rec.Code != 200 {
		t.Fatalf("upload %d %s", rec.Code, rec.Body)
	}
	if _, err := os.Stat(filepath.Join(a.dataDir, "wallpapers", "my pic.png")); err != nil {
		t.Fatal(err)
	}
	// same name -> suffix, not overwrite
	if rec = upload(h, "file", "my pic.png", pngHdr); rec.Code != 200 || !strings.Contains(rec.Body.String(), "my pic-2.png") {
		t.Fatalf("dup name: %d %s", rec.Code, rec.Body)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/wallpaper", nil))
	if !strings.Contains(rec.Body.String(), "my pic.png") {
		t.Fatal("list missing", rec.Body)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/wallpaper/my%20pic.png", nil))
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("serve %d %v", rec.Code, rec.Header())
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("DELETE", "/api/wallpaper/my%20pic.png", nil))
	if rec.Code != 200 {
		t.Fatal("delete", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("GET", "/api/wallpaper/my%20pic.png", nil))
	if rec.Code != 404 {
		t.Fatal("deleted file still served", rec.Code)
	}
}

func TestWallpaperRejects(t *testing.T) {
	_, h := newTestApp(t)
	if rec := upload(h, "file", "x.png", []byte("<svg onload=alert(1)>")); rec.Code != 415 {
		t.Errorf("svg disguised as png: %d", rec.Code)
	}
	if rec := upload(h, "file", "x.png", nil); rec.Code != 415 {
		t.Errorf("empty: %d", rec.Code)
	}
	if rec := upload(h, "other", "x.png", pngHdr); rec.Code != 400 {
		t.Errorf("wrong field: %d", rec.Code)
	}
	big := append(append([]byte{}, pngHdr...), make([]byte, wallMaxBytes)...)
	if rec := upload(h, "file", "big.png", big); rec.Code != 413 {
		t.Errorf("oversize: %d", rec.Code)
	}
	ok := append(append([]byte{}, pngHdr...), make([]byte, wallMaxBytes-len(pngHdr))...)
	if rec := upload(h, "file", "edge.png", ok); rec.Code != 200 {
		t.Errorf("exactly 8MB should pass: %d", rec.Code)
	}
	req := httptest.NewRequest("POST", "/api/wallpaper", strings.NewReader("not multipart"))
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 400 {
		t.Errorf("non multipart: %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest("PUT", "/api/wallpaper", nil))
	if rec.Code != 405 {
		t.Errorf("PUT: %d", rec.Code)
	}
}

func TestWallpaperTraversal(t *testing.T) {
	a, h := newTestApp(t)
	secret := filepath.Join(a.dataDir, "settings.json")
	os.WriteFile(secret, []byte(`{"s":1}`), 0o644)
	os.MkdirAll(a.wallDir(), 0o755)
	for _, n := range []string{"..%2Fsettings.json", "..%5Csettings.json", "%2e%2e/settings.json", "....//settings.json", "a.png%00.txt", "x.svg", ".png", "a/../../settings.json"} {
		for _, m := range []string{"GET", "DELETE"} {
			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(m, "/api/wallpaper/"+n, nil))
			if rec.Code == 200 {
				t.Errorf("%s %s returned 200", m, n)
			}
		}
	}
	if _, err := os.Stat(secret); err != nil {
		t.Fatal("settings.json was deleted by traversal")
	}
	// hostile upload file names stay inside the dir
	for _, fn := range []string{"../../evil.png", `..\..\evil.png`, "/etc/passwd.png", "a\x00b.png", "...png", "  .png"} {
		rec := upload(h, "file", fn, pngHdr)
		if rec.Code != 200 {
			continue
		}
	}
	filepath.Walk(a.dataDir, func(p string, info os.FileInfo, err error) error {
		if err == nil && !info.IsDir() && p != secret && !strings.HasPrefix(p, a.wallDir()) {
			t.Errorf("file escaped wallpaper dir: %s", p)
		}
		return nil
	})
	if p, ok := a.wallPath("../x.png"); ok {
		t.Errorf("wallPath accepted %s", p)
	}
}

func TestWallStem(t *testing.T) {
	for in, want := range map[string]string{"a/b/c.png": "c", `C:\x\y.jpg`: "y", "..": "wallpaper", "": "wallpaper"} {
		got := wallStem(in)
		if got != want {
			t.Errorf("wallStem(%q)=%q want %q", in, got, want)
		}
	}
	if g := wallStem("a.b.c.gif"); strings.Contains(g, ".") {
		t.Errorf("dots kept: %q", g)
	}
	if n := len([]rune(wallStem(strings.Repeat("a", 300) + ".png"))); n > 48 {
		t.Errorf("long stem %d", n)
	}
}

func TestWallpaperTooMany(t *testing.T) {
	a, h := newTestApp(t)
	os.MkdirAll(a.wallDir(), 0o755)
	for i := 0; i < wallMaxFiles; i++ {
		os.WriteFile(filepath.Join(a.wallDir(), strings.Repeat("a", 1)+string(rune('a'+i%26))+string(rune('a'+i/26))+".png"), pngHdr, 0o644)
	}
	if rec := upload(h, "file", "z.png", pngHdr); rec.Code != 409 {
		t.Errorf("limit: %d", rec.Code)
	}
}

var _ = io.EOF
