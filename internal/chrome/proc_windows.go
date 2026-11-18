//go:build windows

package chrome

import (
	"errors"
	"os"
	"os/exec"
	"sync"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

type procGroup struct {
	cmd      *exec.Cmd
	job      windows.Handle
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

	job, jobErr := windows.CreateJobObject(nil, nil)
	if jobErr == nil {
		var info windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
		info.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
		_, setErr := windows.SetInformationJobObject(
			job,
			windows.JobObjectExtendedLimitInformation,
			uintptr(unsafe.Pointer(&info)),
			uint32(unsafe.Sizeof(info)),
		)
		if setErr != nil {
			_ = windows.CloseHandle(job)
			job = 0
		}
	} else {
		job = 0
	}

	if err := cmd.Start(); err != nil {
		if job != 0 {
			_ = windows.CloseHandle(job)
		}
		return nil, err
	}

	if job != 0 && cmd.Process != nil {
		pHandle, openErr := windows.OpenProcess(
			windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE,
			false,
			uint32(cmd.Process.Pid),
		)
		if openErr == nil {
			if assignErr := windows.AssignProcessToJobObject(job, pHandle); assignErr != nil {
				_ = windows.CloseHandle(job)
				job = 0
			}
			_ = windows.CloseHandle(pHandle)
		} else {
			_ = windows.CloseHandle(job)
			job = 0
		}
	}

	pg := &procGroup{
		cmd:    cmd,
		job:    job,
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
			if pg.job != 0 {
				_ = windows.CloseHandle(pg.job)
				pg.job = 0
			}
			pg.markExited()
			return
		}

		killedViaJob := false
		if pg.job != 0 {
			if err := windows.TerminateJobObject(pg.job, 0); err == nil {
				killedViaJob = true
			}
			_ = windows.CloseHandle(pg.job)
			pg.job = 0
		}

		if killedViaJob {
			select {
			case <-pg.exited:
				return
			case <-time.After(2 * time.Second):
			}
		}

		if pg.cmd.Process != nil {
			select {
			case <-pg.exited:
				return
			default:
				if err := pg.cmd.Process.Kill(); err != nil && !errors.Is(err, os.ErrProcessDone) {
					retErr = err
				}
			}
		}
		<-pg.exited
		// Once <-pg.exited has closed, the OS process is definitively dead (even if TerminateProcess raced with exit).
		retErr = nil
	})
	return retErr
}
