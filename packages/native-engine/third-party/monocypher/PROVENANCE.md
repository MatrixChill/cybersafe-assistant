# Monocypher 4.0.3

Source: https://monocypher.org/download/monocypher-4.0.3.tar.gz

Upstream SHA-512 verified:
40904ada5c7ee4f7741733e38b69a30a4b0561cbffba5ffe7c2dce16136d540251ec0d9056ff606510d3b5b708fb8a40db7e0870d4a0b2dc17ba2bfb880f8965

Files: LICENCE.md, src/monocypher.c, src/monocypher.h, src/optional/monocypher-ed25519.c and its header. The optional pair is stored alongside the core pair. Licence: BSD-2-Clause or CC0, see LICENCE.md.

Review verdict: SAFE_WITH_RESTRICTIONS. Compile only the two C files from this pinned release. No upstream scripts, hooks, binaries, network access, secret access or dependencies are required by the imported files. Used for verification of public Ed25519 signatures. No signing key is shipped. Include the upstream licence in distribution notices before packaging.
