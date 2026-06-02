#!/usr/bin/env bash
# Moonlight Web ACME Certificate Tool
# Obtains a Let's Encrypt SSL certificate using the server's built-in ACME challenge handler.
#
# Dependencies: openssl, curl, jq
#
# Usage:
#   ./acme-certificate.sh
#   ./acme-certificate.sh --domain myhost.example.com --server http://192.168.1.100:8080
#   ./acme-certificate.sh --staging   (use Let's Encrypt staging for testing)

set -euo pipefail

# Defaults
DOMAIN=""
SERVER_URL=""
OUTPUT_DIR="./server"
STAGING=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case "$1" in
        --domain|-d) DOMAIN="$2"; shift 2 ;;
        --server|-s) SERVER_URL="$2"; shift 2 ;;
        --output|-o) OUTPUT_DIR="$2"; shift 2 ;;
        --staging) STAGING=true; shift ;;
        --help|-h)
            echo "Usage: $0 [--domain DOMAIN] [--server URL] [--output DIR] [--staging]"
            exit 0 ;;
        *) echo "Unknown option: $1"; exit 1 ;;
    esac
done

echo "=== Moonlight Web ACME Certificate Tool ==="
echo ""

# Prompt for Domain if not provided
if [[ -z "$DOMAIN" ]]; then
    echo "Enter the domain name to obtain a certificate for."
    echo "  Example: myhost.asuscomm.com"
    read -rp "Domain: " DOMAIN
    if [[ -z "$DOMAIN" ]]; then
        echo "Error: Domain is required." >&2
        exit 1
    fi
fi

# Prompt for ServerUrl if not provided
if [[ -z "$SERVER_URL" ]]; then
    echo ""
    echo "Enter the URL of your Moonlight Web server (used to set the challenge token)."
    echo "  Example: http://192.168.1.100:8080"
    echo "  Note: port 80 must be forwarded to this server on your router for Let's Encrypt validation."
    read -rp "Server URL [http://localhost:8080]: " SERVER_URL
    SERVER_URL="${SERVER_URL:-http://localhost:8080}"
fi

if $STAGING; then
    ACME_DIR="https://acme-staging-v02.api.letsencrypt.org/directory"
else
    ACME_DIR="https://acme-v02.api.letsencrypt.org/directory"
fi

echo ""
echo "Domain: $DOMAIN"
echo "Server: $SERVER_URL"
echo "ACME:   $(if $STAGING; then echo 'STAGING'; else echo 'PRODUCTION'; fi)"
echo ""

# Check dependencies
for cmd in openssl curl jq; do
    if ! command -v "$cmd" &>/dev/null; then
        echo "Error: '$cmd' is required but not found. Install it and try again." >&2
        exit 1
    fi
done

# Ensure output directory exists
mkdir -p "$OUTPUT_DIR"

# Helper: Base64url encode (stdin -> stdout)
base64url() {
    openssl base64 -A | tr '+/' '-_' | tr -d '='
}

# Helper: Base64url encode a file
base64url_file() {
    openssl base64 -A -in "$1" | tr '+/' '-_' | tr -d '='
}

# Helper: SHA-256 hash (stdin -> raw bytes stdout)
sha256() {
    openssl dgst -sha256 -binary
}

# Helper: Sign with RSA-SHA256 (stdin -> base64url stdout)
sign_rs256() {
    openssl dgst -sha256 -sign "$1" | base64url
}

# Step 1: Generate or load account key
ACCOUNT_KEY="$OUTPUT_DIR/acme-account-key.pem"
if [[ -f "$ACCOUNT_KEY" ]]; then
    echo "[1/7] Loading existing account key..."
else
    echo "[1/7] Generating new account key (RSA 2048)..."
    openssl genrsa 2048 > "$ACCOUNT_KEY" 2>/dev/null
fi

# Extract public key components for JWK
MODULUS=$(openssl rsa -in "$ACCOUNT_KEY" -noout -modulus 2>/dev/null | cut -d= -f2 | xxd -r -p | base64url)
# Get exponent
EXPONENT=$(openssl rsa -in "$ACCOUNT_KEY" -noout -text 2>/dev/null | grep -A1 "publicExponent" | tail -1 | tr -d ' :' | sed 's/^0*//' | xxd -r -p | base64url 2>/dev/null || echo "AQAB")
# For standard RSA, exponent is almost always 65537 = 0x010001 = AQAB
EXPONENT="AQAB"

# JWK and thumbprint
JWK_JSON=$(printf '{"e":"%s","kty":"RSA","n":"%s"}' "$EXPONENT" "$MODULUS")
THUMBPRINT=$(printf '%s' "$JWK_JSON" | sha256 | base64url)

