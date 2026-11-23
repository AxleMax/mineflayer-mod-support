'use strict'
class CapabilityCatalog {
  constructor(){this.observed=new Map()}
  record(event,result){
    if(event.direction!=='inbound'||event.phase!=='play'||!Buffer.isBuffer(event.data))return
    if(!this.observed.has(event.channel)&&this.observed.size>=128)return
    const entry=this.observed.get(event.channel)||{packets:0,bytes:0,lastStatus:null}
    entry.packets++;entry.bytes+=event.data.length;entry.lastStatus=result.status;this.observed.set(event.channel,entry)
  }
  report(r){
    const server=r.fml3?.getReport().server,negotiation=r.nativeChannels?.getChannelNegotiation(),channels=new Map()
    for(const entry of negotiation?.entries||[])channels.set(entry.id,{id:entry.id,serverVersion:server?.channels.find(c=>c.id===entry.id)?.version??null,negotiation:entry,observed:this.observed.get(entry.id)||null,messages:[]})
    for(const [id,observed]of this.observed)if(!channels.has(id))channels.set(id,{id,serverVersion:null,negotiation:null,observed,messages:[]})
    const messages=new Map(),add=m=>{if(!m.channel||m.discriminator==null)return;const key=m.channel+'\0'+m.discriminator;const existing=messages.get(key);messages.set(key,{...existing,...m})}
    for(const m of r.compatibility._manifest?.messages||[])add({channel:m.predictedChannel,discriminator:m.predictedDiscriminator,id:m.id,localDiscovery:{source:m.source||r.compatibility.source,status:m.codecStatus},codec:'candidate'})
    for(const source of r.compatibility.forgeChannels)for(const m of source.registrations)add({channel:m.channelBinding?.channel?.name?.resourceLocation,discriminator:m.constructorScopedDiscriminator,id:m.className,localDiscovery:{source:source.source,status:m.codecStatus},codec:'candidate'})
    for(const [key,candidate]of r.nativeChannels?.dispatcher.candidates||[])add({channel:candidate.channel,discriminator:candidate.discriminator,codec:'candidate',wireEvidence:r.nativeChannels.dispatcher.wireMatches.get(key)||null})
    for(const [channel,owner]of r.nativeChannels?.adapterChannels||[])for(const m of owner.channel.messages)add({channel,discriminator:m.discriminator??-1,id:m.name||null,adapter:owner.adapterId,direction:m.direction,codec:'explicit',sendImplemented:typeof m.encode==='function',receiveImplemented:typeof m.decode==='function',serverEffectConfirmed:false})
    for(const m of messages.values()){if(!channels.has(m.channel))channels.set(m.channel,{id:m.channel,serverVersion:null,negotiation:null,observed:null,messages:[]});m.runtimeEvidence=r.nativeChannels?.messageEvidence.get(m.channel+'\0'+m.discriminator)||null;channels.get(m.channel).messages.push(m)}
    const content=r.contentDefinitions.getReport();content.definitions=content.definitions.map(d=>({...d,serverRegistered:r.registryMappings.getId('minecraft:'+({entity:'entity_type'}[d.kind]||d.kind),d.id)!=null}))
    return {schema:'mineflayer-mod-support/capabilities/v1',connection:{handshake:r.fml3?.getReport().handshakeComplete||false},channels:[...channels.values()],adapters:r.adapters.getReport(),content,registries:r.registryMappings.getReport(),synchronization:r.protocolCodecs?.getReport().synchronization||null,limitations:['channel negotiation is independent of codec and behavior support','exact wire round-trip only proves the observed sample','sent and matched response are not server effect confirmation']}
  }
}
module.exports={CapabilityCatalog}
