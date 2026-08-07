"use strict";

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function uniqueModelIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))]
    : [];
}

const DEFAULT_LOW_BALANCE_FLOOR = 100;
const DEFAULT_LOW_BALANCE_MULTIPLIER = 2;

function lowBalanceWarning(accountBilling, estimatedCredits, {
  floor = DEFAULT_LOW_BALANCE_FLOOR,
  multiplier = DEFAULT_LOW_BALANCE_MULTIPLIER
} = {}) {
  if (accountBilling?.mode !== "metered" || accountBilling.balance == null) return null;
  const cost = numberOrNull(estimatedCredits);
  if (cost == null || cost <= 0) return null;
  const minimum = Math.max(0, numberOrNull(floor) ?? DEFAULT_LOW_BALANCE_FLOOR);
  const factor = Math.max(1, numberOrNull(multiplier) ?? DEFAULT_LOW_BALANCE_MULTIPLIER);
  const threshold = Math.max(minimum, Math.ceil(cost * factor));
  if (accountBilling.balance > threshold) return null;
  return {
    level: accountBilling.balance < cost ? "critical" : "low",
    balanceBefore: accountBilling.balance,
    estimatedCredits: cost,
    threshold,
    message: accountBilling.balance < cost
      ? `余额不足：本次预计消耗 ${cost} 积分，当前余额 ${accountBilling.balance} 积分。`
      : `余额偏低：本次预计消耗 ${cost} 积分，当前余额 ${accountBilling.balance} 积分。建议先充值。`
  };
}

function accountMode(account) {
  const user = account?.user || account || {};
  const rawBalance = numberOrNull(account?.balance ?? user.balance);
  const quota = numberOrNull(user.quota);
  const used = numberOrNull(user.used);
  const callsLeft = numberOrNull(user.callsLeft);
  const plan = String(user.plan || account?.plan || "").toLowerCase();
  const accountType = String(user.accountType || account?.accountType || "").toLowerCase();
  const unlimited = plan.includes("unlimited")
    || /unlimited|permanent|unmetered|hosted/u.test(accountType)
    || rawBalance != null && rawBalance < 0
    || callsLeft != null && callsLeft < 0;

  let balance = null;
  if (!unlimited && rawBalance != null && rawBalance >= 0) balance = rawBalance;
  if (!unlimited && balance == null && quota != null && used != null) balance = Math.max(0, quota - used);
  if (!unlimited && balance == null && callsLeft != null && callsLeft >= 0) {
    const perCall = numberOrNull(user.creditsPerCall);
    if (perCall != null && perCall > 0) balance = Math.max(0, callsLeft * perCall);
  }

  return {
    mode: unlimited ? "unlimited" : "metered",
    balance,
    rawBalance,
    quota,
    used,
    callsLeft,
    username: user.username || account?.username || null,
    plan: user.plan || account?.plan || null,
    accountType: user.accountType || account?.accountType || null
  };
}

function modelCost(models, modelId, modelCredits = {}) {
  const id = String(modelId || "");
  const model = (Array.isArray(models) ? models : []).find((item) => String(item?.id || "") === id);
  const raw = model?.credits
    ?? model?.creditCost
    ?? model?.cost
    ?? model?.creditsPerCall
    ?? modelCredits?.[id];
  const cost = numberOrNull(raw);
  return cost != null && cost >= 0 ? Math.floor(cost) : null;
}

function billingError(code, message, billing) {
  const error = new Error(message);
  error.code = code;
  error.billing = billing;
  return error;
}

