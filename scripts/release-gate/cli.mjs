#!/usr/bin/env node
import {readFileSync,realpathSync,statSync} from 'node:fs';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {releaseGate} from './check.mjs';
const args=process.argv.slice(2);
if(args.length!==2){console.error('Usage: node scripts/release-gate/cli.mjs MANIFEST_JSON ARTIFACT_DIRECTORY');process.exitCode=2;}
else try{
 const actualHead=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
 const clean=!execFileSync('git',['status','--porcelain','--untracked-files=normal'],{encoding:'utf8'}).trim();
 const manifest=JSON.parse(readFileSync(args[0],'utf8')),root=realpathSync(args[1]);
 const readArtifact=relative=>{
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).includes('..'))throw Error('Unsafe artifact path');
  const file=realpathSync(path.resolve(root,relative));if(!file.startsWith(root+path.sep)||!statSync(file).isFile()||statSync(file).size>8*1024*1024)throw Error('Artifact outside reviewed directory or too large');
  return readFileSync(file,'utf8');
 };
 const result=releaseGate(manifest,actualHead,readArtifact,clean);console.log(JSON.stringify(result,null,2));if(!result.eligibleForReview)process.exitCode=1;
}catch{console.error('REFUSE: missing/invalid manifest, artifact directory or Git checkout. No approval granted.');process.exitCode=1;}
