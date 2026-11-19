//go:build windows

package winsvc

import (
	"fmt"
	"path/filepath"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// IsWindowsService reports whether the current process was started by Windows SCM (Session 0).
func IsWindowsService() bool {
	inSvc, err := svc.IsWindowsService()
	if err != nil {
		return false
	}
	return inSvc
}

type scmHandler struct {
	startFn func() error
	stopFn  func()
}

func (h *scmHandler) Execute(_ []string, r <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	const cmdsAccepted = svc.AcceptStop | svc.AcceptShutdown
	changes <- svc.Status{State: svc.StartPending}

	if h.startFn != nil {
		if err := h.startFn(); err != nil {
			changes <- svc.Status{State: svc.Stopped}
			return false, 1
		}
	}
	changes <- svc.Status{State: svc.Running, Accepts: cmdsAccepted}

loop:
	for c := range r {
		switch c.Cmd {
		case svc.Interrogate:
			changes <- c.CurrentStatus
		case svc.Stop, svc.Shutdown:
			break loop
		default:
		}
	}

	changes <- svc.Status{State: svc.StopPending}
	if h.stopFn != nil {
		h.stopFn()
	}
	return false, 0
}

// RunService executes startFn under Windows SCM and invokes stopFn when SCM stops/shuts down the service.
func RunService(name string, startFn func() error, stopFn func()) error {
	return svc.Run(name, &scmHandler{
		startFn: startFn,
		stopFn:  stopFn,
	})
}

// Install registers or updates a Windows SCM service with automatic startup and 3-tier crash restart recovery.
func Install(name, displayName, description, exePath string, args ...string) error {
	absExe, err := filepath.Abs(exePath)
	if err != nil {
		absExe = exePath
	}
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Windows SCM (run as Administrator): %w", err)
	}
	defer func() { _ = m.Disconnect() }()

	cfg := mgr.Config{
		StartType:   mgr.StartAutomatic,
		DisplayName: displayName,
		Description: description,
	}

	if existing, openErr := m.OpenService(name); openErr == nil {
		_ = existing.Close()
		if uErr := Uninstall(name); uErr != nil {
			return fmt.Errorf("replace existing service %s: %w", name, uErr)
		}
	}

	s, err := m.CreateService(name, absExe, cfg, args...)
	if err != nil {
		return fmt.Errorf("create service %s: %w", name, err)
	}
	defer func() { _ = s.Close() }()

	_ = s.SetRecoveryActions([]mgr.RecoveryAction{
		{Type: mgr.ServiceRestart, Delay: 3 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 5 * time.Second},
		{Type: mgr.ServiceRestart, Delay: 10 * time.Second},
	}, 86400)
	return nil
}

// Uninstall stops (if running) and deletes a Windows SCM service.
func Uninstall(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Windows SCM (run as Administrator): %w", err)
	}
	defer func() { _ = m.Disconnect() }()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("service %q is not installed: %w", name, err)
	}
	defer func() { _ = s.Close() }()

	if st, qErr := s.Query(); qErr == nil && st.State != svc.Stopped {
		_, _ = s.Control(svc.Stop)
		deadline := time.Now().Add(10 * time.Second)
		for time.Now().Before(deadline) {
			st, qErr = s.Query()
			if qErr != nil || st.State == svc.Stopped {
				break
			}
			time.Sleep(200 * time.Millisecond)
		}
	}
	if err := s.Delete(); err != nil {
		return fmt.Errorf("delete service %s: %w", name, err)
	}
	return nil
}

// Start starts an installed Windows SCM service and waits up to 8s for Running state.
func Start(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Windows SCM: %w", err)
	}
	defer func() { _ = m.Disconnect() }()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %s: %w", name, err)
	}
	defer func() { _ = s.Close() }()

	if st, qErr := s.Query(); qErr == nil && st.State == svc.Running {
		return nil
	}
	if err := s.Start(); err != nil {
		return fmt.Errorf("start service %s: %w", name, err)
	}
	deadline := time.Now().Add(8 * time.Second)
	for time.Now().Before(deadline) {
		if st, qErr := s.Query(); qErr == nil && st.State == svc.Running {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil
}

// Stop sends a Stop control signal to an installed Windows SCM service.
func Stop(name string) error {
	m, err := mgr.Connect()
	if err != nil {
		return fmt.Errorf("connect Windows SCM: %w", err)
	}
	defer func() { _ = m.Disconnect() }()

	s, err := m.OpenService(name)
	if err != nil {
		return fmt.Errorf("open service %s: %w", name, err)
	}
	defer func() { _ = s.Close() }()

	if st, qErr := s.Query(); qErr == nil && st.State == svc.Stopped {
		return nil
	}
	if _, err := s.Control(svc.Stop); err != nil {
		return fmt.Errorf("stop service %s: %w", name, err)
	}
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if st, qErr := s.Query(); qErr == nil && st.State == svc.Stopped {
			return nil
		}
		time.Sleep(150 * time.Millisecond)
	}
	return nil
}

// Status queries the Windows SCM state ("RUNNING", "STOPPED", "NOT_INSTALLED", etc.) using read-only SC_MANAGER_CONNECT
// so non-elevated callers can inspect service status without Administrator privileges.
func Status(name string) (state string, installed bool, err error) {
	scmHandle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return "SCM_UNAVAILABLE", false, err
	}
	defer func() { _ = windows.CloseServiceHandle(scmHandle) }()

	svcNamePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return "INVALID_NAME", false, err
	}
	svcHandle, err := windows.OpenService(scmHandle, svcNamePtr, windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return "NOT_INSTALLED", false, nil
	}
	defer func() { _ = windows.CloseServiceHandle(svcHandle) }()

	var sp windows.SERVICE_STATUS_PROCESS
	var needed uint32
	if qErr := windows.QueryServiceStatusEx(
		svcHandle,
		windows.SC_STATUS_PROCESS_INFO,
		(*byte)(nil),
		0,
		&needed,
	); qErr != nil && needed == 0 {
		return "UNKNOWN", true, qErr
	}
	var st windows.SERVICE_STATUS
	if qErr := windows.QueryServiceStatus(svcHandle, &st); qErr != nil {
		return "UNKNOWN", true, qErr
	}
	_ = sp
	switch svc.State(st.CurrentState) {
	case svc.Running:
		return "RUNNING", true, nil
	case svc.Stopped:
		return "STOPPED", true, nil
	case svc.StartPending:
		return "START_PENDING", true, nil
	case svc.StopPending:
		return "STOP_PENDING", true, nil
	default:
		return fmt.Sprintf("STATE_%d", st.CurrentState), true, nil
	}
}
