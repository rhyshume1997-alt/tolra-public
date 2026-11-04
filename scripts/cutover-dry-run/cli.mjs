#!/usr/bin/env node
import {fakeDryRun} from './check.mjs';
if(process.argv.length!==2){process.stderr.write('REFUSED: this fake-only command accepts no arguments or write option\n');process.exitCode=2;}
else try{const report=await fakeDryRun();process.stdout.write(JSON.stringify(report,null,2)+'\n');process.exitCode=report.status==='FAIL'?1:0;}
catch{process.stderr.write('FAIL: fake fixture dry run could not complete\n');process.exitCode=1;}
