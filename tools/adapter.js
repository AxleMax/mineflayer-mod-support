#!/usr/bin/env node
'use strict'
const fs=require('node:fs'),path=require('node:path'),{createAdapterDraft,replayAdapter}=require('../src/tools/adapter-tools')
const [command,...args]=process.argv.slice(2),option=name=>{const i=args.indexOf('--'+name);return i<0?null:args[i+1]}
try{
  const output=option('out')
  if(!output)throw Error('Usage: mms-adapter draft --mods ./mods --out ./adapter.cjs | replay --adapter ./adapter.cjs --capture ./capture.json --out ./result.json')
  let content,passed=true
  if(command==='draft'){
    if(!option('mods'))throw Error('--mods required')
    content=createAdapterDraft(require('../src/analyzer/mod-jar').analyzeJars([path.resolve(option('mods'))]))
  }else if(command==='replay'){
    if(!option('adapter')||!option('capture'))throw Error('--adapter and --capture required')
    const captureFile=path.resolve(option('capture'));if(fs.statSync(captureFile).size>16*1024*1024)throw Error('capture_file_too_large')
    const capture=JSON.parse(fs.readFileSync(captureFile)),adapter=require(path.resolve(option('adapter')))
    const result=replayAdapter(adapter,capture);passed=result.passed;content=JSON.stringify(result,null,2)+'\n'
  }else throw Error('command must be draft or replay')
  const file=path.resolve(output);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,content,{flag:'wx'});console.log(JSON.stringify({file,passed}));process.exitCode=passed?0:1
}catch(error){console.error(error.message);process.exitCode=1}
