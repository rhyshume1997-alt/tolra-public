import {readFileSync,existsSync} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
export function checkCutoverImports(root){
 const read=f=>readFileSync(path.join(root,f),'utf8'),errors=[];
 const plan=JSON.parse(read('supabase/cutover-import-plan.json')),hashes=JSON.parse(read('supabase/release/sliq-cutover.checksums.json'));
 if(JSON.stringify(plan.requiredCutoverOrder)!=='[138,140,141,144,145,146]')errors.push('Required cutover order differs');
 const preflight=read('supabase/verify/release_preflight.sql');
 for(const p of plan.imports){
  if(!preflight.includes(`'${p.marker}'`))errors.push(`Missing preflight marker: ${p.marker}`);
  for(const key of ['source','release','verify','rollback']){
   const file=p[key];if(!existsSync(path.join(root,file))){errors.push(`Missing ${key}: ${file}`);continue;}
   if(hashes.sha256[file]!==createHash('sha256').update(read(file)).digest('hex'))errors.push(`Checksum differs: ${file}`);
  }
  if(!read(p.release).includes(read(p.source).trim()))errors.push(`Held source not preserved: ${p.number}`);
 }
 for(const file of ['supabase/cutover-import-plan.json','supabase/verify/release_preflight.sql'])if(hashes.sha256[file]!==createHash('sha256').update(read(file)).digest('hex'))errors.push(`Checksum differs: ${file}`);
 return errors;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1])){const errors=checkCutoverImports(path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'));errors.forEach(e=>console.error(e));if(errors.length)process.exitCode=1;else console.log('Cutover package checked: 138 -> 140 -> 141 -> 144 -> 145 -> 146; no SQL executed.');}
