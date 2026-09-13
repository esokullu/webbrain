#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { manifest } from './lib/manifest.mjs';

// This is an explicit maintainer operation, never invoked by run.mjs.
const args=process.argv.slice(2);
if(args.some(a=>!['--write','--replace-existing'].includes(a)))throw new Error('Use --write [--replace-existing], or no arguments to print');
const content=JSON.stringify(await manifest(),null,2)+'\n';
if(args.includes('--write')) {
  await writeFile(new URL('manifest.json',import.meta.url),content,{flag:args.includes('--replace-existing')?'w':'wx'});
  console.log('Frozen manifest written. Previous results must not be compared across a changed manifest.');
} else process.stdout.write(content);
