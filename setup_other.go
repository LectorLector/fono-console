//go:build !windows

package main

import "errors"

var demoChrome bool

func ytmRunning() bool               { return false }
func findREW() string                { return "" }
func runInstaller(path string) error { return errors.New("only on Windows") }
func chromePolicyOn() bool           { return demoChrome }
func setChromePolicy(on bool) error  { demoChrome = on; return nil }
