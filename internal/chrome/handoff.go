package chrome

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
)

// HandoffState represents a Human-in-the-Loop pause request where an AI Agent yields control
// of a live browser session to a human operator (via /dashboard + WebRTC Live View) for login/2FA/CAPTCHA.
type HandoffState struct {
	ID          string `json:"id"`
	UserID      string `json:"user_id"`
	Reason      string `json:"reason"`
	Status      string `json:"status"` // "waiting", "resumed", "timeout", "canceled"
	Note        string `json:"note,omitempty"`
	RequestedAt string `json:"requested_at"`
	ResolvedAt  string `json:"resolved_at,omitempty"`
}

type pendingHandoff struct {
	state HandoffState
	done  chan struct{}
	once  sync.Once
}

func newHandoffID() string {
	var b [6]byte
	_, _ = rand.Read(b[:])
	return "ho-" + hex.EncodeToString(b[:])
}

// RequestHandoff registers a waiting handoff for userKey. If async is false, it blocks until a human
// operator calls ResumeHandoff, timeout elapses, or ctx is canceled.
func (m *Manager) RequestHandoff(ctx context.Context, userKey, reason string, timeout time.Duration, async bool) (HandoffState, error) {
	if strings.TrimSpace(userKey) == "" {
		return HandoffState{}, errors.New("missing user_id")
	}
	if strings.TrimSpace(reason) == "" {
		reason = "Agent 请求人工协助（如登录、2FA 或验证码）"
	}
	if timeout <= 0 {
		timeout = 5 * time.Minute
	}
	if timeout > 30*time.Minute {
		timeout = 30 * time.Minute
	}

	// Resolve canonical instance key if running
	raw := strings.TrimSpace(userKey)
	sanitized := sanitizeKey(raw)
	canonical := raw

	m.mu.Lock()
	var inst *ManagedInstance
	for _, k := range []string{raw, sanitized} {
		if existing, ok := m.instances[k]; ok && !existing.closing.Load() {
			inst = existing
			canonical = k
			break
		}
	}
	if inst == nil {
		m.mu.Unlock()
		return HandoffState{}, fmt.Errorf("browser instance %q not found", userKey)
	}
	inst.Touch()

	// Cancel any stale waiting handoff for the same instance
	if prev, ok := m.handoffs[canonical]; ok {
		prev.once.Do(func() {
			prev.state.Status = "canceled"
			prev.state.ResolvedAt = time.Now().UTC().Format(time.RFC3339Nano)
			close(prev.done)
		})
	}

	ph := &pendingHandoff{
		state: HandoffState{
			ID:          newHandoffID(),
			UserID:      canonical,
			Reason:      strings.TrimSpace(reason),
			Status:      "waiting",
			RequestedAt: time.Now().UTC().Format(time.RFC3339Nano),
		},
		done: make(chan struct{}),
	}
	m.handoffs[canonical] = ph
	m.mu.Unlock()

	m.log.Infof("Human handoff requested for [%s] (id=%s, reason=%q)", canonical, ph.state.ID, ph.state.Reason)

	if async {
		return ph.state, nil
	}

	timer := time.NewTimer(timeout)
	defer timer.Stop()

	select {
	case <-ph.done:
		m.mu.Lock()
		st := ph.state
		m.mu.Unlock()
		return st, nil
	case <-timer.C:
		m.mu.Lock()
		ph.once.Do(func() {
			ph.state.Status = "timeout"
			ph.state.ResolvedAt = time.Now().UTC().Format(time.RFC3339Nano)
			close(ph.done)
		})
		if m.handoffs[canonical] == ph {
			delete(m.handoffs, canonical)
		}
		st := ph.state
		m.mu.Unlock()
		return st, nil
	case <-ctx.Done():
		m.mu.Lock()
		ph.once.Do(func() {
			ph.state.Status = "canceled"
			ph.state.ResolvedAt = time.Now().UTC().Format(time.RFC3339Nano)
			close(ph.done)
		})
		if m.handoffs[canonical] == ph {
			delete(m.handoffs, canonical)
		}
		st := ph.state
		m.mu.Unlock()
		return st, ctx.Err()
	}
}

// ResumeHandoff marks a waiting handoff as resolved and unblocks any waiting Agent/MCP call.
func (m *Manager) ResumeHandoff(userKey, note string) (HandoffState, bool) {
	raw := strings.TrimSpace(userKey)
	sanitized := sanitizeKey(raw)

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range []string{raw, sanitized} {
		if ph, ok := m.handoffs[k]; ok {
			ph.once.Do(func() {
				ph.state.Status = "resumed"
				ph.state.Note = strings.TrimSpace(note)
				ph.state.ResolvedAt = time.Now().UTC().Format(time.RFC3339Nano)
				close(ph.done)
			})
			st := ph.state
			delete(m.handoffs, k)
			m.log.Infof("Human handoff resumed for [%s] (id=%s, note=%q)", k, st.ID, st.Note)
			return st, true
		}
	}
	return HandoffState{}, false
}

// GetHandoff returns a copy of the active waiting handoff for userKey, if any.
func (m *Manager) GetHandoff(userKey string) *HandoffState {
	raw := strings.TrimSpace(userKey)
	sanitized := sanitizeKey(raw)

	m.mu.Lock()
	defer m.mu.Unlock()
	for _, k := range []string{raw, sanitized} {
		if ph, ok := m.handoffs[k]; ok && ph.state.Status == "waiting" {
			cp := ph.state
			return &cp
		}
	}
	return nil
}
