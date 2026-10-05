#!/usr/bin/env bash
# Generates the keys and genesis file of a four-validator QBFT network with the Besu operator
# tool and prepares the node directories mounted by docker-compose.yml.
# Requires Docker. Not executed in the authors' build environment (see besu/README.md).
set -euo pipefail
cd "$(dirname "$0")"
BESU_IMAGE="${BESU_IMAGE:-hyperledger/besu:latest}"
rm -rf networkFiles nodes .env
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD":/work -w /work "$BESU_IMAGE" \
  operator generate-blockchain-config \
  --config-file=qbftConfigFile.json --to=networkFiles --private-key-file-name=key
i=1
for keydir in networkFiles/keys/*; do
  mkdir -p "nodes/node$i/data"
  cp "$keydir/key" "$keydir/key.pub" "nodes/node$i/data/"
  i=$((i + 1))
done
cp networkFiles/genesis.json nodes/genesis.json
NODE1_PUB="$(sed 's/^0x//' nodes/node1/data/key.pub)"
cat > .env <<ENV
BESU_IMAGE=${BESU_IMAGE}
HOST_UID=$(id -u)
HOST_GID=$(id -g)
BOOTNODE=enode://${NODE1_PUB}@172.16.240.11:30303
ENV
echo "Generated $((i - 1)) validator keys in ./nodes; bootnode written to ./.env"
