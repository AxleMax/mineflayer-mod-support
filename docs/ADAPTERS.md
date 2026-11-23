# Adapter development

An adapter is a synchronous, scoped module. `runtime.use(adapter)` returns an
idempotent unload function. `modSupport.adapters` installs adapters before connecting.
Existing adapter API version 1 is retained; the new message interface is additive.

## Matching and activation

```js
const adapter = {
  id: 'my-mod-protocol', apiVersion: 1,
  loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'],
  matches: {
    mods: { mymod: '^1.2.0' },
    channels: { 'mymod:wire': '3' },
    registries: { 'minecraft:entity_type': ['mymod:actor'] }
    // jarSha256: ['<64 lowercase hex characters>'] // Optional, local JAR evidence.
  },
  setup(ctx) { /* register schemas, data, listeners; return optional cleanup */ }
}
```

Mod version constraints use semver when the server version is a valid semver;
exact strings also support non-semver Mod versions. Channel versions are exact
strings. Matching waits for server declarations and required registries. Failed
conditions appear in `getCapabilities().adapters.entries` as `waiting`, `mismatch`
or `failed`. A matched adapter reports `active`. A later mismatch releases active
registrations; create a new Bot/runtime after reconnecting.

Without `matches`, setup runs immediately, preserving existing adapters. Data
definitions never fabricate server registration. JAR fingerprints are optional
and require local JAR analysis; they do not represent server binary attestation.

## Register messages without claiming a Java Mod identity

`ctx.registerChannel({id, version, framing?, messages})` registers explicit codecs.
Messages specify `discriminator`, `direction`, and either `schema` or
`codec: {encode(value): Buffer, decode(bytes): value}`. `name` is diagnostic text.

Directions: `clientbound`, `serverbound`, `bidirectional`. Default framing is
Forge 1.20.1 SimpleChannel (a reviewed one-byte discriminator 0..255). `raw`
uses one message, no discriminator and the entire custom payload. Never select
framing from the channel name or the first byte of an unknown packet.

Clientbound messages can supply `onMessage(data, context)`. Without it, the runtime
emits `adapterMessage` containing adapter ID, message name, channel and decoded data.
Callbacks are synchronous. Exceptions are diagnostics, not evidence of behavior.

Channel registration does not add a Java Mod ID. A matching declared peer and the
real clientbound Join Game barrier are required for PLAY registration/sends. Local
and server protocol version conflicts prevent use of the incompatible codec.
The older `registerNetwork` explicitly advertises a Mod identity and is retained
for legacy adapters; ordinary message adapters should use `registerChannel`.

## Data and protocol extensions

| Context method | Purpose |
| --- | --- |
| `defineItem(id, data)` | Verified display name, stack size, durability |
| `defineEntity(id, data)` | Verified dimensions/name |
| `defineBlock(id, data)` | Actual state ID range, property order/domains and per-state shapes |
| `registerBlockCollision(id, provider)` | Explicit neighbor-aware collision provider |
| `defineMenu(id, data)` | Verified native slots/layout and standard click semantics |
| `registerMenuRules(id, callback)` | Window-specific explicit rules; may return cleanup |
| `registerProtocolCodec(kind, id, schema)` | Recipe/ingredient/argument/metadata ProtoDef schema |
| `registerExplicitCodec(kind, id, codec)` | Bounded `read/write/sizeOf` for a private format |
| `getRegistryId/getRegistryName` | Actual synchronized registry lookups |
| `getConfig` | Already decoded optional config data |
| `on`, `onChannel` | Scoped observations |
| `sendMessage`, `requestMessage` | Registered messages; never gameplay commands |

Slots/NBT use actual wire values. Registries provide identity, not every gameplay
property. Unknown states/shapes/layouts remain unknown. Do not derive global state
IDs from block type IDs. Do not mark a custom result/shift-click rule supported
solely because an inventory can be opened.

## Requests and operation ownership

```js
const response = await bot.modSupport.requestModMessage('example:wire', 0, input, {
  responseDiscriminator: 1,
  match: data => data.requestId === input.requestId,
  timeoutMs: 5000,
  signal: abortController.signal
})
```

One pending request per channel is supported. Match must return a synchronous
boolean. Timeout, signal abort, adapter removal and transport end reject the
request and release its listener/timer state. A send receipt has
`serverConfirmed: false`; a matching reply has `serverEffectConfirmed: false`.
Your application must verify the desired world/inventory/entity outcome.

Keep target selection, native Mineflayer interaction, high-level flows and result
checks in application code. A protocol adapter may maintain necessary message
state; the framework is not a gameplay state-machine engine.

## Lifecycle

All context registrations are tracked. Setup failure rolls back. Unload/end/destroy
release definitions, handlers and pending requests. Disposed contexts cannot send
or register. Async setup is rejected: finish external loading before installing the
adapter. Define cleanup synchronously and return a function.

See [declarative-adapter.js](../examples/declarative-adapter.js) and
[private-request.js](../examples/private-request.js) for an illustrative protocol;
[guardvillagers-1.6.19.js](../examples/adapters/guardvillagers-1.6.19.js) is an explicit
versioned example that was verified against a real server. It is not auto-enabled.
