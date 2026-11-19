package webrtc

import (
	"runtime"
	"strings"
)

// InputEvent is the JSON schema exchanged over WebRTC DataChannels (`input-rt` and `input-reliable`)
// as well as the tunnel WebSocket fallback channel.
type InputEvent struct {
	Type string `json:"type"` // mousemove, mousedown, mouseup, wheel, keydown, keyup, char, insertText, copy, navigate, back, forward, reload, resize, switchTab, createTab

	// Mouse fields (in remote Chrome CSS viewport coordinates)
	X          float64 `json:"x,omitempty"`
	Y          float64 `json:"y,omitempty"`
	Button     string  `json:"button,omitempty"`     // "left", "middle", "right", "none"
	Buttons    int     `json:"buttons,omitempty"`    // bitmask
	ClickCount int     `json:"clickCount,omitempty"` // 1, 2, 3
	DeltaX     float64 `json:"deltaX,omitempty"`
	DeltaY     float64 `json:"deltaY,omitempty"`

	// Keyboard & IME fields
	Key        string `json:"key,omitempty"`
	Code       string `json:"code,omitempty"`
	KeyCode    int    `json:"keyCode,omitempty"` // windowsVirtualKeyCode
	Text       string `json:"text,omitempty"`    // printable char or IME/paste Unicode text
	Modifiers  int    `json:"modifiers,omitempty"` // Alt=1, Ctrl=2, Meta=4, Shift=8
	ClientOS   string `json:"clientOS,omitempty"`  // "darwin", "windows", "linux"
	AutoRepeat bool   `json:"autoRepeat,omitempty"`

	// Navigation / Viewport / Tab fields
	URL      string `json:"url,omitempty"`
	Width    int    `json:"width,omitempty"`
	Height   int    `json:"height,omitempty"`
	Mobile   bool   `json:"mobile,omitempty"`
	TargetID string `json:"targetId,omitempty"`
}

// CDPCommand represents a single Chrome DevTools Protocol method+params pair emitted by TranslateInputEvent.
type CDPCommand struct {
	Method string
	Params map[string]any
}

// NormalizeModifiers maps macOS Cmd (Meta=4) to Ctrl (2) when controlling a non-macOS remote Chrome
// for universal shortcut ergonomics (Cmd+A/C/V/X/Z/Y).
func NormalizeModifiers(modifiers int, clientOS, remoteOS, key string) int {
	if strings.EqualFold(clientOS, "darwin") && !strings.EqualFold(remoteOS, "darwin") {
		if (modifiers & 4) != 0 {
			switch strings.ToLower(key) {
			case "a", "c", "v", "x", "z", "y", "f", "r", "l", "w", "t", "backspace":
				modifiers = (modifiers &^ 4) | 2
			}
		}
	}
	return modifiers
}

// LookupVirtualKeyCode fills missing windowsVirtualKeyCode for common control and navigation keys.
func LookupVirtualKeyCode(key string, given int) int {
	if given > 0 {
		return given
	}
	switch key {
	case "Backspace":
		return 8
	case "Tab":
		return 9
	case "Enter":
		return 13
	case "Shift":
		return 16
	case "Control":
		return 17
	case "Alt":
		return 18
	case "Escape":
		return 27
	case " ", "Spacebar":
		return 32
	case "PageUp":
		return 33
	case "PageDown":
		return 34
	case "End":
		return 35
	case "Home":
		return 36
	case "ArrowLeft":
		return 37
	case "ArrowUp":
		return 38
	case "ArrowRight":
		return 39
	case "ArrowDown":
		return 40
	case "Delete":
		return 46
	default:
		if len(key) == 1 {
			c := key[0]
			if c >= 'a' && c <= 'z' {
				return int(c - 'a' + 'A')
			}
			return int(c)
		}
		return 0
	}
}

