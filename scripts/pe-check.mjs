import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
export function checkPE(bytes) {
  const bad=message=>{throw new Error(`Invalid Windows executable: ${message}`);};
  if(bytes.length<64||bytes.toString('ascii',0,2)!=='MZ')bad('missing DOS header');
  const pe=bytes.readUInt32LE(0x3c);
  if(pe<64||pe+24>bytes.length||!bytes.subarray(pe,pe+4).equals(Buffer.from([80,69,0,0])))bad('missing PE header');
  const machine=bytes.readUInt16LE(pe+4),count=bytes.readUInt16LE(pe+6),optional=bytes.readUInt16LE(pe+20);
  if(machine!==0x8664)bad('expected x64');
  if(!count||count>96||optional<112||pe+24+optional+count*40>bytes.length)bad('invalid section table');
  if(bytes.readUInt16LE(pe+24)!==0x20b)bad('expected PE32+');
  const sections=[];
  for(let i=0;i<count;i++){
    const offset=pe+24+optional+i*40,name=bytes.toString('ascii',offset,offset+8).replace(/\0+$/,''),size=bytes.readUInt32LE(offset+16),pointer=bytes.readUInt32LE(offset+20);
    if(size>0&&(pointer===0||pointer+size>bytes.length))bad(`truncated ${name} section: need ${pointer+size} bytes, have ${bytes.length}`);
    sections.push({name,size,pointer});
  }
  return {architecture:'x64',bytes:bytes.length,sections,sha256:createHash('sha256').update(bytes).digest('hex')};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  try{for(const file of process.argv.slice(2))console.log(JSON.stringify({file,...checkPE(await readFile(file))}));}
  catch(error){console.error(error.message);process.exitCode=1;}
}
