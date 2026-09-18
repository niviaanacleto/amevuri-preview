(() => {
  const root = document.querySelector("[data-prive-account]");
  if (!root) return;
  const login = root.querySelector("[data-prive-login]"), dashboard = root.querySelector("[data-prive-dashboard]");
  const requestForm = root.querySelector("[data-code-request]"), verifyForm = root.querySelector("[data-code-verify]");
  const loginMessage = root.querySelector("[data-login-message]"), accountMessage = root.querySelector("[data-account-message]");
  let loginEmail = "";
  const money = (n) => new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(Number(n) || 0);
  const date = (v) => v ? new Intl.DateTimeFormat("pt-BR", { dateStyle: "medium" }).format(new Date(v)) : "—";
  async function api(path, options = {}) {
    const response = await fetch(path, { ...options, headers: { accept: "application/json", ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.error || "Não foi possível concluir esta etapa."), { status: response.status, code: data.code });
    return data;
  }
  const labels = { purchase: "Pontos da compra", redemption: "Conversão em crédito", expiry: "Pontos expirados", refund: "Estorno da compra", admin_adjustment: "Ajuste AMEVURI", credit_used: "Crédito usado no pedido", credit_released: "Crédito devolvido", credit_refund: "Crédito restituído" };
  function render(account) {
    const { member, history } = account;
    login.hidden = true; dashboard.hidden = false;
    root.querySelector("[data-member-name]").textContent = member.name;
    root.querySelector("[data-member-email]").textContent = member.email;
    root.querySelector("[data-points]").textContent = member.pointsBalance;
    root.querySelector("[data-credit]").textContent = money(member.creditBalance);
    root.querySelector("[data-lifetime]").textContent = member.lifetimePoints;
    const profile = root.querySelector("[data-profile-form]");
    profile.elements.name.value = member.name; profile.elements.phone.value = member.phone || ""; profile.elements.marketingConsent.checked = member.marketingConsent;
    const select = root.querySelector("[data-redeem-options]"); select.innerHTML = "";
    const max = Math.floor(member.pointsBalance / 100) * 100;
    if (!max) select.append(new Option("Saldo mínimo: 100 pontos", "", true, true));
    for (let points = 100; points <= max; points += 100) select.append(new Option(`${points} pontos → ${money(points / 20)}`, String(points)));
    root.querySelector("[data-redeem-form] button").disabled = !max;
    const box = root.querySelector("[data-history]"); box.innerHTML = "";
    if (!history.length) box.innerHTML = "<p>Nenhuma movimentação registrada.</p>";
    history.forEach((entry) => {
      const row = document.createElement("article");
      const value = entry.points ? `${entry.points > 0 ? "+" : ""}${entry.points} pontos` : `${entry.creditAmount > 0 ? "+" : ""}${money(entry.creditAmount)}`;
      row.innerHTML = `<div><strong>${labels[entry.type] || "Movimentação Privé"}</strong><small>${date(entry.createdAt)}${entry.orderId ? ` · ${entry.orderId}` : ""}${entry.expiresAt && entry.points > 0 ? ` · vence ${date(entry.expiresAt)}` : ""}</small></div><b>${value}</b>`;
      box.appendChild(row);
    });
  }
  async function load() { try { render((await api("/api/prive/account")).account); } catch (error) { if (error.status !== 401) loginMessage.textContent = error.message; } }
  requestForm.addEventListener("submit", async (event) => { event.preventDefault(); if (!requestForm.reportValidity()) return; loginEmail = requestForm.elements.email.value.trim().toLowerCase(); loginMessage.textContent = "Enviando código…"; try { await api("/api/prive/request-code", { method: "POST", body: JSON.stringify({ email: loginEmail, company: requestForm.elements.company.value }) }); requestForm.hidden = true; verifyForm.hidden = false; root.querySelector("[data-code-destination]").textContent = `Enviamos o código para ${loginEmail}, caso exista uma conta ativa.`; loginMessage.textContent = "Confira sua caixa de entrada e o spam."; verifyForm.elements.code.focus(); } catch (error) { loginMessage.textContent = error.message; } });
  verifyForm.addEventListener("submit", async (event) => { event.preventDefault(); if (!verifyForm.reportValidity()) return; loginMessage.textContent = "Validando acesso…"; try { render((await api("/api/prive/verify-code", { method: "POST", body: JSON.stringify({ email: loginEmail, code: verifyForm.elements.code.value }) })).account); loginMessage.textContent = ""; } catch (error) { loginMessage.textContent = error.message; } });
  root.querySelector("[data-code-back]").addEventListener("click", () => { requestForm.hidden = false; verifyForm.hidden = true; verifyForm.reset(); });
  root.querySelector("[data-redeem-form]").addEventListener("submit", async (event) => { event.preventDefault(); const points = Number(event.currentTarget.elements.points.value); if (!points || !confirm(`Converter ${points} pontos em ${money(points / 20)} de crédito?`)) return; accountMessage.textContent = "Convertendo pontos…"; try { render((await api("/api/prive/redeem", { method: "POST", body: JSON.stringify({ points }) })).account); accountMessage.textContent = "Crédito disponível para uso no checkout."; } catch (error) { accountMessage.textContent = error.message; } });
  root.querySelector("[data-profile-form]").addEventListener("submit", async (event) => { event.preventDefault(); if (!event.currentTarget.reportValidity()) return; const data = Object.fromEntries(new FormData(event.currentTarget)); try { render((await api("/api/prive/account", { method: "POST", body: JSON.stringify({ name: data.name, phone: data.phone, marketingConsent: data.marketingConsent === "on" }) })).account); accountMessage.textContent = "Preferências atualizadas."; } catch (error) { accountMessage.textContent = error.message; } });
  root.querySelector("[data-logout]").addEventListener("click", async () => { await api("/api/prive/logout", { method: "POST", body: "{}" }).catch(() => {}); location.reload(); });
  root.querySelector("[data-close-account]").addEventListener("click", async () => { if (!confirm("Encerrar sua participação? O saldo e os créditos serão cancelados e o perfil será anonimizado.")) return; try { await api("/api/prive/account", { method: "DELETE" }); location.reload(); } catch (error) { accountMessage.textContent = error.message; } });
  load();
})();
