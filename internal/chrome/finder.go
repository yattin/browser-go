package chrome

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// FindExecutable locates a local Chromium-based browser executable (Chrome, Chromium, Ungoogled-Chromium, Brave, Edge).
func FindExecutable(explicitPath string) (string, error) {
	if p := strings.TrimSpace(explicitPath); p != "" {
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			return p, nil
		}
		if lp, err := exec.LookPath(p); err == nil {
			return lp, nil
		}
		return "", errors.New("specified --chrome-path does not exist: " + p)
	}

	if envPath := strings.TrimSpace(os.Getenv("CHROME_PATH")); envPath != "" {
		if st, err := os.Stat(envPath); err == nil && !st.IsDir() {
			return envPath, nil
		}
	}

	var candidates []string
	switch runtime.GOOS {
	case "windows":
		prefixes := []string{
			os.Getenv("LOCALAPPDATA"),
			os.Getenv("PROGRAMFILES"),
			os.Getenv("PROGRAMFILES(X86)"),
		}
		suffixes := []string{
			`Google\Chrome\Application\chrome.exe`,
			`Chromium\Application\chrome.exe`,
			`BraveSoftware\Brave-Browser\Application\brave.exe`,
			`Microsoft\Edge\Application\msedge.exe`,
		}
		for _, pfx := range prefixes {
			if pfx == "" {
				continue
			}
			for _, sfx := range suffixes {
				candidates = append(candidates, filepath.Join(pfx, sfx))
			}
		}
		for _, bin := range []string{"chrome.exe", "chromium.exe", "brave.exe", "msedge.exe"} {
			if lp, err := exec.LookPath(bin); err == nil {
				candidates = append(candidates, lp)
			}
		}
	case "darwin":
		candidates = []string{
			"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
			"/Applications/Chromium.app/Contents/MacOS/Chromium",
			"/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
			"/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
		}
		for _, bin := range []string{"google-chrome", "chromium", "brave-browser", "microsoft-edge"} {
			if lp, err := exec.LookPath(bin); err == nil {
				candidates = append(candidates, lp)
			}
		}
	default: // linux & unix
		for _, bin := range []string{
			"google-chrome",
			"google-chrome-stable",
			"chromium",
			"chromium-browser",
			"brave-browser",
			"microsoft-edge",
			"microsoft-edge-stable",
		} {
			if lp, err := exec.LookPath(bin); err == nil {
				candidates = append(candidates, lp)
			}
		}
		candidates = append(candidates,
			"/usr/bin/google-chrome",
			"/usr/bin/chromium",
			"/usr/bin/chromium-browser",
			"/snap/bin/chromium",
		)
	}

	for _, c := range candidates {
		if c == "" {
			continue
		}
		if st, err := os.Stat(c); err == nil && !st.IsDir() {
			return c, nil
		}
	}

	return "", errors.New("no Chrome/Chromium/Brave/Edge executable found; set --chrome-path or CHROME_PATH")
}