async function readBillingSnapshot(gateway, modelIds, { includeModels = true } = {}) {
  if (!gateway || typeof gateway.accountStatus !== "function") {
    throw billingError("BILLING_UNAVAILABLE", "无法读取账号余额，已停止模型调用。", { status: "unavailable" });
  }

  const account = await gateway.accountStatus();
  if (!account || account.loggedIn !== true || account.active === false || account.user?.active === false) {
    const error = new Error("请先登录网关。");
    error.code = "AUTH_REQUIRED";
    error.billing = { status: "unauthenticated" };
    throw error;
  }

  let models = [];
  let modelCredits = gateway.modelCredits && typeof gateway.modelCredits === "object" ? gateway.modelCredits : {};
  if (includeModels) {
    if (typeof gateway.listModels !== "function") {
      throw billingError("BILLING_UNAVAILABLE", "网关没有提供实时模型费率，已停止模型调用。", { status: "unavailable" });
    }
    let catalog;
    try {
      catalog = await gateway.listModels();
    } catch (cause) {
      throw billingError("BILLING_UNAVAILABLE", "无法读取实时模型费率，已停止模型调用。", {
        status: "rate_unavailable",
        causeCode: cause?.code || null
      });
    }
    models = Array.isArray(catalog) ? catalog : (Array.isArray(catalog?.models) ? catalog.models : []);
    if (catalog?.modelCredits && typeof catalog.modelCredits === "object") modelCredits = catalog.modelCredits;
  }

  const ids = uniqueModelIds(modelIds);
  const rates = ids.map((modelId) => ({ modelId, credits: modelCost(models, modelId, modelCredits) }));
  const missing = rates.filter((item) => item.credits == null).map((item) => item.modelId);
  if (missing.length) {
    throw billingError("BILLING_UNAVAILABLE", "所选模型没有可核对的实时费率，已停止模型调用。", {
      status: "rate_missing",
      modelIds: ids,
      missingModelIds: missing
    });
  }

  const accountBilling = accountMode(account);
  const estimatedCredits = rates.reduce((sum, item) => sum + item.credits, 0);
  const snapshot = {
    status: "checked",
    mode: accountBilling.mode,
    modelIds: ids,
    rates,
    estimatedCredits,
    balanceBefore: accountBilling.balance,
    expectedBalanceAfter: accountBilling.mode === "metered" && accountBilling.balance != null
      ? Math.max(0, accountBilling.balance - estimatedCredits)
      : null,
    quotaBefore: accountBilling.quota,
    usedBefore: accountBilling.used,
    callsLeftBefore: accountBilling.callsLeft,
    username: accountBilling.username,
    plan: accountBilling.plan,
    accountType: accountBilling.accountType
  };

  const warning = lowBalanceWarning(accountBilling, estimatedCredits);
  if (warning) {
    snapshot.balanceWarning = true;
    snapshot.balanceLevel = warning.level;
    snapshot.balanceThreshold = warning.threshold;
    snapshot.balanceWarningMessage = warning.message;
  }

  if (accountBilling.mode === "metered" && accountBilling.balance == null) {
    throw billingError("BILLING_UNAVAILABLE", "无法确认当前有限积分余额，已停止模型调用。", {
      ...snapshot,
      status: "balance_unavailable"
    });
  }
  if (accountBilling.mode === "metered" && estimatedCredits > accountBilling.balance) {
    throw billingError(
      "INSUFFICIENT_BALANCE",
      `余额不足：本次预计消耗 ${estimatedCredits} 积分，当前余额 ${accountBilling.balance} 积分。`,
      {
        ...snapshot,
        status: "insufficient_balance",
        balanceAfterEstimate: accountBilling.balance,
        message: "请先充值或兑换积分，再重新确认本次调用。"
      }
    );
  }

  return snapshot;
}

async function readAfterAccount(gateway) {
  try {
    if (typeof gateway?.accountStatus !== "function") return null;
    return await gateway.accountStatus();
  } catch {
    return null;
  }
}

