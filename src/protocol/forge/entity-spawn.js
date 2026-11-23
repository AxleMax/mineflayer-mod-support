'use strict'
const { WireReader } = require('./wire')
// Forge 47.4.13 NetworkInitialization.getPlayChannel:
// fml:play discriminator 0 = PlayMessages.SpawnEntity.
function decodeForgeSpawn (payload) {
  const reader=new WireReader(payload)
  const type=reader.varInt(); const entityId=reader.bytes(4).readInt32BE()
  const hex=reader.bytes(16).toString('hex')
  const objectUUID=`${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`
  const x=reader.bytes(8).readDoubleBE(), y=reader.bytes(8).readDoubleBE(), z=reader.bytes(8).readDoubleBE()
  if(![x,y,z].every(Number.isFinite))throw new Error('invalid_forge_spawn_position')
  const pitch=reader.bytes(1).readInt8(),yaw=reader.bytes(1).readInt8(),headPitch=reader.bytes(1).readInt8()
  const velocity={x:reader.bytes(2).readInt16BE(),y:reader.bytes(2).readInt16BE(),z:reader.bytes(2).readInt16BE()}
  const length=reader.varInt();const additionalData=Buffer.from(reader.bytes(length));reader.end()
  return { packet:{entityId,type,objectUUID,x,y,z,pitch,yaw,headPitch,velocity,objectData:0},additionalData }
}
class ForgeEntityBridge {
  constructor (runtime) {this.runtime=runtime;this.spawned=0;this.rejected=0;this.additionalBytes=0;this.failures=[]}
  observe (event) {
    if(event?.channel!=='fml:play'||event.direction!=='inbound'||event.phase!=='play'||!Buffer.isBuffer(event.data)||event.data[0]!==0)return {status:'ignored'}
    try {
      if(this.runtime.client?.version!=='1.20.1')throw new Error('unsupported_forge_entity_protocol_version')
      if(!this.runtime.bot)throw new Error('forge_entity_bot_not_attached')
      const {packet,additionalData}=decodeForgeSpawn(event.data.subarray(1))
      const type=this.runtime.nativeRegistry.resolve('entity',packet.type)
      if(!type)throw new Error('forge_spawn_entity_type_not_registered:'+packet.type)
      // Reuse Mineflayer's actual entity construction and all its lifecycle listeners.
      // This is a local event, never an outbound packet or forged server response.
      this.runtime.client.emit('spawn_entity',packet)
      const entity=this.runtime.bot.entities?.[packet.entityId]
      if(!entity)throw new Error('mineflayer_entity_not_created')
      Object.defineProperty(entity,'modSupportSpawnData',{configurable:true,get:()=>Buffer.from(additionalData)})
      this.spawned++;this.additionalBytes+=additionalData.length
      this.runtime.emit('forgeEntitySpawn',{entityId:packet.entityId,uuid:packet.objectUUID,typeId:packet.type,name:type.name,additionalBytes:additionalData.length,additionalDataDecoded:additionalData.length===0})
      return {status:'handled',entityId:packet.entityId,additionalBytes:additionalData.length}
    } catch(error) {
      this.rejected++;const failure={reason:error.message};this.failures.push(failure);if(this.failures.length>16)this.failures.shift()
      this.runtime.emit('forgeEntitySpawnError',failure);return {status:'rejected',...failure}
    }
  }
  getReport () {return {spawned:this.spawned,rejected:this.rejected,additionalBytes:this.additionalBytes,failures:this.failures.map(x=>({...x})),additionalDataSemanticsImplemented:false}}
}
module.exports={decodeForgeSpawn,ForgeEntityBridge}
