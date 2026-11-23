'use strict'
const test=require('node:test'),assert=require('node:assert/strict'),{EventEmitter}=require('node:events')
const {negotiateChannels}=require('../src/protocol/forge/channel-negotiation')
const {ModSupportRuntime}=require('../src/core/runtime')
const {WireWriter}=require('../src/protocol/forge/wire')
const {wrapFml3Reply,unwrapFml3Reply,decodeC2SModListReply}=require('../src/protocol/forge/fml3-client-wire')
class Client extends EventEmitter {
  constructor(){super();this.version='1.20.1';this.state='login';this.autoVersionHooks=[];this.writes=[]}
  write(name,data){this.writes.push({name,data})}
  writeRaw(){}
}
function request(runtime,channels){
  const client=new Client();runtime.attachClient(client)
  const w=new WireWriter().byte(1).count(1).modId('forge').count(channels.length)
  for(const c of channels)w.identifier(c.id).string(c.version)
  const data=wrapFml3Reply(w.count(0).count(0).finish())
  client.emit('login_plugin_request',{messageId:7,channel:'fml:loginwrapper',data})
  client.write('login_plugin_response',{messageId:7,successful:false,data:null})
  return decodeC2SModListReply(unwrapFml3Reply(client.writes.at(-1).data.data))
}
test('server declarations complete absent channels and win version conflicts; local-only declarations supplement',()=>{
  const local=[{id:'unseen:old',version:'1'},{id:'local:only',version:'4'}],server=[{id:'unseen:old',version:'2'},{id:'unseen:new',version:'9'}]
  const result=negotiateChannels(local,server)
  assert.deepEqual(result.channels,[{id:'local:only',version:'4'},{id:'unseen:new',version:'9'},{id:'unseen:old',version:'2'}])
  assert.equal(result.serverCompletedCount,1);assert.equal(result.versionConflicts[0].localVersion,'1')
  assert.equal(result.policy,'server-primary');assert.equal(negotiateChannels(local,null).policy,'awaiting-server-declaration')
  assert.equal(local[0].version,'1');assert.equal(server.length,2)
  assert.throws(()=>negotiateChannels([],[...server,server[0]]),/invalid_server_channel_declaration/)
})
test('actual Forge reply negotiates an unknown channel without modsDir, local metadata, adapter or JAR-observation flag',()=>{
  const runtime=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  try{
    const peer=[{id:'blind:required',version:'27'},{id:'minecraft:register',version:'FML3'}],reply=request(runtime,peer)
    assert.deepEqual(reply.mods,[]);for(const channel of peer)assert.ok(reply.channels.some(c=>c.id===channel.id&&c.version===channel.version))
    assert.deepEqual(runtime.adapters.getReport().active,[])
    assert.equal(runtime.nativeChannels.getReport().channelNegotiation.serverCompletedCount,2)
    assert.throws(()=>runtime.nativeChannels.send('blind:required',0,{}),/not_registered/)
    assert.equal(runtime.nativeChannels.observe({channel:'blind:required',phase:'play',direction:'inbound',data:Buffer.from([0,1,2])}).status,'ignored')
    assert.deepEqual(runtime.nativeChannels.dispatcher.handlers.size,0)
  }finally{runtime.destroy()}
})
test('server version wins handshake but incompatible adapter codec does not decode or send; trials cannot replace server declarations',()=>{
  const runtime=new ModSupportRuntime({experimental:{fml3Runtime:true,trialChannels:[{id:'blind:wire',version:'99'}]}})
  let decoded=0
  try{
    runtime.registerModAdapter({id:'explicit',version:'1',advertise:true,channels:[{id:'blind:wire',version:'1',messages:[{discriminator:0,direction:'bidirectional',encode:()=>Buffer.alloc(0),decode:()=>{decoded++;return{}},onMessage:()=>{}}]}]})
    const reply=request(runtime,[{id:'blind:wire',version:'2'}])
    assert.deepEqual(reply.channels.filter(c=>c.id==='blind:wire'),[{id:'blind:wire',version:'2'}])
    const result=runtime.nativeChannels.observe({channel:'blind:wire',phase:'play',direction:'inbound',data:Buffer.from([0])})
    assert.equal(result.reason,'local_codec_channel_version_mismatch');assert.equal(result.decodedBody,false);assert.equal(decoded,0)
    assert.equal(runtime.nativeChannels.getReport().channelNegotiation.versionConflicts.length,1)
  }finally{runtime.destroy()}
})
test('passive controlled probe retains its explicit channel-only contract',()=>{
  const runtime=new ModSupportRuntime({experimental:{fml3ProbeControlled:true}})
  try{assert.deepEqual(request(runtime,[{id:'blind:required',version:'27'}]).channels,[])}finally{runtime.destroy()}
})
