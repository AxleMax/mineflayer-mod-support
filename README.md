# Mineflayer Mod Support

[English](README.md) | [简体中文](README.zh-CN.md)

Mineflayer Mod Support is a lightweight, pure Node.js compatibility layer for
modded protocols and interactions. Through dynamic content discovery, protocol
parsing and optional behavior adapters, it aims to let Mineflayer interact with
modded content on Forge, NeoForge and Fabric servers without a complete Mod client.

**Implemented and tested: Forge FML3 / Minecraft Java 1.20.1.** NeoForge and Fabric
are extension directions, **not implemented loaders**. This is an experimental
compatibility layer, not a universal Mod client or a Java execution environment.

## Install

Node.js 22 or newer. Install from this repository; an npm registry release is
not required:

```powershell
npm install mineflayer@4.39.0 minecraft-protocol@1.68.0 github:AxleMax/mineflayer-mod-support#main
```

For development:

```powershell
git clone https://github.com/AxleMax/mineflayer-mod-support.git
cd mineflayer-mod-support
npm ci
npm run check
npm test
npm run typecheck
```

## Run a regular Mineflayer bot

```js
const mineflayer = require('mineflayer')
const modSupport = require('mineflayer-mod-support')

const bot = modSupport.createBot(mineflayer, {
  host: '127.0.0.1', port: 25565,
  username: 'ModSupportBot', version: '1.20.1', auth: 'offline',
  modSupport: {
    // Optional: local JAR metadata/codecs, never executed as Java.
    ...(process.env.MC_MODS_DIR ? { modsDir: process.env.MC_MODS_DIR } : {}),
    experimental: { forgeFml3Marker: true, fml3Runtime: true, nativeTierChannel: true }
  }
})

bot.once('spawn', () => {
  console.log(bot.modSupport.getCapabilities())
  console.log(bot.inventory.items()) // ItemStack name, count, NBT
  // Use native bot.equip, bot.toss, bot.activateBlock, bot.closeWindow, etc.
})
bot.modSupport.on('packetDecodeFailure', failure => console.error(failure))
bot.on('error', error => console.error(error.message))
bot.on('end', () => bot.modSupport.destroy())
```

Use `createBot` so instrumentation is installed **before** the Forge handshake.
Late `bot.loadPlugin` injection cannot recover packets already exchanged.
`auth: 'offline'` is for an offline-auth test server; configure your normal
Mineflayer authentication for other servers. This package does not bypass login.

From this checkout, `npm run example` runs [basic-bot.js](examples/basic-bot.js),
keeps the Bot online and quits on Ctrl+C. Start the server yourself; no example
starts, stops or restarts Mohist.

## What is automatic, and what is not?

| Capability | Scope |
| --- | --- |
| Forge channel negotiation | Server declarations complete local discovery; no JAR required for this step |
| Registry identity | Server item/entity/block/menu names and IDs; per-Bot item/entity projection |
| Available content data | ItemStack/NBT/count and verified explicit data; no invented state IDs or shapes |
| Protocol discovery | Reusable static rules for known standard entrypoints; candidates remain candidates |
| Native interaction | Mineflayer executes actions; target container layouts/custom protocols may need adapters |
| Private protocol extension | Declarative messages, explicit codecs, scoped lifecycle, peer matching and replay |
| All Mod payloads/recipes | **Not universally supported**; unknown private serializers remain incomplete |
| Java Mod behavior / rendering | **Not executed or emulated** |

Channel presence does not prove payload decoding, Java Mod presence or behavior.
Complex private recipe formats can prevent delivery of a whole recipe sync frame;
the error is reported instead of guessing an entry boundary or claiming success.
Automatic global BlockState/collision discovery, arbitrary custom entity semantics,
and special container click rules are not promised.

## Low-cost private adapters

Adapters can be ordinary local modules or separate npm packages:

```js
module.exports = {
  id: 'my-protocol', apiVersion: 1,
  loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'],
  matches: { channels: { 'example:wire': '1' } },
  setup(ctx) {
    ctx.registerChannel({
      id: 'example:wire', version: '1',
      messages: [{
        name: 'setLabel', discriminator: 0, direction: 'serverbound',
        schema: { type: 'struct', fields: [
          { name: 'entityId', codec: { type: 'int' } },
          { name: 'label', codec: { type: 'utf' } }
        ] }
      }]
    })
  }
}
```

`example:wire` is an illustrative protocol, not a channel existing on your server.
Install with `modSupport: { adapters: [require('./my-adapter')] }`. The adapter waits
for matching server declarations; it never allocates server IDs or declares that a
Java Mod ran. Send only after the target protocol and PLAY channel are ready:

```js
const receipt = bot.modSupport.sendModMessage('example:wire', 0, {
  entityId: target.id, label: 'New label'
})
// receipt.serverConfirmed is false. Confirm the actual result independently.
```

See [adapter development](docs/ADAPTERS.md), [schemas and replay](docs/SCHEMAS.md),
[API and architecture](docs/API.md), and [validation/limitations](docs/VALIDATION.md).

## Adapter tools

```powershell
npx mms-adapter draft --mods ./mods --out ./my-adapter.cjs
npx mms-adapter replay --adapter ./my-adapter.cjs --capture ./capture.json --out ./replay-result.json
```

Drafts are disabled until reviewed. Missing schemas remain unresolved. Replay
checks full sample decoding and exact re-encoding; it is not a server behavior test.
Tools refuse to overwrite an existing output. Raw captures and adapters can contain
private data/code: only load modules you trust, and keep server artifacts private.

## Development boundaries

The core handles public protocol mechanisms, discovery and data projection;
adapters supply private formats; native Mineflayer and application code execute
operations. There is no duplicate equipment/placement/container API or Java
execution, and supporting every private recipe is not a completion requirement.
Connection, data completeness, explicit adaptation and actual server effects are
validated separately.

Contributions are welcome within these boundaries. See [CONTRIBUTING.md](CONTRIBUTING.md).
MIT licensed. Third-party Mod JARs, worlds, player data and local development history
are not distributed in this repository.
