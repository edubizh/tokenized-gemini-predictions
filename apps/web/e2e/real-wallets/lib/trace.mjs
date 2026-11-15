// Records every request a page makes to a wallet. A wallet extension registers itself with the page
// through the Wallet Standard; this stands between that registration and the app, and reports each
// feature call (connect, sign a message, sign a transaction, ...): when it was made, with what, and
// how it ended. The app and the wallet behave as they would without it.

/** Runs in the page before anything else. */
function installTrace() {
  const report = (entry) => console.debug(`[wallet-call] ${JSON.stringify(entry)}`);
  const text = (bytes) => new TextDecoder().decode(bytes).replace(/\s+/g, " ").slice(0, 80);
  const describe = (feature, input) => {
    if (!input || typeof input !== "object") return input === undefined ? "" : String(input);
    if (feature.endsWith("signMessage")) return `${input.message?.length ?? "?"} bytes: "${input.message ? text(input.message) : ""}"`;
    if (feature.endsWith("Transaction")) return `${input.transaction?.length ?? "?"} bytes, chain ${input.chain ?? "(none)"}`;
    return JSON.stringify(input, (key, value) => (value instanceof Uint8Array ? `${value.length} bytes` : value)).slice(0, 160);
  };
  const outcome = (feature, result) => {
    if (feature === "standard:connect") return `${result?.accounts?.length ?? 0} account(s): ${(result?.accounts ?? []).map((account) => account.address).join(", ")}`;
    return Array.isArray(result) ? `${result.length} result(s)` : "";
  };

  let calls = 0;
  const traced = (wallet, feature, method, fn) => async (...inputs) => {
    const id = ++calls;
    const started = Date.now();
    report({ id, wallet, feature, method, phase: "called", with: inputs.map((input) => describe(feature, input)).join("; "), gesture: navigator.userActivation?.isActive ?? null, visible: !document.hidden });
    try {
      const result = await fn(...inputs);
      report({ id, wallet, feature, phase: "resolved", after: Date.now() - started, result: outcome(feature, result) });
      return result;
    } catch (error) {
      report({ id, wallet, feature, phase: "rejected", after: Date.now() - started, error: String(error?.message ?? error).slice(0, 200) });
      throw error;
    }
  };

  const wrapped = new WeakMap();
  const wrap = (wallet) => {
    if (!wallet || typeof wallet !== "object" || typeof wallet.name !== "string") return wallet;
    if (wrapped.has(wallet)) return wrapped.get(wallet);
    report({ wallet: wallet.name, phase: "registered", chains: (wallet.chains ?? []).join(","), features: Object.keys(wallet.features ?? {}).join(",") });
    const proxy = new Proxy(wallet, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (property !== "features") return typeof value === "function" ? value.bind(target) : value;
        const features = {};
        for (const [name, feature] of Object.entries(value)) {
          features[name] = { ...feature };
          for (const [method, fn] of Object.entries(feature)) {
            if (typeof fn !== "function") continue;
            features[name][method] =
              name === "standard:events"
                ? (event, listener) =>
                    fn(event, (change) => {
                      report({ wallet: target.name, phase: "event", event, accounts: change?.accounts?.map((account) => account.address) ?? null });
                      listener(change);
                    })
                : traced(target.name, name, method, fn);
          }
        }
        return features;
      },
    });
    wrapped.set(wallet, proxy);
    return proxy;
  };
  const wrapApi = (api) => Object.freeze({ register: (...wallets) => api.register(...wallets.map(wrap)) });

  // The app listens for wallets that register themselves...
  const addEventListener = window.addEventListener;
  window.addEventListener = function (type, listener, options) {
    if (type !== "wallet-standard:register-wallet" || typeof listener !== "function") return addEventListener.call(this, type, listener, options);
    return addEventListener.call(this, type, (event) => listener({ type: event.type, detail: (api) => event.detail(wrapApi(api)) }), options);
  };
  // ...and announces itself to the wallets that are already there.
  const dispatchEvent = window.dispatchEvent;
  window.dispatchEvent = function (event) {
    if (event?.type !== "wallet-standard:app-ready") return dispatchEvent.call(this, event);
    return dispatchEvent.call(this, new CustomEvent(event.type, { detail: wrapApi(event.detail) }));
  };
}

/**
 * Starts tracing on a page (call before it navigates). Returns the list the calls are appended to:
 * `{ at, id, wallet, feature, phase, ... }`, `phase` being registered, called, resolved, rejected
 * or event. `log` receives one line per entry.
 */
export async function traceWalletCalls(page, log) {
  const calls = [];
  await page.addInitScript(installTrace);
  page.on("console", (message) => {
    const line = message.text();
    if (!line.startsWith("[wallet-call] ")) return;
    const entry = { at: Date.now(), ...JSON.parse(line.slice(14)) };
    calls.push(entry);
    const { at, wallet, phase, feature, id, ...rest } = entry;
    log("wallet", `${wallet} ${feature ?? ""}${id ? `#${id}` : ""} ${phase} ${Object.entries(rest).map(([key, value]) => `${key}=${typeof value === "string" ? value : JSON.stringify(value)}`).join(" ")}`.replace(/\s+/g, " "));
  });
  return calls;
}
