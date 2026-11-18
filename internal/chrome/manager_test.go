package chrome

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestManagerSlotQuotaEphemeralAndCoalescing(t *testing.T) {
	tmpDir := t.TempDir()
	var spawnCount atomic.Int32

	mgr := NewManager(ManagerConfig{
		MaxInstances:          2,
		InstanceTimeout:       80 * time.Millisecond,
		InactiveCheckInterval: 10 * time.Second, // manual CleanupInactive trigger in unit test for determinism
		DataDir:               tmpDir,
		SpawnOverride: func(ctx context.Context, debugPort int, userDataDir, startingURL string, extraArgs []string, headless bool) (*ProcGroup, string, error) {
			spawnCount.Add(1)
			time.Sleep(35 * time.Millisecond)
			pg, _ := NewMockProcess()
			return pg, "ws://127.0.0.1:9999/devtools/browser/fake", nil
		},
	})
	defer mgr.Shutdown()

	// 1. Five concurrent Acquire calls for the SAME user ("alice") must coalesce into a SINGLE spawn!
	var wg sync.WaitGroup
	releases := make([]func(), 5)
	errs := make([]error, 5)
	for i := 0; i < 5; i++ {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			_, rel, err := mgr.Acquire(context.Background(), "https://example.com", LaunchParams{User: "alice"})
			releases[idx] = rel
			errs[idx] = err
		}(i)
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("concurrent alice acquire[%d] failed: %v", i, err)
		}
	}
	if got := spawnCount.Load(); got != 1 {
		t.Fatalf("expected 1 coalesced spawn for alice, got %d", got)
	}

	// 2. Acquire an ephemeral (no user) instance -> consumes 2nd slot
	ephemInst, ephemRel, err := mgr.Acquire(context.Background(), "https://example.org", LaunchParams{})
	if err != nil {
		t.Fatalf("ephemeral acquire failed: %v", err)
	}
	if !ephemInst.IsEphemeral {
		t.Fatalf("expected ephemeral instance")
	}

	// 3. Pool is now 2/2 full -> 3rd distinct instance MUST fail with ErrMaxInstancesReached
	_, _, err = mgr.Acquire(context.Background(), "https://example.net", LaunchParams{User: "bob"})
	if !errors.Is(err, ErrMaxInstancesReached) {
		t.Fatalf("expected ErrMaxInstancesReached when 2/2 slots used, got %v", err)
	}

	// 4. Releasing ephemeral connection must immediately evict it & free 1 slot!
	ephemDir := ephemInst.UserDataDir
	ephemRel()

	st := mgr.Stats()
	if st.CurrentInstances != 1 || st.AvailableSlots != 1 {
		t.Fatalf("expected 1 current / 1 available after ephemeral release, got %+v", st)
	}
	for i := 0; i < 10; i++ {
		if _, statErr := os.Stat(ephemDir); os.IsNotExist(statErr) {
			break
		}
		time.Sleep(30 * time.Millisecond)
	}
	if _, statErr := os.Stat(ephemDir); !os.IsNotExist(statErr) {
		t.Fatalf("ephemeral userDataDir %s was not cleaned up", ephemDir)
	}

	// 5. While alice still has active connections, CleanupInactive MUST NOT evict alice even past timeout!
	time.Sleep(100 * time.Millisecond)
	if reaped := mgr.CleanupInactive(); reaped != 0 {
		t.Fatalf("expected 0 active instances reaped, got %d", reaped)
	}

	// Release all 5 alice connections -> wait past timeout -> CleanupInactive reaps alice!
	for _, rel := range releases {
		rel()
	}
	time.Sleep(100 * time.Millisecond)
	if reaped := mgr.CleanupInactive(); reaped != 1 {
		t.Fatalf("expected 1 idle instance reaped, got %d", reaped)
	}
}

func TestIsolatedOSProcessKill(t *testing.T) {
	var bin string
	var args []string
	if runtime.GOOS == "windows" {
		sysRoot := os.Getenv("SystemRoot")
		if sysRoot == "" {
			sysRoot = `C:\Windows`
		}
		bin = filepath.Join(sysRoot, "System32", "ping.exe")
		args = []string{"-n", "30", "127.0.0.1"}
	} else {
		bin = "sleep"
		args = []string{"30"}
	}

	pg, err := startIsolatedProcess(bin, args)
	if err != nil {
		t.Skipf("skipping OS process test: %v", err)
	}
	if pg.PID() <= 0 {
		t.Fatalf("expected positive PID")
	}

	done := make(chan error, 1)
	go func() {
		done <- pg.Kill()
	}()

	select {
	case <-done:
	case <-time.After(3 * time.Second):
		t.Fatalf("pg.Kill() timed out killing isolated process")
	}

	select {
	case <-pg.Exited():
	default:
		t.Fatalf("expected pg.Exited() channel to be closed after Kill()")
	}
}
