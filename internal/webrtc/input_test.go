package webrtc

import "testing"

func TestNormalizeModifiersMacToWin(t *testing.T) {
	// macOS Cmd+V (Meta=4) controlling Windows Chrome -> Ctrl+V (Ctrl=2)
	got := NormalizeModifiers(4, "darwin", "windows", "v")
	if got != 2 {
		t.Fatalf("expected Meta(4) -> Ctrl(2), got %d", got)
	}
	// macOS controlling macOS keeps Meta=4
	gotSame := NormalizeModifiers(4, "darwin", "darwin", "v")
	if gotSame != 4 {
		t.Fatalf("expected darwin->darwin to keep Meta(4), got %d", gotSame)
	}
	// Windows Ctrl+C controlling Linux keeps Ctrl=2
	gotWin := NormalizeModifiers(2, "windows", "linux", "c")
	if gotWin != 2 {
		t.Fatalf("expected windows->linux to keep Ctrl(2), got %d", gotWin)
	}
}

func TestTranslateInputEventIMEInsertText(t *testing.T) {
	cmds := TranslateInputEvent(InputEvent{
		Type: "insertText",
		Text: "你好WebRTC接管测试2026",
	}, "windows")
	if len(cmds) != 1 {
		t.Fatalf("expected 1 CDP command for insertText, got %d", len(cmds))
	}
	if cmds[0].Method != "Input.insertText" {
		t.Fatalf("expected Input.insertText, got %q", cmds[0].Method)
	}
	if cmds[0].Params["text"] != "你好WebRTC接管测试2026" {
		t.Fatalf("unexpected text payload: %v", cmds[0].Params["text"])
	}
}

func TestTranslateInputEventMouseAndKey(t *testing.T) {
	mouseCmds := TranslateInputEvent(InputEvent{
		Type:       "mousedown",
		X:          320.5,
		Y:          180.25,
		Button:     "left",
		ClickCount: 1,
	}, "windows")
	if len(mouseCmds) != 1 || mouseCmds[0].Method != "Input.dispatchMouseEvent" {
		t.Fatalf("unexpected mouse command: %+v", mouseCmds)
	}
	if mouseCmds[0].Params["type"] != "mousePressed" || mouseCmds[0].Params["button"] != "left" {
		t.Fatalf("unexpected mouse params: %+v", mouseCmds[0].Params)
	}

	keyCmds := TranslateInputEvent(InputEvent{
		Type: "keydown",
		Key:  "Enter",
		Code: "Enter",
	}, "windows")
	if len(keyCmds) != 2 || keyCmds[0].Method != "Input.dispatchKeyEvent" || keyCmds[1].Method != "Input.dispatchKeyEvent" {
		t.Fatalf("unexpected Enter keydown commands: %+v", keyCmds)
	}
	if keyCmds[0].Params["type"] != "rawKeyDown" || keyCmds[0].Params["windowsVirtualKeyCode"] != 13 {
		t.Fatalf("expected rawKeyDown with vkCode 13, got %+v", keyCmds[0].Params)
	}
	if keyCmds[1].Params["type"] != "char" || keyCmds[1].Params["text"] != "\r" {
		t.Fatalf("expected char with \\r, got %+v", keyCmds[1].Params)
	}
}
