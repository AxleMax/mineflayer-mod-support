# Security and private data

Adapters are ordinary Node.js modules running with your application's permissions;
they are not sandboxed. Load only trusted code. Server-first channel negotiation
does not prove that a private payload can be decoded safely or that a behavior is
implemented. Unknown frame layouts must not be guessed.

Raw captures and runtime snapshots may include player identities, locations,
ItemStack/NBT, configuration and application-specific content. Keep them local and
redact before sharing. This repository excludes private server artifacts and local
development history.

For a vulnerability, use GitHub's private vulnerability reporting if available.
Otherwise open an issue requesting a private contact channel without posting
credentials, exploitable private server details or unredacted captures.