function finalizeBilling(before, afterAccount, { succeeded = true } = {}) {
  const after = afterAccount ? accountMode(afterAccount) : null;
  const result = {
    status: "verified",
    mode: before?.mode || "unknown",
    modelIds: before?.modelIds || [],
    rates: before?.rates || [],
    estimatedCredits: before?.estimatedCredits ?? null,
    balanceBefore: before?.balanceBefore ?? null,
    balanceAfter: after?.balance ?? null,
    expectedBalanceAfter: before?.mode === "metered" && before.balanceBefore != null
      ? Math.max(0, before.balanceBefore - before.estimatedCredits)
      : null,
    quotaBefore: before?.quotaBefore ?? null,
    quotaAfter: after?.quota ?? null,
    usedBefore: before?.usedBefore ?? null,
    usedAfter: after?.used ?? null,
    callsLeftBefore: before?.callsLeftBefore ?? null,
    callsLeftAfter: after?.callsLeft ?? null,
    balanceWarning: before?.balanceWarning === true,
    balanceLevel: before?.balanceLevel || null,
    balanceThreshold: before?.balanceThreshold ?? null,
    balanceWarningMessage: before?.balanceWarningMessage || null,
    balancePopup: before?.balancePopup || null,
    succeeded: succeeded === true,
    chargeStatus: "unverified",
    message: "调用后余额暂未核对。"
  };

  if (before?.mode === "unlimited") {
    result.chargeStatus = "unmetered";
    result.message = "当前是不限额/托管套餐；本次不会扣有限积分，模型费率仅作参考。";
    if (!after) result.status = "postcheck_unavailable";
    return result;
  }
  if (!after || after.mode !== "metered" || before.balanceBefore == null || after.balance == null) {
    result.status = "postcheck_unavailable";
    result.chargeStatus = "unverified";
    result.message = "模型已返回，但调用后余额无法核对；请刷新账号状态后再继续调用。";
    return result;
  }

  const delta = before.balanceBefore - after.balance;
  result.chargedCredits = Math.max(0, delta);
  result.balanceChanged = delta !== 0;
  if (!succeeded) {
    result.chargeStatus = delta > 0 ? "charged_after_error" : "not_charged_after_error";
    result.message = delta > 0
      ? `请求未正常完成，但余额已减少约 ${Math.max(0, delta)} 积分；请以后台记录为准。`
      : "请求未正常完成，核对到余额未减少。";
  } else if (delta === before.estimatedCredits) {
    result.chargeStatus = "charged";
    result.message = `已扣 ${delta} 积分；调用后余额 ${after.balance} 积分。`;
  } else if (delta > 0) {
    result.chargeStatus = "charged_different_amount";
    result.message = `余额减少 ${delta} 积分；预计 ${before.estimatedCredits} 积分，请以后台记录为准。`;
  } else if (delta === 0) {
    result.chargeStatus = "not_charged";
    result.message = "模型已返回，但余额没有减少；这次不能当作扣费成功，请检查账号套餐和后台记录。";
  } else {
    result.chargeStatus = "balance_increased";
    result.message = `调用后余额为 ${after.balance} 积分，较调用前增加 ${Math.abs(delta)} 积分。`;
  }
  return result;
}

function createBillingGateway(gateway, { onBalanceWarning } = {}) {
  if (!gateway || typeof gateway.callModels !== "function") throw new TypeError("gateway.callModels is required");
  let tail = Promise.resolve();
  const runExclusive = (operation) => {
    const current = tail.then(operation, operation);
    tail = current.catch(() => {});
    return current;
  };

  const billed = Object.assign({}, gateway);
  billed.callModels = (input = {}) => runExclusive(async () => {
    async function notifyBalanceWarning(snapshot) {
      if (snapshot?.balanceWarning !== true || typeof onBalanceWarning !== "function") return;
      try {
        const popup = await onBalanceWarning(snapshot);
        if (popup && typeof popup === "object") snapshot.balancePopup = popup;
      } catch {
        // A warning popup must never turn a valid, sufficiently funded call into a failed call.
      }
    }

    let before;
    try {
      before = await readBillingSnapshot(gateway, input.modelIds);
    } catch (error) {
      await notifyBalanceWarning(error?.billing);
      throw error;
    }
    await notifyBalanceWarning(before);
    let result;
    try {
      result = await gateway.callModels(input);
    } catch (error) {
      const after = await readAfterAccount(gateway);
      error.billing = finalizeBilling(before, after, { succeeded: false });
      throw error;
    }
    const after = await readAfterAccount(gateway);
    const output = result && typeof result === "object" && !Array.isArray(result)
      ? { ...result }
      : { content: String(result || "") };
    output.billing = finalizeBilling(before, after, { succeeded: true });
    return output;
  });
  billed.readBillingSnapshot = (modelIds) => readBillingSnapshot(gateway, modelIds);
  return Object.freeze(billed);
}

module.exports = {
  accountMode,
  createBillingGateway,
  finalizeBilling,
  lowBalanceWarning,
  modelCost,
  readBillingSnapshot,
  uniqueModelIds,
  DEFAULT_LOW_BALANCE_FLOOR,
  DEFAULT_LOW_BALANCE_MULTIPLIER
};
