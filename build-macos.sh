#!/usr/bin/env sh
set -eu

chmod +x src-tauri/binaries/*-apple-darwin
cargo test --manifest-path src-tauri/Cargo.toml
cargo tauri build --bundles app,dmg

echo "Unsigned Moodeur artifacts are in src-tauri/target/release/bundle/."
