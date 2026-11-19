package webrtc

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/pion/rtcp"
	pionwebrtc "github.com/pion/webrtc/v4"
	"github.com/pion/webrtc/v4/pkg/media"

	"browser-go/internal/chrome"
	"browser-go/internal/config"
	"browser-go/internal/logger"
	"browser-go/internal/wsutil"
)

// SignalMessage is the JSON envelope exchanged over WS `/api/v1/browser/webrtc/signal`.
type SignalMessage struct {
	Type           string                    `json:"type"` // "hello", "offer", "answer", "candidate", "fallback", "input", "meta", "clipboard", "targets", "error"
	SDP            string                    `json:"sdp,omitempty"`
	Candidate      *pionwebrtc.ICECandidateInit `json:"candidate,omitempty"`
	ICEServers     []pionwebrtc.ICEServer    `json:"iceServers,omitempty"`
	RemoteOS       string                    `json:"remoteOS,omitempty"`
	VideoMode      string                    `json:"videoMode,omitempty"` // "rtp" (H.264) or "dc" (Unordered DataChannel)
	Encoder        string                    `json:"encoder,omitempty"`
	FPS            int                       `json:"fps,omitempty"`
	ActiveTargetID string                    `json:"activeTargetId,omitempty"`
	Targets        []chrome.TargetSnapshot   `json:"targets,omitempty"`
	DeviceWidth    float64                   `json:"deviceWidth,omitempty"`
	DeviceHeight   float64                   `json:"deviceHeight,omitempty"`
	Input          *InputEvent               `json:"input,omitempty"`
	ClipboardText  string                    `json:"clipboardText,omitempty"`
	Error          string                    `json:"error,omitempty"`
}

