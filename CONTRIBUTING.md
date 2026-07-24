# Contributing to Moodeur

Thanks for helping improve Moodeur.

## Development

Moodeur uses a plain HTML/CSS/JavaScript frontend and a Rust/Tauri backend. See
the developer setup in the [README](README.md#developer-setup), then run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml --all -- --check
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features --locked -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml --locked
```

Keep changes focused, add or update tests for backend behavior, and verify the
relevant platform bundle when changing packaging or sidecar integration.

## Pull requests

1. Branch from `main`.
2. Explain the behavior and motivation in the pull request.
3. Keep `Cargo.lock` committed when dependencies change.
4. Wait for CI, dependency review, and code scanning to pass.
5. Resolve review conversations before squash-merging.

Please report security issues through
[GitHub private vulnerability reporting](https://github.com/Zeclown/Moodeur/security/advisories/new),
not through a public issue.

## Releases

Releases use semantic version tags. Maintainers update the version in both
`src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`, merge the change to
`main`, then push an annotated `vX.Y.Z` tag. The release workflow rejects tags
whose version does not match the source.
