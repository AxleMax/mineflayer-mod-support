'use strict'

const { compileCodecPlan, flatSchemaToPlan } = require('..')
const channel = 'waystones:network'

function installAdapter (runtime) {
  const outgoing = ['edit_waystone', 'select_waystone', 'remove_waystone'].map(name => {
    const message = runtime.compatibility.getMessage('waystones:' + name)
    if (message?.predictedChannel !== channel || message.direction !== 'serverbound' || message.codecStatus !== 'candidate-codec') {
      throw new Error('missing_fixture_encoder:' + name)
    }
    const codec = compileCodecPlan(flatSchemaToPlan(message.codecSchema))
    return { name, discriminator: message.predictedDiscriminator, direction: 'serverbound', encode: value => codec.encode(value) }
  })
  runtime.use({ id: 'waystones', apiVersion: 1, loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'], setup (context) {
    context.registerProtocolCodec('recipe', 'waystones:warp_plate', ['container', [
      { name: 'result', type: 'slot' },
      { name: 'primaryIngredient', type: 'ingredient' },
      { name: 'secondaryIngredients', type: ['array', { countType: 'varint', type: 'ingredient' }] }
    ]])
    context.registerNetwork({
      id: 'waystones',
      version: '14.1.21',
      advertise: true,
      channels: [{ id: channel, version: '1.0', messages: outgoing }]
    })
    for (const name of ['waystone_update', 'known_waystones', 'teleport_effect', 'waystone_cooldown']) {
      const id = 'waystones:' + name
      const { predictedDiscriminator: discriminator } = runtime.compatibility.getMessage(id)
      context.registerCodecHandler({ channel, discriminator, id, onMessage (data) {
        if (name === 'known_waystones') return Array.isArray(data.slot_1) && typeof data.slot_0 === 'string'
        if (name === 'waystone_update') return typeof data.slot_0?.slot_0 === 'string'
        if (name === 'teleport_effect') return Number.isSafeInteger(data.pos?.x)
        return typeof data.warpStoneCooldownUntil === 'bigint'
      } })
    }
  } })
  return Object.fromEntries(outgoing.map(({ name, discriminator }) => [name, discriminator]))
}

module.exports = { installAdapter }
