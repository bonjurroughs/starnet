/* node test/claudecode-cap-fallback.http.test.js — the Claude usage-cap fallback opt-in, against a REAL sidecar.
   Default OFF; a real boolean flips it; it survives a restart; junk input is refused and changes nothing. */
'use strict';
const assert = require('node:assert/strict');
const { SidecarFixture } = require('./helpers/sidecar-fixture.js');

(async () => {
  const f = SidecarFixture.create({ timeoutMs: 15000 });
  try {
    await f.start();
    const route = '/api/claudecode/cap-fallback';

    let r = await f.json('GET', route);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { enabled: false }, 'a fresh station has the fallback OFF');

    for (const bad of [{ enabled: 'true' }, { enabled: 1 }, {}]) {
      r = await f.json('POST', route, bad);
      assert.equal(r.status, 400, 'a non-boolean is refused: ' + JSON.stringify(bad));
    }
    assert.deepEqual((await f.json('GET', route)).body, { enabled: false }, 'refused input changes nothing');

    r = await f.json('POST', route, { enabled: true });
    assert.deepEqual(r.body, { enabled: true }, 'POST true turns it on');

    await f.restart();
    assert.deepEqual((await f.json('GET', route)).body, { enabled: true }, 'ON survives a sidecar restart');

    r = await f.json('POST', route, { enabled: false });
    assert.deepEqual(r.body, { enabled: false }, 'POST false turns it off');
    await f.restart();
    assert.deepEqual((await f.json('GET', route)).body, { enabled: false }, 'OFF survives a sidecar restart');

    console.log('claudecode-cap-fallback.http: PASS (default off, boolean-only, persisted across restart)');
  } finally { await f.dispose(); }
})().catch(e => { console.error(e); process.exitCode = 1; });
