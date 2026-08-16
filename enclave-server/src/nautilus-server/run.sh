#!/bin/sh
export LD_LIBRARY_PATH=/lib:$LD_LIBRARY_PATH
busybox ip addr add 127.0.0.1/32 dev lo
busybox ip link set dev lo up
echo "127.0.0.1   localhost" > /etc/hosts

# A Nitro Enclave has no network interface at all beyond loopback -- only vsock -- so an app that
# needs real outbound HTTPS (e.g. kms_secrets.rs's attestation-gated KMS Decrypt call) can't just
# open a normal TCP connection. This maps the KMS hostname to loopback and bridges that loopback
# port to the parent instance's own vsock-proxy (CID 3 is the reserved parent-instance CID from
# inside any enclave; port 8000 is where the parent's nitro-enclaves-vsock-proxy service listens,
# forwarding on to kms.<region>.amazonaws.com:443 per its own allowlist) -- the parent-side proxy
# is the piece that actually opens the real TCP/TLS connection out to KMS.
echo "127.0.0.1   kms.us-east-1.amazonaws.com" >> /etc/hosts
socat TCP4-LISTEN:443,bind=127.0.0.1,reuseaddr,fork VSOCK-CONNECT:3:8000 &

JSON_RESPONSE=$(socat - VSOCK-LISTEN:7777,reuseaddr)
echo "$JSON_RESPONSE" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > /tmp/kvpairs
while IFS="=" read -r key value; do export "$key"="$value"; done < /tmp/kvpairs
rm -f /tmp/kvpairs

socat VSOCK-LISTEN:3000,reuseaddr,fork TCP:localhost:3000 &
/nautilus-server
