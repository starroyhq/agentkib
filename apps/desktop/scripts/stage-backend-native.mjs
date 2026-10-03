import {cp,mkdir,realpath,rm} from "node:fs/promises";
import {createRequire} from "node:module";
import path from "node:path";
const root=path.resolve(import.meta.dirname,'..'),require=createRequire(path.join(root,'package.json'));
const source=path.dirname(await realpath(require.resolve('koffi/package.json'))),target=path.join(root,'dist-electron/native/koffi');
await rm(target,{recursive:true,force:true});await mkdir(path.dirname(target),{recursive:true});
await cp(source,target,{recursive:true,filter:file=>{
  const first=path.relative(source,file).split(path.sep)[0];return !['doc','src','vendor'].includes(first);
}});
