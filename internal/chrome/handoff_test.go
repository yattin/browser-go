package chrome

import (
	"context"
	"testing"
	"time"
)

func TestHumanHandoffRequestAndResume(t *testing.T) {
	mgr := NewManager(ManagerConfig{
		MaxInstances: 2,
		SpawnOverride: func(ctx context.Context, debugPort int, userDataDir, startingURL string, extraArgs []string, headless bool) (*ProcGroup, string, error) {
			pg, _ := NewMockProcess()
			return pg, "ws://127.0.0.1:1/devtools/browser/mock", nil
		},
	})
	defer mgr.Shutdown()

	_, release, err := mgr.Acquire(context.Background(), "about:blank", LaunchParams{User: "agent-1"})
	if err != nil {
		t.Fatalf("Acquire failed: %v", err)
	}
	defer release()

	// Start blocking handoff in background
	doneCh := make(chan HandoffState, 1)
	go func() {
		st, hErr := mgr.RequestHandoff(context.Background(), "agent-1", "Please solve CAPTCHA", 10*time.Second, false)
		if hErr != nil {
			t.Errorf("RequestHandoff error: %v", hErr)
		}
		doneCh <- st
	}()

	// Wait briefly for waiting handoff to appear in GetHandoff & ListInstances
	var ho *HandoffState
	for i := 0; i < 30; i++ {
		ho = mgr.GetHandoff("agent-1")
		if ho != nil {
			break
		}
		time.Sleep(15 * time.Millisecond)
	}
	if ho == nil || ho.Status != "waiting" || ho.Reason != "Please solve CAPTCHA" {
		t.Fatalf("expected waiting handoff, got %+v", ho)
	}

	// Simulate human clicking "完成并交还 Agent"
	resumed, ok := mgr.ResumeHandoff("agent-1", "CAPTCHA solved")
	if !ok || resumed.Status != "resumed" || resumed.Note != "CAPTCHA solved" {
		t.Fatalf("unexpected ResumeHandoff result: ok=%v state=%+v", ok, resumed)
	}

	select {
	case st := <-doneCh:
		if st.Status != "resumed" || st.Note != "CAPTCHA solved" {
			t.Fatalf("blocked agent received unexpected state: %+v", st)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("timed out waiting for blocked handoff to resume")
	}

	if after := mgr.GetHandoff("agent-1"); after != nil {
		t.Fatalf("expected handoff cleared after resume, got %+v", after)
	}
}
