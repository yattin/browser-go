package logger

import (
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	maxLogFileSize = 10 * 1024 * 1024 // 10MB per file
	maxLogDays     = 10               // 10 days retention
	ringCapacity   = 128
)

// Logger provides concurrent-safe console + daily rotating file logging and a memory ring buffer.
type Logger struct {
	mu       sync.Mutex
	prefix   string
	logDir   string
	debug    bool
	noFile   bool
	toStdout bool

	curDate string
	curSize int64
	curSeq  int
	file    *os.File

	ring    []string
	ringPos int
}

var defaultLogger = &Logger{
	toStdout: true,
	noFile:   true,
	ring:     make([]string, 0, ringCapacity),
}

// Default returns the package-level default logger.
func Default() *Logger {
	return defaultLogger
}

// SetDefault replaces the package-level default logger.
func SetDefault(l *Logger) {
	if l != nil {
		defaultLogger = l
	}
}

// New creates a new Logger writing to ~/.browser-go/logs (or dataDir/logs) and stdout.
func New(prefix, dataDir string, debug, noFile, toStdout bool) (*Logger, error) {
	l := &Logger{
		prefix:   prefix,
		debug:    debug,
		noFile:   noFile,
		toStdout: toStdout,
		ring:     make([]string, 0, ringCapacity),
	}
	if !noFile {
		if dataDir == "" {
			home, err := os.UserHomeDir()
			if err == nil && home != "" {
				dataDir = filepath.Join(home, ".browser-go")
			} else {
				dataDir = ".browser-go"
			}
		}
		l.logDir = filepath.Join(dataDir, "logs")
		if err := os.MkdirAll(l.logDir, 0755); err != nil {
			l.noFile = true
		} else {
			_ = l.rotateLocked(time.Now())
		}
	}
	return l, nil
}

// Close flushes and closes the underlying log file if open.
func (l *Logger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.file != nil {
		err := l.file.Close()
		l.file = nil
		return err
	}
	return nil
}

// Debugf logs at DEBUG level when debug is enabled.
func (l *Logger) Debugf(format string, args ...any) {
	if l == nil || !l.debug {
		return
	}
	l.write("DEBUG", "\x1b[36m", fmt.Sprintf(format, args...))
}

// Infof logs at INFO level.
func (l *Logger) Infof(format string, args ...any) {
	if l == nil {
		return
	}
	l.write("INFO", "\x1b[32m", fmt.Sprintf(format, args...))
}

// Warnf logs at WARN level.
func (l *Logger) Warnf(format string, args ...any) {
	if l == nil {
		return
	}
	l.write("WARN", "\x1b[33m", fmt.Sprintf(format, args...))
}

// Errorf logs at ERROR level.
func (l *Logger) Errorf(format string, args ...any) {
	if l == nil {
		return
	}
	l.write("ERROR", "\x1b[31m", fmt.Sprintf(format, args...))
}

// Tail returns up to n most recent plain-text log entries.
func (l *Logger) Tail(n int) []string {
	if l == nil || n <= 0 {
		return nil
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	total := len(l.ring)
	if total == 0 {
		return nil
	}
	if n > total {
		n = total
	}
	out := make([]string, 0, n)
	if total < ringCapacity {
		out = append(out, l.ring[total-n:]...)
		return out
	}
	start := (l.ringPos + ringCapacity - n) % ringCapacity
	for i := 0; i < n; i++ {
		out = append(out, l.ring[(start+i)%ringCapacity])
	}
	return out
}

func (l *Logger) write(level, color, msg string) {
	now := time.Now()
	ts := now.Format("2006-01-02 15:04:05.000")
	pfx := ""
	if l.prefix != "" {
		pfx = "[" + l.prefix + "] "
	}
	plain := fmt.Sprintf("%s [%s] %s%s", ts, level, pfx, strings.TrimRight(msg, "\r\n"))

	l.mu.Lock()
	defer l.mu.Unlock()

	if len(l.ring) < ringCapacity {
		l.ring = append(l.ring, plain)
	} else {
		l.ring[l.ringPos] = plain
		l.ringPos = (l.ringPos + 1) % ringCapacity
	}

	if l.toStdout {
		var w io.Writer = os.Stdout
		if level == "ERROR" {
			w = os.Stderr
		}
		_, _ = fmt.Fprintf(w, "%s [%s%s\x1b[0m] %s%s\n", ts, color, level, pfx, strings.TrimRight(msg, "\r\n"))
	}

	if !l.noFile && l.logDir != "" {
		dateStr := now.Format("2006-01-02")
		if l.file == nil || l.curDate != dateStr || l.curSize >= maxLogFileSize {
			_ = l.rotateLocked(now)
		}
		if l.file != nil {
			n, err := l.file.WriteString(plain + "\n")
			if err == nil {
				l.curSize += int64(n)
			}
		}
	}
}

func (l *Logger) rotateLocked(now time.Time) error {
	dateStr := now.Format("2006-01-02")
	if l.curDate != dateStr {
		l.curDate = dateStr
		l.curSeq = 0
	} else if l.curSize >= maxLogFileSize {
		l.curSeq++
	}
	if l.file != nil {
		_ = l.file.Close()
		l.file = nil
	}

	name := fmt.Sprintf("browser-go-%s.log", dateStr)
	if l.curSeq > 0 {
		name = fmt.Sprintf("browser-go-%s.%d.log", dateStr, l.curSeq)
	}
	fullPath := filepath.Join(l.logDir, name)
	f, err := os.OpenFile(fullPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0640)
	if err != nil {
		return err
	}
	if st, err := f.Stat(); err == nil {
		l.curSize = st.Size()
	} else {
		l.curSize = 0
	}
	l.file = f
	l.cleanupOldLogsLocked(now)
	return nil
}

func (l *Logger) cleanupOldLogsLocked(now time.Time) {
	entries, err := os.ReadDir(l.logDir)
	if err != nil {
		return
	}
	cutoff := now.Add(-maxLogDays * 24 * time.Hour)
	var logFiles []string
	for _, e := range entries {
		if e.IsDir() || !strings.HasPrefix(e.Name(), "browser-go-") || !strings.HasSuffix(e.Name(), ".log") {
			continue
		}
		info, err := e.Info()
		if err == nil && info.ModTime().Before(cutoff) {
			_ = os.Remove(filepath.Join(l.logDir, e.Name()))
			continue
		}
		logFiles = append(logFiles, e.Name())
	}
	sort.Strings(logFiles)
}
