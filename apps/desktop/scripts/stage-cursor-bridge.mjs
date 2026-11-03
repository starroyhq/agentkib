import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'cursor-bridge');
const destination = path.join(root, 'build/cursor-bridge');
const crc32 = bytes => {let crc = 0xffffffff; for(const byte of bytes) {crc ^= byte; for(let i=0;i<8;i++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);} return (crc ^ 0xffffffff) >>> 0;};
const manifest = JSON.parse(readFileSync(path.join(source, 'package.json'), 'utf8'));
const entries = [
 ['extension/package.json', readFileSync(path.join(source, 'package.json'))],
 ['extension/extension.cjs', readFileSync(path.join(source, 'extension.cjs'))],
 ['extension/LICENSE', readFileSync(path.resolve(root, '../../LICENSE'))],
 ['extension/NOTICE', readFileSync(path.resolve(root, '../../NOTICE'))],
 ['[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="json" ContentType="application/json"/><Default Extension="cjs" ContentType="application/javascript"/><Default Extension="vsixmanifest" ContentType="text/xml"/><Override PartName="/extension/LICENSE" ContentType="text/plain"/><Override PartName="/extension/NOTICE" ContentType="text/plain"/></Types>')],
 ['extension.vsixmanifest', Buffer.from(`<?xml version="1.0"?><PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011"><Metadata><Identity Language="en-US" Id="cursor-bridge" Version="${manifest.version}" Publisher="agentkib"/><DisplayName>AgentKib Session Bridge</DisplayName><Description xml:space="preserve">Local Cursor IDE session interoperability</Description></Metadata><Installation><InstallationTarget Id="Microsoft.VisualStudio.Code"/></Installation><Dependencies/><Assets><Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true"/></Assets></PackageManifest>`)],
];
const local = [], central = []; let offset = 0;
for (const [entry, bytes] of entries) {
 const name=Buffer.from(entry), crc=crc32(bytes), header=Buffer.alloc(30), dir=Buffer.alloc(46);
 header.writeUInt32LE(0x04034b50);header.writeUInt16LE(20,4);header.writeUInt32LE(crc,14);header.writeUInt32LE(bytes.length,18);header.writeUInt32LE(bytes.length,22);header.writeUInt16LE(name.length,26);
 dir.writeUInt32LE(0x02014b50);dir.writeUInt16LE(20,4);dir.writeUInt16LE(20,6);dir.writeUInt32LE(crc,16);dir.writeUInt32LE(bytes.length,20);dir.writeUInt32LE(bytes.length,24);dir.writeUInt16LE(name.length,28);dir.writeUInt32LE(offset,42);
 local.push(header,name,bytes);central.push(dir,name);offset += header.length+name.length+bytes.length;
}
const directory=Buffer.concat(central), end=Buffer.alloc(22);
end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
const bytes=Buffer.concat([...local,directory,end]);
mkdirSync(destination,{recursive:true});
writeFileSync(path.join(destination,'agentkib.cursor-bridge.vsix'),bytes);
writeFileSync(path.join(destination,'manifest.json'),JSON.stringify({id:'agentkib.cursor-bridge',version:manifest.version,sha256:createHash('sha256').update(bytes).digest('hex')},null,2)+'\n');
