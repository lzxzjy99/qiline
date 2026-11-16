import './build-web.mjs';
import {readFile,writeFile,readdir,mkdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {build} from 'esbuild';
import path from 'node:path';
async function walk(folder){const files=[];for(const f of await readdir(folder,{withFileTypes:true})){
 if(f.name==='server'||f.name==='.openai')continue;
 const p=folder+'/'+f.name;files.push(...(f.isDirectory()?await walk(p):[p]));
}return files;}
const types={'.html':'text/html;charset=utf-8','.js':'text/javascript;charset=utf-8','.mjs':'text/javascript;charset=utf-8',
 '.css':'text/css;charset=utf-8','.svg':'image/svg+xml','.json':'application/json;charset=utf-8','.ico':'image/x-icon','.map':'application/json'};
const assets={};
for(const f of await walk('dist')){
 const bytes=await readFile(f),ext=f.slice(f.lastIndexOf('.'));
 assets['/'+f.slice(5)]={body:bytes.toString('base64'),type:types[ext]??'application/octet-stream',etag:'"'+createHash('sha256').update(bytes).digest('hex').slice(0,24)+'"'};
}
await mkdir('server',{recursive:true});await writeFile('server/assets.generated.mjs','export default '+JSON.stringify(assets)+';\n');
await build({absWorkingDir:process.cwd(),entryPoints:[path.resolve('server/index.mjs')],outfile:path.resolve('dist/server/index.js'),tsconfigRaw:{},bundle:true,format:'esm',platform:'browser',target:'es2022',minify:false});
console.log('Worker ready: existing game, test replays, and D1 online rooms.');
