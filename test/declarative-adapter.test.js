'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {ModSupportRuntime}=require('../src/core/runtime'),{compileMessageSchema}=require('../src/protocol/message-schema')
const {replayAdapter,createAdapterDraft}=require('../src/tools/adapter-tools')
const schema={type:'struct',fields:[{name:'mode',codec:{type:'enum',ordinalType:'varint',values:['name','item']}},{name:'body',codec:{type:'switch',field:'mode',cases:{name:{type:'optional',value:{type:'utf'}},item:{type:'slot'}}}}]}
function peer(r,version='7'){
  r.fml3.modData=[{id:'fixture',version:'1.2.3'}];r.fml3.modList={modIds:['fixture'],channels:[{id:'fixture:wire',version},{id:'minecraft:register',version:'FML3'}],registries:[],dataPackRegistries:[]};r.emit('fml3Message',{})
}
function adapter(extra={}){return{id:'fixture-protocol',apiVersion:1,minecraftVersions:['1.20.1'],matches:{mods:{fixture:'^1.2.0'},channels:{'fixture:wire':'7'}},setup(ctx){ctx.registerChannel({id:'fixture:wire',version:'7',messages:[{discriminator:0,name:'echo',direction:'bidirectional',schema}]})},...extra}}
test('declarative conditional/optional/ItemStack/NBT/list schemas roundtrip and reject incomplete or unknown branches',()=>{
  const codec=compileMessageSchema(schema)
  for(const body of ['hello',null])assert.equal(codec.decode(codec.encode({mode:'name',body})).body,body)
  const nbt=require('prismarine-nbt'),item={present:true,itemId:1,itemCount:3,nbtData:nbt.comp({probe:nbt.string('sample')})}
  assert.equal(codec.decode(codec.encode({mode:'item',body:item})).body.nbtData.value.probe.value,'sample')
  const list=compileMessageSchema({type:'list',lengthType:'varint',maxItems:2,element:{type:'nbt'}});assert.equal(list.decode(list.encode([nbt.comp({})])).length,1)
  assert.throws(()=>list.encode([null,null,null]),/invalid_list_value/)
  const bytes=codec.encode({mode:'name',body:'hi'});assert.throws(()=>codec.decode(bytes.subarray(0,bytes.length-1)))
  assert.throws(()=>codec.decode(Buffer.concat([bytes,Buffer.from([0])])),/trailing/)
  assert.throws(()=>codec.decode(Buffer.from([9])),/enum/)
  assert.throws(()=>compileMessageSchema({type:'struct',fields:[{name:'body',codec:{type:'switch',field:'later',cases:{x:{type:'int'}}}}]}),/preceding_field/)
})
test('deferred adapter matching activates only a compatible peer; late channel registration never grants Mod identity and unload cleans it',()=>{
  const r=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  try{const off=r.use(adapter());assert.equal(r.adapters.getReport().entries[0].status,'waiting');peer(r,'8');assert.equal(r.adapters.getReport().entries[0].status,'mismatch');assert.equal(r.nativeChannels.adapterChannels.size,0)
    peer(r);assert.deepEqual(r.adapters.getReport().active,['fixture-protocol']);assert.deepEqual(r.nativeChannels.getAdvertisedMods(),[]);assert.equal(r.getCapabilities().channels.find(c=>c.id==='fixture:wire').messages[0].codec,'explicit')
    off();assert.equal(r.nativeChannels.adapterChannels.size,0);assert.equal(r.nativeChannels.dispatcher.handlers.size,0)
  }finally{r.destroy()}
})
test('registry and fingerprint requirements do not fabricate content; activation failure rolls back',()=>{
  const r=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  try{peer(r);const a=adapter({matches:{channels:{'fixture:wire':'7'},registries:{'minecraft:item':['fixture:gem']}},setup(ctx){ctx.defineItem('fixture:gem',{stackSize:1});throw Error('bad setup')}});r.use(a)
    assert.equal(r.adapters.getReport().entries[0].status,'waiting');r.installRegistry({name:'minecraft:item',entries:[{id:5000,name:'fixture:gem'}]});assert.equal(r.adapters.getReport().entries[0].status,'failed');assert.equal(r.contentDefinitions.get('item','fixture:gem'),null)
    const off=r.use(adapter({id:'hash',matches:{jarSha256:['a'.repeat(64)]}}));assert.equal(r.adapters.getReport().entries.find(e=>e.id==='hash').status,'mismatch');off()
  }finally{r.destroy()}
})
test('native requests correlate responses, cancel by signal and unload without pretending server effect',async()=>{
  const r=new ModSupportRuntime({experimental:{fml3Runtime:true}}),c=new EventEmitter();c.version='1.20.1';c.state='play';c.autoVersionHooks=[];c.write=()=>{};c.writeRaw=()=>{}
  try{r.attachClient(c);peer(r);r.protocol.state='play';r.nativeChannels._serverPlayPacketObserved=true;const off=r.use(adapter());r.nativeChannels.registerPlayChannels()
    const controller=new AbortController(),pending=r.requestModMessage('fixture:wire',0,{mode:'name',body:'hello'},{responseDiscriminator:0,match:data=>data.body==='hello',signal:controller.signal});controller.abort();await assert.rejects(pending,/aborted/);assert.equal(r.nativeChannels.pendingRequests.size,0)
    const request=r.requestModMessage('fixture:wire',0,{mode:'name',body:'hello'},{responseDiscriminator:0,match:data=>data.body==='hello'})
    const payload=Buffer.concat([Buffer.from([0]),compileMessageSchema(schema).encode({mode:'name',body:'hello'})]);r.emit('payload',{channel:'fixture:wire',direction:'inbound',phase:'play',data:payload})
    const receipt=await request;assert.equal(receipt.request.serverConfirmed,false);assert.equal(receipt.serverEffectConfirmed,false)
    assert.equal(r.getCapabilities().channels.find(c=>c.id==='fixture:wire').messages[0].runtimeEvidence.sent,2)
    const cancelled=r.requestModMessage('fixture:wire',0,{mode:'name',body:null},{responseDiscriminator:0,match:()=>true});off();await assert.rejects(cancelled,/adapter_removed/)
  }finally{r.destroy()}
})
test('replay validates actual bytes and rejects truncated/version-mismatched samples; generated draft is disabled',()=>{
  const a=adapter(),hex=Buffer.concat([Buffer.from([0]),compileMessageSchema(schema).encode({mode:'name',body:'hi'})]).toString('hex'),sample={channel:'fixture:wire',version:'7',hex}
  assert.equal(replayAdapter(a,{samples:[sample]}).passed,true);assert.equal(replayAdapter(a,{samples:[{...sample,truncated:true}]}).passed,false);assert.equal(replayAdapter(a,{samples:[{...sample,version:'8'}]}).passed,false)
  assert.match(createAdapterDraft({forgeChannels:[],limitations:[]}),/adapter_draft_requires_review/)
  const draft=createAdapterDraft({forgeChannels:[{source:'unseen.jar',diagnostics:[],registrations:[{channelIdentity:{id:'unseen:wire',version:'1'},constructorScopedDiscriminator:0,direction:null,codec:{}}]}]})
  assert.match(draft,/"direction": null/)
})
