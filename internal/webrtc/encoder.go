package webrtc

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"time"
)

var (
	probeOnce      sync.Once
	cachedFFmpeg   string
	cachedEncoder  string
	cachedProbeErr error
)

// DetectBestEncoder probes local ffmpeg and tests hardware H.264 encoders before falling back to libx264.
func DetectBestEncoder(explicitFFmpeg, preference string) (ffmpegBin string, encoderName string, err error) {
	pref := strings.ToLower(strings.TrimSpace(preference))
	if pref == "dc" || pref == "none" {
		return "", "dc", nil
	}

	if explicitFFmpeg == "" && (pref == "" || pref == "auto") {
		probeOnce.Do(func() {
			cachedFFmpeg, cachedEncoder, cachedProbeErr = runEncoderProbe("", "auto")
		})
		return cachedFFmpeg, cachedEncoder, cachedProbeErr
	}
	return runEncoderProbe(explicitFFmpeg, pref)
}

func runEncoderProbe(explicitFFmpeg, pref string) (string, string, error) {
	bin := strings.TrimSpace(explicitFFmpeg)
	if bin == "" {
		lp, err := exec.LookPath("ffmpeg")
		if err != nil {
			return "", "dc", errors.New("ffmpeg not found in PATH")
		}
		bin = lp
	}

	var candidates []string
	switch pref {
	case "nvenc":
		candidates = []string{"h264_nvenc", "libx264"}
	case "qsv":
		candidates = []string{"h264_qsv", "libx264"}
	case "amf":
		candidates = []string{"h264_amf", "libx264"}
	case "mf":
		candidates = []string{"h264_mf", "libx264"}
	case "x264", "libx264":
		candidates = []string{"libx264"}
	default: // "auto"
		candidates = []string{"h264_nvenc", "h264_qsv", "h264_amf", "libx264"}
	}

	for _, enc := range candidates {
		if testFFmpegEncoder(bin, enc) {
			return bin, enc, nil
		}
	}
	return "", "dc", errors.New("no usable H.264 encoder found in ffmpeg")
}

func testFFmpegEncoder(bin, enc string) bool {
	ctx, cancel := context.WithTimeout(context.Background(), 2200*time.Millisecond)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin,
		"-hide_banner", "-loglevel", "error",
		"-f", "lavfi", "-i", "color=c=black:s=128x128:d=0.05",
		"-frames:v", "1",
		"-pix_fmt", "yuv420p",
		"-c:v", enc,
		"-f", "h264", "pipe:1",
	)
	out, err := cmd.Output()
	return err == nil && len(out) > 16
}

func buildEncoderArgs(enc string, fps int) []string {
	if fps <= 0 {
		fps = 30
	}
	gop := strconv.Itoa(fps) // 1 keyframe per second for fast join & packet-loss recovery
	base := []string{
		"-hide_banner",
		"-loglevel", "error",
		"-probesize", "65536",
		"-analyzeduration", "0",
		"-fflags", "nobuffer",
		"-flags", "low_delay",
		"-f", "image2pipe",
		"-vcodec", "mjpeg",
		"-framerate", strconv.Itoa(fps),
		"-i", "pipe:0",
		"-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2:in_range=full:out_range=limited,format=yuv420p",
		"-pix_fmt", "yuv420p",
		"-an",
	}

	switch enc {
	case "h264_nvenc":
		base = append(base, "-c:v", "h264_nvenc", "-profile:v", "baseline", "-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-bf", "0", "-g", gop, "-b:v", "2500k", "-maxrate", "3500k", "-bufsize", "1200k")
	case "h264_qsv":
		base = append(base, "-c:v", "h264_qsv", "-profile:v", "baseline", "-preset", "veryfast", "-bf", "0", "-g", gop, "-b:v", "2500k")
	case "h264_amf":
		base = append(base, "-c:v", "h264_amf", "-profile:v", "constrained_baseline", "-usage", "ultralowlatency", "-bf", "0", "-g", gop, "-b:v", "2500k")
	case "h264_mf":
		base = append(base, "-c:v", "h264_mf", "-scenario", "low_latency", "-rate_control", "cbr", "-b:v", "2500k", "-g", gop)
	default: // libx264 ultra-low-latency Constrained Baseline (single-slice per frame for clean RTP packetization)
		base = append(base,
			"-c:v", "libx264",
			"-preset", "ultrafast",
			"-tune", "zerolatency",
			"-profile:v", "baseline",
			"-level", "3.1",
			"-bf", "0",
			"-g", gop,
			"-keyint_min", strconv.Itoa(fps/2),
			"-rc-lookahead", "0",
			"-x264-params", "sliced-threads=0:repeat-headers=1:annexb=1",
			"-b:v", "2200k",
			"-maxrate", "3200k",
			"-bufsize", "1000k",
			"-threads", "1",
		)
	}

	return append(base, "-flush_packets", "1", "-f", "h264", "pipe:1")
}

