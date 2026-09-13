import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { buildCases,SEEDS,SUITE_VERSION,CATEGORY_COUNTS } from '../cases.mjs';

const ROOT=new URL('../',import.meta.url);
const FILES=['cases.mjs','models.mjs','run.mjs','compare.mjs','lib/adapters.mjs','lib/fara-reference.json','lib/browser.mjs','lib/fixture.mjs','lib/scoring.mjs','lib/manifest.mjs'];
export const DEFAULT_LIMITS=Object.freeze({maxTurns:80,maxActions:120,taskTimeoutMs:900000,requestTimeoutMs:90000,maxTokens:4096});
export const digest=value=>createHash('sha256').update(value).digest('hex');
export async function manifest() {
  const files={};for(const path of FILES)files[path]=digest(await readFile(new URL(path,ROOT)));
  const cases=[...buildCases({split:'pilot'}),...buildCases()].map(c=>({id:c.id,taskId:c.taskId,category:c.category,split:c.split,seed:c.seed,sha256:digest(JSON.stringify(c))}));
  return {version:SUITE_VERSION,seeds:SEEDS,categories:CATEGORY_COUNTS,limits:DEFAULT_LIMITS,files,cases};
}
export async function verifyManifest() {
  const actual=await manifest();
  const frozen=JSON.parse(await readFile(new URL('manifest.json',ROOT),'utf8'));
  if(JSON.stringify(actual)!==JSON.stringify(frozen))throw new Error('Frozen manifest mismatch. Review changes and explicitly re-freeze before comparing runs.');
  return digest(JSON.stringify(actual));
}
