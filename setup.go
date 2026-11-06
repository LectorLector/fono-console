package main

// In-app setup: everything scripts/setup.ps1 does, as API calls the setup
// wizard in the UI drives. Nothing here runs without the user pressing a
// button, and every download is hash-checked before it is executed.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"
)

type setupJob struct {
	mu    sync.Mutex
	State string `json:"state"` // idle | running | done | error
	Step  string `json:"step"`
	Error string `json:"error,omitempty"`
}

func (j *setupJob) set(state, step, errText string) {
	j.mu.Lock()
	j.State, j.Step, j.Error = state, step, errText
	j.mu.Unlock()
}

func (j *setupJob) snapshot() map[string]string {
	j.mu.Lock()
	defer j.mu.Unlock()
	return map[string]string{"state": j.State, "step": j.Step, "error": j.Error}
}

// ytmConfigPath finds the YouTube Music desktop app's settings file.
func ytmConfigPath() string {
	base := os.Getenv("APPDATA")
	if base == "" {
		base, _ = os.UserConfigDir()
	}
	for _, d := range []string{"YouTube Music", "youtube-music", "pear-desktop"} {
		p := filepath.Join(base, d, "config.json")
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

func ytmAPIEnabled() bool {
	p := ytmConfigPath()
	if p == "" {
		return false
	}
	var cfg map[string]any
	b, err := os.ReadFile(p)
	if err != nil || json.Unmarshal(b, &cfg) != nil {
		return false
	}
	pl, _ := cfg["plugins"].(map[string]any)
	api, _ := pl["api-server"].(map[string]any)
	on, _ := api["enabled"].(bool)
	return on
}

// enableYtmAPI switches on the api-server plugin, bound to localhost only.
func enableYtmAPI() error {
	p := ytmConfigPath()
	if p == "" {
		return errors.New("找不到 YouTube Music 的設定檔：請先開一次 YouTube Music、登入後關閉，再按一次")
	}
	if ytmRunning() {
		return errors.New("YouTube Music 正在執行：請先完全關閉（含系統匣圖示）再按一次")
	}
	b, err := os.ReadFile(p)
	if err != nil {
		return err
	}
	cfg := map[string]any{}
	if len(strings.TrimSpace(string(b))) > 0 {
		if err := json.Unmarshal(b, &cfg); err != nil {
			return fmt.Errorf("設定檔格式不正確：%v", err)
		}
	}
	pl, _ := cfg["plugins"].(map[string]any)
	if pl == nil {
		pl = map[string]any{}
		cfg["plugins"] = pl
	}
	api, _ := pl["api-server"].(map[string]any)
	if api == nil {
		api = map[string]any{}
		pl["api-server"] = api
	}
	api["enabled"] = true
	api["hostname"] = "127.0.0.1"
	api["port"] = 26538
	api["authStrategy"] = "AUTH_AT_FIRST"
	os.WriteFile(p+".bak-fono-"+time.Now().Format("20060102-150405"), b, 0o644)
	out, _ := json.MarshalIndent(cfg, "", "  ")
	return os.WriteFile(p, out, 0o644)
}

type ghAsset struct {
	Name   string `json:"name"`
	URL    string `json:"browser_download_url"`
	Size   int64  `json:"size"`
	Digest string `json:"digest"`
}

// downloadVerified fetches the newest GitHub release asset whose name matches
// pattern, checks its SHA-256 against the digest GitHub publishes and returns
// the local path. An asset without a published digest is refused.
func downloadVerified(repos []string, pattern string, job *setupJob) (string, string, error) {
	re := regexp.MustCompile(pattern)
	client := &http.Client{Timeout: 10 * time.Minute}
	var asset *ghAsset
	var tag string
	for _, repo := range repos {
		req, _ := http.NewRequest("GET", "https://api.github.com/repos/"+repo+"/releases/latest", nil)
		req.Header.Set("Accept", "application/vnd.github+json")
		req.Header.Set("User-Agent", "fono-console-setup")
		res, err := client.Do(req)
		if err != nil {
			continue
		}
		var rel struct {
			Tag    string    `json:"tag_name"`
			Assets []ghAsset `json:"assets"`
		}
		json.NewDecoder(res.Body).Decode(&rel)
		res.Body.Close()
		for i := range rel.Assets {
			if re.MatchString(rel.Assets[i].Name) {
				asset, tag = &rel.Assets[i], rel.Tag
				break
			}
		}
		if asset != nil {
			break
		}
	}
	if asset == nil {
		return "", "", errors.New("無法從 GitHub 取得安裝檔資訊（網路或 GitHub 暫時無法連線）")
	}
	want := strings.ToLower(strings.TrimPrefix(asset.Digest, "sha256:"))
	if len(want) != 64 {
		return "", "", errors.New("GitHub 沒有公布這個檔案的雜湊值，為了安全不自動安裝：請手動下載")
	}
	job.set("running", fmt.Sprintf("下載 %s（%s，%.1f MB）", asset.Name, tag, float64(asset.Size)/1e6), "")
	res, err := client.Get(asset.URL)
	if err != nil {
		return "", "", err
	}
	defer res.Body.Close()
	dir, _ := os.MkdirTemp("", "fono-setup-")
	dst := filepath.Join(dir, asset.Name)
	f, err := os.Create(dst)
	if err != nil {
		return "", "", err
	}
	h := sha256.New()
	_, err = io.Copy(io.MultiWriter(f, h), res.Body)
	f.Close()
	if err != nil {
		return "", "", err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		os.Remove(dst)
		return "", "", fmt.Errorf("雜湊值不符，已刪除下載檔（得到 %s，應為 %s）", got[:16], want[:16])
	}
	return dst, want, nil
}

// bundledInstaller returns an installer shipped next to the program, e.g.
// bundled\EqualizerAPO-x64-1.4.2.exe in the release zip.
func bundledInstaller(prefix string) string {
	exe, err := os.Executable()
	if err != nil {
		return ""
	}
	for _, dir := range []string{filepath.Join(filepath.Dir(exe), "bundled"), filepath.Dir(exe)} {
		m, _ := filepath.Glob(filepath.Join(dir, prefix+"*.exe"))
		if len(m) > 0 {
			return m[0]
		}
	}
	return ""
}

func (a *app) setupRoutes(mux *http.ServeMux) {
	ytmJob := &setupJob{State: "idle"}
	mux.HandleFunc("/api/setup/status", func(w http.ResponseWriter, r *http.Request) {
		eapo := defaultEapoDir()
		_, eapoErr := os.Stat(filepath.Join(eapo, "config.txt"))
		writeJSON(w, 200, map[string]any{
			"eapo":    map[string]any{"installed": eapoErr == nil, "config": eapo, "bundled": bundledInstaller("EqualizerAPO") != ""},
			"ytm":     map[string]any{"installed": ytmExe() != "" || a.demo, "config": ytmConfigPath() != "" || a.demo, "api": ytmAPIEnabled() || a.demo, "running": ytmRunning(), "job": ytmJob.snapshot()},
			"chrome":  map[string]any{"policy": chromePolicyOn()},
			"rew":     map[string]any{"path": findREW()},
			"windows": !a.demo,
		})
	})
	mux.HandleFunc("/api/setup/eapo-install", func(w http.ResponseWriter, r *http.Request) {
		if p := bundledInstaller("EqualizerAPO"); p != "" {
			if err := runInstaller(p); err != nil {
				errJSON(w, 500, "install", err)
				return
			}
			writeJSON(w, 200, map[string]string{"started": "bundled"})
			return
		}
		openExternal("https://sourceforge.net/projects/equalizerapo/files/")
		writeJSON(w, 200, map[string]string{"started": "browser"})
	})
	mux.HandleFunc("/api/setup/ytm-install", func(w http.ResponseWriter, r *http.Request) {
		if st := ytmJob.snapshot(); st["state"] == "running" {
			writeJSON(w, 200, st)
			return
		}
		ytmJob.set("running", "查詢最新版本…", "")
		go func() {
			if a.demo {
				time.Sleep(2 * time.Second)
				ytmJob.set("done", "（示範）已安裝並驗證雜湊", "")
				return
			}
			p, sum, err := downloadVerified([]string{"pear-devs/pear-desktop", "th-ch/youtube-music"}, `(?i)Web-Setup.*\.exe$`, ytmJob)
			if err != nil {
				ytmJob.set("error", "", err.Error())
				return
			}
			ytmJob.set("running", "SHA-256 相符（"+sum[:16]+"…），執行安裝程式", "")
			if err := runInstaller(p); err != nil {
				ytmJob.set("error", "", err.Error())
				return
			}
			ytmJob.set("done", "安裝程式已啟動：完成後登入一次 YouTube Music、關閉它，再按「開啟 API」", "")
		}()
		writeJSON(w, 200, ytmJob.snapshot())
	})
	mux.HandleFunc("/api/setup/ytm-api", func(w http.ResponseWriter, r *http.Request) {
		if a.demo {
			writeJSON(w, 200, map[string]bool{"ok": true})
			return
		}
		if err := enableYtmAPI(); err != nil {
			errJSON(w, 409, "ytm-api", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"ok": true})
	})
	mux.HandleFunc("/api/setup/chrome", func(w http.ResponseWriter, r *http.Request) {
		var req struct {
			On bool `json:"on"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		if err := setChromePolicy(req.On); err != nil {
			errJSON(w, 500, "chrome", err)
			return
		}
		writeJSON(w, 200, map[string]bool{"on": chromePolicyOn()})
	})
}
