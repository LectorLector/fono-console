//go:build !windows

package main

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

func defaultEapoDir() string {
	wd, _ := os.Getwd()
	d := filepath.Join(wd, "demo-eapo", "config")
	os.MkdirAll(d, 0o755)
	if _, err := os.Stat(filepath.Join(d, "config.txt")); err != nil {
		os.WriteFile(filepath.Join(d, "config.txt"), []byte("Preamp: 0 dB\r\n"), 0o644)
	}
	return d
}

func startPSBridge(a *app, dataDir string) bridge { return startDemoBridge(a) }

func grantWrite(dir string) error { return errors.New("only on Windows") }
func launchREW(path string) error { return errors.New("only on Windows") }
func openExternal(u string)       { exec.Command("xdg-open", u).Start() }
func openFolder(dir string)       {}
func openAppWindow(url string)    { fmt.Println("Open:", url) }
func isInstalled() bool           { return false }
func installSelf() error          { return errors.New("only on Windows") }
func uninstallSelf() error        { return errors.New("only on Windows") }
func fatalBox(text string)        { fmt.Fprintln(os.Stderr, text); os.Exit(1) }

func ytmExe() string                         { return "" }
func launchApp(name string) error            { return errors.New("only on Windows") }
func setPnpEnabled(id string, en bool) error { return errors.New("only on Windows") }
func launchDeviceSelector() error            { return errors.New("only on Windows") }
