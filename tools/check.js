'use strict'
const fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'..')
function walk(dir){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isDirectory())walk(file);else if(/\.(c?js)$/.test(file))execFileSync(process.execPath,['--check',file],{stdio:'inherit'})}}
for(const dir of ['src','examples','tools'])walk(path.join(root,dir))
execFileSync(process.execPath,['--check',path.join(root,'index.js')],{stdio:'inherit'})
console.log('JavaScript syntax checks passed')
