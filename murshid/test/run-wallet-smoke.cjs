'use strict';

// Runs the wallet's end-to-end check (wallet-smoke.cjs) in a fresh profile.
// MURSHID_TEST_SHOTS=<folder> keeps screenshots of the wallet panel.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'murshid-wallet-test-'));
try {
  fs.writeFileSync(path.join(profile, 'murshid-settings.json'), JSON.stringify({ startCompanion: false, ...(process.env.MURSHID_TEST_LANG ? { language: process.env.MURSHID_TEST_LANG } : {}) }));
  const env = { ...process.env, MURSHID_PROFILE: profile };
  delete env.MURSHID_COMPANION;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'wallet-smoke.cjs')], { env, stdio: 'inherit', timeout: 120000 });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  fs.rmSync(profile, { recursive: true, force: true });
}
