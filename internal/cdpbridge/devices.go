package cdpbridge

import (
	"sort"
	"sync"
	"time"

	"browser-go/internal/logger"
	"browser-go/internal/wsutil"
)

const heartbeatTimeout = 45 * time.Second

// DeviceInfo describes metadata reported by a Chrome extension instance.
type DeviceInfo struct {
	Name      string `json:"name"`
	Version   string `json:"version"`
	UserAgent string `json:"userAgent"`
	Timestamp string `json:"timestamp"`
}

// ConnectionInfo holds the active tab TargetInfo and CDP root sessionId reported by the extension.
type ConnectionInfo struct {
	SessionID  string         `json:"sessionId"`
	TargetInfo map[string]any `json:"targetInfo"`
}

// RegisteredDevice represents an online Chrome extension device.
type RegisteredDevice struct {
	DeviceID       string          `json:"deviceId"`
	DeviceInfo     DeviceInfo      `json:"deviceInfo"`
	ConnectionInfo *ConnectionInfo `json:"connectionInfo,omitempty"`
	RegisteredAt   time.Time       `json:"registeredAt"`
	LastSeen       time.Time       `json:"lastSeen"`
	Session        *ExtensionSession `json:"-"`
}

// DeviceStats summarizes registered extension devices.
type DeviceStats struct {
	TotalDevices       int `json:"totalDevices"`
	ConnectedDevices   int `json:"connectedDevices"`
	DevicesWithTargets int `json:"devicesWithTargets"`
}

// DeviceManager manages Chrome extension registration, heartbeats, and stale cleanup.
type DeviceManager struct {
	mu      sync.RWMutex
	devices map[string]*RegisteredDevice
	log     *logger.Logger

	stopCh chan struct{}
	wg     sync.WaitGroup
}

func NewDeviceManager(log *logger.Logger) *DeviceManager {
	if log == nil {
		log = logger.Default()
	}
	dm := &DeviceManager{
		devices: make(map[string]*RegisteredDevice),
		log:     log,
		stopCh:  make(chan struct{}),
	}
	dm.wg.Add(1)
	go dm.cleanupLoop()
	return dm
}

func (dm *DeviceManager) Register(deviceID string, info DeviceInfo, sess *ExtensionSession, connInfo *ConnectionInfo) {
	if deviceID == "" || sess == nil {
		return
	}
	now := time.Now()
	if info.Name == "" {
		info.Name = "Chrome Extension"
	}
	if info.Version == "" {
		info.Version = "1.0.0"
	}
	if info.Timestamp == "" {
		info.Timestamp = now.UTC().Format(time.RFC3339Nano)
	}

	var prevSess *ExtensionSession
	dm.mu.Lock()
	regAt := now
	if existing, ok := dm.devices[deviceID]; ok {
		regAt = existing.RegisteredAt
		if existing.Session != nil && existing.Session != sess {
			prevSess = existing.Session
		}
		if connInfo == nil && existing.ConnectionInfo != nil {
			connInfo = existing.ConnectionInfo
		}
	}
	dm.devices[deviceID] = &RegisteredDevice{
		DeviceID:       deviceID,
		DeviceInfo:     info,
		ConnectionInfo: connInfo,
		RegisteredAt:   regAt,
		LastSeen:       now,
		Session:        sess,
	}
	dm.mu.Unlock()

	if prevSess != nil && !prevSess.ws.IsClosed() {
		dm.log.Infof("Closing superseded extension socket for device %s", deviceID)
		_ = prevSess.ws.Close(1000, "New connection established")
	}
	dm.log.Infof("Device registered: %s (%s)", deviceID, info.Name)
}

func (dm *DeviceManager) UpdateConnectionInfo(deviceID string, ci *ConnectionInfo) {
	if deviceID == "" || ci == nil {
		return
	}
	dm.mu.Lock()
	if d, ok := dm.devices[deviceID]; ok {
		d.ConnectionInfo = ci
		d.LastSeen = time.Now()
	}
	dm.mu.Unlock()
}