// H264PipeEncoder streams latest CDP JPEG frames through a persistent low-latency ffmpeg H.264 encoder.
// Old unencoded frames are dropped so end-to-end latency never accumulates.
type H264PipeEncoder struct {
	ffmpegBin string
	encoder   string
	fps       int
	parser    *AnnexBParser
	onAU      func(au []byte, duration time.Duration, isKeyframe bool)

	cmd    *exec.Cmd
	stdin  io.WriteCloser
	stdout io.ReadCloser

	frameMu     sync.Mutex
	latestJPEG  []byte
	frameSeq    uint64
	frameSignal chan struct{}

	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func StartH264PipeEncoder(
	parentCtx context.Context,
	ffmpegBin, encoder string,
	fps int,
	onAU func(au []byte, duration time.Duration, isKeyframe bool),
) (*H264PipeEncoder, error) {
	if fps <= 0 {
		fps = 30
	}
	ctx, cancel := context.WithCancel(parentCtx)
	args := buildEncoderArgs(encoder, fps)
	cmd := exec.CommandContext(ctx, ffmpegBin, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		cancel()
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		cancel()
		return nil, fmt.Errorf("start ffmpeg (%s): %w", encoder, err)
	}

	e := &H264PipeEncoder{
		ffmpegBin:   ffmpegBin,
		encoder:     encoder,
		fps:         fps,
		parser:      NewAnnexBParser(),
		onAU:        onAU,
		cmd:         cmd,
		stdin:       stdin,
		stdout:      stdout,
		frameSignal: make(chan struct{}, 1),
		ctx:         ctx,
		cancel:      cancel,
	}

	e.wg.Add(2)
	go e.feedLoop()
	go e.readLoop()
	return e, nil
}

// PushJPEG copies and overwrites the single latest-frame slot (drop-old policy for constant low latency).
func (e *H264PipeEncoder) PushJPEG(jpegBytes []byte) {
	if len(jpegBytes) == 0 {
		return
	}
	cp := make([]byte, len(jpegBytes))
	copy(cp, jpegBytes)
	e.PushJPEGOwned(cp)
}

// PushJPEGOwned takes ownership of a freshly allocated JPEG buffer without an extra heap copy.
func (e *H264PipeEncoder) PushJPEGOwned(jpegBytes []byte) {
	if len(jpegBytes) == 0 {
		return
	}
	e.frameMu.Lock()
	e.latestJPEG = jpegBytes
	e.frameSeq++
	e.frameMu.Unlock()

	select {
	case e.frameSignal <- struct{}{}:
	default:
	}
}

// ReemitKeyframe immediately emits the last cached SPS+PPS+IDR Access Unit upon RTCP PLI.
func (e *H264PipeEncoder) ReemitKeyframe() {
	if kf := e.parser.LastKeyframeAU(); len(kf) > 0 && e.onAU != nil {
		e.onAU(kf, time.Second/time.Duration(e.fps), true)
	}
	// Also nudge pacer to feed a fresh frame into ffmpeg
	select {
	case e.frameSignal <- struct{}{}:
	default:
	}
}

func (e *H264PipeEncoder) feedLoop() {
	defer e.wg.Done()
	defer func() { _ = e.stdin.Close() }()

	minInterval := time.Second / time.Duration(e.fps)
	if minInterval > 16*time.Millisecond {
		// Allow up to 60Hz burst frame delivery during interactive dragging for ultra-low visual lag
		minInterval = 16 * time.Millisecond
	}
	// Smart adaptive keepalive: fast 400ms warm-up for first 3 static frames so WebRTC decodes instantly,
	// then back off to 3s while page is idle to cut static CPU & uplink overhead by >80%.
	const fastIdle = 400 * time.Millisecond
	const slowIdle = 3000 * time.Millisecond
	idleTimer := time.NewTimer(fastIdle)
	defer idleTimer.Stop()

	var lastSentSeq uint64
	var lastWrite time.Time
	var staticRepeats int

	writeLatest := func(force bool) bool {
		e.frameMu.Lock()
		frame := e.latestJPEG
		seq := e.frameSeq
		e.frameMu.Unlock()

		if len(frame) == 0 {
			return true
		}
		if !force && seq == lastSentSeq {
			return true
		}
		if elapsed := time.Since(lastWrite); elapsed < minInterval {
			wait := time.NewTimer(minInterval - elapsed)
			select {
			case <-e.ctx.Done():
				wait.Stop()
				return false
			case <-wait.C:
			}
		}
		if _, err := e.stdin.Write(frame); err != nil {
			return false
		}
		if seq != lastSentSeq {
			staticRepeats = 0
		} else {
			staticRepeats++
		}
		lastSentSeq = seq
		lastWrite = time.Now()
		return true
	}

	resetIdle := func() {
		next := fastIdle
		if staticRepeats >= 3 {
			next = slowIdle
		}
		if !idleTimer.Stop() {
			select {
			case <-idleTimer.C:
			default:
			}
		}
		idleTimer.Reset(next)
	}

	for {
		select {
		case <-e.ctx.Done():
			return
		case <-e.frameSignal:
			if !writeLatest(false) {
				return
			}
			resetIdle()
		case <-idleTimer.C:
			if !writeLatest(true) {
				return
			}
			resetIdle()
		}
	}
}

func (e *H264PipeEncoder) readLoop() {
	defer e.wg.Done()
	frameDur := time.Second / time.Duration(e.fps)
	lastEmit := time.Now()

	_ = e.parser.ReadStream(e.stdout, func(au []byte, isKeyframe bool) {
		now := time.Now()
		dur := now.Sub(lastEmit)
		if dur <= 0 || dur > 500*time.Millisecond {
			dur = frameDur
		}
		lastEmit = now
		if e.onAU != nil {
			e.onAU(au, dur, isKeyframe)
		}
	})
}

func (e *H264PipeEncoder) Close() {
	if e == nil {
		return
	}
	e.cancel()
	_ = e.stdin.Close()
	if e.cmd != nil && e.cmd.Process != nil {
		_ = e.cmd.Process.Kill()
		_ = e.cmd.Wait()
	}
	e.wg.Wait()
}
