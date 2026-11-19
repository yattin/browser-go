package webrtc

import (
	"bytes"
	"io"
)

// AnnexBParser splits a raw H.264 Annex-B byte stream into complete Access Units (NALUs)
// suitable for pion/webrtc TrackLocalStaticSample.WriteSample, caching SPS/PPS to prepend before every IDR.
type AnnexBParser struct {
	lastSPS        []byte
	lastPPS        []byte
	lastKeyframeAU []byte
	buf            []byte
}

func NewAnnexBParser() *AnnexBParser {
	return &AnnexBParser{
		buf: make([]byte, 0, 256*1024),
	}
}

// LastKeyframeAU returns a copy of the most recently seen SPS+PPS+IDR Access Unit (for instant PLI recovery).
func (p *AnnexBParser) LastKeyframeAU() []byte {
	if len(p.lastKeyframeAU) == 0 {
		return nil
	}
	cp := make([]byte, len(p.lastKeyframeAU))
	copy(cp, p.lastKeyframeAU)
	return cp
}

// ReadStream continuously reads from r and invokes onAU for every complete video frame Access Unit.
func (p *AnnexBParser) ReadStream(r io.Reader, onAU func(au []byte, isKeyframe bool)) error {
	tmp := make([]byte, 64*1024)
	for {
		n, err := r.Read(tmp)
		if n > 0 {
			p.buf = append(p.buf, tmp[:n]...)
			p.drainNALUs(onAU)
		}
		if err != nil {
			if err == io.EOF {
				// Flush trailing NALU
				if len(p.buf) > 4 {
					p.processNALU(stripStartCode(p.buf), onAU)
				}
				return nil
			}
			return err
		}
	}
}

func findStartCode(b []byte, from int) (pos int, scLen int) {
	n := len(b)
	for i := from; i+2 < n; i++ {
		if b[i] == 0 && b[i+1] == 0 {
			if b[i+2] == 1 {
				return i, 3
			}
			if i+3 < n && b[i+2] == 0 && b[i+3] == 1 {
				return i, 4
			}
		}
	}
	return -1, 0
}

func stripStartCode(b []byte) []byte {
	if len(b) >= 4 && b[0] == 0 && b[1] == 0 && b[2] == 0 && b[3] == 1 {
		return b[4:]
	}
	if len(b) >= 3 && b[0] == 0 && b[1] == 0 && b[2] == 1 {
		return b[3:]
	}
	return b
}

func (p *AnnexBParser) drainNALUs(onAU func(au []byte, isKeyframe bool)) {
	firstPos, firstLen := findStartCode(p.buf, 0)
	if firstPos < 0 {
		// Prevent unbounded buffer growth if stream has garbage
		if len(p.buf) > 4*1024*1024 {
			p.buf = p.buf[:0]
		}
		return
	}
	if firstPos > 0 {
		rem := copy(p.buf, p.buf[firstPos:])
		p.buf = p.buf[:rem]
		firstPos = 0
	}

	curStart := firstPos + firstLen
	consumed := 0
	for {
		nextPos, nextLen := findStartCode(p.buf, curStart)
		if nextPos < 0 {
			break
		}
		nalu := p.buf[curStart:nextPos]
		if len(nalu) > 0 {
			p.processNALU(nalu, onAU)
		}
		consumed = nextPos
		curStart = nextPos + nextLen
	}
	// Compact remaining tail back to index 0 so the backing array never drifts/grows unboundedly
	if consumed > 0 {
		rem := copy(p.buf, p.buf[consumed:])
		p.buf = p.buf[:rem]
	} else if firstPos > 0 {
		rem := copy(p.buf, p.buf[firstPos:])
		p.buf = p.buf[:rem]
	}
}

func (p *AnnexBParser) processNALU(nalu []byte, onAU func(au []byte, isKeyframe bool)) {
	if len(nalu) == 0 {
		return
	}
	nalType := nalu[0] & 0x1F
	switch nalType {
	case 7: // SPS
		p.lastSPS = append(p.lastSPS[:0], nalu...)
	case 8: // PPS
		p.lastPPS = append(p.lastPPS[:0], nalu...)
	case 5: // IDR Keyframe — prepend cached SPS + PPS into a single Annex-B Access Unit
		var au bytes.Buffer
		if len(p.lastSPS) > 0 {
			au.Write([]byte{0, 0, 0, 1})
			au.Write(p.lastSPS)
		}
		if len(p.lastPPS) > 0 {
			au.Write([]byte{0, 0, 0, 1})
			au.Write(p.lastPPS)
		}
		au.Write([]byte{0, 0, 0, 1})
		au.Write(nalu)
		out := au.Bytes()
		p.lastKeyframeAU = append(p.lastKeyframeAU[:0], out...)
		onAU(out, true)
	case 1: // Non-IDR Slice (P-frame)
		out := make([]byte, 4+len(nalu))
		out[3] = 1
		copy(out[4:], nalu)
		onAU(out, false)
	default:
		// Ignore AUD (9), SEI (6), filler (12) for minimal RTP overhead
	}
}
