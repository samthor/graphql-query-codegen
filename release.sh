#!/bin/bash

set -eu
rm -rf dist/
mkdir -p dist/

# Build binary (esbuild is fine, no types needed)
esbuild --bundle --format=esm --platform=node src/bin.ts > dist/bin.js

# Build library
esbuild --bundle --format=esm --platform=node src/index.ts > dist/index.js

# Build types (with tsc, need .d.ts generation)
tsc \
  --outdir dist/types/ \
  --target esnext src/index.ts \
  --moduleResolution node \
  --emitDeclarationOnly \
  --declaration
