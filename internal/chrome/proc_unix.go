//go:build !windows

package chrome

import (
	"os/exec"
	"sync"
	"syscall"
	"time"
)

type procGroup struct {
	cmd      *exec.Cmd
	once     sync.Once
	exitOnce sync.Once
	exited   chan struct{}
}

func (pg *procGroup) markExited() {
	if pg != nil && pg.exited != nil {
		pg.exitOnce.Do(func() {
			close(pg.exited)
		})
	}
}

func startIsolatedProcess(bin string, args []string) (*procGroup, error) {
	cmd := exec.Command(bin, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{
		Setpgid: true,
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	pg := &procGroup{
		cmd:    cmd,
		exited: make(chan struct{}),
	}
	go func() {
		_ = cmd.Wait()
		pg.markExited()
	}()
	return pg, nil
}

func (pg *procGroup) PID() int {
	if pg == nil || pg.cmd == nil || pg.cmd.Process == nil {
		return 0
	}
	return pg.cmd.Process.Pid
}

func (pg *procGroup) Exited() <-chan struct{} {
	return pg.exited
}

func (pg *procGroup) Kill() error {
	if pg == nil {
		return nil
	}
	var retErr error
	pg.once.Do(func() {
		if pg.cmd == nil {
			pg.markExited()
			return
		}
		if pg.cmd.Process != nil {
			pid := pg.cmd.Process.Pid
			_ = syscall.Kill(-pid, syscall.SIGTERM)
			select {
			case <-pg.exited:
				return
			case <-time.After(600 * time.Millisecond):
				retErr = syscall.Kill(-pid, syscall.SIGKILL)
			}
		}
		<-pg.exited
	})
	return retErr
}
