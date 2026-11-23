# Declarative schemas, drafts and replay

`compileMessageSchema(schema, {version: '1.20.1'})` generates a bounded
`{encode, decode}` pair. Schemas use the existing Codec IR, either the root node
directly or `{schema: 'mineflayer-mod-support/codec-ir/v1', root, definitions}`.

| Node | Shape |
| --- | --- |
| Scalar | `{type: 'int'}`; byte, short, long, varint, float, double, boolean, utf, uuid, blockpos, resource_location |
| Struct | `{type:'struct', fields:[{name:'id',codec:{type:'int'}}]}` |
| Counted list | `{type:'list', lengthType:'varint', maxItems:64, element:{type:'int'}}` |
| Optional | `{type:'optional', value:{type:'utf'}}` (boolean presence prefix) |
| Enum | `{type:'enum', ordinalType:'varint', values:['north','south']}` |
| Reference | `{type:'ref', name:'Entry'}` with definitions; recursive references unsupported |
| Conditional | `{type:'switch', field:'mode', cases:{rename:{type:'utf'}, clear:{type:'struct',fields:[]}}}` |
| ItemStack | `{type:'slot'}` (Minecraft 1.20.1 raw wire ItemStack) |
| NBT | `{type:'nbt'}` (Minecraft 1.20.1 optional network NBT) |

Conditional fields refer to a preceding discriminator in the same containing
struct; unknown cases fail. Long uses BigInt. Strings use a VarInt byte length.
ItemStack fields are `present`, `itemId`, `itemCount`, `nbtData`; use the server's
actual item ID. NBT values follow prismarine-nbt tagged values. Slot/NBT nodes
require `compileMessageSchema`; the lower-level `compileCodecPlan` alone has no
Minecraft type context.

Decoding must consume the complete message. Trailing bytes, truncated data,
unknown branches and invalid limits fail. The compiler limits depth, operations,
list sizes and total bytes. Complex private encoding can use an explicit codec;
this project does not interpret arbitrary Java callback logic.

## Generate a candidate adapter

```powershell
npx mms-adapter draft --mods ./mods --out ./candidate.cjs
```

This runs the existing static analyzer and follows discovered Forge registrations.
It outputs reviewable channel/message/schema candidates and unresolved diagnostics.
The generated adapter refuses setup until `draft.reviewed` is explicitly enabled;
messages lacking schemas still fail. Review message direction as well as byte
structure. A found registration or a successful round-trip is not permission to
send an arbitrary Mod operation.

## Replay full captures

Capture format (keep real captures private):

```json
{
  "minecraftVersion": "1.20.1",
  "samples": [
    {"channel":"example:wire","version":"1","hex":"0000000001026869","truncated":false}
  ]
}
```

The example bytes represent discriminator 0, int requestId=1, UTF string `hi`,
matching `examples/declarative-adapter.js`.

```powershell
npx mms-adapter replay --adapter ./examples/declarative-adapter.js --capture ./capture.json --out ./result.json
```

The tool runs the explicitly selected trusted adapter module, compiles its message
definitions, decodes full samples and checks exact encode parity. It rejects
truncated samples and mismatched specified channel versions. Zero samples do not
pass. Output files are created exclusively, never silently overwritten.

Replay has no server connection, invents no registry entries and makes no server
effect claim. Supply `registries` in a capture only if a trusted adapter's setup
requires actual lookup evidence. Adapters depending on live state or other context
extensions need dedicated runtime tests; replay's context supports message schema
registration, observations and provided registry lookups.
