//go:build !windows

package winsvc

import "errors"

func IsWindowsService() bool { return false }

func RunService(_ string, startFn func() error, stopFn func()) error {
	if startFn != nil {
		if err := startFn(); err != nil {
			return err
		}
	}
	if stopFn != nil {
		defer stopFn()
	}
	return nil
}

func Install(_, _, _, _ string, _ ...string) error {
	return errors.New("Windows SCM service installation is only supported on Windows")
}

func Uninstall(_ string) error {
	return errors.New("Windows SCM service uninstallation is only supported on Windows")
}

func Start(_ string) error {
	return errors.New("Windows SCM service start is only supported on Windows")
}

func Stop(_ string) error {
	return errors.New("Windows SCM service stop is only supported on Windows")
}

func Status(_ string) (string, bool, error) {
	return "UNSUPPORTED", false, nil
}
