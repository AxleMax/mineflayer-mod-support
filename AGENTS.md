# Development contract

Implement standards-driven, versioned protocol rules. Trace standard API arguments,
wrappers, inheritance, callbacks and lifecycle. Do not use private method names or
sample Mod names as general rules. Verify candidate layouts against actual bytes.

Keep pure Node.js, a standalone npm package and a Mod-independent core. Only Forge
FML3 / Minecraft 1.20.1 is currently bundled and verified; Fabric/NeoForge support
requires implemented independent protocol modules and real validation.

Server channel declarations take precedence for negotiation; local discovery must
not gate a declared channel's login presence. This does not install codecs, claim
Java Mod identities or prove behavior. Native Mineflayer executes gameplay; do not
add duplicate equip/use/container APIs. Private schemas belong in optional adapters.

Do not guess unknown unbounded payload entry lengths, skip entries to fake complete
sync, or conflate mapping, parsing, sending and server effects. Report incomplete
data separately from a successful connection. Do not execute Java or try to fully
replicate arbitrary Mod clients/recipes/machines.

Run syntax checks, portable tests and strict types. Use structural diversity and
holdouts where evaluating general rules. Keep real Mod JARs, worlds, credentials,
local paths, NBT, server logs and packet captures out of Git.

Live tests connect only to an existing user-controlled server. Never implicitly
start/restart/stop Mohist or replace its process. Clean only explicitly owned test
fixtures. Group related implementation and validation; preserve unrelated work.
