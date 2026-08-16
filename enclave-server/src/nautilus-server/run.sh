#!/bin/sh
export LD_LIBRARY_PATH=/lib:$LD_LIBRARY_PATH
busybox ip addr add 127.0.0.1/32 dev lo
busybox ip link set dev lo up
echo "127.0.0.1   localhost" > /etc/hosts

JSON_RESPONSE=$(socat - VSOCK-LISTEN:7777,reuseaddr)
echo "$JSON_RESPONSE" | jq -r 'to_entries[] | "\(.key)=\(.value)"' > /tmp/kvpairs
while IFS="=" read -r key value; do export "$key"="$value"; done < /tmp/kvpairs
rm -f /tmp/kvpairs

socat VSOCK-LISTEN:3000,reuseaddr,fork TCP:localhost:3000 &
/nautilus-server
