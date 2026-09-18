import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { harness, payload, cart, customer } from "./harness.mjs";
const tests = [];
const test = (name, fn) => tests.push({ name, fn });
test("Cadastro Privé valida consentimentos e evita duplicidade", async () => {
  const h = await harness();
  const member = {
    name: "Nivia Anacleto",
    email: "nivia@example.com",
    phone: "21971133616",
    acceptTerms: true,
    acceptPrivacy: true,
    marketingConsent: true,
  };
  assert.equal(
    (await h.api("/api/prive/register", { ...member, acceptTerms: false }))
      .status,
    400,
  );
  const first = await h.api("/api/prive/register", member);
  const second = await h.api("/api/prive/register", {
    ...member,
    name: "Nivia A.",
  });
  assert.equal(first.status, 201);
  assert.equal(first.data.created, true);
  assert.equal(second.status, 200);
  assert.equal(second.data.created, false);
  assert.equal(second.data.member.pointsBalance, 0);
  await h.drain();
  assert.equal(
    h.state.calls.filter((c) => c.url === "https://api.resend.com/emails")
      .length,
    1,
  );
});
test("Compra paga credita pontos Privé uma única vez e exclui o frete", async () => {
  const h = await harness();
  await h.api("/api/prive/register", {
    name: "Cliente Privé",
    email: customer.email,
    acceptTerms: true,
    acceptPrivacy: true,
  });
  await h.drain();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(data.checkoutId).status = "PAID";
  await Promise.all([
    h.api("/api/verify-checkout?orderId=" + data.orderId),
    h.api("/api/verify-checkout?orderId=" + data.orderId),
  ]);
  const member = h.memory.get(`prive-member:${customer.email.toLowerCase()}`);
  assert.equal(member.pointsBalance, 179);
  assert.equal(member.lifetimePoints, 179);
  assert.equal(h.memory.get(`prive-ledger:${data.orderId}`).eligibleValue, 179.97);
});
const priveSecret = "test-secret-with-at-least-thirty-two-characters";
const priveHash = (value) => createHash("sha256").update(`${priveSecret}:${value}`).digest("hex");
async function loginPrive(h, email) {
  const member = await h.store.getPriveMember(email);
  const code = "123456";
  await h.store.issuePriveCode(email, priveHash(`code:${email}:${code}`), "test-ip");
  const verified = await h.api("/api/prive/verify-code", { email, code });
  assert.equal(verified.status, 200);
  return verified.headers["set-cookie"].split(";")[0];
}
test("Acesso Privé usa código único, cookie seguro e sessão autenticada", async () => {
  const h = await harness(), email = "conta@example.com";
  await h.api("/api/prive/register", { name: "Conta Privé", email, acceptTerms: true, acceptPrivacy: true });
  const cookie = await loginPrive(h, email);
  assert.match(cookie, /^amevuri_prive=/);
  const account = await h.api("/api/prive/account", undefined, { cookie });
  assert.equal(account.status, 200);
  assert.equal(account.data.account.member.email, email);
  assert.equal((await h.api("/api/prive/verify-code", { email, code: "123456" })).status, 401);
});
test("Resgate converte pontos, aplica crédito no checkout e devolve ao expirar", async () => {
  const h = await harness();
  await h.api("/api/prive/register", { name: "Cliente Privé", email: customer.email, acceptTerms: true, acceptPrivacy: true });
  const first = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(first.data.checkoutId).status = "PAID";
  await h.api(`/api/verify-checkout?orderId=${first.data.orderId}`);
  const cookie = await loginPrive(h, customer.email);
  const redeemed = await h.api("/api/prive/redeem", { points: 100 }, { cookie });
  assert.equal(redeemed.data.account.member.pointsBalance, 79);
  assert.equal(redeemed.data.account.member.creditBalance, 5);
  const p = payload(); p.requestId = crypto.randomUUID(); p.priveCredit = 5;
  const checkout = await h.api("/api/create-checkout", p, { cookie });
  assert.equal(checkout.status, 200);
  assert.equal(checkout.data.priveCredit, 5);
  assert.equal(checkout.data.total, 187.47);
  assert.equal((await h.store.getPriveMember(customer.email)).creditBalance, 0);
  h.state.checkouts.get(checkout.data.checkoutId).status = "EXPIRED";
  await h.api(`/api/verify-checkout?orderId=${checkout.data.orderId}`);
  assert.equal((await h.store.getPriveMember(customer.email)).creditBalance, 5);
});
test("Reembolso reverte pontos e cria dívida quando pontos já foram usados", async () => {
  const h = await harness();
  await h.api("/api/prive/register", { name: "Cliente Privé", email: customer.email, acceptTerms: true, acceptPrivacy: true });
  const paid = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(paid.data.checkoutId).status = "PAID";
  await h.api(`/api/verify-checkout?orderId=${paid.data.orderId}`);
  const member = await h.store.getPriveMember(customer.email);
  await h.store.redeemPrivePoints(member.id, 100);
  const refunded = await h.api("/api/admin-order", { orderId: paid.data.orderId, financialStatus: "refunded" }, { "x-amevuri-setup-key": "test-admin" });
  assert.equal(refunded.status, 200);
  const after = await h.store.getPriveMember(customer.email);
  assert.equal(after.pointsBalance, 0);
  assert.equal(after.pointsDebt, 100);
  assert.equal((await h.store.getOrder(paid.data.orderId)).status, "refunded");
});
test("Compras anteriores ao cadastro não recebem pontos retroativos", async () => {
  const h = await harness();
  const paid = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(paid.data.checkoutId).status = "PAID";
  await h.api(`/api/verify-checkout?orderId=${paid.data.orderId}`);
  await new Promise((resolve) => setTimeout(resolve, 2));
  await h.api("/api/prive/register", { name: "Cadastro posterior", email: customer.email, acceptTerms: true, acceptPrivacy: true });
  const result = await h.store.awardPrivePoints(await h.store.getOrder(paid.data.orderId));
  assert.equal(result.reason, "purchase-before-enrollment");
  assert.equal((await h.store.getPriveMember(customer.email)).pointsBalance, 0);
});
test("Pontos vencem em doze meses e a expiração entra no histórico", async () => {
  const h = await harness();
  await h.api("/api/prive/register", { name: "Validade Privé", email: customer.email, acceptTerms: true, acceptPrivacy: true });
  const paid = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(paid.data.checkoutId).status = "PAID";
  await h.api(`/api/verify-checkout?orderId=${paid.data.orderId}`);
  const member = await h.store.getPriveMember(customer.email);
  const indexed = [...h.memory].find(([key, value]) => key.startsWith(`prive-entry:${member.id}:`) && value.type === "purchase");
  indexed[1].expiresAt = "2020-01-01T00:00:00.000Z";
  h.memory.set(indexed[0], indexed[1]);
  h.memory.set(`prive-ledger:${paid.data.orderId}`, indexed[1]);
  const account = await h.store.priveAccount(member.id);
  assert.equal(account.member.pointsBalance, 0);
  assert(account.history.some((entry) => entry.type === "expiry" && entry.points === -179));
});
test("Admin ajusta saldo com histórico e titular pode encerrar a conta", async () => {
  const h = await harness(), email = "ajuste@example.com";
  await h.api("/api/prive/register", { name: "Ajuste Privé", email, acceptTerms: true, acceptPrivacy: true });
  const adjusted = await h.api("/api/admin-prive", { email, points: 200, creditAmount: 10, reason: "Cortesia validada" }, { "x-amevuri-setup-key": "test-admin" });
  assert.equal(adjusted.data.account.member.pointsBalance, 200);
  assert.equal(adjusted.data.account.member.creditBalance, 10);
  const cookie = await loginPrive(h, email);
  assert.equal((await h.api("/api/prive/account", {}, { cookie }, "DELETE")).status, 200);
  assert.equal((await h.api("/api/prive/account", undefined, { cookie })).status, 401);
  assert.equal(await h.store.getPriveMember(email), null);
  assert.equal([...h.memory.keys()].filter((key) => key.startsWith("prive-member-closed:")).length, 1);
});
test("Pesos oficiais e identificadores compatíveis", async () => {
  const h = await harness();
  const r = await h.api("/api/inventory");
  assert.equal(r.status, 200);
  assert.deepEqual(
    r.data.products
      .filter((p) => p.format === "Vela aromática")
      .map((p) => p.size),
    ["130g", "130g"],
  );
  assert.deepEqual(
    r.data.products.filter((p) => p.format === "Wax Melts").map((p) => p.size),
    ["80g", "80g"],
  );
});
test("Frete envia seguro unitário e não revela origem", async () => {
  const h = await harness();
  const r = await h.api("/api/shipping-quote", {
    postalCode: "01001000",
    items: cart,
  });
  assert.equal(r.status, 200);
  assert.equal(r.data.origin, undefined);
  const call = h.state.calls.find((c) => c.url.endsWith("/calculate"));
  assert.equal(call.body.products[0].insurance_value, 69.99);
  assert.equal(call.body.products[0].quantity, 2);
  assert.equal(call.body.from.postal_code, "24358080");
});
test("Entradas inválidas, duplicações e quantidades são recusadas", async () => {
  const h = await harness();
  for (const items of [
    [null],
    [{ id: "toString", quantity: 1 }],
    [
      { id: cart[0].id, quantity: 6 },
      { id: cart[0].id, quantity: 6 },
    ],
    [{ id: cart[0].id, quantity: 0 }],
  ])
    assert.equal(
      (await h.api("/api/shipping-quote", { postalCode: "01001000", items }))
        .status,
      400,
    );
  assert.equal((await h.api("/api/create-checkout", "null")).status, 400);
  assert.equal((await h.api("/api/create-checkout", "{")).status, 400);
});
test("CPF, UF e telefone são validados antes de cobrar", async () => {
  for (const patch of [
    { cpf: "11111111111" },
    { state: "XX" },
    { phone: "1" },
  ]) {
    const h = await harness(),
      p = payload();
    p.customer = { ...customer, ...patch };
    assert.equal((await h.api("/api/create-checkout", p)).status, 400);
    assert.equal(h.state.checkouts.size, 0);
  }
});
test("Frete alterado exige confirmação do novo preço", async () => {
  const h = await harness();
  h.state.quotePrice = 25;
  assert.equal((await h.api("/api/create-checkout", payload())).status, 409);
  assert.equal(h.state.checkouts.size, 0);
  assert.equal((await h.store.getInventory())[cart[0].id], 10);
});
test("Checkout usa preços do catálogo e reserva uma vez", async () => {
  const h = await harness(),
    p = payload();
  p.items = p.items.map((i) => ({ ...i, price: 0.01 }));
  const a = await h.api("/api/create-checkout", p),
    b = await h.api("/api/create-checkout", p);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.equal(a.data.orderId, b.data.orderId);
  assert.equal(a.data.total, 192.47);
  assert.equal(h.state.checkouts.size, 1);
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
});
test("Requisições simultâneas não duplicam a reserva", async () => {
  const h = await harness(),
    p = payload();
  const results = await Promise.all([
    h.api("/api/create-checkout", p),
    h.api("/api/create-checkout", p),
  ]);
  assert(results.some((r) => r.status === 200));
  assert.equal(h.state.checkouts.size, 1);
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
});
test("Resposta perdida é recuperada sem criar nova cobrança", async () => {
  const h = await harness(),
    p = payload();
  h.state.ambiguous = true;
  assert.equal((await h.api("/api/create-checkout", p)).status, 503);
  const r = await h.api("/api/create-checkout", p);
  assert.equal(r.status, 200);
  assert.equal(h.state.checkouts.size, 1);
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
});
test("Expiração repetida devolve estoque uma única vez", async () => {
  const h = await harness(),
    p = payload();
  const { data } = await h.api("/api/create-checkout", p);
  h.state.checkouts.get(data.checkoutId).status = "EXPIRED";
  await Promise.all([
    h.api("/api/verify-checkout?orderId=" + data.orderId),
    h.api("/api/verify-checkout?orderId=" + data.orderId),
  ]);
  assert.equal((await h.store.getInventory())[cart[0].id], 10);
});
test("Webhook valida valor, moeda, referência e recebedor", async () => {
  for (const bad of [
    { amount: 0.01 },
    { currency: "USD" },
    { merchant_code: "OTHER" },
  ]) {
    const h = await harness();
    const { data } = await h.api("/api/create-checkout", payload());
    Object.assign(
      h.state.checkouts.get(data.checkoutId),
      { status: "PAID" },
      bad,
    );
    const r = await h.api("/api/sumup/webhook", {
      event_type: "CHECKOUT_STATUS_CHANGED",
      id: data.checkoutId,
    });
    assert.equal(r.status, 502);
    assert.equal((await h.store.getOrder(data.orderId)).status, "reserved");
  }
});
test("Pagamento confirmado não regride nem duplica emails", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  const c = h.state.checkouts.get(data.checkoutId);
  c.status = "PAID";
  const body = { event_type: "CHECKOUT_STATUS_CHANGED", id: data.checkoutId };
  await Promise.all([
    h.api("/api/sumup/webhook", body),
    h.api("/api/sumup/webhook", body),
  ]);
  assert.equal(
    h.state.calls.filter((c) => c.url === "https://api.resend.com/emails")
      .length,
    2,
  );
  c.status = "EXPIRED";
  await h.api("/api/sumup/webhook", body);
  assert.equal((await h.store.getOrder(data.orderId)).status, "paid");
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
});
test("Falha de email fica persistida e pode ser reenviada", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.emailFail = true;
  h.state.checkouts.get(data.checkoutId).status = "PAID";
  await h.api("/api/sumup/webhook", {
    event_type: "CHECKOUT_STATUS_CHANGED",
    id: data.checkoutId,
  });
  assert.equal((await h.store.getOrder(data.orderId)).status, "paid");
  const keys = [...h.memory].filter(
    ([k, v]) => k.startsWith("notify:") && v.state === "pending",
  );
  assert.equal(keys.length, 2);
  h.state.emailFail = false;
  for (const [k, v] of keys) h.memory.set(k, { ...v, nextAttemptAt: 0 });
  await h.worker.scheduled({}, h.env, h.ctx);
  await h.drain();
  assert(keys.every(([k]) => h.memory.get(k).state === "sent"));
  const calls = h.state.calls.filter(
    (c) => c.url === "https://api.resend.com/emails",
  );
  const retry = calls
    .slice(2)
    .find(
      (c) =>
        c.headers["Idempotency-Key"] === calls[0].headers["Idempotency-Key"],
    );
  assert(retry);
  assert.deepEqual(calls[0].body, retry.body);
});
test("API pública não expõe cliente ou rastreio sem email", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  const r = await h.api("/api/verify-checkout?orderId=" + data.orderId);
  assert.deepEqual(Object.keys(r.data.order).sort(), ["id", "status"]);
  assert.equal(
    (
      await h.api("/api/order-status", {
        orderId: data.orderId,
        email: "outro@example.com",
      })
    ).status,
    404,
  );
});
test("Admin requer chave e não confirma pedido sem pagamento", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  assert.equal(
    (await h.api("/api/admin-order", { orderId: data.orderId })).status,
    401,
  );
  assert.equal(
    (
      await h.api(
        "/api/admin-order",
        { orderId: data.orderId, sendConfirmationEmail: true },
        { "x-amevuri-setup-key": "test-admin" },
      )
    ).status,
    409,
  );
});
test("Webhook Melhor Envio recusa assinatura inválida", async () => {
  const h = await harness();
  assert.equal(
    (
      await h.api("/api/melhor-envio/webhook", {
        event: "order.posted",
        data: { id: "x" },
      })
    ).status,
    401,
  );
});
test("Webhook Melhor Envio assinado atualiza rastreio", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(data.checkoutId).status = "PAID";
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  await h.store.updateOrder(data.orderId, { melhorEnvioOrderId: "label-1" });
  const body = JSON.stringify({
    event: "order.posted",
    data: {
      id: "label-1",
      tracking: "BR123",
      tracking_url: "https://www.melhorrastreio.com.br/rastreio/BR123",
    },
  });
  const signature = createHmac("sha256", "test-secret")
    .update(body)
    .digest("base64");
  assert.equal(
    (
      await h.api("/api/melhor-envio/webhook", body, {
        "x-me-signature": signature,
      })
    ).status,
    204,
  );
  assert.equal(
    (await h.store.getOrder(data.orderId)).fulfillmentStatus,
    "posted",
  );
});
test("OAuth state é consumido uma vez mesmo em concorrência", async () => {
  const h = await harness();
  await h.store.putAuth("oauth-state:nonce", { createdAt: Date.now() });
  const results = await Promise.all([
    h.store.consumeOAuthState("nonce"),
    h.store.consumeOAuthState("nonce"),
  ]);
  assert.equal(results.filter(Boolean).length, 1);
});
test("Renovação concorrente compartilha um único refresh", async () => {
  const h = await harness();
  delete h.env.MELHOR_ENVIO_TOKEN;
  await h.store.putAuth("oauth-token", {
    access_token: "old",
    refresh_token: "refresh",
    expires_at: Date.now() - 100,
  });
  await Promise.all([
    h.store.refreshMelhorEnvio("http://localhost"),
    h.store.refreshMelhorEnvio("http://localhost"),
  ]);
  assert.equal(
    h.state.calls.filter((c) => c.url.endsWith("/oauth/token")).length,
    1,
  );
});
test("Falha de uma tentativa não libera estoque enquanto checkout pode ser pago", async () => {
  const h = await harness(),
    p = payload();
  const { data } = await h.api("/api/create-checkout", p);
  h.state.checkouts.get(data.checkoutId).status = "FAILED";
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
  assert.equal((await h.store.getOrder(data.orderId)).status, "reserved");
});
test("Entrega confirmada não regride com webhook atrasado", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(data.checkoutId).status = "PAID";
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  await h.store.updateFulfillment(data.orderId, "delivered");
  await h.store.updateFulfillment(data.orderId, "posted");
  assert.equal(
    (await h.store.getOrder(data.orderId)).fulfillmentStatus,
    "delivered",
  );
});
test("Painel mostra falhas de email e recusa URL insegura", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.emailFail = true;
  h.state.checkouts.get(data.checkoutId).status = "PAID";
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  const headers = { "x-amevuri-setup-key": "test-admin" };
  const r = await h.api(
    "/api/admin-order?orderId=" + data.orderId,
    undefined,
    headers,
  );
  assert.equal(r.status, 200);
  assert.equal(
    r.data.order.notifications.filter((n) => n.state === "pending").length,
    2,
  );
  assert.equal(
    (
      await h.api(
        "/api/admin-order",
        { orderId: data.orderId, trackingUrl: "javascript:alert(1)" },
        headers,
      )
    ).status,
    400,
  );
  assert.equal(
    (
      await h.api(
        "/api/admin-order",
        { orderId: data.orderId, sendTrackingEmail: true },
        headers,
      )
    ).status,
    400,
  );
});
test("Pedidos após os primeiros cem também entram na manutenção", async () => {
  const h = await harness();
  for (let i = 0; i < 125; i++)
    h.memory.set("order:" + String(i).padStart(3, "0"), { id: String(i) });
  const seen = new Set();
  for (let i = 0; i < 13; i++)
    for (const o of await h.store.orderPage(10)) seen.add(o.id);
  assert.equal(seen.size, 125);
});
test("Checkout vencido ainda pendente é desativado antes de liberar estoque", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  h.state.checkouts.get(data.checkoutId).valid_until = new Date(
    Date.now() - 120000,
  ).toISOString();
  const r = await h.api("/api/verify-checkout?orderId=" + data.orderId);
  assert.equal(r.data.order.status, "expired");
  assert.equal((await h.store.getInventory())[cart[0].id], 10);
  assert.equal(h.state.calls.filter((c) => c.method === "DELETE").length, 1);
});
test("Transação pendente mantém reserva mesmo após vencimento da sessão", async () => {
  const h = await harness();
  const { data } = await h.api("/api/create-checkout", payload());
  Object.assign(h.state.checkouts.get(data.checkoutId), {
    valid_until: new Date(Date.now() - 120000).toISOString(),
    transactions: [{ status: "PENDING" }],
  });
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  await h.api("/api/verify-checkout?orderId=" + data.orderId);
  assert.equal((await h.store.getOrder(data.orderId)).status, "reserved");
  assert.equal((await h.store.getInventory())[cart[0].id], 8);
});
test("Miniaturas têm preço de 8,99 e conteúdo de 20g no servidor", async () => {
  const { CATALOG, validateItems } = await import("../src/lib/catalog.js");
  const items = ["mini-cumaru-20", "mini-sakura-20"].map(id => ({id, quantity: 1}));
  assert.equal(validateItems(items).subtotal, 17.98);
  for (const item of items) {
    assert.equal(CATALOG[item.id].size, "20g");
    assert.equal(CATALOG[item.id].price, 8.99);
  }
});
test("Novos SKUs entram no estoque sem repor produtos esgotados", async () => {
  const h = await harness();
  const { CATALOG } = await import("../src/lib/catalog.js");
  h.memory.set("inventory", {"vela-cumaru-120": 0, "vela-sakura-120": 3});
  const stock = await h.store.getInventory();
  assert.equal(stock["vela-cumaru-120"], 0);
  assert.equal(stock["vela-sakura-120"], 3);
  assert.equal(stock["mini-cumaru-20"], CATALOG["mini-cumaru-20"].initialStock);
  stock["mini-cumaru-20"] = 0;
  h.memory.set("inventory", stock);
  assert.equal((await h.store.getInventory())["mini-cumaru-20"], 0);
});
test("Miniaturas calculam frete com peso bruto e reservam estoque no checkout", async () => {
  const h = await harness();
  const items = [{id:"mini-cumaru-20",quantity:1},{id:"mini-sakura-20",quantity:1}];
  const quote = await h.api("/api/shipping-quote", {postalCode: customer.postalCode, items});
  assert.equal(quote.status, 200);
  const shippingCall = h.state.calls.find(c => c.url.includes("shipment/calculate"));
  const body = typeof shippingCall.body === "string" ? JSON.parse(shippingCall.body) : shippingCall.body;
  for (const product of body.products) {
    assert.equal(product.weight, 0.04);
    assert.equal(product.width, 6);
    assert.equal(product.height, 2);
    assert.equal(product.length, 6);
    assert.equal(product.insurance_value, 8.99);
  }
  const checkout = await h.api("/api/create-checkout", {...payload(), items});
  assert.equal(checkout.status, 200);
  const order = await h.store.getOrder(checkout.data.orderId);
  assert.equal(order.subtotal, 17.98);
  assert.equal((await h.store.getInventory())["mini-cumaru-20"], 9);
  assert.equal((await h.store.getInventory())["mini-sakura-20"], 9);
});
let passed = 0;
for (const { name, fn } of tests) {
  try {
    await fn();
    console.log("PASS " + name);
    passed++;
  } catch (e) {
    console.error("FAIL " + name, e);
    process.exitCode = 1;
  }
}
console.log(`${passed}/${tests.length} testes aprovados.`);
