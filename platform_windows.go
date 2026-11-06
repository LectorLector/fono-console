//go:build windows

package main

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unsafe"
)

const createNoWindow = 0x08000000

func hidden(cmd *exec.Cmd) *exec.Cmd {
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: createNoWindow}
	return cmd
}

func psExe() string {
	p := filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return "powershell.exe"
}

// encodedPS runs a PowerShell snippet via -EncodedCommand (no quoting issues).
func encodedPS(script string) []string {
	u := utf16.Encode([]rune(script))
	b := make([]byte, len(u)*2)
	for i, v := range u {
		b[i*2] = byte(v)
		b[i*2+1] = byte(v >> 8)
	}
	return []string{"-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", base64.StdEncoding.EncodeToString(b)}
}

func runPS(script string) (string, error) {
	out, err := hidden(exec.Command(psExe(), encodedPS(script)...)).CombinedOutput()
	return string(out), err
}

func psQuote(s string) string { return "'" + strings.ReplaceAll(s, "'", "''") + "'" }

func defaultEapoDir() string {
	out, err := hidden(exec.Command("reg", "query", `HKLM\SOFTWARE\EqualizerAPO`, "/v", "ConfigPath")).Output()
	if err == nil {
		for _, l := range strings.Split(string(out), "\n") {
			l = strings.TrimSpace(l)
			if strings.HasPrefix(strings.ToLower(l), "configpath") {
				f := strings.SplitN(l, "REG_SZ", 2)
				if len(f) == 2 {
					if p := strings.TrimSpace(f[1]); p != "" {
						return p
					}
				}
			}
		}
	}
	pf := os.Getenv("ProgramFiles")
	if pf == "" {
		pf = `C:\Program Files`
	}
	return filepath.Join(pf, "EqualizerAPO", "config")
}

// ---------------------------------------------------------------- PowerShell bridge

type psBridge struct {
	mu     sync.Mutex
	stdin  io.WriteCloser
	cmd    *exec.Cmd
	closed bool
}

func startPSBridge(a *app, dataDir string) bridge {
	b := &psBridge{}
	script := filepath.Join(dataDir, "bridge.ps1")
	os.WriteFile(script, bridgeScript, 0o644)
	go func() {
		fails := 0
		for {
			b.mu.Lock()
			if b.closed {
				b.mu.Unlock()
				return
			}
			cmd := hidden(exec.Command(psExe(), "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-STA", "-File", script))
			in, _ := cmd.StdinPipe()
			out, _ := cmd.StdoutPipe()
			cmd.Stderr = log.Writer()
			if err := cmd.Start(); err != nil {
				b.mu.Unlock()
				log.Println("bridge start:", err)
				return
			}
			b.cmd, b.stdin = cmd, in
			b.mu.Unlock()
			started := time.Now()
			lineReader(out, a.onBridgeLine)
			cmd.Wait()
			if time.Since(started) < 20*time.Second {
				fails++
			} else {
				fails = 0
			}
			if fails > 4 {
				log.Println("bridge keeps failing; giving up")
				return
			}
			time.Sleep(2 * time.Second)
		}
	}()
	return b
}

func (b *psBridge) Send(cmd map[string]any) {
	line, err := json.Marshal(cmd)
	if err != nil {
		return
	}
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stdin != nil {
		b.stdin.Write(append(line, '\n'))
	}
}

func (b *psBridge) Close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	if b.stdin != nil {
		b.stdin.Close()
	}
	if b.cmd != nil && b.cmd.Process != nil {
		b.cmd.Process.Kill()
	}
}

// ---------------------------------------------------------------- shell helpers

func grantWrite(dir string) error {
	// One elevated icacls call: give the local Users group modify rights on the
	// Equalizer APO config folder so the console can write without admin later.
	inner := "icacls " + `"` + dir + `"` + " /grant *S-1-5-32-545:(OI)(CI)M /T"
	script := "Start-Process -FilePath cmd.exe -ArgumentList '/c', " + psQuote(inner) + " -Verb RunAs -WindowStyle Hidden -Wait"
	out, err := runPS(script)
	if err != nil {
		return errors.New(strings.TrimSpace(out) + " " + err.Error())
	}
	return nil
}

func launchREW(path string) error {
	if path == "" {
		path = filepath.Join(os.Getenv("ProgramFiles"), "REW", "roomeqwizard.exe")
	}
	if _, err := os.Stat(path); err != nil {
		return errors.New("找不到 REW：" + path)
	}
	cmd := exec.Command(path, "-api")
	return cmd.Start()
}

func openExternal(u string) {
	hidden(exec.Command("rundll32", "url.dll,FileProtocolHandler", u)).Start()
}

func openFolder(dir string) {
	if dir != "" {
		exec.Command("explorer.exe", dir).Start()
	}
}

func browserCandidates() []string {
	pf86 := os.Getenv("ProgramFiles(x86)")
	pf := os.Getenv("ProgramFiles")
	la := os.Getenv("LOCALAPPDATA")
	return []string{
		filepath.Join(pf86, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(la, `Microsoft\Edge\Application\msedge.exe`),
		filepath.Join(pf, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(pf86, `Google\Chrome\Application\chrome.exe`),
		filepath.Join(la, `Google\Chrome\Application\chrome.exe`),
	}
}

func openAppWindow(url string) {
	profile := filepath.Join(os.Getenv("LOCALAPPDATA"), "FonoConsole", "ui-profile")
	os.MkdirAll(profile, 0o755)
	for _, b := range browserCandidates() {
		if _, err := os.Stat(b); err == nil {
			cmd := exec.Command(b,
				"--app="+url,
				"--user-data-dir="+profile,
				"--window-size=1380,900",
				"--no-first-run",
				"--no-default-browser-check",
				"--autoplay-policy=no-user-gesture-required",
			)
			if err := cmd.Start(); err == nil {
				return
			}
		}
	}
	openExternal(url)
}

// ---------------------------------------------------------------- install

func installDir() string {
	return filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "FonoConsole")
}

func isInstalled() bool {
	exe, err := os.Executable()
	if err != nil {
		return false
	}
	return strings.EqualFold(filepath.Dir(exe), installDir())
}

func copyFile(src, dst string) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	out, err := os.Create(dst)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}

