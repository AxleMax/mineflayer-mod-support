# Architecture and capability evidence

```
loader protocol module -> normalized server registries/messages -> per-Bot data
               ^                       ^                            |
               |                 scoped adapters                    v
       server-first channels                               native Mineflayer
```

The shared runtime owns lifecycle, data, diagnostics and projections. Forge wire
formats belong to `src/loaders/forge.js` and `src/protocol/forge`. A custom loader
must implement the versioned `LoaderProtocolDefinition` in `index.d.ts`; only
Forge is bundled. Passing an unsupported loader name does not pretend compatibility.

## Main API

* `createBot(mineflayer, options)` installs early instrumentation and returns a
  normal Mineflayer Bot with `bot.modSupport` attached.
* `runtime.use(adapter)` installs a scoped adapter and returns an unload function.
* `runtime.getCapabilities()` returns structured capability evidence.
* `runtime.snapshot()` returns the full diagnostic snapshot, including incomplete
  synchronization, packet failures, registries and adapter state.
* `runtime.registryMappings.getEntries/getId/getName` reads synchronized identities.
* `sendModMessage/requestModMessage` use explicit registered encoders only.
* `compileMessageSchema` compiles the declarative schema interface.
* `destroy()` is idempotent and releases runtime-owned resources.

`index.d.ts` defines the public types and extension methods. No `itemOperations`
API exists: inventory/world interactions remain native Mineflayer operations.

## Evidence is multidimensional

Capability reports distinguish:

1. Peer channel declaration and negotiated version.
2. Local discovery source/status and unresolved structures.
3. Explicit adapter codecs and sender/receiver availability.
4. Observed counts and exact round-trip sample evidence.
5. Sent/received/matched-response evidence.
6. Actual server effects, which must be checked by the application.

Content definitions include whether the server has actually registered that name.
There is no universal `supported: true` switch. Data synchronization can fail while
connection passes; candidate parsing can succeed without implementing behavior.

## Important events

* `packetDecodeFailure`: resource, phase, packet name and available offsets.
* `protocolSyncFailed`: incomplete recipe/metadata synchronization.
* `adapterActivationError`, `adapterCleanupError`: scoped lifecycle failures.
* `adapterMessage`: explicitly decoded adapter data without a custom callback.
* `fml3ChannelMismatch`: server negotiation rejection.
* `unresolvedBlockState`: bounded diagnostics for unknown world state data.

Unknown custom payloads are recorded as bounded transport observations, not guessed
field structures. Raw capture is opt-in (`experimental.playWireCapture`); a full
snapshot or capture may contain private player, configuration and world data.

## Configuration

Full Forge mode uses `experimental.fml3Runtime: true` and the handshake marker.
`nativeTierChannel` enables the built-in tier channel. `modsDir` is optional local
metadata discovery and does not execute JARs. `forgeJarCodecObservation` and
`forgeJarChannelObservation` are opt-in local candidate observation paths; server
channel negotiation itself no longer requires successful static discovery.

Malformed or unsupported private recipe entries are not guessed or skipped when
their boundaries are unknown. The complete frame fails visibly and downstream
recipe-dependent features remain incomplete; this is not a complete sync pass.
