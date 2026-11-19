package chrome

import (
	"errors"
	"testing"
)

func TestSanitizeLaunchArgsAllowAndBlock(t *testing.T) {
	safe, err := SanitizeLaunchArgs([]string{
		"--proxy-server=http://127.0.0.1:7890",
		"--window-size=1920,1080",
		"--lang=zh-CN",
		"--disable-blink-features=AutomationControlled",
		"--mute-audio",
	})
	if err != nil {
		t.Fatalf("expected safe args to pass, got error: %v", err)
	}
	if len(safe) != 5 {
		t.Fatalf("expected 5 sanitized args, got %d", len(safe))
	}

	dangerous := [][]string{
		{"--gpu-launcher=cmd /c calc.exe"},
		{"--renderer-cmd-prefix=powershell -c whoami"},
		{"--utility-cmd-prefix=sh -c id"},
		{"--user-data-dir=C:\\Windows\\Temp\\pwn"},
		{"--load-extension=\\\\evil\\share\\ext"},
		{"--remote-debugging-port=9222"},
		{"--disable-web-security"},
		{"--proxy-server=http://a\r\nEvil: 1"},
	}
	for _, tc := range dangerous {
		if _, err := SanitizeLaunchArgs(tc); !errors.Is(err, ErrForbiddenLaunchArg) {
			t.Fatalf("expected ErrForbiddenLaunchArg for %v, got %v", tc, err)
		}
	}
}

func TestValidateNavigationURL(t *testing.T) {
	okCases := map[string]string{
		"":                         "about:blank",
		"about:blank":              "about:blank",
		"https://www.bing.com":     "https://www.bing.com",
		"http://127.0.0.1:3000/a":  "http://127.0.0.1:3000/a",
		"bing.com":                 "https://bing.com",
		"data:text/html,<h1>x</h1>": "data:text/html,<h1>x</h1>",
	}
	for in, want := range okCases {
		got, err := ValidateNavigationURL(in)
		if err != nil {
			t.Fatalf("expected %q to pass, got err: %v", in, err)
		}
		if got != want {
			t.Fatalf("ValidateNavigationURL(%q) = %q, want %q", in, got, want)
		}
	}

	badCases := []string{
		"file:///C:/Windows/win.ini",
		"chrome://settings",
		"chrome-extension://abcdef/popup.html",
		"javascript:alert(1)",
		"https://example.com\r\nX-Injected: 1",
	}
	for _, in := range badCases {
		if _, err := ValidateNavigationURL(in); !errors.Is(err, ErrInvalidNavigationURL) {
			t.Fatalf("expected ErrInvalidNavigationURL for %q, got %v", in, err)
		}
	}
}

func TestValidateTargetID(t *testing.T) {
	if err := ValidateTargetID("5D90A20DC6AAC328AE898D0590E305BB"); err != nil {
		t.Fatalf("expected valid target ID to pass, got %v", err)
	}
	for _, bad := range []string{"", "ab", "../list", "abc/def", "abc?foo=1", "abc\r\n"} {
		if err := ValidateTargetID(bad); !errors.Is(err, ErrInvalidTargetID) {
			t.Fatalf("expected ErrInvalidTargetID for %q, got %v", bad, err)
		}
	}
}

func TestManagedInstanceTakeoverLimit(t *testing.T) {
	inst := &ManagedInstance{Key: "demo"}
	rel1, ok1 := inst.TryAcquireTakeover(2)
	rel2, ok2 := inst.TryAcquireTakeover(2)
	_, ok3 := inst.TryAcquireTakeover(2)
	if !ok1 || !ok2 || ok3 {
		t.Fatalf("unexpected takeover slot results: ok1=%v ok2=%v ok3=%v", ok1, ok2, ok3)
	}
	rel1()
	rel3, ok4 := inst.TryAcquireTakeover(2)
	if !ok4 {
		t.Fatalf("expected slot to be available after release")
	}
	rel2()
	rel3()
}
