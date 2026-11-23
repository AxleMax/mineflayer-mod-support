'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {ModSupportRuntime}=require('../src/core/runtime')
const {discoverRecipeBookTypes}=require('../src/analyzer/recipe-book-types')
function enumClass(name,branched=false) {
  return {thisClass:'sample/Bootstrap',methods:[{name:'<clinit>',descriptor:'()V',flags:8,code:Buffer.from([...(branched?[0x99,0,0]:[]),0x12,1,0xb8,0,2,0xb3,0,3,0xb1])}],constant:()=>name,
    member:i=>i===2?{owner:'net/minecraft/world/inventory/RecipeBookType',name:'create',descriptor:'(Ljava/lang/String;)Lnet/minecraft/world/inventory/RecipeBookType;'}:{owner:'sample/Bootstrap',name:'anything',descriptor:'Lnet/minecraft/world/inventory/RecipeBookType;'}}
}
test('recipe-book count comes from standard enum extensions, not Mod or field names',()=>{
  const c=enumClass('UNSEEN_WORKSHOP');const r=discoverRecipeBookTypes(new Map([[c.thisClass,c]]));assert.equal(r.extensions[0].name,'UNSEEN_WORKSHOP');assert.deepEqual(r.unresolved,[])
  const branch=enumClass('UNSEEN_WORKSHOP',true),unknown=discoverRecipeBookTypes(new Map([[branch.thisClass,branch]]));assert.equal(unknown.extensions.length,0);assert.equal(unknown.unresolved.length,1)
})
function runtime(extra=[]) {const r=new ModSupportRuntime({experimental:{fml3Runtime:true}});r.protocolCodecs.recipeBookTypes={extensions:extra.map(name=>({name})),unresolved:[]};return r}
test('recipe-book actions 0/1/2 with 4,5,6 types preserve all settings and recipe lists',()=>{
  for(const names of [[],['ALPHA'],['ALPHA','BETA']])for(const action of [0,1,2]){
    const r=runtime(names)
    try {
      const params={action,craftingBookOpen:true,filteringCraftable:false,smeltingBookOpen:false,filteringSmeltable:true,blastFurnaceOpen:false,filteringBlastFurnace:false,smokerBookOpen:true,filteringSmoker:false,recipes1:['minecraft:crafting_table','sample:work']}
      if(action===0)params.recipes2=['sample:work']
      if(names.length)params.additionalRecipeBookSettings=names.map((_,i)=>({open:i===0,filtering:i!==0}))
      const bytes=r.protocolCodecs._protocol('1.20.1').proto.createPacketBuffer('packet',{name:'unlock_recipes',params})
      const out=r.protocolCodecs.decode(bytes,'1.20.1','play')
      assert.deepEqual(out.data.params.recipes1,params.recipes1);assert.deepEqual(out.data.params.additionalRecipeBookSettings,params.additionalRecipeBookSettings)
      assert.deepEqual(r.protocolCodecs.cache.proto.createPacketBuffer('packet',out.data),bytes)
    }finally{r.destroy()}
  }
})
test('unknown or duplicate enum creation cannot be guessed from zero bytes',()=>{
  for(const book of [{extensions:[],unresolved:[{reason:'dynamic'}]},{extensions:[{name:'SAME'},{name:'SAME'}],unresolved:[]}]){
    const r=runtime();r.protocolCodecs.recipeBookTypes=book
    try{assert.throws(()=>r.protocolCodecs.decode(Buffer.from('3d0000000000000000000000','hex'),'1.20.1','play'),/count_unresolved/)}finally{r.destroy()}
  }
})
test('historical extended recipe-book warning frame now decodes completely', {skip:!fs.existsSync('../../verification/native-foundation-live.log')},()=>{
  const log=fs.readFileSync('../../verification/native-foundation-live.log','utf8');const hex=log.match(/buffer :([a-f0-9]+)/)?.[1];assert.ok(hex)
  const r=runtime(['ARBITRARY_EXTENSION'])
  try{const bytes=Buffer.from(hex,'hex');const out=r.protocolCodecs.decode(bytes,'1.20.1','play');assert.equal(out.metadata.size,bytes.length);assert.deepEqual(out.data.params.recipes1,['minecraft:crafting_table']);assert.deepEqual(out.data.params.recipes2,['minecraft:crafting_table'])}finally{r.destroy()}
})
test('MessageBuilder chains retain callbacks, direction and commit only at add()',()=>{
  const SIMPLE='net/minecraftforge/network/simple/SimpleChannel',BUILDER=SIMPLE+'$MessageBuilder'
  const members={
    1:{owner:'sample/Setup',name:'WIRE',descriptor:'L'+SIMPLE+';',tag:9},3:{owner:'net/minecraftforge/network/NetworkDirection',name:'PLAY_TO_CLIENT',descriptor:'Lnet/minecraftforge/network/NetworkDirection;',tag:9},
    4:{owner:SIMPLE,name:'messageBuilder',descriptor:'(Ljava/lang/Class;ILnet/minecraftforge/network/NetworkDirection;)L'+BUILDER+';',tag:10},
    6:{owner:BUILDER,name:'encoder',descriptor:'(Ljava/util/function/BiConsumer;)L'+BUILDER+';',tag:10},
    8:{owner:BUILDER,name:'decoder',descriptor:'(Ljava/util/function/Function;)L'+BUILDER+';',tag:10},
    10:{owner:BUILDER,name:'consumerMainThread',descriptor:'(Ljava/util/function/BiConsumer;)L'+BUILDER+';',tag:10},
    11:{owner:BUILDER,name:'add',descriptor:'()V',tag:10}
  }
  const seq=[0xb2,0,1,0x12,2,5,0xb2,0,3,0xb6,0,4,0xba,0,5,0,0,0xb6,0,6,0xba,0,7,0,0,0xb6,0,8,0xba,0,9,0,0,0xb6,0,10]
  const cls={thisClass:'sample/Setup',methods:[{name:'boot',descriptor:'()V',flags:8,code:Buffer.from([...seq,0xb6,0,11,0xb1])}],member:i=>members[i],constant:()=>({className:'sample/Packet'}),dynamicDescriptor:()=>'()Ljava/lang/Object;',lambdaTarget:i=>({owner:'sample/Packet',name:({5:'serialize',7:'deserialize',9:'apply'})[i],descriptor:'()V'})}
  const {discoverForgeChannels}=require('../src/analyzer/forge-channels');const result=discoverForgeChannels(new Map([[cls.thisClass,cls]]))
  assert.equal(result.registrations.length,1);const message=result.registrations[0]
  assert.equal(message.numericDiscriminator,2);assert.equal(message.direction,'PLAY_TO_CLIENT');assert.equal(message.encoder.callback.name,'serialize');assert.equal(message.decoder.callback.name,'deserialize')
  assert.equal(message.builderProperties.consumerThread,'consumerMainThread');assert.equal(message.canAdvertise,false)
  cls.methods[0].code=Buffer.from([...seq,0x57,0xb1]);assert.equal(discoverForgeChannels(new Map([[cls.thisClass,cls]])).registrations.length,0)
})
test('channel handlers are disposed on transport end and cannot run on stale payloads',()=>{
  const {EventEmitter}=require('node:events'),{NativeChannelRuntime}=require('../src/runtime/native-channels')
  const runtime=new EventEmitter();runtime.fml3Controller={enabled:true,experimentalRegistryFlow:true};runtime.protocol={state:'login'}
  const native=new NativeChannelRuntime(runtime);let handled=0
  native.registerModAdapter({id:'fixture',version:'1',advertise:true,channels:[{id:'fixture:wire',version:'1',messages:[{discriminator:0,direction:'clientbound',decode:()=>true,onMessage:()=>handled++}]}]})
  assert.equal(native.getReport().genericNetwork.handlerCount,1)
  runtime.emit('end','fixture');assert.equal(native.getReport().genericNetwork.handlerCount,0)
  assert.equal(native.observe({channel:'fixture:wire',direction:'inbound',phase:'play',data:Buffer.from([0])}).status,'ignored');assert.equal(handled,0)
  native.destroy();assert.equal(runtime.listenerCount('end'),0)
})
const forgeJar=process.env.MMR_FORGE_JAR || '../../fixtures/forge-universal.jar'
test('actual Forge MessageBuilder registrations resolve SpawnEntity/OpenContainer IDs and callbacks', {skip:!fs.existsSync(forgeJar)},()=>{
  const {ZipArchive}=require('../src/analyzer/zip'),{readClass}=require('../src/analyzer/classfile'),{discoverForgeChannels}=require('../src/analyzer/forge-channels')
  const z=new ZipArchive(fs.readFileSync(forgeJar));const classes=new Map(['NetworkInitialization','PlayMessages$SpawnEntity','PlayMessages$OpenContainer'].map(name=>{const c=readClass(z.read('net/minecraftforge/network/'+name+'.class'));return [c.thisClass,c]}))
  const result=discoverForgeChannels(classes).registrations.filter(p=>p.trace[0].method==='getPlayChannel')
  assert.deepEqual(result.map(p=>[p.className.split('$').at(-1),p.numericDiscriminator]),[['SpawnEntity',0],['OpenContainer',1]])
  assert.ok(result.every(p=>p.encoder.callback.name==='encode'&&p.decoder.callback.name==='decode'&&p.builderProperties.consumerThread==='consumerNetworkThread'))
})
