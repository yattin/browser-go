package webrtc

import (
	"bytes"
	"testing"
)

func TestAnnexBParserSplitsAndCachesSPSPPSForIDR(t *testing.T) {
	// Build a synthetic Annex-B stream: SPS (type 7) + PPS (type 8) + IDR (type 5) + P-frame (type 1)
	var stream bytes.Buffer
	stream.Write([]byte{0x00, 0x00, 0x00, 0x01, 0x67, 0x42, 0x00, 0x1E}) // SPS
	stream.Write([]byte{0x00, 0x00, 0x00, 0x01, 0x68, 0xCE, 0x3C, 0x80}) // PPS
	stream.Write([]byte{0x00, 0x00, 0x00, 0x01, 0x65, 0x88, 0x84, 0x21}) // IDR
	stream.Write([]byte{0x00, 0x00, 0x01, 0x41, 0x9A, 0x22, 0x33})       // P-slice (3-byte start code)

	parser := NewAnnexBParser()
	type gotFrame struct {
		data []byte
		kf   bool
	}
	var frames []gotFrame

	if err := parser.ReadStream(&stream, func(au []byte, isKeyframe bool) {
		cp := make([]byte, len(au))
		copy(cp, au)
		frames = append(frames, gotFrame{data: cp, kf: isKeyframe})
	}); err != nil {
		t.Fatalf("ReadStream returned error: %v", err)
	}

	if len(frames) != 2 {
		t.Fatalf("expected 2 emitted frames (IDR + P), got %d", len(frames))
	}
	if !frames[0].kf {
		t.Fatalf("expected first frame to be keyframe")
	}
	if !bytes.Contains(frames[0].data, []byte{0x67, 0x42, 0x00, 0x1E}) {
		t.Fatalf("expected IDR Access Unit to include cached SPS")
	}
	if !bytes.Contains(frames[0].data, []byte{0x68, 0xCE, 0x3C, 0x80}) {
		t.Fatalf("expected IDR Access Unit to include cached PPS")
	}
	if !bytes.Contains(frames[0].data, []byte{0x65, 0x88, 0x84, 0x21}) {
		t.Fatalf("expected IDR Access Unit to include IDR slice")
	}

	if frames[1].kf {
		t.Fatalf("expected second frame to be non-keyframe P-slice")
	}
	if !bytes.Contains(frames[1].data, []byte{0x41, 0x9A, 0x22, 0x33}) {
		t.Fatalf("expected P-slice payload intact")
	}

	lastKF := parser.LastKeyframeAU()
	if !bytes.Equal(lastKF, frames[0].data) {
		t.Fatalf("expected LastKeyframeAU() to match cached IDR Access Unit")
	}
}
