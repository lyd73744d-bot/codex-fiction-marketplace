"use strict";

const assert = require("node:assert");
const {
  createBillingGateway,
  readBillingSnapshot
} = require("../server/billing-guard");

function gatewayFor({ balance, plan = "count" } = {}) {
  return {
    async accountStatus() {
      return {
        ok: true,
        loggedIn: true,
        active: true,
        balance,
        user: { username: "billing-test", active: true, balance, plan }
      };
    },
    async listModels() {
      return { models: [{ id: "test-model", credits: 10 }] };
    },
    async callModels() {
      return { content: "test output", model: "test-model" };
    }
  };
}

async function expectCode(promise, code) {
  try {
    await promise;
  } catch (error) {
    assert.strictEqual(error.code, code);
    return error;
  }
  assert.fail(`expected ${code}`);
}

async function main() {
  const unlimited = await readBillingSnapshot(gatewayFor({ balance: -1, plan: "unlimited" }), ["test-model"]);
  assert.strictEqual(unlimited.mode, "unlimited");
  assert.strictEqual(unlimited.balanceWarning, undefined, "unlimited plans must not receive low-balance warnings");

  const healthy = await readBillingSnapshot(gatewayFor({ balance: 101 }), ["test-model"]);
  assert.strictEqual(healthy.balanceWarning, undefined, "a balance above the warning floor should remain quiet");

  const low = await readBillingSnapshot(gatewayFor({ balance: 80 }), ["test-model"]);
  assert.strictEqual(low.balanceWarning, true, "low balance was not flagged");
  assert.strictEqual(low.balanceLevel, "low");
  assert.strictEqual(low.balanceThreshold, 100);

  let warnings = 0;
  const billedLow = createBillingGateway(gatewayFor({ balance: 80 }), {
    async onBalanceWarning(snapshot) {
      warnings += 1;
      return { popupOpened: true, reason: "low_balance", balance: snapshot.balanceBefore };
    }
  });
  const lowResult = await billedLow.callModels({ modelIds: ["test-model"] });
  assert.strictEqual(warnings, 1, "a low-balance call did not trigger the warning callback");
  assert.strictEqual(lowResult.billing.balanceWarning, true);
  assert.strictEqual(lowResult.billing.balancePopup.popupOpened, true);

  const billedInsufficient = createBillingGateway(gatewayFor({ balance: 5 }), {
    async onBalanceWarning() {
      warnings += 1;
      return { popupOpened: true, reason: "insufficient_balance" };
    }
  });
  const insufficient = await expectCode(billedInsufficient.callModels({ modelIds: ["test-model"] }), "INSUFFICIENT_BALANCE");
  assert.strictEqual(insufficient.billing.balanceWarning, true, "insufficient balance must retain the warning state");
  assert.strictEqual(insufficient.billing.balancePopup.popupOpened, true, "insufficient balance did not expose the warning popup result");

  console.log("PASS selftest-billing-warning: unlimited quiet, low balance warned, insufficient balance blocked");
}

main().catch((error) => {
  console.error("FAIL", error && (error.stack || error.message || error));
  process.exit(1);
});