// ServeTakeoverSession runs an interactive WebRTC (with automatic ProxyForge tunnel fallback) Live View session
// attached to an already-running Chrome instance without disturbing existing Playwright CDP clients.
func ServeTakeoverSession(
	ctx context.Context,
	sigWS *wsutil.Conn,
	chromeMgr *chrome.Manager,
	userKey string,
	requestedTargetID string,
	cfg config.WebRTCConfig,
	extraICEServers []pionwebrtc.ICEServer,
	log *logger.Logger,
) {
	if log == nil {
		log = logger.Default()
	}

	inst, releaseInst, err := chromeMgr.AttachExisting(userKey)
	if err != nil {
		_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: err.Error()})
		return
	}
	defer releaseInst()

	targets, err := chromeMgr.ListTargets(ctx, userKey)
	if err != nil || len(targets) == 0 {
		_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "No active page targets in browser instance"})
		return
	}

	activeTarget := targets[0]
	if requestedTargetID != "" {
		for _, t := range targets {
			if t.ID == requestedTargetID {
				activeTarget = t
				break
			}
		}
	}
	if activeTarget.WebSocketDebuggerURL == "" {
		_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "Target page has no WebSocket debugger URL"})
		return
	}

	sessCtx, sessCancel := context.WithCancel(ctx)
	defer sessCancel()

	// Connect to target Chrome Page CDP WebSocket
	cdpWS, _, err := wsutil.Dial(sessCtx, activeTarget.WebSocketDebuggerURL, nil, nil)
	if err != nil {
		_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "Failed to attach target CDP: " + err.Error()})
		return
	}
	defer func() { _ = cdpWS.Close(1000, "") }()

	// Build ICE server list (STUN + external TURN + injected Pool TURN)
	iceServers := make([]pionwebrtc.ICEServer, 0, len(cfg.STUNServers)+len(cfg.TURNServers)+len(extraICEServers))
	if len(cfg.STUNServers) > 0 {
		iceServers = append(iceServers, pionwebrtc.ICEServer{URLs: cfg.STUNServers})
	}
	for _, rawT := range cfg.TURNServers {
		if ts, ok := ParseExternalTURN(rawT); ok {
			iceServers = append(iceServers, ts)
		}
	}
	iceServers = append(iceServers, extraICEServers...)

	fps := cfg.FPS
	if fps <= 0 {
		fps = 30
	}

	ffmpegBin, encName, _ := DetectBestEncoder(cfg.FFmpegPath, cfg.Encoder)
	videoMode := "dc"
	if ffmpegBin != "" && encName != "dc" {
		videoMode = "rtp"
	}

	// Send initial handshake hello with ICE config, capabilities, and target list
	_ = sigWS.WriteJSON(SignalMessage{
		Type:           "hello",
		ICEServers:     iceServers,
		RemoteOS:       runtime.GOOS,
		VideoMode:      videoMode,
		Encoder:        encName,
		FPS:            fps,
		ActiveTargetID: activeTarget.ID,
		Targets:        targets,
	})

	// CDP command helper with monotonic IDs
	var cdpSeq atomic.Int64
	var cdpMu sync.Mutex
	evalPending := make(map[int64]chan string)

	sendCDP := func(method string, params map[string]any) int64 {
		id := cdpSeq.Add(1)
		inst.Touch()
		_ = cdpWS.WriteJSON(map[string]any{
			"id":     id,
			"method": method,
			"params": params,
		})
		return id
	}

	// Serial input queue so fast typing & IME commits never reorder
	inputCh := make(chan InputEvent, 256)
	var reliableDC atomic.Pointer[pionwebrtc.DataChannel]
	var videoDC atomic.Pointer[pionwebrtc.DataChannel]
	var fallbackMode atomic.Bool

	sendClipboardToClient := func(text string) {
		msg := SignalMessage{Type: "clipboard", ClipboardText: text}
		if dc := reliableDC.Load(); dc != nil && dc.ReadyState() == pionwebrtc.DataChannelStateOpen {
			if b, err := json.Marshal(msg); err == nil {
				_ = dc.SendText(string(b))
				return
			}
		}
		_ = sigWS.WriteJSON(msg)
	}

	go func() {
		for {
			select {
			case <-sessCtx.Done():
				return
			case ev := <-inputCh:
				if ev.Type == "copy" {
					id := cdpSeq.Add(1)
					resCh := make(chan string, 1)
					cdpMu.Lock()
					evalPending[id] = resCh
					cdpMu.Unlock()
					_ = cdpWS.WriteJSON(map[string]any{
						"id":     id,
						"method": "Runtime.evaluate",
						"params": map[string]any{
							"expression": `(function(){
								var s = window.getSelection ? window.getSelection().toString() : '';
								if (s) return s;
								var el = document.activeElement;
								if (el && typeof el.selectionStart === 'number' && el.selectionStart !== el.selectionEnd) {
									return (el.value || '').substring(el.selectionStart, el.selectionEnd);
								}
								return '';
							})()`,
							"returnByValue": true,
						},
					})
					go func(reqID int64, ch chan string) {
						select {
						case txt := <-ch:
							if txt != "" {
								sendClipboardToClient(txt)
							}
						case <-time.After(2 * time.Second):
							cdpMu.Lock()
							delete(evalPending, reqID)
							cdpMu.Unlock()
						}
					}(id, resCh)
					continue
				}
				if ev.Type == "createTab" {
					sendCDP("Target.createTarget", map[string]any{"url": "about:blank"})
					continue
				}
				for _, cmd := range TranslateInputEvent(ev, runtime.GOOS) {
					sendCDP(cmd.Method, cmd.Params)
				}
			}
		}
	}()

	enqueueInput := func(ev InputEvent) {
		// Mouse moves may be dropped when queue is saturated; reliable events wait briefly
		if ev.Type == "mousemove" {
			select {
			case inputCh <- ev:
			default:
			}
			return
		}
		select {
		case inputCh <- ev:
		case <-sessCtx.Done():
		}
	}

	// Setup WebRTC PeerConnection & H.264 RTP Track
	pc, err := pionwebrtc.NewPeerConnection(pionwebrtc.Configuration{
		ICEServers: iceServers,
	})
	if err != nil {
		_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "PeerConnection init failed: " + err.Error()})
		return
	}
	defer func() { _ = pc.Close() }()

	var videoTrack *pionwebrtc.TrackLocalStaticSample
	var h264Enc *H264PipeEncoder

	if videoMode == "rtp" {
		videoTrack, err = pionwebrtc.NewTrackLocalStaticSample(
			pionwebrtc.RTPCodecCapability{
				MimeType:    pionwebrtc.MimeTypeH264,
				ClockRate:   90000,
				SDPFmtpLine: "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
			},
			"browser-video",
			"browser-go-stream",
		)
		if err == nil {
			rtpSender, addErr := pc.AddTrack(videoTrack)
			if addErr == nil {
				h264Enc, err = StartH264PipeEncoder(sessCtx, ffmpegBin, encName, fps, func(au []byte, dur time.Duration, _ bool) {
					_ = videoTrack.WriteSample(media.Sample{Data: au, Duration: dur})
				})
				if err != nil {
					log.Warnf("H.264 encoder failed (%v), auto-falling back to WebRTC DataChannel video", err)
					videoMode = "dc"
				} else {
					defer h264Enc.Close()
					// Read incoming RTCP packets to trigger instant keyframe recovery on PLI/FIR
					go func() {
						rtcpBuf := make([]byte, 1500)
						for {
							n, _, rerr := rtpSender.Read(rtcpBuf)
							if rerr != nil {
								return
							}
							if pkts, perr := rtcp.Unmarshal(rtcpBuf[:n]); perr == nil {
								for _, pkt := range pkts {
									switch pkt.(type) {
									case *rtcp.PictureLossIndication, *rtcp.FullIntraRequest:
										h264Enc.ReemitKeyframe()
									}
								}
							}
						}
					}()
				}
			}
		}
	}

	pc.OnICECandidate(func(c *pionwebrtc.ICECandidate) {
		if c == nil {
			return
		}
		init := c.ToJSON()
		_ = sigWS.WriteJSON(SignalMessage{Type: "candidate", Candidate: &init})
	})

	pc.OnDataChannel(func(dc *pionwebrtc.DataChannel) {
		switch dc.Label() {
		case "input-rt", "input-reliable":
			if dc.Label() == "input-reliable" {
				reliableDC.Store(dc)
			}
			dc.OnMessage(func(msg pionwebrtc.DataChannelMessage) {
				var ev InputEvent
				if json.Unmarshal(msg.Data, &ev) == nil {
					enqueueInput(ev)
				}
			})
		case "video-dc":
			videoDC.Store(dc)
		}
	})

	// Enable Page domain & start CDP Screencast
	sendCDP("Page.enable", map[string]any{})
	sendCDP("Page.startScreencast", map[string]any{
		"format":        "jpeg",
		"quality":       80,
		"maxWidth":      1280,
		"maxHeight":     800,
		"everyNthFrame": 1,
	})
	defer sendCDP("Page.stopScreencast", map[string]any{})

	// Read CDP events from Chrome: feed screencast frames to H.264 encoder / DataChannel / Tunnel fallback
	var lastW, lastH float64
	go func() {
		for {
			_, raw, err := cdpWS.ReadMessage()
			if err != nil {
				sessCancel()
				return
			}
			var msg struct {
				ID     *int64          `json:"id"`
				Method string          `json:"method"`
				Params json.RawMessage `json:"params"`
				Result json.RawMessage `json:"result"`
			}
			if json.Unmarshal(raw, &msg) != nil {
				continue
			}

			if msg.ID != nil {
				cdpMu.Lock()
				ch, ok := evalPending[*msg.ID]
				if ok {
					delete(evalPending, *msg.ID)
				}
				cdpMu.Unlock()
				if ok {
					var evalRes struct {
						Result struct {
							Value string `json:"value"`
						} `json:"result"`
					}
					if json.Unmarshal(msg.Result, &evalRes) == nil {
						ch <- evalRes.Result.Value
					} else {
						ch <- ""
					}
				}
				continue
			}

			if msg.Method == "Page.screencastFrame" {
				var frame struct {
					Data      string `json:"data"`
					SessionID int    `json:"sessionId"`
					Metadata  struct {
						DeviceWidth  float64 `json:"deviceWidth"`
						DeviceHeight float64 `json:"deviceHeight"`
					} `json:"metadata"`
				}
				if json.Unmarshal(msg.Params, &frame) != nil {
					continue
				}
				// Acknowledge immediately to release Chrome compositor backpressure
				sendCDP("Page.screencastFrameAck", map[string]any{"sessionId": frame.SessionID})

				if frame.Metadata.DeviceWidth > 0 && (frame.Metadata.DeviceWidth != lastW || frame.Metadata.DeviceHeight != lastH) {
					lastW = frame.Metadata.DeviceWidth
					lastH = frame.Metadata.DeviceHeight
					_ = sigWS.WriteJSON(SignalMessage{
						Type:         "meta",
						DeviceWidth:  lastW,
						DeviceHeight: lastH,
					})
				}

				jpegBytes, decErr := base64.StdEncoding.DecodeString(frame.Data)
				if decErr != nil || len(jpegBytes) == 0 {
					continue
				}

				if fallbackMode.Load() {
					// Tunnel WebSocket fallback: send raw binary JPEG frame directly
					_ = sigWS.WriteBinary(jpegBytes)
				} else if h264Enc != nil && videoMode == "rtp" {
					h264Enc.PushJPEG(jpegBytes)
				} else if dc := videoDC.Load(); dc != nil && dc.ReadyState() == pionwebrtc.DataChannelStateOpen {
					// Zero-ffmpeg unordered WebRTC DataChannel binary JPEG frame
					if dc.BufferedAmount() < 512*1024 {
						_ = dc.Send(jpegBytes)
					}
				}
			}
		}
	}()

	// Signaling read loop (SDP Offer, Trickle ICE Candidates, Fallback trigger, and Fallback input events)
	for {
		_, raw, err := sigWS.ReadMessage()
		if err != nil {
			return
		}
		var sig SignalMessage
		if json.Unmarshal(raw, &sig) != nil {
			continue
		}
		switch sig.Type {
		case "offer":
			if err := pc.SetRemoteDescription(pionwebrtc.SessionDescription{
				Type: pionwebrtc.SDPTypeOffer,
				SDP:  sig.SDP,
			}); err != nil {
				_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "SetRemoteDescription: " + err.Error()})
				continue
			}
			answer, err := pc.CreateAnswer(nil)
			if err != nil {
				_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "CreateAnswer: " + err.Error()})
				continue
			}
			if err := pc.SetLocalDescription(answer); err != nil {
				_ = sigWS.WriteJSON(SignalMessage{Type: "error", Error: "SetLocalDescription: " + err.Error()})
				continue
			}
			_ = sigWS.WriteJSON(SignalMessage{Type: "answer", SDP: answer.SDP})

		case "candidate":
			if sig.Candidate != nil && strings.TrimSpace(sig.Candidate.Candidate) != "" {
				_ = pc.AddICECandidate(*sig.Candidate)
			}

		case "fallback":
			// Browser requested ProxyForge tunnel fallback after ICE timeout
			fallbackMode.Store(true)
			log.Infof("Live View session [%s] switched to ProxyForge tunnel fallback mode", userKey)

		case "input":
			if sig.Input != nil {
				enqueueInput(*sig.Input)
			}
		}
	}
}
