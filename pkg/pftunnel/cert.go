package pftunnel

import (
	"crypto"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/pem"
	"fmt"
	"math/big"
	"net"
	"os"
	"strings"
	"sync"
	"time"
)

var (
	defCertOnce sync.Once
	defTLSCert  tls.Certificate
)

func GetDefaultTLSCertificate() tls.Certificate {
	defCertOnce.Do(func() {
		certPEM, keyPEM, err := GenerateSelfSignedCAPEM("browser-go.local", 3650)
		if err == nil {
			if c, err := tls.X509KeyPair(certPEM, keyPEM); err == nil {
				defTLSCert = c
			}
		}
	})
	return defTLSCert
}

func CertFingerprintSHA256(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

func normalizeHexPin(s string) string {
	s = strings.ToLower(strings.TrimSpace(s))
	s = strings.TrimPrefix(s, "sha256:")
	s = strings.TrimPrefix(s, "sha256/")
	s = strings.ReplaceAll(s, ":", "")
	s = strings.ReplaceAll(s, " ", "")
	return s
}

func splitHostOnly(addr string) string {
	if h, _, err := net.SplitHostPort(addr); err == nil {
		return h
	}
	return addr
}

func loadResourceBytes(spec string) ([]byte, error) {
	spec = strings.TrimSpace(spec)
	if strings.HasPrefix(spec, "base64://") {
		return base64.StdEncoding.DecodeString(strings.TrimPrefix(spec, "base64://"))
	}
	if strings.HasPrefix(spec, "str://") {
		return []byte(strings.TrimPrefix(spec, "str://")), nil
	}
	return os.ReadFile(spec)
}

// GenerateSelfSignedCAPEM creates a ProxyForge-compatible RSA-2048 Root CA certificate and private key.
func GenerateSelfSignedCAPEM(domain string, validDays int) ([]byte, []byte, error) {
	if domain == "" {
		domain = "browser-go.local"
	}
	if validDays <= 0 {
		validDays = 3650
	}
	priv, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return nil, nil, err
	}
	serialMax := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, err := rand.Int(rand.Reader, serialMax)
	if err != nil {
		return nil, nil, err
	}
	tpl := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   domain,
			Organization: []string{"ProxyForge Certificate Authority"},
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(time.Duration(validDays) * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature | x509.KeyUsageCertSign,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
		IsCA:                  true,
		DNSNames:              []string{domain, "localhost", "*." + strings.TrimPrefix(domain, "*.")},
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")},
	}
	if ip := net.ParseIP(domain); ip != nil {
		tpl.IPAddresses = append(tpl.IPAddresses, ip)
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, &tpl, &tpl, &priv.PublicKey, priv)
	if err != nil {
		return nil, nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(priv)})
	return certPEM, keyPEM, nil
}

func parseSignerPEM(keyPEM []byte) (crypto.Signer, error) {
	blk, _ := pem.Decode(keyPEM)
	if blk == nil {
		return nil, fmt.Errorf("invalid private key PEM")
	}
	if k, err := x509.ParsePKCS1PrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	if k, err := x509.ParsePKCS8PrivateKey(blk.Bytes); err == nil {
		if s, ok := k.(crypto.Signer); ok {
			return s, nil
		}
	}
	if k, err := x509.ParseECPrivateKey(blk.Bytes); err == nil {
		return k, nil
	}
	return nil, fmt.Errorf("unsupported private key format")
}

