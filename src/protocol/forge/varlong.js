'use strict'
// FriendlyByteBuf 1.20.1: signed 64-bit two's complement, seven bits per byte,
// unsigned right shift on write. BigInt preserves values above 2^53 exactly.
const { PartialReadError } = require('protodef').utils
const MIN=-(1n<<63n),MAX=(1n<<63n)-1n
function unsigned(value){
  if(typeof value==='number'&&Number.isSafeInteger(value))value=BigInt(value)
  if(typeof value!=='bigint'||value<MIN||value>MAX)throw new Error('invalid_varlong')
  return BigInt.asUintN(64,value)
}
function read(buffer,offset){
  let value=0n
  for(let i=0;i<10;i++){
    if(offset+i>=buffer.length)throw new PartialReadError('truncated_varlong')
    const byte=buffer[offset+i]
    if(i===9&&(byte&0xfe)!==0)throw new Error('varlong_overflow')
    value|=BigInt(byte&0x7f)<<BigInt(7*i)
    if(!(byte&0x80))return {value:BigInt.asIntN(64,value),size:i+1}
  }
  throw new Error('varlong_too_long')
}
function write(value,buffer,offset){
  let remaining=unsigned(value)
  do{
    if(offset>=buffer.length)throw new PartialReadError('varlong_output_truncated')
    let byte=Number(remaining&0x7fn);remaining>>=7n
    if(remaining)byte|=0x80
    buffer[offset++]=byte
  }while(remaining)
  return offset
}
function sizeOf(value){let remaining=unsigned(value),size=1;while(remaining>>=7n)size++;return size}
module.exports={varlong:[read,write,sizeOf]}
