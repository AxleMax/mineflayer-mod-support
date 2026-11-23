'use strict'
const test=require('node:test'),assert=require('node:assert/strict')
const [read,write,sizeOf]=require('../src/protocol/forge/varlong').varlong
test('standard signed VarLong vectors retain all 64 bits without number rounding',()=>{
  for(const [value,hex]of [
    [0n,'00'],[127n,'7f'],[128n,'8001'],[2147483648n,'8080808008'],
    [9007199254740993n,'8180808080808010'],[(1n<<63n)-1n,'ffffffffffffffff7f'],
    [-1n,'ffffffffffffffffff01'],[-(1n<<63n),'80808080808080808001']
  ]){
    const bytes=Buffer.from(hex,'hex');assert.deepEqual(read(bytes,0),{value,size:bytes.length})
    const out=Buffer.alloc(sizeOf(value));assert.equal(write(value,out,0),out.length);assert.deepEqual(out,bytes)
  }
})
test('VarLong rejects truncation, overflow and imprecise numeric input',()=>{
  assert.throws(()=>read(Buffer.from([128]),0),/truncated_varlong/)
  assert.throws(()=>read(Buffer.from('ffffffffffffffffff02','hex'),0),/varlong_overflow/)
  for(const value of [Number.MAX_SAFE_INTEGER+1,1n<<63n,-(1n<<63n)-1n])assert.throws(()=>sizeOf(value),/invalid_varlong/)
})
test('VarLong is replaced only in the per-client play interpreter',()=>{
  const upstream=require('minecraft-protocol/src/datatypes/minecraft').varlong
  const {ModSupportRuntime}=require('../src/core/runtime'),r=new ModSupportRuntime({experimental:{fml3Runtime:true}})
  try{
    const proto=r.protocolCodecs._protocol('1.20.1').proto,value=9007199254740993n
    const bytes=proto.createPacketBuffer('varlong',value)
    assert.equal(proto.parsePacketBuffer('varlong',bytes).data,value)
    assert.equal(require('minecraft-protocol/src/datatypes/minecraft').varlong,upstream)
  }finally{r.destroy()}
})
