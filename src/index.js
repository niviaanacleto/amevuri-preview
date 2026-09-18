import { validateCustomer } from "./lib/customer.js";
import { providerFetch, safeHttpsUrl } from "./lib/provider-http.js";
import { AmevuriStore, storeStub } from "./store.js";
import { CATALOG, catalogArray, validateItems } from "./lib/catalog.js";
import { json, html, cleanDigits } from "./lib/http.js";
import {
  sumupConfigured,
  createCheckout as createSumUpCheckout,
  getCheckout as getSumUpCheckout,
  paymentMethods,
  findCheckout,
  validateHostedUrl,
  deactivateCheckout,
} from "./providers/sumup.js";
import * as ME from "./providers/melhor-envio.js";
import {
  emailConfigured,
  notifyOrder,
  notifyPriveAccessCode,
  notifyPriveWelcome,
  retryEmails,
} from "./providers/email.js";
import { markPaid, setFulfillment } from "./lib/order-events.js";
export { AmevuriStore };

const money = (n) => Math.round(Number(n) * 100) / 100;
const lower = (v) =>
  String(v || "")
    .trim()
    .toLowerCase();
const clean = (v) => String(v || "").trim();
const nowIso = () => new Date().toISOString();
const originOf = (req) => new URL(req.url).origin;

