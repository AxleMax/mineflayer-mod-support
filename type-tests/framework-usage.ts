import modSupport = require('..')

const adapter: modSupport.ModAdapter = {
  id: 'typed-example', apiVersion: 1, loaderProtocols: ['forge'], minecraftVersions: ['1.20.1'],
  setup(ctx) {
    ctx.defineItem('example:token', { stackSize: 64 })
    ctx.defineMenu('example:menu', { containerSlots: 9, playerInventory: 'appended-36', standardClick: true })
    ctx.defineBlock('example:block', { minStateId: 50000, defaultStateId: 50000, properties: [], collisionShapes: [[[0,0,0,1,1,1]]] })
    ctx.registerBlockCollision('example:block', (block, context) => { void context.getBlock(block.position); return [[0,0,0,1,1,1]] })
    ctx.registerProtocolCodec('metadata', 'example:metadata', 'varint')
    ctx.registerExplicitCodec('recipe', 'example:recipe', {
      read(buffer,offset) { return {value:buffer.readUInt8(offset),size:1} },
      write(value,buffer,offset) { buffer.writeUInt8(value,offset);return offset+1 },
      sizeOf() { return 1 }
    })
    ctx.registerMenuRules('example:menu', (window,context) => { window.craftingResultSlot=2; void context.additionalData; return () => {} })
    ctx.onChannel('example:updates', event => { const bytes: Buffer | null = event.data; void bytes })
    // @ts-expect-error Gameplay execution is not an adapter context API.
    ctx.equip('example:token')
  }
}
const protocol: modSupport.LoaderProtocolDefinition = {
  id: 'typed-protocol-fixture', apiVersion: 1,
  create(runtime) {
    return { id: 'typed-protocol-fixture', apiVersion: 1,
      observeInbound(packet) { void packet.name; void runtime }, destroy() {} }
  }
}
const runtime = new modSupport.ModSupportRuntime({ loaderProtocol: protocol })
const stop = runtime.use(adapter)
void stop
// @ts-expect-error Removed wrapper; callers use native Mineflayer.
runtime.itemOperations.equip('example:token')
// @ts-expect-error Fabric is not a bundled implementation.
const unsupported: modSupport.ModSupportOptions = { loaderProtocol: 'fabric' }
void unsupported

const messageAdapter: modSupport.ModAdapter = {
  id: 'typed-message', apiVersion: 1, minecraftVersions: ['1.20.1'],
  matches: {mods: {example: '^1.0.0'}, channels: {'example:wire': '1'}},
  setup(ctx) {
    ctx.registerChannel({id: 'example:wire', version: '1', messages: [{
      discriminator: 0, direction: 'bidirectional', schema: {type: 'int'},
      onMessage(value, context) { void value; void context.channel }
    }]})
  }
}
const compiled = modSupport.compileMessageSchema({type: 'nbt'}, {version: '1.20.1'})
void compiled; void messageAdapter
const capabilities = runtime.getCapabilities()
void capabilities.channels
const requestOptions: modSupport.NativeModRequestOptions = {responseDiscriminator: 1, match: () => true, signal: new AbortController().signal}
void requestOptions
