'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs')
const {normalInstructions}=require('../src/analyzer/normal-control-flow')
const {ReadCodecCompiler}=require('../src/analyzer/read-codec-compiler')
const {ModSupportRuntime}=require('../src/core/runtime')
const {WireWriter}=require('../src/protocol/forge/wire')
const BUF='net/minecraft/network/FriendlyByteBuf'
function fixture(code,members={}) {
  const method={name:'unseen',descriptor:'(L'+BUF+';)I',flags:8,code:Buffer.from(code)}
  const cls={thisClass:'holdout/Arbitrary',superClass:'java/lang/Object',methods:[method],member:i=>members[i]}
  return {cls,method}
}
test('normal flow excludes catch-only calls but keeps code reached by a normal branch',()=>{
  const entry=fixture([0x2a,0xb6,0,1,0xac,0x57,0x03,0xac],{1:{owner:BUF,name:'m_130242_',descriptor:'()I'}})
  entry.method.exceptionHandlers=[{start:0,end:5,handler:5,catchType:'java/lang/Exception'}]
  assert.deepEqual(normalInstructions(entry.cls,entry.method).excluded,[5,6,7])
  const out=new ReadCodecCompiler(new Map([[entry.cls.thisClass,entry.cls]])).compile(entry,entry.cls.thisClass)
  assert.deepEqual(out.definitions[out.schema],['container',[{name:'field_0',type:'varint'}]])
  const shared=fixture([0x03,0x99,0,4,0xb1,0xb1])
  assert.deepEqual(normalInstructions(shared.cls,shared.method).excluded,[])
})
test('unproved branches, invalid targets and parent buffer methods cannot produce a schema',()=>{
  const entry=fixture([0x2a,0xb6,0,1,0xac],{1:{owner:'io/netty/buffer/ByteBuf',name:'readInt',descriptor:'()I'}})
  assert.throws(()=>new ReadCodecCompiler(new Map()).compile(entry,entry.cls.thisClass),/unsupported_buffer_receiver/)
  const invalid=fixture([0xa7,0,2,0xb1])
  assert.throws(()=>normalInstructions(invalid.cls,invalid.method),/invalid_normal_control_flow_target/)
  const conditional=fixture([0x03,0x99,0,4,0xac,0x03,0xac])
  assert.throws(()=>new ReadCodecCompiler(new Map()).compile(conditional,conditional.cls.thisClass),/unsupported_read_opcode_99/)
})
const jar='../../fixtures/blind-mods/Mekanism-1.20.1-10.4.16.80.jar'
test('actual inherited recipe reader decodes independently built single and recursive multi ingredients', {skip:!fs.existsSync(jar)},()=>{
  const candidates=require('../src/analyzer/mod-jar').analyzeJars([jar]).recipeSerializers
  const runtime=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  try {
    runtime.protocolCodecs.recipeCandidates=candidates
    runtime.registryMappings.getEntries=name=>name==='minecraft:recipe_serializer'?[{name:'mekanism:enriching',id:30},{name:'mekanism:energy_conversion',id:31}]:[]
    const header=()=>new WireWriter().varInt(0x6d).varInt(1).identifier('mekanism:enriching').identifier('holdout:recipe')
    // SINGLE ordinal, one ordinary ingredient ItemStack, required count,
    // then output ItemStack. Item IDs here are wire integers, not name guesses.
    const single=w=>w.varInt(0).varInt(1).byte(1).varInt(5).byte(1).byte(0).varInt(3)
    for(const multi of [false,true]) {
      const w=header();if(multi){w.varInt(1).varInt(2);single(w)}single(w)
      const bytes=w.byte(1).varInt(9).byte(2).byte(0).finish()
      const packet=runtime.protocolCodecs.decode(bytes,'1.20.1','play')
      const data=packet.data.params.recipes[0].data
      assert.equal(data.field_1.itemId,9);assert.equal(data.field_1.itemCount,2)
      assert.deepEqual(runtime.protocolCodecs.cache.proto.createPacketBuffer('packet',packet.data),bytes)
    }
    assert.equal(runtime.protocolCodecs.getReport().inferredRecipes.find(r=>r.id==='mekanism:enriching').wireVerified,true)
    const energy=new WireWriter().varInt(0x6d).varInt(1).identifier('mekanism:energy_conversion').identifier('holdout:energy')
    single(energy)
    energy.bytes(Buffer.from('8180808080808010007b','hex'))
    const energyPacket=runtime.protocolCodecs.decode(energy.finish(),'1.20.1','play')
    assert.deepEqual(energyPacket.data.params.recipes[0].data.field_1,{field_0:9007199254740993n,field_1:123})
    assert.throws(()=>runtime.protocolCodecs.decode(header().varInt(9).finish(),'1.20.1','play'),/unsupported_mod_protocol_type/)
    const deep=header();for(let i=0;i<100;i++)deep.varInt(1).varInt(1);single(deep)
    assert.throws(()=>runtime.protocolCodecs.decode(deep.byte(0).finish(),'1.20.1','play'),/protocol_schema_nesting_limit/)
    // Another supplied archive can alter ServiceLoader discovery. It must
    // invalidate the binding even though the original archive is unchanged.
    const name=Buffer.from('META-INF/services/mekanism.api.IMekanismAccess'),body=Buffer.from('holdout.SecondProvider\n')
    const local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22)
    local.writeUInt32LE(0x04034b50);local.writeUInt32LE(body.length,18);local.writeUInt32LE(body.length,22);local.writeUInt16LE(name.length,26)
    central.writeUInt32LE(0x02014b50);central.writeUInt32LE(body.length,20);central.writeUInt32LE(body.length,24);central.writeUInt16LE(name.length,28)
    end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(46+name.length,12);end.writeUInt32LE(30+name.length+body.length,16)
    const extra=require('node:path').join(require('node:os').tmpdir(),'mmr-service-'+require('node:crypto').randomUUID()+'.jar')
    try{
      fs.writeFileSync(extra,Buffer.concat([local,name,body,central,name,end]))
      const changed=require('../src/analyzer/mod-jar').analyzeJars([jar,extra]).recipeSerializers.find(r=>r.id==='mekanism:enriching')
      assert.equal(changed.status,'unresolved');assert.equal(changed.reason,'ambiguous_service_provider');assert.equal(changed.schema,null)
    }finally{if(fs.existsSync(extra))fs.unlinkSync(extra)}
  }finally{runtime.destroy()}
})