// TranslateInputEvent converts a high-level Live View InputEvent into zero or more exact CDP commands.
func TranslateInputEvent(ev InputEvent, remoteOS string) []CDPCommand {
	if remoteOS == "" {
		remoteOS = runtime.GOOS
	}
	mods := NormalizeModifiers(ev.Modifiers, ev.ClientOS, remoteOS, ev.Key)

	switch ev.Type {
	case "mousemove":
		return []CDPCommand{{
			Method: "Input.dispatchMouseEvent",
			Params: map[string]any{
				"type":      "mouseMoved",
				"x":         ev.X,
				"y":         ev.Y,
				"modifiers": mods,
				"buttons":   ev.Buttons,
			},
		}}

	case "mousedown":
		btn := ev.Button
		if btn == "" {
			btn = "left"
		}
		cc := ev.ClickCount
		if cc <= 0 {
			cc = 1
		}
		return []CDPCommand{{
			Method: "Input.dispatchMouseEvent",
			Params: map[string]any{
				"type":       "mousePressed",
				"x":          ev.X,
				"y":          ev.Y,
				"button":     btn,
				"buttons":    ev.Buttons,
				"clickCount": cc,
				"modifiers":  mods,
			},
		}}

	case "mouseup":
		btn := ev.Button
		if btn == "" {
			btn = "left"
		}
		cc := ev.ClickCount
		if cc <= 0 {
			cc = 1
		}
		return []CDPCommand{{
			Method: "Input.dispatchMouseEvent",
			Params: map[string]any{
				"type":       "mouseReleased",
				"x":          ev.X,
				"y":          ev.Y,
				"button":     btn,
				"buttons":    ev.Buttons,
				"clickCount": cc,
				"modifiers":  mods,
			},
		}}

	case "wheel":
		return []CDPCommand{{
			Method: "Input.dispatchMouseEvent",
			Params: map[string]any{
				"type":      "mouseWheel",
				"x":         ev.X,
				"y":         ev.Y,
				"deltaX":    ev.DeltaX,
				"deltaY":    ev.DeltaY,
				"modifiers": mods,
			},
		}}

	case "insertText":
		// Dedicated CJK IME composition commit, Emoji, and Paste path:
		// Chrome Input.insertText natively fires beforeinput + input and updates React/Vue controlled inputs!
		if ev.Text == "" {
			return nil
		}
		return []CDPCommand{{
			Method: "Input.insertText",
			Params: map[string]any{
				"text": ev.Text,
			},
		}}

	case "keydown":
		vk := LookupVirtualKeyCode(ev.Key, ev.KeyCode)
		// Printable single ASCII char without Ctrl/Alt/Meta -> emit rawKeyDown + char so both keydown listeners and inputs work cleanly!
		if ev.Text != "" && (mods&(1|2|4)) == 0 && len(ev.Text) == 1 {
			return []CDPCommand{
				{
					Method: "Input.dispatchKeyEvent",
					Params: map[string]any{
						"type":                  "rawKeyDown",
						"key":                   ev.Key,
						"code":                  ev.Code,
						"windowsVirtualKeyCode": vk,
						"nativeVirtualKeyCode":  vk,
						"modifiers":             mods,
						"autoRepeat":            ev.AutoRepeat,
					},
				},
				{
					Method: "Input.dispatchKeyEvent",
					Params: map[string]any{
						"type":                  "char",
						"key":                   ev.Key,
						"code":                  ev.Code,
						"text":                  ev.Text,
						"unmodifiedText":        ev.Text,
						"windowsVirtualKeyCode": vk,
						"modifiers":             mods,
					},
				},
			}
		}

		// Enter key must also emit a "\r" char event in Chrome so form submission and newline work natively
		if ev.Key == "Enter" && (mods&(1|2|4)) == 0 {
			return []CDPCommand{
				{
					Method: "Input.dispatchKeyEvent",
					Params: map[string]any{
						"type":                  "rawKeyDown",
						"key":                   "Enter",
						"code":                  "Enter",
						"windowsVirtualKeyCode": 13,
						"nativeVirtualKeyCode":  13,
						"modifiers":             mods,
					},
				},
				{
					Method: "Input.dispatchKeyEvent",
					Params: map[string]any{
						"type":                  "char",
						"key":                   "Enter",
						"code":                  "Enter",
						"text":                  "\r",
						"unmodifiedText":        "\r",
						"windowsVirtualKeyCode": 13,
						"modifiers":             mods,
					},
				},
			}
		}

		return []CDPCommand{{
			Method: "Input.dispatchKeyEvent",
			Params: map[string]any{
				"type":                  "rawKeyDown",
				"key":                   ev.Key,
				"code":                  ev.Code,
				"windowsVirtualKeyCode": vk,
				"nativeVirtualKeyCode":  vk,
				"modifiers":             mods,
				"autoRepeat":            ev.AutoRepeat,
			},
		}}

	case "keyup":
		vk := LookupVirtualKeyCode(ev.Key, ev.KeyCode)
		return []CDPCommand{{
			Method: "Input.dispatchKeyEvent",
			Params: map[string]any{
				"type":                  "keyUp",
				"key":                   ev.Key,
				"code":                  ev.Code,
				"windowsVirtualKeyCode": vk,
				"nativeVirtualKeyCode":  vk,
				"modifiers":             mods,
			},
		}}

	case "navigate":
		if strings.TrimSpace(ev.URL) == "" {
			return nil
		}
		targetURL := strings.TrimSpace(ev.URL)
		if !strings.Contains(targetURL, "://") && !strings.HasPrefix(targetURL, "about:") && !strings.HasPrefix(targetURL, "data:") {
			targetURL = "https://" + targetURL
		}
		return []CDPCommand{{
			Method: "Page.navigate",
			Params: map[string]any{"url": targetURL},
		}}

	case "reload":
		return []CDPCommand{{
			Method: "Page.reload",
			Params: map[string]any{},
		}}

	case "back":
		return []CDPCommand{{
			Method: "Runtime.evaluate",
			Params: map[string]any{"expression": "window.history.back()"},
		}}

	case "forward":
		return []CDPCommand{{
			Method: "Runtime.evaluate",
			Params: map[string]any{"expression": "window.history.forward()"},
		}}

	case "resize":
		if ev.Width >= 320 && ev.Height >= 240 && ev.Width <= 2560 && ev.Height <= 1600 {
			return []CDPCommand{{
				Method: "Emulation.setDeviceMetricsOverride",
				Params: map[string]any{
					"width":             ev.Width,
					"height":            ev.Height,
					"deviceScaleFactor": 1,
					"mobile":            false,
				},
			}}
		}
		return nil

	default:
		return nil
	}
}