# Helper: Create JWS request body
jws_request() {
    local url="$1"
    local payload="$2"
    local nonce="$3"
    local kid="${4:-}"

    local header
    if [[ -n "$kid" ]]; then
        header=$(printf '{"alg":"RS256","kid":"%s","nonce":"%s","url":"%s"}' "$kid" "$nonce" "$url")
    else
        header=$(printf '{"alg":"RS256","jwk":%s,"nonce":"%s","url":"%s"}' "$JWK_JSON" "$nonce" "$url")
    fi

    local header_b64
    header_b64=$(printf '%s' "$header" | base64url)

    local payload_b64
    if [[ "$payload" == "EMPTY" ]]; then
        payload_b64=""
    else
        payload_b64=$(printf '%s' "$payload" | base64url)
    fi

    local signing_input="${header_b64}.${payload_b64}"
    local signature
    signature=$(printf '%s' "$signing_input" | sign_rs256 "$ACCOUNT_KEY")

    printf '{"protected":"%s","payload":"%s","signature":"%s"}' "$header_b64" "$payload_b64" "$signature"
}

# Step 2: Get ACME directory
echo "[2/7] Fetching ACME directory..."
DIRECTORY=$(curl -sS "$ACME_DIR")
NEW_NONCE_URL=$(echo "$DIRECTORY" | jq -r '.newNonce')
NEW_ACCOUNT_URL=$(echo "$DIRECTORY" | jq -r '.newAccount')
NEW_ORDER_URL=$(echo "$DIRECTORY" | jq -r '.newOrder')

# Get initial nonce
get_nonce() {
    curl -sS -I "$NEW_NONCE_URL" 2>/dev/null | grep -i "replay-nonce" | awk '{print $2}' | tr -d '\r'
}

# Step 3: Create/find account
echo "[3/7] Registering ACME account..."
NONCE=$(get_nonce)
ACCOUNT_PAYLOAD='{"termsOfServiceAgreed":true}'
BODY=$(jws_request "$NEW_ACCOUNT_URL" "$ACCOUNT_PAYLOAD" "$NONCE")

