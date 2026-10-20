import {cp, mkdir} from 'node:fs/promises';
await mkdir('dist', {recursive:true});
await cp('compiled', 'dist', {recursive:true});
await cp('apps/web', 'dist', {recursive:true});
await cp('packages/ui', 'dist/ui', {recursive:true});
console.log('Static web build ready: dist');