func (dm *DeviceManager) TouchHeartbeat(deviceID string) {
	dm.mu.Lock()
	if d, ok := dm.devices[deviceID]; ok {
		d.LastSeen = time.Now()
	}
	dm.mu.Unlock()
}

func (dm *DeviceManager) Unregister(deviceID string, matchSess *ExtensionSession) {
	if deviceID == "" {
		return
	}
	dm.mu.Lock()
	if d, ok := dm.devices[deviceID]; ok {
		if matchSess != nil && d.Session != matchSess {
			dm.mu.Unlock()
			return
		}
		delete(dm.devices, deviceID)
		dm.mu.Unlock()
		dm.log.Infof("Device unregistered: %s", deviceID)
		return
	}
	dm.mu.Unlock()
}

func (dm *DeviceManager) Get(deviceID string) *RegisteredDevice {
	dm.mu.RLock()
	d, ok := dm.devices[deviceID]
	dm.mu.RUnlock()
	if !ok || d == nil {
		return nil
	}
	if d.Session == nil || d.Session.ws.IsClosed() {
		dm.Unregister(deviceID, d.Session)
		return nil
	}
	cp := *d
	return &cp
}

func (dm *DeviceManager) List() []RegisteredDevice {
	dm.mu.RLock()
	out := make([]RegisteredDevice, 0, len(dm.devices))
	for _, d := range dm.devices {
		cp := *d
		out = append(out, cp)
	}
	dm.mu.RUnlock()

	sort.Slice(out, func(i, j int) bool {
		return out[i].DeviceID < out[j].DeviceID
	})
	return out
}

func (dm *DeviceManager) Stats() DeviceStats {
	dm.mu.RLock()
	defer dm.mu.RUnlock()
	st := DeviceStats{
		TotalDevices: len(dm.devices),
	}
	for _, d := range dm.devices {
		if d.Session != nil && !d.Session.ws.IsClosed() {
			st.ConnectedDevices++
			if d.ConnectionInfo != nil {
				st.DevicesWithTargets++
			}
		}
	}
	return st
}

func (dm *DeviceManager) cleanupLoop() {
	defer dm.wg.Done()
	tk := time.NewTicker(10 * time.Second)
	defer tk.Stop()
	for {
		select {
		case <-tk.C:
			dm.cleanupStale()
		case <-dm.stopCh:
			return
		}
	}
}

func (dm *DeviceManager) cleanupStale() {
	now := time.Now()
	var stale []*ExtensionSession

	dm.mu.Lock()
	for id, d := range dm.devices {
		closed := d.Session == nil || d.Session.ws.IsClosed()
		expired := now.Sub(d.LastSeen) > heartbeatTimeout
		if closed || expired {
			if d.Session != nil && !d.Session.ws.IsClosed() {
				stale = append(stale, d.Session)
			}
			delete(dm.devices, id)
			dm.log.Infof("Cleaned stale device %s (closed=%v, expired=%v)", id, closed, expired)
		}
	}
	dm.mu.Unlock()

	for _, s := range stale {
		_ = s.ws.Close(1000, "Heartbeat timeout")
	}
}

func (dm *DeviceManager) Shutdown() {
	select {
	case <-dm.stopCh:
		return
	default:
		close(dm.stopCh)
	}
	dm.wg.Wait()

	dm.mu.Lock()
	sessions := make([]*ExtensionSession, 0, len(dm.devices))
	for _, d := range dm.devices {
		if d.Session != nil {
			sessions = append(sessions, d.Session)
		}
	}
	dm.devices = make(map[string]*RegisteredDevice)
	dm.mu.Unlock()

	for _, s := range sessions {
		_ = s.ws.Close(1000, "Server shutdown")
	}
}

var _ = (*wsutil.Conn)(nil)