RESPONSE=$(curl -sS -D /dev/stderr -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$NEW_ACCOUNT_URL" 2>"$OUTPUT_DIR/.headers")
ACCOUNT_URL=$(grep -i "^location:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
echo "  Account: $ACCOUNT_URL"

# Step 4: Create order
echo "[4/7] Creating certificate order for $DOMAIN..."
ORDER_PAYLOAD=$(printf '{"identifiers":[{"type":"dns","value":"%s"}]}' "$DOMAIN")
BODY=$(jws_request "$NEW_ORDER_URL" "$ORDER_PAYLOAD" "$NONCE" "$ACCOUNT_URL")

RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$NEW_ORDER_URL")
ORDER_URL=$(grep -i "^location:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
ORDER_STATUS=$(echo "$RESPONSE" | jq -r '.status')
FINALIZE_URL=$(echo "$RESPONSE" | jq -r '.finalize')
AUTHZ_URL=$(echo "$RESPONSE" | jq -r '.authorizations[0]')
echo "  Order status: $ORDER_STATUS"

# Step 5: Process authorization (HTTP-01 challenge)
echo "[5/7] Setting up HTTP-01 challenge..."
BODY=$(jws_request "$AUTHZ_URL" "EMPTY" "$NONCE" "$ACCOUNT_URL")
RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$AUTHZ_URL")
NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')

TOKEN=$(echo "$RESPONSE" | jq -r '.challenges[] | select(.type=="http-01") | .token')
CHALLENGE_URL=$(echo "$RESPONSE" | jq -r '.challenges[] | select(.type=="http-01") | .url')

if [[ -z "$TOKEN" || "$TOKEN" == "null" ]]; then
    echo "Error: No HTTP-01 challenge available!" >&2
    exit 1
fi

KEY_AUTH="${TOKEN}.${THUMBPRINT}"
echo "  Token: $TOKEN"
echo "  Key Authorization: ${KEY_AUTH:0:40}..."

# Set the challenge on our server
echo "  Setting challenge on server..."
HTTP_CODE=$(curl -sS -o /dev/null -w "%{http_code}" -X PUT \
    -H "Content-Type: text/plain" \
    -d "$KEY_AUTH" "$SERVER_URL/api/acme/challenge/$TOKEN")

if [[ "$HTTP_CODE" == "200" ]]; then
    echo "  Challenge set successfully!"
else
    echo "Error: Failed to set challenge on server (HTTP $HTTP_CODE)" >&2
    echo "  Make sure the server is running."
    exit 1
fi

# Verify it's accessible
echo "  Verifying challenge is accessible..."
VERIFY=$(curl -sS "$SERVER_URL/.well-known/acme-challenge/$TOKEN" 2>/dev/null || true)
if [[ "$VERIFY" == "$KEY_AUTH" ]]; then
    echo "  Verification OK!"
else
    echo "  Warning: Challenge response doesn't match or not accessible locally (may be OK if behind NAT)"
fi

# Step 6: Notify ACME server we're ready
echo "[6/7] Notifying ACME server to validate..."
BODY=$(jws_request "$CHALLENGE_URL" '{}' "$NONCE" "$ACCOUNT_URL")
RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$CHALLENGE_URL")
NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')

# Poll for validation
for i in $(seq 1 30); do
    sleep 2
    BODY=$(jws_request "$AUTHZ_URL" "EMPTY" "$NONCE" "$ACCOUNT_URL")
    RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
        -H "Content-Type: application/jose+json" \
        -d "$BODY" "$AUTHZ_URL")
    NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
    STATUS=$(echo "$RESPONSE" | jq -r '.status')
    printf "  Authorization status: %s" "$STATUS"

    if [[ "$STATUS" == "valid" ]]; then
        echo " - Success!"
        break
    elif [[ "$STATUS" == "invalid" ]]; then
        echo ""
        DETAIL=$(echo "$RESPONSE" | jq -r '.challenges[] | select(.type=="http-01") | .error.detail // "unknown"')
        echo "Error: Challenge validation failed: $DETAIL" >&2
        curl -sS -X DELETE "$SERVER_URL/api/acme/challenge/$TOKEN" >/dev/null 2>&1 || true
        exit 1
    fi
    echo ""
done

# Cleanup challenge
curl -sS -X DELETE "$SERVER_URL/api/acme/challenge/$TOKEN" >/dev/null 2>&1 || true

# Step 7: Finalize order and download certificate
echo "[7/7] Finalizing order and downloading certificate..."

# Generate certificate private key and CSR
CERT_KEY="$OUTPUT_DIR/key.pem"
openssl genrsa 2048 > "$CERT_KEY" 2>/dev/null
CSR_DER=$(openssl req -new -key "$CERT_KEY" -subj "/CN=$DOMAIN" -outform DER 2>/dev/null | base64url)

# Finalize order
FINALIZE_PAYLOAD=$(printf '{"csr":"%s"}' "$CSR_DER")
BODY=$(jws_request "$FINALIZE_URL" "$FINALIZE_PAYLOAD" "$NONCE" "$ACCOUNT_URL")
RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$FINALIZE_URL")
NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
ORDER_STATUS=$(echo "$RESPONSE" | jq -r '.status')
CERT_URL=$(echo "$RESPONSE" | jq -r '.certificate // empty')

# Poll order until ready
for i in $(seq 1 30); do
    if [[ "$ORDER_STATUS" == "valid" && -n "$CERT_URL" ]]; then break; fi
    sleep 2
    BODY=$(jws_request "$ORDER_URL" "EMPTY" "$NONCE" "$ACCOUNT_URL")
    RESPONSE=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
        -H "Content-Type: application/jose+json" \
        -d "$BODY" "$ORDER_URL")
    NONCE=$(grep -i "^replay-nonce:" "$OUTPUT_DIR/.headers" | awk '{print $2}' | tr -d '\r')
    ORDER_STATUS=$(echo "$RESPONSE" | jq -r '.status')
    CERT_URL=$(echo "$RESPONSE" | jq -r '.certificate // empty')
    echo "  Order status: $ORDER_STATUS"
done

if [[ "$ORDER_STATUS" != "valid" ]]; then
    echo "Error: Order did not become valid in time" >&2
    exit 1
fi

# Download certificate
BODY=$(jws_request "$CERT_URL" "EMPTY" "$NONCE" "$ACCOUNT_URL")
CERT_PEM=$(curl -sS -D "$OUTPUT_DIR/.headers" -X POST \
    -H "Content-Type: application/jose+json" \
    -d "$BODY" "$CERT_URL")

CERT_PATH="$OUTPUT_DIR/cert.pem"
printf '%s\n' "$CERT_PEM" > "$CERT_PATH"

# Cleanup temp files
rm -f "$OUTPUT_DIR/.headers"

echo ""
echo "=== Certificate obtained successfully! ==="
echo "  Certificate: $CERT_PATH"
echo "  Private Key: $CERT_KEY"
echo ""
echo "To use this certificate, update your server/config.json:"
echo "  \"certificate\": {"
echo "    \"certificate_pem\": \"$CERT_PATH\","
echo "    \"private_key_pem\": \"$CERT_KEY\""
echo "  }"
echo ""
echo "Then restart the server."
