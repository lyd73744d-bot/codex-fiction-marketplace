"use strict";
const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const fsp = require("node:fs/promises");
const onboarding = require("../server/onboarding-state");

async function withTemp(fn) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "lfd-onboard-"));
  const statePath = path.join(dir, "onboarding-state.json");
  try { return await fn(statePath); }
  finally { try { await fsp.rm(dir, { recursive: true, force: true }); } catch {} }
}

async function main() {
  await withTemp(async (statePath) => {
    // fresh install must popup
    let state = await onboarding.markPackageInstalled(statePath);
    let d = onboarding.decidePopup(state, { loggedIn: false });
    assert.equal(d.open, true);
    assert.equal(d.reason, "first_install");

    // after shown once: NEVER auto re-open for first install (even if cooldown expired)
    state = await onboarding.markPopup("open_gateway_login", statePath);
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 0 });
    assert.equal(d.open, false);
    assert.equal(d.reason, "first_install_already_shown");

    // cooldown path also blocked (same already_shown)
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 120000 });
    assert.equal(d.open, false);
    assert.equal(d.reason, "first_install_already_shown");

    // initialize reason also does not re-open after shown
    state = await onboarding.markPopup("initialize", statePath);
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 0 });
    assert.equal(d.open, false);
    assert.equal(d.reason, "first_install_already_shown");

    // logged in => never
    d = onboarding.decidePopup(state, { loggedIn: true });
    assert.equal(d.open, false);
    assert.equal(d.reason, "already_logged_in");

    // mark login ok
    state = await onboarding.markLoginOk(statePath);
    assert.ok(state.firstLoginCompletedAt);
    assert.equal(state.pendingFirstLogin, false);
    d = onboarding.decidePopup(state, { loggedIn: true });
    assert.equal(d.open, false);

    // reinstall after login should NOT reset first login / should not casual popup when logged in
    state = await onboarding.markPackageInstalled(statePath);
    assert.ok(state.firstLoginCompletedAt);
    assert.equal(state.pendingFirstLogin, false);
    d = onboarding.decidePopup(state, { loggedIn: true });
    assert.equal(d.open, false);

    // session drop after previous login
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 0 });
    assert.equal(d.open, true);
    assert.equal(d.reason, "session_dropped");

    // drop cooldown for ANY recent popup reason
    state = await onboarding.markPopup("open_gateway_login", statePath);
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 120000 });
    assert.equal(d.open, false);
    assert.equal(d.reason, "session_drop_cooldown");

    // after cooldown ends, drop reminds again
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 0 });
    assert.equal(d.open, true);
    assert.equal(d.reason, "session_dropped");

    // force flag works even when first_install already shown or in drop cooldown
    d = onboarding.decidePopup(state, { loggedIn: false, cooldownMs: 120000, force: true });
    assert.equal(d.open, true);
    assert.equal(d.reason, "forced");

    // reinstall when NEVER logged in clears lastPopupAt so install can popup again
    const neverPath = statePath + ".never.json";
    let s2 = await onboarding.markPackageInstalled(neverPath);
    s2 = await onboarding.markPopup("first_install", neverPath);
    d = onboarding.decidePopup(s2, { loggedIn: false, cooldownMs: 0 });
    assert.equal(d.open, false);
    assert.equal(d.reason, "first_install_already_shown");
    s2 = await onboarding.markPackageInstalled(neverPath);
    assert.equal(s2.lastPopupAt, null);
    d = onboarding.decidePopup(s2, { loggedIn: false });
    assert.equal(d.open, true);
    assert.equal(d.reason, "first_install");
  });
  console.log("onboarding popup rules: PASS");
}

main().catch((e) => { console.error(e); process.exit(1); });