// SignLeafPEM signs an ECDSA P-256 leaf certificate (ServerAuth + ClientAuth) from an existing CA.
func SignLeafPEM(caCertPEM, caKeyPEM []byte, domain string, validDays int) ([]byte, []byte, error) {
	caBlock, _ := pem.Decode(caCertPEM)
	if caBlock == nil {
		return nil, nil, fmt.Errorf("invalid CA certificate PEM")
	}
	caCert, err := x509.ParseCertificate(caBlock.Bytes)
	if err != nil {
		return nil, nil, err
	}
	caSigner, err := parseSignerPEM(caKeyPEM)
	if err != nil {
		return nil, nil, err
	}
	if domain == "" {
		domain = "node.browser-go.local"
	}
	if validDays <= 0 {
		validDays = 3650
	}
	leafPriv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	serialMax := new(big.Int).Lsh(big.NewInt(1), 128)
	serial, _ := rand.Int(rand.Reader, serialMax)
	tpl := x509.Certificate{
		SerialNumber: serial,
		Subject: pkix.Name{
			CommonName:   domain,
			Organization: []string{"ProxyForge Signed Node"},
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(time.Duration(validDays) * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth, x509.ExtKeyUsageClientAuth},
		BasicConstraintsValid: true,
	}
	if ip := net.ParseIP(domain); ip != nil {
		tpl.IPAddresses = []net.IP{ip, net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	} else {
		tpl.DNSNames = []string{domain, "localhost", "*." + strings.TrimPrefix(domain, "*.")}
		tpl.IPAddresses = []net.IP{net.ParseIP("127.0.0.1"), net.ParseIP("::1")}
	}
	derBytes, err := x509.CreateCertificate(rand.Reader, &tpl, caCert, &leafPriv.PublicKey, caSigner)
	if err != nil {
		return nil, nil, err
	}
	ecBytes, err := x509.MarshalECPrivateKey(leafPriv)
	if err != nil {
		return nil, nil, err
	}
	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: derBytes})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: ecBytes})
	return certPEM, keyPEM, nil
}

func LoadKeyPair(certSpec, keySpec string) (tls.Certificate, *x509.CertPool, error) {
	certSpec = strings.TrimSpace(certSpec)
	keySpec = strings.TrimSpace(keySpec)
	if certSpec == "" || certSpec == "default" || keySpec == "" {
		return GetDefaultTLSCertificate(), nil, nil
	}
	certBytes, err := loadResourceBytes(certSpec)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("load cert %q: %w", certSpec, err)
	}
	keyBytes, err := loadResourceBytes(keySpec)
	if err != nil {
		return tls.Certificate{}, nil, fmt.Errorf("load key %q: %w", keySpec, err)
	}
	pair, err := tls.X509KeyPair(certBytes, keyBytes)
	if err != nil {
		return tls.Certificate{}, nil, err
	}
	pool := x509.NewCertPool()
	pool.AppendCertsFromPEM(certBytes)
	return pair, pool, nil
}

func ServerTLSConfig(certSpec, keySpec string, singleTLS bool) (*tls.Config, error) {
	pair, pool, err := LoadKeyPair(certSpec, keySpec)
	if err != nil {
		return nil, err
	}
	cfg := &tls.Config{
		Certificates: []tls.Certificate{pair},
		MinVersion:   tls.VersionTLS12,
	}
	if !singleTLS && pool != nil && certSpec != "" && certSpec != "default" {
		cfg.ClientCAs = pool
		cfg.ClientAuth = tls.RequireAndVerifyClientCert
	}
	return cfg, nil
}

func BuildClientTLSConfig(certSpec, keySpec, caBundleSpec, pinSHA256, serverName string, singleTLS bool) (*tls.Config, error) {
	cfg := &tls.Config{
		InsecureSkipVerify: true,
		MinVersion:         tls.VersionTLS12,
	}
	if serverName != "" {
		cfg.ServerName = splitHostOnly(serverName)
	}
	if !singleTLS && certSpec != "" {
		if pair, _, err := LoadKeyPair(certSpec, keySpec); err == nil && len(pair.Certificate) > 0 {
			cfg.Certificates = []tls.Certificate{pair}
		}
	}
	caBundleSpec = strings.TrimSpace(caBundleSpec)
	if caBundleSpec != "" {
		caPEM, err := loadResourceBytes(caBundleSpec)
		if err != nil {
			return nil, fmt.Errorf("load CA bundle %q: %w", caBundleSpec, err)
		}
		pool := x509.NewCertPool()
		if !pool.AppendCertsFromPEM(caPEM) {
			return nil, fmt.Errorf("invalid CA bundle PEM %q", caBundleSpec)
		}
		cfg.RootCAs = pool
		cfg.InsecureSkipVerify = false
	}
	normPin := normalizeHexPin(pinSHA256)
	if normPin != "" {
		cfg.VerifyPeerCertificate = func(rawCerts [][]byte, _ [][]*x509.Certificate) error {
			for _, raw := range rawCerts {
				got := CertFingerprintSHA256(raw)
				if subtle.ConstantTimeCompare([]byte(got), []byte(normPin)) == 1 {
					return nil
				}
			}
			return fmt.Errorf("TLS peer certificate SHA-256 fingerprint mismatch (expected %s)", normPin)
		}
	}
	return cfg, nil
}