function timingSafeString(a, b) {
  const aa = new TextEncoder().encode(String(a || ""));
  const bb = new TextEncoder().encode(String(b || ""));
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}
function authorized(req, env) {
  return Boolean(
    env.AMEVURI_SETUP_KEY &&
    timingSafeString(
      req.headers.get("x-amevuri-setup-key"),
      env.AMEVURI_SETUP_KEY,
    ),
  );
}
const PRIVE_COOKIE = "amevuri_prive";
async function sha256(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(String(value)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function priveHash(env, value) {
  const secret = clean(env.PRIVE_AUTH_SECRET);
  if (secret.length < 32) {
    const e = new Error("A autenticação Privé ainda não foi configurada.");
    e.code = "PRIVE_AUTH_NOT_CONFIGURED";
    e.status = 503;
    throw e;
  }
  return sha256(`${secret}:${value}`);
}
const randomHex = (bytes = 32) => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), (b) => b.toString(16).padStart(2, "0")).join("");
const randomCode = () => String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000).padStart(6, "0");
function cookieValue(req) {
  const raw = req.headers.get("cookie") || "";
  for (const part of raw.split(";")) {
    const [name, ...rest] = part.trim().split("=");
    if (name === PRIVE_COOKIE) return decodeURIComponent(rest.join("="));
  }
  return "";
}
const sessionCookie = (token, maxAge = 30 * 24 * 60 * 60) =>
  `${PRIVE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
async function priveSession(req, env, store) {
  const token = cookieValue(req);
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const tokenHash = await priveHash(env, `session:${token}`);
  const session = await store.getPriveSession(tokenHash);
  return session ? { ...session, tokenHash } : null;
}
function publicPriveAccount(account) {
  if (!account) return null;
  const { member, history } = account;
  return {
    member: {
      name: member.name,
      email: member.email,
      phone: member.phone || "",
      marketingConsent: Boolean(member.marketingConsent),
      pointsBalance: Number(member.pointsBalance || 0),
      lifetimePoints: Number(member.lifetimePoints || 0),
      pointsDebt: Number(member.pointsDebt || 0),
      creditBalance: money(member.creditBalance || 0),
      createdAt: member.createdAt,
    },
    history: history.map((entry) => ({
      id: entry.id,
      orderId: entry.orderId || null,
      type: entry.type,
      points: Number(entry.points || 0),
      creditAmount: money(entry.creditAmount || 0),
      eligibleValue: entry.eligibleValue == null ? null : money(entry.eligibleValue),
      expiresAt: entry.expiresAt || null,
      createdAt: entry.createdAt,
      reason: entry.reason || null,
    })),
  };
}
function publicOrder(o) {
  return o
    ? {
        id: o.id,
        status: o.status,
        fulfillmentStatus: o.fulfillmentStatus || null,
        createdAt: o.createdAt,
        updatedAt: o.updatedAt,
        paidAt: o.paidAt || null,
        items: o.items,
        subtotal: o.subtotal,
        priveCredit: Number(o.prive?.creditApplied || 0),
        shipping: o.shipping,
        total: o.total,
        trackingCode: o.trackingCode || null,
        trackingUrl: safeHttpsUrl(o.trackingUrl),
        postedAt: o.postedAt || null,
        deliveredAt: o.deliveredAt || null,
      }
    : null;
}
async function adminOrder(o, store) {
  return o
    ? {
        ...publicOrder(o),
        updatedAt: o.updatedAt,
        customer: o.customer,
        stockAttention: Boolean(o.stockAttention),
        notifications: await store.orderNotifications(o.id),
        melhorEnvioOrderId: o.melhorEnvioOrderId || null,
      }
    : null;
}

function verifyPayment(c, o, env) {
  if (
    c.checkout_reference !== o.id ||
    Math.round(Number(c.amount) * 100) !== Math.round(o.total * 100) ||
    c.currency !== "BRL" ||
    c.merchant_code !== String(env.SUMUP_MERCHANT_CODE).trim() ||
    (o.checkoutId && c.id !== o.checkoutId)
  ) {
    const e = new Error(
      "Não foi possível validar a confirmação deste pagamento.",
    );
    e.code = "PAYMENT_MISMATCH";
    e.status = 502;
    throw e;
  }
}
async function applyCheckout(env, store, origin, order, c) {
  verifyPayment(c, order, env);
  if (c.status === "PAID")
    return markPaid(env, store, origin, order, {
      checkoutId: c.id,
      checkoutStatus: "PAID",
      transactionCode:
        c.transaction_code || c.transactions?.[0]?.transaction_code || null,
    });
  if (["REFUNDED", "CHARGEBACK"].includes(c.status)) {
    const refunded = await store.refundPaidOrder(order.id, c.status.toLowerCase());
    if (refunded)
      await notifyOrder(env, store, origin, refunded, "cancelled").catch(() => {});
    return refunded || order;
  }
  if (
    c.status === "EXPIRED" &&
    !(c.transactions || []).some((t) => t.status === "PENDING")
  )
    return store.finishPayment(order.id, "expired", {
      checkoutStatus: c.status,
    });
  return store.updateOrder(order.id, { checkoutStatus: c.status });
}
async function reconcile(env, store, origin, order) {
  if (!order) return null;
  let c = order.checkoutId
    ? await getSumUpCheckout(env, order.checkoutId)
    : await findCheckout(env, order.id);
  if (!c) {
    if (
      order.status === "reserved" &&
      Date.parse(order.expiresAt) + 300000 < Date.now()
    )
      return store.finishPayment(order.id, "expired");
    return order;
  }
  if (!order.checkoutId) {
    verifyPayment(c, order, env);
    order = await store.updateOrder(order.id, {
      checkoutId: c.id,
      paymentUrl: c.hosted_checkout_url
        ? validateHostedUrl(c.hosted_checkout_url)
        : null,
    });
  }
  // Deactivate an expired session before releasing units if its provider status
  // has not advanced yet. An unsettled transaction still holds its reservation.
  if (
    order.status === "reserved" &&
    ["PENDING", "FAILED"].includes(c.status) &&
    Date.parse(c.valid_until || order.expiresAt) + 60000 <= Date.now()
  ) {
    c = await deactivateCheckout(env, c.id);
    verifyPayment(c, order, env);
    if (c.status !== "PAID") {
      if ((c.transactions || []).some((t) => t.status === "PENDING"))
        return store.updateOrder(order.id, { checkoutStatus: c.status });
      return store.finishPayment(order.id, "expired", {
        checkoutStatus: c.status,
      });
    }
  }
  return applyCheckout(env, store, origin, order, c);
}
const checkoutResponse = (o) =>
  json({
    ok: true,
    orderId: o.id,
    checkoutId: o.checkoutId,
    paymentUrl: o.paymentUrl,
    subtotal: o.subtotal,
    priveCredit: Number(o.prive?.creditApplied || 0),
    shipping: o.shipping,
    total: o.total,
    expiresAt: o.expiresAt,
    paymentMode: "hosted_checkout",
  });
async function readBody(req) {
  try {
    const text = await req.text();
    if (text.length > 20000) throw new Error();
    const body = JSON.parse(text);
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new Error();
    return body;
  } catch {
    const e = new Error("Informe dados válidos para esta solicitação.");
    e.status = 400;
    throw e;
  }
}

async function routeApi(req, env, ctx, path) {
  const store = storeStub(env);
  const origin =
    safeHttpsUrl(env.AMEVURI_SITE_URL)?.replace(/\/$/, "") || originOf(req);
  const url = new URL(req.url);
  try {
    if (path === "/api/health")
      return json({
        ok: true,
        service: "AMEVURI Cloudflare Worker",
        release: "5.5.0",
        status: "online",
        routing: "static-assets-native",
      });
    if (path === "/api/inventory") {
      const stock = await store.getInventory();
      return json({
        ok: true,
        products: catalogArray().map((p) => ({
          id: p.id,
          name: p.name,
          fragrance: p.fragrance,
          format: p.format,
          size: p.size,
          price: p.price,
          stock: Math.max(0, Number(stock[p.id] ?? 0)),
        })),
      });
    }
    if (path === "/api/prive/register") {
      if (req.method !== "POST")
        return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      if (clean(body.company)) return json({ ok: true, registered: true });
      const registerIpHash = await priveHash(env, `register-ip:${req.headers.get("cf-connecting-ip") || "unknown"}`);
      await store.guardPriveRegistration(registerIpHash);
      const name = clean(body.name).replace(/\s+/g, " ");
      const email = lower(body.email);
      const phone = cleanDigits(body.phone);
      if (name.length < 2 || name.length > 120)
        return json({ ok: false, error: "Informe seu nome completo." }, 400);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        return json({ ok: false, error: "Informe um email válido." }, 400);
      if (phone && (phone.length < 10 || phone.length > 13))
        return json({ ok: false, error: "Informe um telefone válido." }, 400);
      if (body.acceptTerms !== true || body.acceptPrivacy !== true)
        return json(
          {
            ok: false,
            error: "É necessário aceitar o regulamento e a Política de Privacidade.",
          },
          400,
        );
      const result = await store.registerPriveMember({
        name,
        email,
        phone,
        marketingConsent: body.marketingConsent === true,
        termsVersion: "2026-09-17",
        privacyVersion: "2026-09-17",
      });
      if (result.created && emailConfigured(env))
        ctx.waitUntil(
          notifyPriveWelcome(env, store, origin, result.member).catch((e) =>
            console.error("AMEVURI Privé", e.code || "WELCOME_EMAIL_FAILED"),
          ),
        );
      return json(
        {
          ok: true,
          registered: true,
          created: result.created,
          member: {
            name: result.member.name,
            email: result.member.email,
            pointsBalance: result.member.pointsBalance,
          },
        },
        result.created ? 201 : 200,
      );
    }
    if (path === "/api/prive/request-code") {
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      if (clean(body.company)) return json({ ok: true, sent: true });
      const email = lower(body.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254)
        return json({ ok: false, error: "Informe um email válido." }, 400);
      if (!emailConfigured(env)) return json({ ok: false, code: "EMAIL_NOT_CONFIGURED", error: "O acesso por email está temporariamente indisponível." }, 503);
      const member = await store.getPriveMember(email);
      const code = randomCode();
      const codeHash = await priveHash(env, `code:${email}:${code}`);
      const ip = req.headers.get("cf-connecting-ip") || "unknown";
      const ipHash = await priveHash(env, `ip:${ip}`);
      await store.issuePriveCode(email, codeHash, ipHash);
      if (member?.status === "active") {
        await notifyPriveAccessCode(env, store, origin, member, code);
      }
      return json({ ok: true, sent: true, message: "Se existe uma conta ativa para este email, o código foi enviado." });
    }
    if (path === "/api/prive/verify-code") {
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const email = lower(body.email), code = clean(body.code);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !/^\d{6}$/.test(code))
        return json({ ok: false, error: "Código ou email inválido." }, 400);
      const member = await store.getPriveMember(email);
      const codeHash = await priveHash(env, `code:${email}:${code}`);
      if (!member || member.status !== "active" || !(await store.consumePriveCode(email, codeHash)))
        return json({ ok: false, code: "PRIVE_CODE_INVALID", error: "Código inválido ou expirado." }, 401);
      const token = randomHex(32);
      const tokenHash = await priveHash(env, `session:${token}`);
      await store.createPriveSession(member.id, tokenHash);
      const account = await store.priveAccount(member.id);
      return json({ ok: true, account: publicPriveAccount(account) }, 200, { "set-cookie": sessionCookie(token) });
    }
    if (path === "/api/prive/account") {
      const session = await priveSession(req, env, store);
      if (!session) return json({ ok: false, code: "PRIVE_AUTH_REQUIRED", error: "Acesse sua conta Privé." }, 401);
      if (req.method === "GET") {
        const account = await store.priveAccount(session.memberId);
        return account ? json({ ok: true, account: publicPriveAccount(account) }) : json({ ok: false, error: "Conta Privé indisponível." }, 404);
      }
      if (req.method === "DELETE") {
        await store.closePriveAccount(session.memberId);
        return json({ ok: true, closed: true }, 200, { "set-cookie": sessionCookie("", 0) });
      }
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const current = await store.getPriveMemberById(session.memberId);
      if (!current) return json({ ok: false, error: "Conta Privé indisponível." }, 404);
      const profileName = clean(body.name || current.name).replace(/\s+/g, " ");
      const profilePhone = body.phone === undefined ? current.phone : cleanDigits(body.phone);
      if (profileName.length < 2 || profileName.length > 120)
        return json({ ok: false, error: "Informe seu nome completo." }, 400);
      if (profilePhone && (profilePhone.length < 10 || profilePhone.length > 13))
        return json({ ok: false, error: "Informe um telefone válido." }, 400);
      const result = await store.registerPriveMember({
        name: profileName,
        email: current.email,
        phone: profilePhone,
        marketingConsent: body.marketingConsent === true,
        termsVersion: current.termsVersion,
        privacyVersion: current.privacyVersion,
      });
      return json({ ok: true, account: publicPriveAccount(await store.priveAccount(result.member.id)) });
    }
    if (path === "/api/prive/redeem") {
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const session = await priveSession(req, env, store);
      if (!session) return json({ ok: false, code: "PRIVE_AUTH_REQUIRED", error: "Acesse sua conta Privé." }, 401);
      const body = await readBody(req);
      await store.redeemPrivePoints(session.memberId, Number(body.points));
      return json({ ok: true, account: publicPriveAccount(await store.priveAccount(session.memberId)) });
    }
    if (path === "/api/prive/logout") {
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const session = await priveSession(req, env, store);
      if (session) await store.deletePriveSession(session.tokenHash);
      return json({ ok: true }, 200, { "set-cookie": sessionCookie("", 0) });
    }
    if (path === "/api/admin-prive") {
      if (!authorized(req, env)) return json({ ok: false, error: "Não autorizado." }, 401);
      const email = lower(url.searchParams.get("email"));
      if (req.method === "GET") {
        const member = await store.getPriveMember(email);
        return member ? json({ ok: true, account: publicPriveAccount(await store.priveAccount(member.id)) }) : json({ ok: false, error: "Membro não encontrado." }, 404);
      }
      if (req.method !== "POST") return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const result = await store.adminAdjustPrive(lower(body.email), Number(body.points || 0), Number(body.creditAmount || 0), clean(body.reason));
      return result ? json({ ok: true, account: publicPriveAccount(await store.priveAccount(result.member.id)) }) : json({ ok: false, error: "Membro não encontrado." }, 404);
    }
    if (path === "/api/config-status") {
      let auth = false;
      try {
        auth = Boolean(
          env.MELHOR_ENVIO_TOKEN ||
          (await store.getAuth("oauth-token"))?.access_token,
        );
      } catch {}
      return json({
        ok: true,
        release: "5.5.0",
        platform: "Cloudflare Workers",
        routing: { cleanUrls: true, manualRedirects: false },
        shipping: {
          originCepConfigured:
            cleanDigits(env.AMEVURI_ORIGIN_CEP || "24358080").length === 8,
          clientIdConfigured: Boolean(env.MELHOR_ENVIO_CLIENT_ID || "29241"),
          clientSecretConfigured: Boolean(env.MELHOR_ENVIO_CLIENT_SECRET),
          authorized: auth,
        },
        payment: {
          provider: "SumUp",
          configured: sumupConfigured(env),
          mode: "hosted_checkout",
        },
        email: { provider: "Resend", configured: emailConfigured(env) },
        prive: {
          authConfigured: clean(env.PRIVE_AUTH_SECRET).length >= 32,
          accountUrl: "/minha-conta",
          adminUrl: "/admin-prive",
        },
      });
    }
    if (path === "/api/email-status")
      return json({
        ok: true,
        configured: emailConfigured(env),
        variables: {
          RESEND_API_KEY: Boolean(env.RESEND_API_KEY),
          AMEVURI_EMAIL_FROM: Boolean(env.AMEVURI_EMAIL_FROM),
          AMEVURI_ORDER_EMAIL: Boolean(env.AMEVURI_ORDER_EMAIL),
          AMEVURI_SITE_URL: Boolean(env.AMEVURI_SITE_URL),
        },
      });
    if (path === "/api/sumup-status") {
      const configured = sumupConfigured(env);
      let methods = [],
        providerReachable = false,
        error = null;
      if (configured) {
        try {
          const d = await paymentMethods(env, 10);
          methods = (d.available_payment_methods || d.items || [])
            .map((x) => String(x.id || x))
            .filter(Boolean);
          providerReachable = true;
        } catch (e) {
          error = e.message;
        }
      }
      return json({
        ok: true,
        configured,
        providerReachable,
        mode: "hosted_checkout",
        paymentMethods: methods,
        cardAvailable: methods.length ? methods.includes("card") : null,
        pixAvailable: methods.length
          ? methods.includes("pix") || methods.includes("qr_code_pix")
          : null,
        error,
      });
    }
    if (path === "/api/shipping-status") {
      const configured =
        Boolean(env.MELHOR_ENVIO_TOKEN) ||
        (Boolean(env.MELHOR_ENVIO_CLIENT_SECRET) &&
          Boolean(env.MELHOR_ENVIO_CLIENT_ID || "29241"));
      if (!configured)
        return json({
          ok: true,
          ready: false,
          configured: false,
          authorized: false,
          code: "SHIPPING_NOT_CONFIGURED",
        });
      let token;
      try {
        token = await ME.validToken(env, store, origin);
      } catch {
        return json({
          ok: true,
          ready: false,
          configured: true,
          authorized: false,
          code: "SHIPPING_NOT_AUTHORIZED",
        });
      }
      try {
        const r = await providerFetch(
          `${ME.base(env)}/api/v2/me/shipment/companies`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              "User-Agent": ME.userAgent(env),
            },
          },
        );
        return json({
          ok: true,
          ready: r.ok,
          configured: true,
          authorized: true,
          providerReachable: true,
          providerStatus: r.status,
          code:
            r.status === 401
              ? "SHIPPING_TOKEN_INVALID"
              : r.status === 403
                ? "SHIPPING_PERMISSION_DENIED"
                : undefined,
        });
      } catch {
        return json({
          ok: true,
          ready: false,
          configured: true,
          authorized: true,
          providerReachable: false,
          code: "SHIPPING_PROVIDER_UNREACHABLE",
        });
      }
    }
    if (path === "/api/shipping-quote") {
      if (req.method !== "POST")
        return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const { items } = validateItems(body.items);
      const result = await ME.shippingQuote(env, store, origin, {
        postalCode: body.postalCode,
        items,
      });
      return json({ ok: true, ...result });
    }
    if (path === "/api/create-checkout") {
      if (req.method !== "POST")
        return json({ ok: false, error: "Método não permitido." }, 405);
      if (!sumupConfigured(env))
        return json(
          {
            ok: false,
            code: "SUMUP_NOT_CONFIGURED",
            error:
              "O pagamento está temporariamente indisponível. Tente novamente mais tarde.",
          },
          503,
        );
      const body = await readBody(req),
        validated = validateItems(body.items),
        customer = validateCustomer(body.customer);
      const selectedId = String(body.shipping?.id || "");
      if (!selectedId)
        return json({ ok: false, error: "Selecione uma opção de frete." }, 400);
      const requestId = String(body.requestId || "");
      if (
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          requestId,
        )
      )
        return json(
          { ok: false, error: "Atualize a página e tente novamente." },
          400,
        );
      const fingerprint = JSON.stringify({
        items: validated.items.map((i) => ({ id: i.id, quantity: i.quantity })),
        customer,
        shipping: body.shipping,
        priveCredit: money(body.priveCredit || 0),
      });
      const orderId = `AMV-${requestId.toUpperCase()}`;
      const previous = await store.getOrder(orderId);
      if (previous) {
        if (previous.fingerprint !== fingerprint)
          return json(
            {
              ok: false,
              code: "CHECKOUT_CONFLICT",
              error: "Os dados desta tentativa mudaram. Revise sua compra.",
            },
            409,
          );
        const current = await reconcile(env, store, origin, previous);
        if (
          current.status !== "reserved" ||
          Date.parse(current.expiresAt) <= Date.now()
        )
          return json(
            {
              ok: false,
              code: "CHECKOUT_CLOSED",
              error:
                "Esta tentativa foi encerrada. Revise os dados e inicie novamente.",
            },
            409,
          );
        if (current.paymentUrl) return checkoutResponse(current);
        return json(
          {
            ok: false,
            code: "CHECKOUT_PENDING",
            error:
              "A confirmação desta tentativa está em andamento. Aguarde alguns instantes e tente novamente.",
          },
          409,
        );
      }
      const ship = await ME.shippingQuote(env, store, origin, {
        postalCode: customer.postalCode,
        items: validated.items,
      });
      const authoritative = ship.quotes.find((q) => q.id === selectedId);
      if (
        !authoritative ||
        !Number.isFinite(Number(body.shipping.price)) ||
        money(body.shipping.price) !== money(authoritative.price)
      )
        return json(
          {
            ok: false,
            code: "SHIPPING_SELECTION_EXPIRED",
            error:
              "O frete mudou. Calcule novamente e confira o total antes de pagar.",
          },
          409,
        );
      const subtotal = validated.subtotal;
      const requestedCredit = money(body.priveCredit || 0);
      let priveReservation = null;
      if (requestedCredit) {
        if (requestedCredit < 0 || requestedCredit % 5 !== 0 || requestedCredit > subtotal)
          return json({ ok: false, code: "PRIVE_CREDIT_INVALID", error: "Selecione um crédito Privé válido." }, 400);
        const session = await priveSession(req, env, store);
        const member = session ? await store.getPriveMemberById(session.memberId) : null;
        if (!member || member.email !== customer.email.toLowerCase())
          return json({ ok: false, code: "PRIVE_AUTH_REQUIRED", error: "Acesse a conta Privé vinculada ao email da compra." }, 401);
        priveReservation = { memberId: member.id, creditAmount: requestedCredit };
      }
      const total = money(subtotal + authoritative.price - requestedCredit),
        expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString();
      if (total < 1) return json({ ok: false, error: "O total mínimo para pagamento é R$1,00." }, 400);
      const order = {
        id: orderId,
        fingerprint,
        status: "reserved",
        createdAt: nowIso(),
        updatedAt: nowIso(),
        expiresAt,
        customer,
        items: validated.items.map(
          ({ shipping, initialStock, ...item }) => item,
        ),
        subtotal,
        shipping: authoritative,
        total,
        stockReleased: false,
      };
      const reservation = await store.reserveOrder(order, priveReservation);
      if (!reservation.created)
        return json(
          {
            ok: false,
            code: "CHECKOUT_PENDING",
            error:
              "Esta tentativa já está sendo processada. Aguarde alguns instantes.",
          },
          409,
        );
      try {
        const c = await createSumUpCheckout(env, {
          orderId,
          amount: total,
          origin,
          description: `AMEVURI · ${validated.items.reduce((a, i) => a + i.quantity, 0)} item(ns)`,
        });
        verifyPayment(c, order, env);
        const saved = await store.updateOrder(orderId, {
          checkoutId: c.id,
          checkoutStatus: c.status,
          paymentUrl: c.hosted_checkout_url,
          paymentMode: "hosted_checkout",
        });
        return checkoutResponse(saved);
      } catch (e) {
        // A timeout or server error may still have created a payable checkout.
        if (
          e.status >= 400 &&
          e.status < 500 &&
          ![408, 409, 429].includes(e.status)
        )
          await store.finishPayment(orderId, "cancelled");
        else await store.updateOrder(orderId, { creationUncertain: true });
        throw e;
      }
    }
    if (path === "/api/verify-checkout") {
      const id = url.searchParams.get("orderId");
      if (!id) return json({ ok: false, error: "Pedido não informado." }, 400);
      const order = await store.getOrder(id);
      if (!order)
        return json({ ok: false, error: "Pedido não encontrado." }, 404);
      const updated = await reconcile(env, store, origin, order);
      return json({
        ok: true,
        order: { id: updated.id, status: updated.status },
      });
    }
    if (path === "/api/order-status") {
      if (req.method !== "POST")
        return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const id = clean(body.orderId).toUpperCase(),
        email = lower(body.email);
      if (!id || !email)
        return json(
          {
            ok: false,
            error: "Informe o número do pedido e o email usado na compra.",
          },
          400,
        );
      const order = await store.getOrder(id);
      if (!order || lower(order.customer?.email) !== email)
        return json(
          { ok: false, error: "Não encontramos um pedido com esses dados." },
          404,
        );
      return json({ ok: true, order: publicOrder(order) });
    }
    if (path === "/api/admin-order") {
      if (!authorized(req, env))
        return json({ ok: false, error: "Não autorizado." }, 401);
      if (req.method === "GET") {
        const id = clean(url.searchParams.get("orderId")).toUpperCase(),
          o = id ? await store.getOrder(id) : null;
        return o
          ? json({ ok: true, order: await adminOrder(o, store) })
          : json({ ok: false, error: "Pedido não encontrado." }, 404);
      }
      if (req.method !== "POST")
        return json({ ok: false, error: "Método não permitido." }, 405);
      const body = await readBody(req);
      const id = clean(body.orderId).toUpperCase();
      if (body.trackingUrl && !safeHttpsUrl(body.trackingUrl))
        return json(
          { ok: false, error: "Informe uma URL HTTPS válida de rastreio." },
          400,
        );
      let o = id ? await store.getOrder(id) : null;
      if (!o) return json({ ok: false, error: "Pedido não encontrado." }, 404);
      if (body.financialStatus === "refunded") {
        if (o.status !== "paid") return json({ ok: false, error: "Somente pedidos pagos podem ser marcados como reembolsados." }, 409);
        o = await store.refundPaidOrder(id, clean(body.refundReason) || "admin-confirmed-refund");
        await notifyOrder(env, store, origin, o, "cancelled").catch(() => {});
        return json({ ok: true, order: await adminOrder(o, store) });
      }
      if (o.status !== "paid")
        return json(
          { ok: false, error: "O pagamento ainda não foi confirmado." },
          409,
        );
      const allowedStates = [
        "confirmed",
        "preparing",
        "generated",
        "shipped",
        "posted",
        "delivered",
        "undelivered",
        "paused",
        "suspended",
        "cancelled",
      ];
      if (
        body.fulfillmentStatus &&
        !allowedStates.includes(body.fulfillmentStatus)
      )
        return json({ ok: false, error: "Status inválido." }, 400);
      const patch = {};
      if (
        body.sendTrackingEmail === true &&
        !(body.trackingCode ?? o.trackingCode) &&
        !(body.trackingUrl ?? o.trackingUrl)
      )
        return json(
          {
            ok: false,
            error: "Informe o rastreio antes de enviar a mensagem.",
          },
          400,
        );
      for (const k of ["trackingCode", "trackingUrl", "melhorEnvioOrderId"])
        if (body[k] !== undefined) patch[k] = clean(body[k]) || null;
      if (Object.keys(patch).length) o = await store.updateOrder(id, patch);
      if (body.sendConfirmationEmail === true) {
        await notifyOrder(env, store, origin, o, "payment_confirmed", {
          force: true,
        });
        return json({ ok: true, order: await adminOrder(o, store) });
      }
      const next = clean(body.fulfillmentStatus);
      const allowed = [
        "confirmed",
        "preparing",
        "generated",
        "shipped",
        "posted",
        "delivered",
        "undelivered",
        "paused",
        "suspended",
        "cancelled",
      ];
      if (next) {
        if (!allowed.includes(next))
          return json({ ok: false, error: "Status inválido." }, 400);
        const extra = {};
        if (["shipped", "posted"].includes(next) && !o.postedAt)
          extra.postedAt = nowIso();
        if (next === "delivered" && !o.deliveredAt)
          extra.deliveredAt = nowIso();
        o = await setFulfillment(env, store, origin, o, next, extra);
      } else if (
        body.sendTrackingEmail === true &&
        (o.trackingCode || o.trackingUrl)
      )
        await notifyOrder(env, store, origin, o, "shipped", { force: true });
      else if (
        (body.trackingCode || body.trackingUrl) &&
        (o.trackingCode || o.trackingUrl)
      )
        o = await setFulfillment(env, store, origin, o, "posted", {
          postedAt: o.postedAt || nowIso(),
        });
      return json({ ok: true, order: await adminOrder(o, store) });
    }
    if (path === "/api/melhor-envio/authorize") {
      if (req.method !== "POST")
        return html(
          "<p>Use a página protegida de conexão da AMEVURI.</p>",
          405,
        );
      const form = await req.formData();
      if (
        !env.AMEVURI_SETUP_KEY ||
        !timingSafeString(form.get("setup_key"), env.AMEVURI_SETUP_KEY)
      )
        return html("<p>Chave de configuração inválida.</p>", 403);
      if (!env.MELHOR_ENVIO_CLIENT_SECRET)
        return html(
          "<p>Client Secret do Melhor Envio ainda não configurado.</p>",
          503,
        );
      const state = Array.from(
        crypto.getRandomValues(new Uint8Array(32)),
        (b) => b.toString(16).padStart(2, "0"),
      ).join("");
      await ME.saveState(store, state);
      const q = new URLSearchParams({
        client_id: ME.clientId(env),
        redirect_uri: ME.redirectUri(env, origin),
        response_type: "code",
        state,
        scope: "shipping-calculate shipping-companies shipping-tracking",
      });
      return Response.redirect(`${ME.base(env)}/oauth/authorize?${q}`, 302);
    }
    if (path === "/api/melhor-envio/oauth-callback") {
      const code = url.searchParams.get("code"),
        state = url.searchParams.get("state");
      if (url.searchParams.get("error"))
        return html(
          "<h1>Autorização não concluída</h1><p>O Melhor Envio não concedeu autorização.</p>",
          400,
        );
      if (!code || !state) return html("<h1>Retorno incompleto</h1>", 400);
      if (!(await ME.consumeState(store, state)))
        return html("<h1>Sessão de autorização inválida ou expirada</h1>", 400);
      const payload = await ME.exchangeCode(env, code, origin);
      await ME.saveTokens(store, payload);
      return html(
        '<main style="font-family:Arial;max-width:680px;margin:80px auto"><h1>AMEVURI</h1><h2>Integração autorizada</h2><p>O Melhor Envio está conectado à loja.</p><p><a href="/checkout">Ir ao checkout</a></p></main>',
        200,
      );
    }
    if (path === "/api/sumup/webhook") {
      if (req.method !== "POST") return new Response(null, { status: 204 });
      const payload = await req.json().catch(() => ({}));
      if (payload.event_type !== "CHECKOUT_STATUS_CHANGED" || !payload.id)
        return new Response(null, { status: 204 });
      const c = await getSumUpCheckout(env, payload.id);
      const o = c.checkout_reference
        ? await store.getOrder(String(c.checkout_reference))
        : null;
      if (!o) return new Response(null, { status: 204 });
      await applyCheckout(env, store, origin, o, c);
      return new Response(null, { status: 204 });
    }
    if (path === "/api/melhor-envio/webhook") {
      if (req.method !== "POST") return new Response(null, { status: 204 });
      const raw = await req.text();
      const sig = req.headers.get("x-me-signature");
      if (!(await verifyHmac(raw, sig, env.MELHOR_ENVIO_CLIENT_SECRET)))
        return new Response("unauthorized", { status: 401 });
      const payload = JSON.parse(raw || "{}"),
        data = payload.data || {};
      if (!data.id) return new Response(null, { status: 204 });
      let o = await store.findOrderByMelhorEnvioId(data.id);
      if (!o) return new Response(null, { status: 204 });
      o = await store.updateOrder(o.id, {
        melhorEnvioStatus: data.status || null,
        trackingCode: data.tracking || o.trackingCode || null,
        trackingUrl: data.tracking_url || o.trackingUrl || null,
        melhorEnvioProtocol: data.protocol || o.melhorEnvioProtocol || null,
      });
      const map = {
        "order.generated": "generated",
        "order.received": "generated",
        "order.posted": "posted",
        "order.delivered": "delivered",
        "order.undelivered": "undelivered",
        "order.paused": "paused",
        "order.suspended": "suspended",
        "order.cancelled": "cancelled",
      };
      const next = map[String(payload.event || "")];
      if (next)
        await setFulfillment(
          env,
          store,
          origin,
          o,
          next,
          next === "posted"
            ? { postedAt: data.posted_at || nowIso() }
            : next === "delivered"
              ? { deliveredAt: data.delivered_at || nowIso() }
              : {},
        );
      return new Response(null, { status: 204 });
    }
    return json({ ok: false, error: "Rota de API não encontrada.", path }, 404);
  } catch (e) {
    console.error(
      "AMEVURI API",
      path,
      e.code || "SERVER_ERROR",
      e.status || 500,
    );
    if (["OUT_OF_STOCK", "CHECKOUT_CONFLICT", "PRIVE_CREDIT_INVALID"].includes(e.code))
      return json({ ok: false, code: e.code, error: e.message }, 409);
    if (String(e.code || "").startsWith("PRIVE_"))
      return json({ ok: false, code: e.code, error: e.message }, e.status || 400);
    if (
      String(e.code || "").startsWith("SHIPPING_") ||
      e.code === "INVALID_POSTAL_CODE"
    )
      return json(
        { ok: false, code: e.code, error: e.message, reasons: e.reasons },
        e.status || 503,
      );
    if (
      /Preencha|válido|Selecione|Informe|sacola|Quantidade|Produto inválido/.test(
        e.message || "",
      )
    )
      return json({ ok: false, error: e.message }, 400);
    return json(
      {
        ok: false,
        code: e.code || "SERVER_ERROR",
        error:
          e.status === 400
            ? e.message
            : "Não foi possível concluir esta etapa. Tente novamente em instantes.",
      },
      e.status >= 400 && e.status <= 599 ? e.status : 500,
    );
  }
}

async function verifyHmac(raw, received, secret) {
  if (!raw || !received || !secret) return false;
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(raw),
    );
    const bytes = new Uint8Array(sig);
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    const expected = btoa(bin);
    return timingSafeString(expected, received);
  } catch {
    return false;
  }
}

function normalizeLegacy(path) {
  const map = {
    health: "/api/health",
    inventory: "/api/inventory",
    "shipping-quote": "/api/shipping-quote",
    "shipping-status": "/api/shipping-status",
    "create-checkout": "/api/create-checkout",
    "verify-checkout": "/api/verify-checkout",
    "config-status": "/api/config-status",
    "sumup-status": "/api/sumup-status",
    "email-status": "/api/email-status",
    "order-status": "/api/order-status",
    "admin-order": "/api/admin-order",
    "melhor-envio-authorize": "/api/melhor-envio/authorize",
    "melhor-envio-oauth-callback": "/api/melhor-envio/oauth-callback",
    "sumup-webhook": "/api/sumup/webhook",
    "melhor-envio-webhook": "/api/melhor-envio/webhook",
  };
  const m = path.match(/^\/\.netlify\/functions\/([^/]+)$/);
  return m ? map[m[1]] || path : path;
}

async function hourly(env) {
  const store = storeStub(env),
    origin = String(env.AMEVURI_SITE_URL || "https://amevuri.com.br").replace(
      /\/$/,
      "",
    );
  await retryEmails(env, store);
  await store.expirePriveBatch(50);
  for (let o of await store.orderPage(10)) {
    try {
      if (o.status === "reserved" && sumupConfigured(env))
        o = await reconcile(env, store, origin, o);
      if (o.status === "paid") {
        await markPaid(env, store, origin, o);
        if (o.fulfillmentStatus)
          await setFulfillment(env, store, origin, o, o.fulfillmentStatus);
      }
      if (
        o.melhorEnvioOrderId &&
        o.status === "paid" &&
        !["delivered", "cancelled"].includes(o.fulfillmentStatus)
      ) {
        const { item } = await ME.tracking(
            env,
            store,
            origin,
            o.melhorEnvioOrderId,
          ),
          status = String(item.status || item.state || "").toLowerCase();
        const cur = await store.updateOrder(o.id, {
          melhorEnvioStatus: status || o.melhorEnvioStatus,
          trackingCode:
            item.tracking || item.tracking_code || o.trackingCode || null,
          trackingUrl:
            safeHttpsUrl(item.tracking_url || item.url) ||
            o.trackingUrl ||
            null,
        });
        if (
          [
            "posted",
            "delivered",
            "undelivered",
            "paused",
            "suspended",
            "cancelled",
          ].includes(status)
        )
          await setFulfillment(env, store, origin, cur, status);
      }
    } catch (e) {
      console.error("maintenance", o.id, e.code || "PROVIDER_ERROR");
    }
  }
}

export default {
  async fetch(request, env, ctx) {
    const u = new URL(request.url);
    const normalized = normalizeLegacy(u.pathname);
    if (normalized.startsWith("/api/"))
      return routeApi(request, env, ctx, normalized);
    return env.ASSETS.fetch(request);
  },
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(hourly(env));
  },
};
