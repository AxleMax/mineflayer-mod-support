'use strict'
const {compileCodecPlan}=require('../analyzer/codec-ir')
function compileMessageSchema(schema,{version='1.20.1'}={}){
  if(version!=='1.20.1')throw Error('message_schema_minecraft_version_not_supported:'+version)
  const {ProtoDef}=require('protodef'),nbt=require('prismarine-nbt'),proto=new ProtoDef(false)
  proto.addTypes(require('minecraft-protocol/src/datatypes/minecraft'))
  proto.addProtocol(structuredClone(require('minecraft-data')(version).protocol),['play','toClient'])
  nbt.addTypesToInterpreter('big',proto)
  const plan=schema.schema?schema:{schema:'mineflayer-mod-support/codec-ir/v1',root:schema}
  return compileCodecPlan(plan,{protocol:proto})
}
module.exports={compileMessageSchema}
