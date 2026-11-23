# Validation and limitations (2026-11-23)

This release separates automatic mechanisms, explicit adapters and unsupported data.
Test counts are evidence for the exercised scope, not a compatibility percentage.

## Public, reproducible checks

A clean checkout outside the private workspace, with no JARs/captures supplied:

* `npm ci --ignore-scripts`: passed.
* `npm test`: 280 tests, 255 passed, 0 failed, 25 optional-evidence tests skipped.
* `npm run check`: passed.
* `npm run typecheck`: passed (TypeScript 5.9.3).

Skipped tests require explicitly supplied third-party Mod JARs or historical live
captures. These are not bundled or published. The portable suite covers matching,
rollback/unload, message schemas, request cancellation, unknown menus, parser
boundaries, isolated registry projection and server-first handshake replies.

Local checks with authorized private fixtures also passed. The declarative schema
holdout uses an independent fixed wire vector with nested conditional/ref/list,
UUID, optional UTF and signed 64-bit values beyond JavaScript's safe integer range;
it required no additional implementation rule.

## Real server evidence (private artifacts retained locally)

Target: existing user-controlled Mohist / Forge 47.4.13, Minecraft 1.20.1, port 25565.
No test started or restarted the server, and no JVM helper executed Mod code.

* Server-first negotiation: without local JARs or adapters, all 15 server channel
  declarations entered the reply; 13 supplemented absent local discovery. FML3
  33/33 replies and Play/Spawn passed.
* Ordinary local-source Bot with local JARs: connection also passed independently
  of the old Waystones adapter. This does not establish complete payload support.
* Versioned explicit Guard Villagers 1.20.1-1.6.19 adapter: declarative int/boolean
  message on `guardvillagers:main` changed a uniquely owned test entity's Patrolling
  state from 0b to 1b and back to 0b. Both states were confirmed by server commands.
  The send receipt remained `serverConfirmed: false`; the harness separately
  established the actual effect. The entity was removed and adapter resources closed.
* Iron Chests / Iron Furnaces native container insertion and removal passed with
  explicit verified layouts, including count/NBT server confirmation.
* Guard Villagers type/standard metadata/native attack were previously verified.

These real interactions are sample evidence. The private protocol example is
explicit adaptation, not automatic discovery of Guard Villagers behavior.

## Remaining limits

* Mixed-Mod full recipe sync is **not passed**: an unsupported Mekanism private
  serializer (`mekanism:painting` in the current capture) prevents complete delivery
  of that recipe frame. Without local metadata, extended recipe-book layouts may
  also be unavailable. Unknown unbounded entries are not guessed or skipped.
* Construction Wand equipment passed; an isolated placement attempt did not place
  a block. Its cause is unresolved and placement is not certified.
* Carry On channel negotiation passed; carrying behavior is not implemented/tested.
* No automatic global BlockState/collision reconstruction, arbitrary entity metadata
  semantics, all container special rules, Java execution or complete Mod client.
* NeoForge/Fabric have extension interfaces only; no built-in verified implementation.
* Short scoped sessions do not establish arbitrary long-duration reliability.

Private recipe/payload layouts can be supplied by optional adapters. Standard
mechanism gaps should be fixed with reusable rules. Neither path may erase an
incomplete-sync result or turn a channel declaration into a behavior claim.
