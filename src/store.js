import { DurableObject } from "cloudflare:workers";
import { CATALOG } from "./lib/catalog.js";
import { refreshTokens, saveTokens } from "./providers/melhor-envio.js";
const seedInventory = () =>
  Object.fromEntries(Object.values(CATALOG).map((p) => [p.id, p.initialStock]));
const now = () => new Date().toISOString();
const twelveMonthsFromNow = () => {
  const d = new Date();
  d.setUTCMonth(d.getUTCMonth() + 12);
  return d.toISOString();
};
export class AmevuriStore extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.refreshPromise = null;
  }
  async getInventory() {
    return this.ctx.storage.transaction(async (t) => {
      let stock = await t.get("inventory");
      if (!stock || Object.keys(CATALOG).some((id) => !Object.hasOwn(stock, id))) {
        stock = { ...seedInventory(), ...(stock || {}) };
        await t.put("inventory", stock);
      }
      return stock;
    });
  }
  // Stock and order commit together, including deduplication.
  async reserveOrder(order, prive = null) {
    return this.ctx.storage.transaction(async (t) => {
      const old = await t.get(`order:${order.id}`);
      if (old) {
        if (old.fingerprint !== order.fingerprint) {
          const e = new Error(
            "Esta tentativa de pagamento contém dados diferentes.",
          );
          e.code = "CHECKOUT_CONFLICT";
          throw e;
        }
        return { created: false, order: old };
      }
      const stock = { ...seedInventory(), ...((await t.get("inventory")) || {}) };
      for (const i of order.items) {
        if (Number(stock[i.id] || 0) < i.quantity) {
          const e = new Error(
            `Estoque insuficiente para ${CATALOG[i.id]?.name || "este produto"}.`,
          );
          e.code = "OUT_OF_STOCK";
          throw e;
        }
        stock[i.id] -= i.quantity;
      }
      if (prive?.creditAmount) {
        const memberKey = `prive-member-id:${prive.memberId}`;
        const email = await t.get(memberKey);
        const key = email ? `prive-member:${email}` : "";
        const member = key ? await t.get(key) : null;
        const amount = Number(prive.creditAmount);
        if (
          !member ||
          member.status !== "active" ||
          member.email !== order.customer.email.toLowerCase() ||
          !Number.isFinite(amount) ||
          amount <= 0 ||
          amount % 5 !== 0 ||
          amount > Number(member.creditBalance || 0) ||
          amount > Number(order.subtotal || 0)
        ) {
          const e = new Error("O crédito Privé selecionado não está mais disponível.");
          e.code = "PRIVE_CREDIT_INVALID";
          throw e;
        }
        const entry = {
          id: crypto.randomUUID(),
          memberId: member.id,
          orderId: order.id,
          type: "credit_used",
          points: 0,
          creditAmount: -amount,
          createdAt: now(),
        };
        await t.put(key, {
          ...member,
          creditBalance: Number(member.creditBalance || 0) - amount,
          updatedAt: now(),
        });
        await t.put(`prive-entry:${member.id}:${entry.createdAt}:${entry.id}`, entry);
        order.prive = { memberId: member.id, creditApplied: amount };
      }
      await t.put("inventory", stock);
      await t.put(`order:${order.id}`, order);
      return { created: true, order };
    });
  }
  async getOrder(id) {
    return (await this.ctx.storage.get(`order:${id}`)) || null;
  }
  async registerPriveMember(profile) {
    return this.ctx.storage.transaction(async (t) => {
      const email = String(profile.email || "").trim().toLowerCase();
      const key = `prive-member:${email}`;
      const existing = await t.get(key);
      const member = {
        id: existing?.id || crypto.randomUUID(),
        name: profile.name,
        email,
        phone: profile.phone || "",
        marketingConsent: Boolean(profile.marketingConsent),
        termsVersion: profile.termsVersion,
        privacyVersion: profile.privacyVersion,
        termsAcceptedAt: existing?.termsAcceptedAt || now(),
        privacyAcceptedAt: existing?.privacyAcceptedAt || now(),
        marketingUpdatedAt: now(),
        status: "active",
        pointsBalance: Number(existing?.pointsBalance || 0),
        lifetimePoints: Number(existing?.lifetimePoints || 0),
        creditBalance: Number(existing?.creditBalance || 0),
        pointsDebt: Number(existing?.pointsDebt || 0),
        createdAt: existing?.createdAt || now(),
        updatedAt: now(),
      };
      await t.put(key, member);
      await t.put(`prive-member-id:${member.id}`, email);
      return { created: !existing, member };
    });
  }
  async getPriveMember(email) {
    return (await this.ctx.storage.get(`prive-member:${String(email || "").trim().toLowerCase()}`)) || null;
  }
  async getPriveMemberById(id) {
    const email = await this.ctx.storage.get(`prive-member-id:${id}`);
    return email ? this.getPriveMember(email) : null;
  }
  async issuePriveCode(email, codeHash, ipHash) {
    return this.ctx.storage.transaction(async (t) => {
      const current = Date.now();
      const emailRateKey = `prive-rate:email:${email}`;
      const ipRateKey = `prive-rate:ip:${ipHash}`;
      const emailRate = (await t.get(emailRateKey)) || { count: 0, start: current };
      const ipRate = (await t.get(ipRateKey)) || { count: 0, start: current };
      for (const rate of [emailRate, ipRate])
        if (current - rate.start > 60 * 60 * 1000) Object.assign(rate, { count: 0, start: current });
      if (emailRate.count >= 5 || ipRate.count >= 20) {
        const e = new Error("Aguarde antes de solicitar um novo código.");
        e.code = "PRIVE_RATE_LIMIT";
        e.status = 429;
        throw e;
      }
      emailRate.count++;
      ipRate.count++;
      await t.put(emailRateKey, emailRate);
      await t.put(ipRateKey, ipRate);
      await t.put(`prive-code:${email}`, {
        codeHash,
        attempts: 0,
        expiresAt: current + 10 * 60 * 1000,
        createdAt: now(),
      });
      return true;
    });
  }
  async guardPriveRegistration(ipHash) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `prive-rate:register:${ipHash}`;
      const current = Date.now();
      const rate = (await t.get(key)) || { count: 0, start: current };
      if (current - rate.start > 60 * 60 * 1000) Object.assign(rate, { count: 0, start: current });
      if (rate.count >= 10) throw Object.assign(new Error("Aguarde antes de realizar outro cadastro."), { code: "PRIVE_RATE_LIMIT", status: 429 });
      rate.count++;
      await t.put(key, rate);
      return true;
    });
  }
  async consumePriveCode(email, codeHash) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `prive-code:${email}`;
      const record = await t.get(key);
      if (!record || record.expiresAt < Date.now() || record.attempts >= 5) {
        if (record) await t.delete(key);
        return false;
      }
      if (record.codeHash !== codeHash) {
        record.attempts++;
        await t.put(key, record);
        return false;
      }
      await t.delete(key);
      return true;
    });
  }
  async createPriveSession(memberId, tokenHash) {
    const expiresAt = Date.now() + 30 * 24 * 60 * 60 * 1000;
    await this.ctx.storage.put(`prive-session:${tokenHash}`, {
      memberId,
      createdAt: now(),
      expiresAt,
    });
    return expiresAt;
  }
  async getPriveSession(tokenHash) {
    const key = `prive-session:${tokenHash}`;
    const session = await this.ctx.storage.get(key);
    if (!session || session.expiresAt < Date.now()) {
      if (session) await this.ctx.storage.delete(key);
      return null;
    }
    return session;
  }
  async deletePriveSession(tokenHash) {
    await this.ctx.storage.delete(`prive-session:${tokenHash}`);
    return true;
  }
  async expirePrivePoints(memberId) {
    return this.ctx.storage.transaction(async (t) => {
      const email = await t.get(`prive-member-id:${memberId}`);
      const key = email ? `prive-member:${email}` : "";
      const member = key ? await t.get(key) : null;
      if (!member) return null;
      const entries = await t.list({ prefix: `prive-entry:${memberId}:` });
      let expired = 0;
      for (const [entryKey, entry] of entries) {
        if (
          Number(entry.remainingPoints || 0) > 0 &&
          entry.expiresAt &&
          Date.parse(entry.expiresAt) <= Date.now()
        ) {
          const amount = Number(entry.remainingPoints);
          expired += amount;
          const consumed = { ...entry, remainingPoints: 0, expiredAt: now() };
          await t.put(entryKey, consumed);
          if (entry.type === "purchase" && entry.orderId) await t.put(`prive-ledger:${entry.orderId}`, consumed);
          const expiry = {
            id: crypto.randomUUID(), memberId, type: "expiry", points: -amount,
            sourceEntryId: entry.id, createdAt: now(),
          };
          await t.put(`prive-entry:${memberId}:${expiry.createdAt}:${expiry.id}`, expiry);
        }
      }
      if (expired) {
        member.pointsBalance = Math.max(0, Number(member.pointsBalance || 0) - expired);
        member.updatedAt = now();
        await t.put(key, member);
      }
      return member;
    });
  }
  async priveAccount(memberId) {
    await this.expirePrivePoints(memberId);
    const member = await this.getPriveMemberById(memberId);
    if (!member || member.status !== "active") return null;
    const rows = await this.ctx.storage.list({ prefix: `prive-entry:${memberId}:` });
    const history = [...rows.values()].sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return { member, history: history.slice(0, 100) };
  }
  async redeemPrivePoints(memberId, points) {
    await this.expirePrivePoints(memberId);
    return this.ctx.storage.transaction(async (t) => {
      const email = await t.get(`prive-member-id:${memberId}`);
      const key = email ? `prive-member:${email}` : "";
      const member = key ? await t.get(key) : null;
      points = Number(points);
      if (!member || member.status !== "active") throw Object.assign(new Error("Conta Privé indisponível."), { code: "PRIVE_ACCOUNT_UNAVAILABLE" });
      if (!Number.isInteger(points) || points < 100 || points % 100 !== 0)
        throw Object.assign(new Error("Resgate pontos em múltiplos de 100."), { code: "PRIVE_REDEEM_INVALID" });
      if (Number(member.pointsBalance || 0) < points)
        throw Object.assign(new Error("Saldo de pontos insuficiente."), { code: "PRIVE_POINTS_INSUFFICIENT" });
      const rows = await t.list({ prefix: `prive-entry:${memberId}:` });
      const lots = [...rows].filter(([, e]) => Number(e.remainingPoints || 0) > 0)
        .sort(([, a], [, b]) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
      let remaining = points;
      for (const [entryKey, entry] of lots) {
        const used = Math.min(remaining, Number(entry.remainingPoints));
        const consumed = { ...entry, remainingPoints: Number(entry.remainingPoints) - used };
        await t.put(entryKey, consumed);
        if (entry.type === "purchase" && entry.orderId) await t.put(`prive-ledger:${entry.orderId}`, consumed);
        remaining -= used;
        if (!remaining) break;
      }
      if (remaining) throw Object.assign(new Error("Não foi possível reservar os pontos disponíveis."), { code: "PRIVE_POINTS_INCONSISTENT" });
      const creditAmount = points / 20;
      const entry = { id: crypto.randomUUID(), memberId, type: "redemption", points: -points, creditAmount, createdAt: now() };
      await t.put(`prive-entry:${memberId}:${entry.createdAt}:${entry.id}`, entry);
      const next = { ...member, pointsBalance: Number(member.pointsBalance) - points, creditBalance: Number(member.creditBalance || 0) + creditAmount, updatedAt: now() };
      await t.put(key, next);
      return { member: next, entry };
    });
  }
  async awardPrivePoints(order) {
    return this.ctx.storage.transaction(async (t) => {
      const email = String(order?.customer?.email || "").trim().toLowerCase();
      if (!email) return { credited: false, reason: "missing-email" };
      const memberKey = `prive-member:${email}`;
      const member = await t.get(memberKey);
      if (!member || member.status !== "active")
        return { credited: false, reason: "not-enrolled" };
      if (Date.parse(member.createdAt) > Date.parse(order.paidAt || order.createdAt))
        return { credited: false, reason: "purchase-before-enrollment" };
      const ledgerKey = `prive-ledger:${order.id}`;
      const existing = await t.get(ledgerKey);
      if (existing)
        return { credited: false, reason: "already-credited", entry: existing };
      const eligibleValue = Math.max(0, Number(order.subtotal || 0) - Number(order.prive?.creditApplied || 0));
      const points = Math.max(0, Math.floor(eligibleValue));
      if (!points) return { credited: false, reason: "no-eligible-value" };
      const debtPaid = Math.min(points, Number(member.pointsDebt || 0));
      const availablePoints = points - debtPaid;
      const entry = {
        id: crypto.randomUUID(),
        memberId: member.id,
        orderId: order.id,
        type: "purchase",
        points,
        remainingPoints: availablePoints,
        debtPaid,
        eligibleValue,
        expiresAt: twelveMonthsFromNow(),
        createdAt: now(),
      };
      await t.put(ledgerKey, entry);
      await t.put(`prive-entry:${member.id}:${entry.createdAt}:${entry.id}`, entry);
      await t.put(memberKey, {
        ...member,
        pointsBalance: Number(member.pointsBalance || 0) + availablePoints,
        lifetimePoints: Number(member.lifetimePoints || 0) + points,
        pointsDebt: Number(member.pointsDebt || 0) - debtPaid,
        updatedAt: now(),
      });
      return { credited: true, entry };
    });
  }
  async updateOrder(id, patch) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `order:${id}`,
        o = await t.get(key);
      if (!o) return null;
      const next = { ...o, ...patch, updatedAt: now() };
      await t.put(key, next);
      return next;
    });
  }
  async updateFulfillment(id, status, patch = {}) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `order:${id}`,
        o = await t.get(key);
      if (!o || o.status !== "paid")
        throw new Error("O pagamento ainda não foi confirmado.");
      const ranks = {
        confirmed: 0,
        preparing: 1,
        generated: 2,
        shipped: 3,
        posted: 3,
        delivered: 4,
      };
      if (o.fulfillmentStatus === "delivered" && status !== "delivered")
        return o;
      if (
        ranks[status] != null &&
        ranks[o.fulfillmentStatus] != null &&
        ranks[status] < ranks[o.fulfillmentStatus]
      )
        return o;
      const next = {
        ...o,
        ...patch,
        fulfillmentStatus: status,
        updatedAt: now(),
      };
      if (["shipped", "posted"].includes(status))
        next.postedAt = o.postedAt || patch.postedAt || now();
      if (status === "delivered")
        next.deliveredAt = o.deliveredAt || patch.deliveredAt || now();
      await t.put(key, next);
      return next;
    });
  }
  async finishPayment(id, status, extra = {}) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `order:${id}`,
        o = await t.get(key);
      if (!o) return null;
      if (o.status === "paid") return o;
      const stock = { ...seedInventory(), ...((await t.get("inventory")) || {}) };
      if (status === "paid") {
        if (o.stockReleased) {
          for (const i of o.items)
            stock[i.id] = Number(stock[i.id] || 0) - i.quantity;
          await t.put("inventory", stock);
        }
        let creditAttention = false;
        if (o.prive?.creditApplied && o.creditReleased) {
          const email = await t.get(`prive-member-id:${o.prive.memberId}`);
          const memberKey = email ? `prive-member:${email}` : "";
          const member = memberKey ? await t.get(memberKey) : null;
          if (member) {
            const amount = Number(o.prive.creditApplied);
            creditAttention = Number(member.creditBalance || 0) < amount;
            await t.put(memberKey, { ...member, creditBalance: Math.max(0, Number(member.creditBalance || 0) - amount), updatedAt: now() });
          }
        }
        const next = {
          ...o,
          ...extra,
          status: "paid",
          stockReleased: false,
          stockAttention: o.items.some((i) => stock[i.id] < 0),
          creditAttention,
          creditReleased: false,
          fulfillmentStatus: o.fulfillmentStatus || "confirmed",
          paidAt: o.paidAt || now(),
          updatedAt: now(),
        };
        await t.put(key, next);
        return next;
      }
      if (!o.stockReleased) {
        for (const i of o.items)
          stock[i.id] = Number(stock[i.id] || 0) + i.quantity;
        await t.put("inventory", stock);
      }
      let creditReleased = Boolean(o.creditReleased);
      if (o.prive?.creditApplied && !creditReleased) {
        const email = await t.get(`prive-member-id:${o.prive.memberId}`);
        const memberKey = email ? `prive-member:${email}` : "";
        const member = memberKey ? await t.get(memberKey) : null;
        if (member) {
          const amount = Number(o.prive.creditApplied);
          await t.put(memberKey, { ...member, creditBalance: Number(member.creditBalance || 0) + amount, updatedAt: now() });
          const entry = { id: crypto.randomUUID(), memberId: member.id, orderId: o.id, type: "credit_released", points: 0, creditAmount: amount, createdAt: now() };
          await t.put(`prive-entry:${member.id}:${entry.createdAt}:${entry.id}`, entry);
        }
        creditReleased = true;
      }
      const next = {
        ...o,
        ...extra,
        status,
        stockReleased: true,
        creditReleased,
        updatedAt: now(),
      };
      await t.put(key, next);
      return next;
    });
  }
  async refundPaidOrder(id, reason = "refund") {
    return this.ctx.storage.transaction(async (t) => {
      const key = `order:${id}`;
      const order = await t.get(key);
      if (!order || !["paid", "refunded"].includes(order.status)) return null;
      if (order.status === "refunded") return order;
      const email = String(order.customer?.email || "").toLowerCase();
      const memberKey = `prive-member:${email}`;
      const member = await t.get(memberKey);
      if (member) {
        const purchase = await t.get(`prive-ledger:${id}`);
        let debt = 0;
        if (purchase && !purchase.reversedAt) {
          const available = Math.min(Number(member.pointsBalance || 0), Number(purchase.remainingPoints || 0));
          debt = Math.max(0, Number(purchase.points || 0) - Number(purchase.remainingPoints || 0));
          member.pointsBalance = Math.max(0, Number(member.pointsBalance || 0) - available);
          member.pointsDebt = Number(member.pointsDebt || 0) + debt;
          purchase.remainingPoints = 0;
          purchase.reversedAt = now();
          await t.put(`prive-ledger:${id}`, purchase);
          const rows = await t.list({ prefix: `prive-entry:${member.id}:` });
          for (const [entryKey, source] of rows)
            if (source.id === purchase.id) {
              await t.put(entryKey, purchase);
              break;
            }
          const reversal = { id: crypto.randomUUID(), memberId: member.id, orderId: id, type: "refund", points: -Number(purchase.points || 0), pointsDebt: debt, reason, createdAt: now() };
          await t.put(`prive-entry:${member.id}:${reversal.createdAt}:${reversal.id}`, reversal);
        }
        if (order.prive?.creditApplied && !order.refundCreditRestored) {
          const amount = Number(order.prive.creditApplied);
          member.creditBalance = Number(member.creditBalance || 0) + amount;
          const credit = { id: crypto.randomUUID(), memberId: member.id, orderId: id, type: "credit_refund", points: 0, creditAmount: amount, createdAt: now() };
          await t.put(`prive-entry:${member.id}:${credit.createdAt}:${credit.id}`, credit);
          order.refundCreditRestored = true;
        }
        member.updatedAt = now();
        await t.put(memberKey, member);
      }
      const next = { ...order, status: "refunded", refundReason: reason, refundedAt: now(), updatedAt: now() };
      await t.put(key, next);
      return next;
    });
  }
  async adminAdjustPrive(email, points, creditAmount, reason) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `prive-member:${String(email || "").trim().toLowerCase()}`;
      const member = await t.get(key);
      if (!member) return null;
      points = Number(points || 0);
      creditAmount = Number(creditAmount || 0);
      if (!Number.isInteger(points) || !Number.isFinite(creditAmount)) throw new Error("Ajuste inválido.");
      if (points < 0) {
        let consume = Math.min(-points, Number(member.pointsBalance || 0));
        const rows = await t.list({ prefix: `prive-entry:${member.id}:` });
        const lots = [...rows].filter(([, e]) => Number(e.remainingPoints || 0) > 0).sort(([, a], [, b]) => String(a.expiresAt).localeCompare(String(b.expiresAt)));
        for (const [entryKey, source] of lots) {
          const used = Math.min(consume, Number(source.remainingPoints));
          const consumed = { ...source, remainingPoints: Number(source.remainingPoints) - used };
          await t.put(entryKey, consumed);
          if (source.type === "purchase" && source.orderId) await t.put(`prive-ledger:${source.orderId}`, consumed);
          consume -= used;
          if (!consume) break;
        }
      }
      const next = { ...member, pointsBalance: Math.max(0, Number(member.pointsBalance || 0) + points), pointsDebt: Number(member.pointsDebt || 0) + Math.max(0, -points - Number(member.pointsBalance || 0)), lifetimePoints: Number(member.lifetimePoints || 0) + Math.max(0, points), creditBalance: Math.max(0, Number(member.creditBalance || 0) + creditAmount), updatedAt: now() };
      const entry = { id: crypto.randomUUID(), memberId: member.id, type: "admin_adjustment", points, creditAmount, remainingPoints: Math.max(0, points), expiresAt: points > 0 ? twelveMonthsFromNow() : null, reason: String(reason || "Ajuste administrativo").slice(0, 240), createdAt: now() };
      await t.put(key, next);
      await t.put(`prive-entry:${member.id}:${entry.createdAt}:${entry.id}`, entry);
      return { member: next, entry };
    });
  }
  async closePriveAccount(memberId) {
    return this.ctx.storage.transaction(async (t) => {
      const email = await t.get(`prive-member-id:${memberId}`);
      const key = email ? `prive-member:${email}` : "";
      const member = key ? await t.get(key) : null;
      if (!member) return false;
      await t.put(`prive-member-closed:${memberId}`, { id: memberId, status: "closed", termsVersion: member.termsVersion, privacyVersion: member.privacyVersion, createdAt: member.createdAt, closedAt: now() });
      await t.delete(key);
      await t.delete(`prive-member-id:${memberId}`);
      const sessions = await t.list({ prefix: "prive-session:" });
      for (const [sessionKey, session] of sessions) if (session.memberId === memberId) await t.delete(sessionKey);
      return true;
    });
  }
  async expirePriveBatch(limit = 50) {
    const cursor = await this.ctx.storage.get("prive-maintenance-cursor");
    let members = await this.ctx.storage.list({ prefix: "prive-member:", limit, ...(cursor ? { startAfter: cursor } : {}) });
    if (!members.size && cursor) members = await this.ctx.storage.list({ prefix: "prive-member:", limit });
    await this.ctx.storage.put("prive-maintenance-cursor", members.size === limit ? [...members.keys()].at(-1) : "");
    for (const member of members.values()) await this.expirePrivePoints(member.id);
    return members.size;
  }
  async listOrders() {
    return [...(await this.ctx.storage.list({ prefix: "order:" })).values()];
  }
  async orderPage(limit = 50) {
    const cursor = await this.ctx.storage.get("maintenance-cursor");
    let entries = await this.ctx.storage.list({
      prefix: "order:",
      limit,
      ...(cursor ? { startAfter: cursor } : {}),
    });
    if (!entries.size && cursor)
      entries = await this.ctx.storage.list({ prefix: "order:", limit });
    await this.ctx.storage.put(
      "maintenance-cursor",
      entries.size === limit ? [...entries.keys()].at(-1) : "",
    );
    return [...entries.values()];
  }
  async findOrderByMelhorEnvioId(id) {
    if (!id) return null;
    return (
      (await this.listOrders()).find(
        (o) => String(o.melhorEnvioOrderId || "") === String(id),
      ) || null
    );
  }
  async getAuth(key) {
    return (await this.ctx.storage.get(`auth:${key}`)) || null;
  }
  async putAuth(key, value) {
    await this.ctx.storage.put(`auth:${key}`, value);
    return true;
  }
  async deleteAuth(key) {
    await this.ctx.storage.delete(`auth:${key}`);
    return true;
  }
  async consumeOAuthState(state) {
    return this.ctx.storage.transaction(async (t) => {
      const key = `auth:oauth-state:${state}`,
        s = await t.get(key);
      if (!s) return false;
      await t.delete(key);
      return (
        Date.now() - s.createdAt >= 0 &&
        Date.now() - s.createdAt <= 20 * 60 * 1000
      );
    });
  }
  async refreshMelhorEnvio(origin) {
    if (!this.refreshPromise)
      this.refreshPromise = (async () => {
        const rec = await this.getAuth("oauth-token");
        if (!rec?.refresh_token)
          throw new Error("Melhor Envio sem autorização.");
        if (Date.now() < rec.expires_at - 86400000) return rec;
        return saveTokens(
          this,
          await refreshTokens(this.env, rec.refresh_token, origin),
        );
      })().finally(() => {
        this.refreshPromise = null;
      });
    return this.refreshPromise;
  }
  async enqueueEmail(key, payload) {
    return this.ctx.storage.transaction(async (t) => {
      const k = `notify:${key}`,
        existing = await t.get(k);
      if (existing?.state === "sent") return existing;
      const queued = existing?.payload
        ? existing
        : { state: "pending", createdAt: now(), payload, attempts: 0 };
      await t.put(k, queued);
      return queued;
    });
  }
  async claimNotification(key) {
    return this.ctx.storage.transaction(async (t) => {
      const k = `notify:${key}`,
        found = await t.get(k);
      if (
        found?.state === "sent" ||
        (found?.state === "sending" &&
          Date.now() - Date.parse(found.claimedAt) < 120000)
      )
        return false;
      await t.put(k, {
        ...found,
        state: "sending",
        claimedAt: now(),
        attempts: Number(found?.attempts || 0) + 1,
      });
      return true;
    });
  }
  async completeNotification(key, meta = {}) {
    await this.ctx.storage.put(`notify:${key}`, {
      state: "sent",
      sentAt: now(),
      ...meta,
    });
    return true;
  }
  async releaseNotificationClaim(key, error = "") {
    return this.ctx.storage.transaction(async (t) => {
      const k = `notify:${key}`,
        found = await t.get(k);
      if (found?.state !== "sent")
        await t.put(k, {
          ...found,
          state: "pending",
          lastError: String(error).slice(0, 240),
          nextAttemptAt:
            Date.now() +
            Math.min(3600000, 60000 * 2 ** Math.min(found?.attempts || 0, 6)),
        });
      return true;
    });
  }
  async pendingEmails(limit = 10) {
    const all = await this.ctx.storage.list({ prefix: "notify:" });
    return [...all]
      .filter(
        ([, v]) =>
          v.payload &&
          v.state !== "sent" &&
          (v.nextAttemptAt || 0) <= Date.now(),
      )
      .slice(0, limit)
      .map(([k, v]) => ({ key: k.slice(7), ...v }));
  }
  async orderNotifications(id) {
    const rows = await this.ctx.storage.list({ prefix: `notify:${id}:` });
    return [...rows].map(([key, v]) => ({
      key: key.slice(7),
      state: v.state,
      attempts: v.attempts || 0,
      lastError: v.lastError || null,
      sentAt: v.sentAt || null,
    }));
  }
}
export function storeStub(env) {
  return env.AMEVURI_STORE.getByName("global");
}
