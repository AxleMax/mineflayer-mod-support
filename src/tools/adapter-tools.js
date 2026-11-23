'use strict'
const {compileMessageSchema}=require('../protocol/message-schema')
function createAdapterDraft(analysis){
  const channels=new Map()
  for(const source of analysis.forgeChannels||[])for(const m of source.registrations){
    const id=m.channelIdentity?.id,version=m.channelIdentity?.version
    if(!id||m.constructorScopedDiscriminator==null)continue
    if(!channels.has(id))channels.set(id,{id,version,messages:[]})
    const messages=channels.get(id).messages
    if(messages.some(v=>v.discriminator===m.constructorScopedDiscriminator))continue
    messages.push({discriminator:m.constructorScopedDiscriminator,direction:m.direction==='PLAY_TO_CLIENT'?'clientbound':m.direction==='PLAY_TO_SERVER'?'serverbound':m.direction==='UNRESTRICTED'?'bidirectional':null,schema:m.codec?.inference?.plan||null,evidence:{source:source.source,status:m.codecStatus,runtimeVerified:false}})
  }
  const draft={reviewed:false,channels:[...channels.values()],unresolved:(analysis.forgeChannels||[]).flatMap(s=>s.diagnostics.map(d=>({source:s.source,...d}))),limitations:analysis.limitations}
  return "'use strict'\n// Generated candidates. Review IDs, versions, directions and every schema before enabling.\nconst draft="+JSON.stringify(draft,null,2)+"\nmodule.exports={id:'reviewed-protocol',apiVersion:1,loaderProtocols:['forge'],minecraftVersions:['1.20.1'],matches:{channels:Object.fromEntries(draft.channels.map(c=>[c.id,c.version]))},draft,setup(ctx){if(!draft.reviewed)throw Error('adapter_draft_requires_review');for(const channel of draft.channels){if(channel.messages.some(m=>!m.schema))throw Error('unresolved_message_schema:'+channel.id);ctx.registerChannel(channel)}}}\n"
}
function replayAdapter(adapter,capture){
  const entries=new Map(),disposers=[]
  const nativeVersion=capture.minecraftVersion||'1.20.1'
  if(adapter.minecraftVersions&&!adapter.minecraftVersions.includes(nativeVersion))throw Error('replay_adapter_minecraft_version_mismatch')
  const ctx={apiVersion:1,loaderProtocol:'forge',registerChannel(channel){for(const m of channel.messages){const key=channel.id+'\0'+(m.discriminator??'raw');if(entries.has(key))throw Error('duplicate_replay_message');const codec=m.schema?compileMessageSchema(m.schema,{version:capture.minecraftVersion||'1.20.1'}):m.codec;if(!codec)throw Error('replay_codec_missing');entries.set(key,{codec,framing:channel.framing||'forge-simple-channel',message:m,channel})}return()=>{for(const m of channel.messages)entries.delete(channel.id+'\0'+(m.discriminator??'raw'))}},on(){return()=>{}},onChannel(){return()=>{}},getRegistryId(registry,name){return capture.registries?.[registry]?.find(e=>e.name===name)?.id??null},getRegistryName(registry,id){return capture.registries?.[registry]?.find(e=>e.id===id)?.name??null}}
  let cleanup
  try{
    cleanup=adapter.setup(ctx)
    if(cleanup&&typeof cleanup!=='function')throw Error('replay_setup_must_be_synchronous')
    const results=(capture.samples||[]).map((sample,index)=>{
      try{
        if(sample.truncated)throw Error('truncated_capture')
        if(typeof sample.hex!=='string'||sample.hex.length>2*1024*1024||sample.hex.length%2||!/^[0-9a-f]*$/i.test(sample.hex))throw Error('invalid_capture_hex')
        const bytes=Buffer.from(sample.hex,'hex'),raw=entries.get(sample.channel+'\0raw')
        const discriminator=raw?null:bytes[0],entry=raw||entries.get(sample.channel+'\0'+discriminator)
        if(!entry)throw Error('message_not_defined')
        if(sample.version!==undefined&&sample.version!==entry.channel.version)throw Error('capture_channel_version_mismatch')
        const payload=raw?bytes:bytes.subarray(1),decoded=entry.codec.decode(payload),encoded=entry.codec.encode(decoded)
        if(!encoded.equals(payload))throw Error('wire_roundtrip_mismatch')
        return{index,channel:sample.channel,discriminator,status:'wire-roundtrip-passed',bytes:bytes.length,serverEffectConfirmed:false}
      }catch(error){return{index,channel:sample.channel,status:'failed',reason:error.message}}
    })
    return{schema:'mineflayer-mod-support/adapter-replay/v1',passed:results.length>0&&results.every(r=>r.status==='wire-roundtrip-passed'),results,scope:'offline wire sample parity only; no runtime lifecycle or server effect proof'}
  }finally{if(typeof cleanup==='function')cleanup();for(const dispose of disposers.reverse())dispose();entries.clear()}
}
module.exports={createAdapterDraft,replayAdapter}
