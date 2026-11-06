//go:build windows

package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

func ytmRunning() bool {
	out, err := hidden(exec.Command("tasklist", "/FI", "IMAGENAME eq YouTube Music.exe", "/NH")).Output()
	return err == nil && strings.Contains(string(out), "YouTube Music.exe")
}

func findREW() string {
	for _, p := range []string{
		filepath.Join(os.Getenv("ProgramFiles"), "REW", "roomeqwizard.exe"),
		filepath.Join(os.Getenv("ProgramFiles(x86)"), "REW", "roomeqwizard.exe"),
		filepath.Join(os.Getenv("LOCALAPPDATA"), "Programs", "REW", "roomeqwizard.exe"),
	} {
		if _, err := os.Stat(p); err == nil {
			return p
		}
	}
	return ""
}

// runInstaller starts an installer; it shows its own UI and UAC prompt.
func runInstaller(path string) error {
	return exec.Command("cmd", "/c", "start", "", path).Start()
}

const chromePolicyKey = `HKCU:\Software\Policies\Google\Chrome`

var chromePolicyValues = []string{"BackgroundModeEnabled=0", "HighEfficiencyModeEnabled=1", "MemorySaverModeEnabled=1", "MemorySaverModeSavings=1"}

func chromePolicyOn() bool {
	out, err := runPS(`(Get-ItemProperty -Path '` + chromePolicyKey + `' -Name MemorySaverModeEnabled -ErrorAction SilentlyContinue).MemorySaverModeEnabled`)
	return err == nil && strings.TrimSpace(out) == "1"
}

func setChromePolicy(on bool) error {
	var b strings.Builder
	b.WriteString("$k='" + chromePolicyKey + "'\n")
	if on {
		b.WriteString("New-Item -Path $k -Force | Out-Null\n")
		for _, kv := range chromePolicyValues {
			p := strings.SplitN(kv, "=", 2)
			b.WriteString("New-ItemProperty -Path $k -Name " + p[0] + " -Value " + p[1] + " -PropertyType DWord -Force | Out-Null\n")
		}
	} else {
		b.WriteString("if (Test-Path $k) {\n")
		for _, kv := range chromePolicyValues {
			b.WriteString("  Remove-ItemProperty -Path $k -Name " + strings.SplitN(kv, "=", 2)[0] + " -ErrorAction SilentlyContinue\n")
		}
		b.WriteString("  if (-not (Get-Item $k).Property) { Remove-Item $k -Force }\n}\n")
	}
	_, err := runPS(b.String())
	return err
}