func installSelf() error {
	exe, err := os.Executable()
	if err != nil {
		return err
	}
	dir := installDir()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}
	target := filepath.Join(dir, "FonoConsole.exe")
	if !strings.EqualFold(exe, target) {
		if err := copyFile(exe, target); err != nil {
			return err
		}
	}
	ico := filepath.Join(dir, "FonoConsole.ico")
	os.WriteFile(ico, iconICO, 0o644)
	script := `
$ErrorActionPreference = 'Stop'
$target = ` + psQuote(target) + `
$ico = ` + psQuote(ico) + `
$sh = New-Object -ComObject WScript.Shell
$paths = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Fono Console.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fono Console.lnk'))
foreach ($p in $paths) { $l = $sh.CreateShortcut($p); $l.TargetPath = $target; $l.WorkingDirectory = (Split-Path $target); $l.IconLocation = $ico; $l.Description = 'Fono Console'; $l.Save() }
$k = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FonoConsole'
New-Item -Path $k -Force | Out-Null
Set-ItemProperty -Path $k -Name DisplayName -Value 'Fono Console'
Set-ItemProperty -Path $k -Name DisplayVersion -Value '` + appVersion + `'
Set-ItemProperty -Path $k -Name Publisher -Value 'Fono Console'
Set-ItemProperty -Path $k -Name DisplayIcon -Value $ico
Set-ItemProperty -Path $k -Name InstallLocation -Value (Split-Path $target)
Set-ItemProperty -Path $k -Name UninstallString -Value ('"' + $target + '" --uninstall')
Set-ItemProperty -Path $k -Name NoModify -Value 1 -Type DWord
Set-ItemProperty -Path $k -Name NoRepair -Value 1 -Type DWord
`
	if out, err := runPS(script); err != nil {
		return errors.New(strings.TrimSpace(out))
	}
	infoBox("已安裝到 " + dir + "\n開始選單與桌面都有「Fono Console」捷徑。")
	return nil
}

func uninstallSelf() error {
	dir := installDir()
	script := `
$paths = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Fono Console.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Fono Console.lnk'))
foreach ($p in $paths) { Remove-Item -LiteralPath $p -ErrorAction SilentlyContinue }
Remove-Item -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\FonoConsole' -Recurse -ErrorAction SilentlyContinue
`
	runPS(script)
	// Delete the program folder after this process exits.
	hidden(exec.Command("cmd.exe", "/c", "ping 127.0.0.1 -n 3 >nul & rmdir /s /q \""+dir+"\"")).Start()
	infoBox("Fono Console 已移除。你的設定保留在 %APPDATA%\\FonoConsole，Equalizer APO 的設定檔不受影響。")
	return nil
}

var (
	user32      = syscall.NewLazyDLL("user32.dll")
	pMessageBox = user32.NewProc("MessageBoxW")
)

func msgBox(text string, flags uintptr) {
	t, _ := syscall.UTF16PtrFromString(text)
	c, _ := syscall.UTF16PtrFromString(appName)
	pMessageBox.Call(0, uintptr(unsafe.Pointer(t)), uintptr(unsafe.Pointer(c)), flags)
}

func infoBox(text string)  { msgBox(text, 0x40) }
func fatalBox(text string) { msgBox(text, 0x10); os.Exit(1) }

// ---------------------------------------------------------------- apps / devices

func ytmExe() string {
	p := filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "youtube-music", "YouTube Music.exe")
	if _, err := os.Stat(p); err == nil {
		return p
	}
	return ""
}

func launchApp(name string) error {
	switch name {
	case "spotify":
		openExternal("spotify:")
		return nil
	case "ytm":
		if p := ytmExe(); p != "" {
			return exec.Command(p).Start()
		}
		return errors.New("YouTube Music 桌面版未安裝")
	case "sound":
		openExternal("ms-settings:sound")
		return nil
	case "bluetooth":
		openExternal("ms-settings:bluetooth")
		return nil
	}
	return errors.New("unknown app")
}

func setPnpEnabled(id string, enable bool) error {
	verb := "Disable-PnpDevice"
	if enable {
		verb = "Enable-PnpDevice"
	}
	inner := verb + " -InstanceId " + psQuote(id) + " -Confirm:$false"
	script := "Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command'," + psQuote(inner) + " -Verb RunAs -WindowStyle Hidden -Wait"
	out, err := runPS(script)
	if err != nil {
		return errors.New(strings.TrimSpace(out) + " " + err.Error())
	}
	return nil
}

func launchDeviceSelector() error {
	inst := filepath.Dir(defaultEapoDir())
	p := filepath.Join(inst, "DeviceSelector.exe")
	if _, err := os.Stat(p); err != nil {
		return errors.New("找不到 Equalizer APO Device Selector")
	}
	_, err := runPS("Start-Process -FilePath " + psQuote(p) + " -Verb RunAs")
	return err
}
