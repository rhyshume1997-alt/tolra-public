#!/usr/bin/env node
// Reads exactly one local JSON file, prints the result. Never connects or writes.
import {readFileSync,realpathSync,statSync} from 'node:fs';
import {reconcile} from './check.mjs';
try{
 const args=process.argv.slice(2);
 if(args.length!==1 || args[0].startsWith('-') || /:\/\//.test(args[0]))throw Error('Supply one local snapshot JSON path');
 const file=realpathSync(args[0]);
 if(!statSync(file).isFile() || statSync(file).size>100*1024*1024)throw Error('Invalid or oversized input');
 const result=reconcile(JSON.parse(readFileSync(file,'utf8')));
 process.stdout.write(JSON.stringify(result,null,2)+'\n');process.exitCode=result.status==='PASS'?0:1;
}catch{process.stderr.write('REFUSED: invalid local reconciliation input\n');process.exitCode=2;}
