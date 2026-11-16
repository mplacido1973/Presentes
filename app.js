import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithRedirect, getRedirectResult,
  signInWithEmailAndPassword, createUserWithEmailAndPassword, sendPasswordResetEmail, updateProfile, signOut
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  initializeFirestore, persistentLocalCache, persistentMultipleTabManager,
  collection, doc, setDoc, updateDoc, deleteDoc, getDoc, onSnapshot, query, where,
  arrayUnion, arrayRemove, deleteField, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

/* ---------- Utilitários ---------- */
const $ = s => document.querySelector(s);
const eur = new Intl.NumberFormat("pt-PT", { style: "currency", currency: "EUR" });
const euro = n => eur.format(Number(n) || 0);
const norm = s => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = u => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : ""; } catch { return ""; } };
const safeImg = u => typeof u === "string" && u.startsWith("data:image/") ? u : "";
const parseMoney = s => { const t = String(s || "").trim().replace(/\s|€/g, "").replace(",", "."); if (t === "") return null; const n = Number(t); return Number.isFinite(n) && n >= 0 ? n : NaN; };
const randomCode = () => { const a = "abcdefghjkmnpqrstuvwxyz23456789"; const r = crypto.getRandomValues(new Uint8Array(20)); return [...r].map(x => a[x % a.length]).join(""); };
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };

let toastT;
function toast(msg) { const t = $("#toast"); t.textContent = msg; t.classList.add("show"); clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove("show"), 3500); }
function fail(e) {
  console.error(e);
  const c = e && e.code;
  if (c === "permission-denied") toast("Não tens permissão para fazer isto.");
  else if (c === "unavailable") toast("Sem ligação. A alteração é enviada quando voltares a ter rede.");
  else toast("Algo correu mal. Tenta outra vez.");
}
const VIEWS = ["setupView", "bootView", "authView", "homeView", "listView"];
const show = id => VIEWS.forEach(v => $("#" + v).classList.toggle("hidden", v !== id));

/* ---------- Arranque do Firebase ---------- */
const configured = firebaseConfig && firebaseConfig.apiKey && !/COLA/i.test(firebaseConfig.apiKey);
if (!configured) { show("setupView"); throw new Error("Falta a configuração do Firebase"); }

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
auth.languageCode = "pt";
const db = initializeFirestore(app, { localCache: persistentLocalCache({ tabManager: persistentMultipleTabManager() }) });

if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});

/* ---------- Estado ---------- */
const S = {
  user: null, lists: [], listsLoaded: false, unsubLists: null,
  cur: null, recipients: [], recLoaded: false, unsubRec: null,
  gifts: {}, giftUnsubs: new Map(), photos: {},
  filterR: "", filterS: "all", open: new Set(), confirmDel: null,
  editing: null, buying: null, photo: { data: null, thumb: null, removed: false },
  signup: false, creating: false, installEvt: null
};
const uid = () => S.user && S.user.uid;
const myName = () => (S.user && (S.user.displayName || (S.user.email || "").split("@")[0])) || "Eu";
const curList = () => S.lists.find(l => l.id === S.cur) || null;
const isOwner = () => { const l = curList(); return !!(l && l.ownerUid === uid()); };
const memberName = id => id === uid() ? "ti" : ((curList() && curList().names && curList().names[id]) || "alguém");
const allGifts = () => Object.values(S.gifts).flat();
const myRecipient = () => S.recipients.find(r => r.uid && r.uid === uid()) || null;
const recByKey = k => S.recipients.find(r => r.key === k);
const giftRef = (rid, gid) => doc(db, "lists", S.cur, "recipients", rid, "gifts", gid);
const photoRef = (rid, gid) => doc(db, "lists", S.cur, "recipients", rid, "photos", gid);

/* ---------- Confirmação genérica ---------- */
let confirmResolve = null;
function ask(title, text, ok = "Confirmar", danger = false) {
  $("#confirmTitle").textContent = title; $("#confirmText").textContent = text;
  const b = $("#confirmYes"); b.textContent = ok; b.className = "btn " + (danger ? "danger" : "primary");
  $("#confirmDlg").showModal();
  return new Promise(r => { confirmResolve = r; });
}
function answer(v) { $("#confirmDlg").close(); if (confirmResolve) { confirmResolve(v); confirmResolve = null; } }
$("#confirmDlg").addEventListener("close", () => { if (confirmResolve) { confirmResolve(false); confirmResolve = null; } });

/* ---------- Autenticação ---------- */
const AUTH_MSG = {
  "auth/invalid-credential": "Email ou palavra-passe errados.",
  "auth/wrong-password": "Email ou palavra-passe errados.",
  "auth/user-not-found": "Não há nenhuma conta com este email.",
  "auth/email-already-in-use": "Já existe uma conta com este email. Usa Entrar.",
  "auth/weak-password": "A palavra-passe tem de ter pelo menos 6 caracteres.",
  "auth/invalid-email": "O email não é válido.",
  "auth/missing-password": "Escreve a palavra-passe.",
  "auth/too-many-requests": "Demasiadas tentativas. Espera um pouco e tenta outra vez.",
  "auth/network-request-failed": "Sem ligação à internet.",
  "auth/unauthorized-domain": "Este endereço ainda não está autorizado no Firebase (ver LEIA-ME)."
};
const authErr = e => { if (e && (e.code === "auth/popup-closed-by-user" || e.code === "auth/cancelled-popup-request")) return; $("#authErr").textContent = AUTH_MSG[e && e.code] || "Não foi possível entrar. Tenta outra vez."; };

getRedirectResult(auth).catch(authErr);

async function google() {
  $("#authErr").textContent = "";
  const p = new GoogleAuthProvider();
  try { await signInWithPopup(auth, p); }
  catch (e) {
    if (["auth/popup-blocked", "auth/operation-not-supported-in-this-environment"].includes(e.code)) signInWithRedirect(auth, p);
    else authErr(e);
  }
}
$("#emailForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("#authErr").textContent = "";
  const email = $("#aEmail").value.trim(), pass = $("#aPass").value;
  const btn = $("#authSubmit"); btn.disabled = true;
  try {
    if (S.signup) {
      const name = $("#aName").value.trim();
      if (!name) { $("#authErr").textContent = "Escreve o teu nome."; return; }
      S.creating = true;
      const cred = await createUserWithEmailAndPassword(auth, email, pass);
      await updateProfile(cred.user, { displayName: name });
      S.creating = false;
      S.user = auth.currentUser;
      if ($("#nameDlg").open) $("#nameDlg").close();
      afterSignIn();
    } else await signInWithEmailAndPassword(auth, email, pass);
  } catch (err) { authErr(err); }
  finally { btn.disabled = false; S.creating = false; }
});
function toggleSignup() {
  S.signup = !S.signup;
  $("#signupName").classList.toggle("hidden", !S.signup);
  $("#authSubmit").textContent = S.signup ? "Criar conta" : "Entrar";
  $("#toggleSignup").textContent = S.signup ? "Já tenho conta" : "Criar conta";
  $("#aPass").autocomplete = S.signup ? "new-password" : "current-password";
  $("#authErr").textContent = "";
}
async function resetPass() {
  const email = $("#aEmail").value.trim();
  if (!email) { $("#authErr").textContent = "Escreve o teu email primeiro."; return; }
  try { await sendPasswordResetEmail(auth, email); toast("Enviámos um email para criares uma palavra-passe nova."); }
  catch (e) { authErr(e); }
}

function teardown() {
  if (S.unsubLists) S.unsubLists(); S.unsubLists = null;
  closeList(true);
  S.lists = []; S.listsLoaded = false;
}

onAuthStateChanged(auth, u => {
  teardown();
  S.user = u;
  if (!u) { show("authView"); return; }
  afterSignIn();
});

function afterSignIn() {
  if (!S.user) return;
  if (!S.user.displayName && !S.creating) openName(true);
  if (!S.unsubLists) {
    S.unsubLists = onSnapshot(query(collection(db, "lists"), where("memberIds", "array-contains", uid())), snap => {
      S.lists = snap.docs.map(d => ({ id: d.id, ...d.data() }));
      if (!snap.metadata.fromCache) S.listsLoaded = true;
      if (S.cur && S.listsLoaded && !curList()) { toast("Já não tens acesso a esta lista."); goHome(); }
      renderHome(); if (S.cur) renderList();
    }, fail);
  }
  route();
}

/* ---------- Navegação ---------- */
function route() {
  const h = new URLSearchParams(location.hash.slice(1));
  const join = h.get("join");
  if (join) { sessionStorage.setItem("pendingJoin", join); history.replaceState(null, "", location.pathname + location.search); }
  if (!S.user) return;
  const pj = sessionStorage.getItem("pendingJoin");
  if (pj) { sessionStorage.removeItem("pendingJoin"); openJoin(pj); }
  const l = new URLSearchParams(location.hash.slice(1)).get("l");
  if (l) openList(l); else closeList();
}
window.addEventListener("hashchange", route);
const goHome = () => { if (location.hash) location.hash = ""; else closeList(); };
const goList = id => { location.hash = "l=" + id; };

/* ---------- Início ---------- */
function renderHome() {
  if (S.cur || !S.user) return;
  show("homeView");
  $("#accountBtn").textContent = myName();
  const box = $("#installBox");
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent);
  if (S.installEvt) box.innerHTML = `<div class="install"><span>Instala a app no telemóvel para a abrires com um toque.</span><button class="btn primary" type="button" data-action="install">Instalar</button></div>`;
  else if (ios && !standalone) box.innerHTML = `<div class="install"><span>Para instalar no iPhone: toca em Partilhar e depois em Adicionar ao ecrã principal.</span></div>`;
  else box.innerHTML = "";
  const lists = [...S.lists].sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  if (!lists.length) {
    $("#lists").innerHTML = S.listsLoaded
      ? `<div class="state"><h3>Ainda não tens listas</h3>Cria uma lista nova ou abre o link de convite que te enviaram.</div>`
      : `<div class="state">A carregar…</div>`;
    return;
  }
  $("#lists").innerHTML = lists.map(l => {
    const n = (l.memberIds || []).length;
    return `<button class="listcard" type="button" data-open="${esc(l.id)}"><span class="ic">🎁</span><span><b>${esc(l.name)}</b><small>${n} ${n === 1 ? "pessoa" : "pessoas"}${l.ownerUid === uid() ? ", criada por ti" : ""}</small></span></button>`;
  }).join("");
}
addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installEvt = e; renderHome(); });
addEventListener("appinstalled", () => { S.installEvt = null; renderHome(); });

/* ---------- Abrir / fechar lista ---------- */
function openList(id) {
  if (S.cur === id) { renderList(); return; }
  closeList(true);
  S.cur = id; S.filterR = ""; S.filterS = "all"; S.open = new Set(); S.recLoaded = false;
  show("listView"); window.scrollTo(0, 0);
  S.unsubRec = onSnapshot(collection(db, "lists", id, "recipients"), snap => {
    if (S.cur !== id) return;
    S.recipients = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (!snap.metadata.fromCache || snap.size) S.recLoaded = true;
    syncGiftSubs(); renderList();
  }, e => { if (S.cur === id) { fail(e); goHome(); } });
  renderList();
}
function closeList(silent) {
  if (S.unsubRec) S.unsubRec(); S.unsubRec = null;
  for (const un of S.giftUnsubs.values()) un();
  S.giftUnsubs.clear(); S.gifts = {}; S.photos = {}; S.recipients = []; S.cur = null;
  if (!silent && S.user) { show("homeView"); renderHome(); }
}
function syncGiftSubs() {
  const listId = S.cur, me = uid();
  const want = new Set(S.recipients.filter(r => r.uid !== me).map(r => r.id));
  for (const [rid, un] of S.giftUnsubs) if (!want.has(rid)) { un(); S.giftUnsubs.delete(rid); delete S.gifts[rid]; }
  for (const rid of want) if (!S.giftUnsubs.has(rid)) {
    const un = onSnapshot(collection(db, "lists", listId, "recipients", rid, "gifts"), snap => {
      if (S.cur !== listId) return;
      S.gifts[rid] = snap.docs.map(d => ({ id: d.id, rid, ...d.data() }));
      renderList();
    }, () => { S.giftUnsubs.delete(rid); delete S.gifts[rid]; renderList(); });
    S.giftUnsubs.set(rid, un);
  }
}

/* ---------- Desenhar a lista ---------- */
const askedKey = () => `asked:${S.cur}:${uid()}`;
const needsGate = () => S.recLoaded && !myRecipient() && !lsGet(askedKey());

function renderList() {
  if (!S.cur) return;
  const l = curList();
  $("#listName").textContent = l ? l.name : "…";
  const n = l ? (l.memberIds || []).length : 0;
  $("#membersLine").textContent = l ? `${n} ${n === 1 ? "pessoa" : "pessoas"}` : "";
  const mr = myRecipient(), who = $("#whoBtn");
  who.classList.toggle("hidden", !S.recLoaded || needsGate());
  who.textContent = mr ? "Tu: " + mr.name : "Tu: sem presentes aqui";

  const visRecs = S.recipients.filter(r => r.uid !== uid()).sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const withGifts = visRecs.filter(r => (S.gifts[r.id] || []).length);
  if (S.filterR && !withGifts.some(r => r.id === S.filterR)) S.filterR = "";

  $("#chips").innerHTML = [["", "Todos"], ...withGifts.map(r => [r.id, r.name])].map(([k, label]) =>
    `<button type="button" class="chip" data-rec="${esc(k)}" aria-pressed="${S.filterR === k}">${esc(label)}</button>`).join("");
  document.querySelectorAll(".seg button").forEach(b => b.setAttribute("aria-pressed", b.dataset.status === S.filterS));

  const scope = allGifts().filter(g => !S.filterR || g.rid === S.filterR);
  const total = scope.reduce((s, g) => s + (+g.price || 0), 0);
  const bought = scope.filter(g => g.done).reduce((s, g) => s + (+(g.actual ?? g.price) || 0), 0);
  const left = scope.filter(g => !g.done).reduce((s, g) => s + (+g.price || 0), 0);
  $("#fTotal").textContent = euro(total); $("#fBought").textContent = euro(bought); $("#fLeft").textContent = euro(left);
  $("#barFill").style.width = (bought + left > 0 ? Math.min(100, bought / (bought + left) * 100) : 0) + "%";
  const fr = S.recipients.find(r => r.id === S.filterR);
  $("#scope").textContent = fr ? "Só para " + fr.name : "";

  $("#notes").innerHTML = mr ? `<div class="note">Estás na lista como <b>${esc(mr.name)}</b>, por isso as sugestões para ti estão escondidas.</div>` : "";
  $("#giftDock").classList.toggle("hidden", !S.recLoaded || needsGate());

  if (!S.recLoaded) { $("#gifts").innerHTML = `<div class="state">A carregar a lista…</div>`; return; }
  if (needsGate()) { $("#gifts").innerHTML = gateHtml(); return; }

  const groups = withGifts.filter(r => !S.filterR || r.id === S.filterR).map(r => {
    const items = (S.gifts[r.id] || []).filter(g => S.filterS === "all" || (S.filterS === "done") === !!g.done);
    return { r, items };
  }).filter(g => g.items.length);

  if (!groups.length) {
    $("#gifts").innerHTML = allGifts().length
      ? `<div class="state">Não há presentes nesta seleção.</div>`
      : `<div class="state"><h3>Ainda não há sugestões</h3>Adiciona a primeira com o botão Nova sugestão, ou convida a família pelo menu ⋯.</div>`;
    return;
  }
  $("#gifts").innerHTML = groups.map(({ r, items }) => {
    items.sort((a, b) => (!!a.done - !!b.done) || ((b.voters || []).length - (a.voters || []).length) || ((b.createdAt || 0) - (a.createdAt || 0)));
    const all = S.gifts[r.id] || [], sub = all.reduce((s, g) => s + (+g.price || 0), 0);
    return `<section class="group"><h2><span>${esc(r.name)}</span><small>${all.length} ${all.length === 1 ? "ideia" : "ideias"}, ${euro(sub)}</small></h2>${items.map(giftHtml).join("")}</section>`;
  }).join("");
  allGifts().filter(g => S.open.has(g.id)).forEach(loadPhoto);
}

function giftHtml(g) {
  const voters = g.voters || [], v = voters.length, mine = voters.includes(uid());
  const name = g.name || "Sugestão por definir", url = safeUrl(g.url), thumb = safeImg(g.thumb);
  const isOpen = S.open.has(g.id), photo = S.photos[g.id];
  return `<details class="gift${g.done ? " done" : ""}" data-gid="${esc(g.id)}" data-rid="${esc(g.rid)}"${isOpen ? " open" : ""}>
  <summary>
    <span class="thumb">${thumb ? `<img src="${esc(thumb)}" alt="">` : "🎁"}</span>
    <span class="sumtext"><div class="gname">${esc(name)}</div>
      <div class="gmeta"><span>${g.done && g.actual != null ? euro(g.actual) : euro(g.price)}</span><span>❤ ${v}</span></div></span>
    <span class="badge${g.done ? " ok" : ""}">${g.done ? "Comprado" : "Por comprar"}</span>
  </summary>
  <div class="body">
    ${g.hasPhoto ? (safeImg(photo) ? `<img class="photo" src="${esc(photo)}" alt="${esc(name)}">` : `<div class="photo ph">${photo === false ? "Fotografia indisponível" : "A carregar fotografia…"}</div>`) : ""}
    <div class="detail">Preço previsto: <b>${euro(g.price)}</b>${g.done && g.actual != null ? `<br>Preço pago: <b>${euro(g.actual)}</b>` : ""}</div>
    ${g.note ? `<div class="detail">${esc(g.note)}</div>` : ""}
    ${g.store ? `<div class="detail">Loja: <b>${esc(g.store)}</b></div>` : ""}
    ${url ? `<div class="detail"><a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Ver na loja ↗</a></div>` : ""}
    ${g.createdBy ? `<div class="detail">Sugerido por ${esc(memberName(g.createdBy))}</div>` : ""}
    ${g.done && g.boughtBy ? `<div class="detail">Comprado por ${esc(memberName(g.boughtBy))}</div>` : ""}
    <div class="detail">${v === 0 ? "Ainda sem votos" : v === 1 ? "1 voto" : v + " votos"}${v ? ": " + esc(voters.map(memberName).join(", ")) : ""}</div>
    <div class="actions">
      <button class="btn" type="button" data-action="vote" aria-pressed="${mine}">${mine ? "❤ Votaste" : "❤ Votar"}</button>
      <button class="btn" type="button" data-action="${g.done ? "reopen" : "buy"}">${g.done ? "↩ Reabrir" : "✓ Marcar comprado"}</button>
      <button class="btn" type="button" data-action="edit">Editar</button>
      <button class="btn danger" type="button" data-action="del">${S.confirmDel === g.id ? "Confirmar eliminação" : "Eliminar"}</button>
    </div>
  </div>
</details>`;
}

function gateHtml() {
  const free = S.recipients.filter(r => !r.uid).sort((a, b) => a.name.localeCompare(b.name, "pt"));
  const mine = norm(myName());
  const exists = free.some(r => r.key === mine) || S.recipients.some(r => r.key === mine);
  return `<div class="gate">
    <h3>Antes de veres a lista, diz-nos quem és</h3>
    <p>Assim escondemos as sugestões para ti e ninguém estraga a surpresa.</p>
    <div class="opts">
      ${free.map(r => `<button class="btn" type="button" data-action="iam" data-rid="${esc(r.id)}">Sou ${esc(r.name)}</button>`).join("")}
      ${exists ? "" : `<button class="btn" type="button" data-action="addMe">Juntar-me como ${esc(myName())}</button>`}
      <button class="btn ghost" type="button" data-action="noGifts">Não recebo presentes nesta lista</button>
    </div>
  </div>`;
}

/* Fotografia completa: só é carregada quando o cartão abre. */
async function loadPhoto(g) {
  if (!g.hasPhoto || g.id in S.photos) return;
  S.photos[g.id] = null;
  try {
    const s = await getDoc(photoRef(g.rid, g.id));
    S.photos[g.id] = s.exists() ? s.data().data : false;
  } catch { S.photos[g.id] = false; }
  renderList();
}

/* ---------- Identidade na lista ---------- */
async function linkMe(rid) {
  const r = S.recipients.find(x => x.id === rid); if (!r) return;
  const ok = await ask(`Confirmas que és ${r.name}?`, `As sugestões para ${r.name} deixam de te aparecer. Só quem criou a lista pode desfazer isto.`, "Sou eu");
  if (!ok) return;
  const un = S.giftUnsubs.get(rid); if (un) { un(); S.giftUnsubs.delete(rid); delete S.gifts[rid]; }
  try { await updateDoc(doc(db, "lists", S.cur, "recipients", rid), { uid: uid() }); toast("Pronto. As tuas surpresas estão escondidas."); }
  catch (e) { fail(e); syncGiftSubs(); }
}
async function addMe() {
  try {
    await setDoc(doc(collection(db, "lists", S.cur, "recipients")), { name: myName(), key: norm(myName()), uid: uid(), createdAt: Date.now() });
    toast("Pronto. O que sugerirem para ti fica escondido.");
  } catch (e) { fail(e); }
}
function noGifts() { lsSet(askedKey(), "1"); renderList(); }
function openIdentity() {
  const mr = myRecipient();
  if (mr) { ask(`Estás como ${mr.name}`, "Para mudar isto, pede a quem criou a lista que te desligue em Pessoas.", "OK").then(() => {}); return; }
  try { localStorage.removeItem(askedKey()); } catch {}
  renderList();
}

/* ---------- Sugestões ---------- */
function fillRecipientInputs() {
  $("#recipientList").innerHTML = S.recipients.map(r => `<option value="${esc(r.name)}">`).join("");
  const l = curList(), taken = new Set(S.recipients.map(r => r.uid).filter(Boolean));
  $("#fLink").innerHTML = `<option value="">Não, ou ainda não</option>` + (l ? (l.memberIds || []).filter(m => !taken.has(m)).map(m =>
    `<option value="${esc(m)}">${esc(m === uid() ? myName() + " (eu)" : (l.names || {})[m] || "Sem nome")}</option>`).join("") : "");
}
function updateGiftHints() {
  const k = norm($("#fRecipient").value), r = recByKey(k);
  $("#linkField").classList.toggle("hidden", !k || !!r);
  const mr = myRecipient();
  $("#selfHint").classList.toggle("hidden", !((mr && mr.key === k) || (!r && $("#fLink").value === uid())));
}
function openGift(g) {
  S.editing = g ? { gid: g.id, rid: g.rid } : null;
  S.photo = { data: null, thumb: null, removed: false };
  fillRecipientInputs();
  $("#giftTitle").textContent = g ? "Editar sugestão" : "Nova sugestão";
  $("#saveGiftBtn").textContent = g ? "Guardar alterações" : "Adicionar";
  const fr = S.recipients.find(r => r.id === (g ? g.rid : S.filterR));
  $("#fRecipient").value = fr ? fr.name : "";
  $("#fName").value = g ? g.name || "" : "";
  $("#fPrice").value = g && g.price ? String(g.price).replace(".", ",") : "";
  $("#fStore").value = g ? g.store || "" : "";
  $("#fNote").value = g ? g.note || "" : "";
  $("#fPhoto").value = ""; $("#fLink").value = "";
  showPreview(g && g.hasPhoto ? safeImg(g.thumb) || "" : "");
  $("#giftErr").textContent = ""; updateGiftHints();
  $("#giftDlg").showModal();
}
function showPreview(src) { const p = $("#photoPreview"); p.classList.toggle("hidden", !src); if (src) p.querySelector("img").src = src; }

async function toJpeg(file, max, quality) {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas"); c.width = Math.round(bmp.width * k); c.height = Math.round(bmp.height * k);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  return c.toDataURL("image/jpeg", quality);
}
$("#fPhoto").addEventListener("change", async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    let data = await toJpeg(f, 1000, .75);
    if (data.length > 850000) data = await toJpeg(f, 700, .6);
    S.photo = { data, thumb: await toJpeg(f, 120, .7), removed: false };
    showPreview(S.photo.thumb);
  } catch { $("#giftErr").textContent = "Não foi possível ler esta imagem. Experimenta outra."; }
});

async function saveGift() {
  const recName = $("#fRecipient").value.trim().slice(0, 60);
  const price = parseMoney($("#fPrice").value), store = $("#fStore").value.trim().slice(0, 80);
  if (!recName) return $("#giftErr").textContent = "Indica para quem é o presente.";
  if (Number.isNaN(price)) return $("#giftErr").textContent = "O preço tem de ser um número, por exemplo 59,90.";
  const btn = $("#saveGiftBtn"); btn.disabled = true; $("#giftErr").textContent = "";
  try {
    // 1. Destinatário (cria-o se ainda não existir).
    let rec = recByKey(norm(recName));
    if (!rec) {
      const ref = doc(collection(db, "lists", S.cur, "recipients"));
      const linkUid = $("#fLink").value || null;
      await setDoc(ref, { name: recName, key: norm(recName), uid: linkUid, createdAt: Date.now() });
      rec = { id: ref.id, uid: linkUid };
    }
    const rid = rec.id;
    const base = { name: $("#fName").value.trim().slice(0, 120), price: price || 0, store, note: $("#fNote").value.trim().slice(0, 500) };
    const ph = S.photo.data ? { hasPhoto: true, thumb: S.photo.thumb } : S.photo.removed ? { hasPhoto: false, thumb: null } : {};
    const batch = writeBatch(db);

    if (S.editing) {
      const { gid, rid: oldRid } = S.editing;
      const old = (S.gifts[oldRid] || []).find(g => g.id === gid);
      if (!old) throw new Error("Sugestão não encontrada");
      if (oldRid === rid) {
        batch.update(giftRef(rid, gid), { ...base, ...ph });
        if (S.photo.data) batch.set(photoRef(rid, gid), { data: S.photo.data });
        else if (S.photo.removed && old.hasPhoto) batch.delete(photoRef(rid, gid));
      } else {
        // Mudou de destinatário: cria no novo sítio e apaga o antigo.
        const { id, rid: _r, ...rest } = old;
        batch.set(giftRef(rid, gid), { ...rest, ...base, ...ph });
        batch.delete(giftRef(oldRid, gid));
        if (S.photo.data) batch.set(photoRef(rid, gid), { data: S.photo.data });
        else if (old.hasPhoto && !S.photo.removed) {
          const p = await getDoc(photoRef(oldRid, gid));
          if (p.exists()) batch.set(photoRef(rid, gid), p.data());
        }
        if (old.hasPhoto) batch.delete(photoRef(oldRid, gid));
      }
    } else {
      const gid = doc(collection(db, "lists", S.cur, "recipients", rid, "gifts")).id;
      batch.set(giftRef(rid, gid), { ...base, hasPhoto: !!S.photo.data, thumb: S.photo.thumb || null, actual: null, done: false, createdBy: uid(), createdAt: Date.now(), boughtBy: null, voters: [] });
      if (S.photo.data) batch.set(photoRef(rid, gid), { data: S.photo.data });
    }
    const hiddenForMe = rec.uid === uid();
    $("#giftDlg").close();
    if (S.photo.data && S.editing) delete S.photos[S.editing.gid];
    await batch.commit();
    toast(hiddenForMe ? "Sugestão guardada e escondida de ti." : S.editing ? "Alterações guardadas." : "Sugestão adicionada.");
  } catch (e) { fail(e); }
  finally { btn.disabled = false; }
}

function findGift(el) {
  const card = el.closest("[data-gid]"); if (!card) return null;
  return (S.gifts[card.dataset.rid] || []).find(g => g.id === card.dataset.gid) || null;
}
function vote(g) {
  const mine = (g.voters || []).includes(uid());
  updateDoc(giftRef(g.rid, g.id), { voters: mine ? arrayRemove(uid()) : arrayUnion(uid()) }).catch(fail);
}
function openBuy(g) { S.buying = g; $("#fActual").value = g.price ? String(g.price).replace(".", ",") : ""; $("#buyErr").textContent = ""; $("#buyDlg").showModal(); }
function confirmBuy() {
  const v = parseMoney($("#fActual").value);
  if (v === null || Number.isNaN(v)) return $("#buyErr").textContent = "Indica o valor pago, por exemplo 35 ou 34,99.";
  const g = S.buying; $("#buyDlg").close();
  updateDoc(giftRef(g.rid, g.id), { done: true, actual: v, boughtBy: uid(), boughtAt: Date.now() }).then(() => toast("Marcado como comprado."), fail);
}
function reopen(g) { updateDoc(giftRef(g.rid, g.id), { done: false, actual: null, boughtBy: null }).catch(fail); }
let delT;
function del(g) {
  if (S.confirmDel !== g.id) { S.confirmDel = g.id; renderList(); clearTimeout(delT); delT = setTimeout(() => { S.confirmDel = null; renderList(); }, 4000); return; }
  S.confirmDel = null; clearTimeout(delT); S.open.delete(g.id);
  const b = writeBatch(db); b.delete(giftRef(g.rid, g.id)); if (g.hasPhoto) b.delete(photoRef(g.rid, g.id));
  b.commit().then(() => toast("Sugestão eliminada."), fail);
}

/* ---------- Listas: criar, mudar nome, sair, eliminar ---------- */
let listNameMode = "new";
function openListName(mode) {
  listNameMode = mode;
  const l = curList();
  $("#listNameTitle").textContent = mode === "new" ? "Nova lista" : "Mudar o nome da lista";
  $("#listNameSave").textContent = mode === "new" ? "Criar lista" : "Guardar";
  $("#fListName").value = mode === "new" ? "" : (l ? l.name : "");
  $("#listNameErr").textContent = "";
  $("#listNameDlg").showModal(); $("#fListName").focus();
}
async function saveListName() {
  const name = $("#fListName").value.trim().slice(0, 80);
  if (!name) return $("#listNameErr").textContent = "Dá um nome à lista.";
  $("#listNameDlg").close();
  try {
    if (listNameMode === "new") {
      const ref = doc(collection(db, "lists"));
      await setDoc(ref, { name, ownerUid: uid(), memberIds: [uid()], names: { [uid()]: myName() }, createdAt: Date.now(), inviteCode: null });
      goList(ref.id);
    } else {
      const l = curList();
      await updateDoc(doc(db, "lists", S.cur), { name });
      if (l && l.inviteCode) updateDoc(doc(db, "invites", l.inviteCode), { listName: name }).catch(() => {});
    }
  } catch (e) { fail(e); }
}
function openMenu() {
  const owner = isOwner();
  $("#menuItems").innerHTML = `
    <button class="btn" type="button" data-action="invite">Convidar pessoas</button>
    <button class="btn" type="button" data-action="people">Pessoas e destinatários</button>
    ${owner ? `<button class="btn" type="button" data-action="renameList">Mudar o nome da lista</button>` : ""}
    ${owner ? `<button class="btn danger" type="button" data-action="deleteList">Eliminar lista</button>` : `<button class="btn danger" type="button" data-action="leaveList">Sair da lista</button>`}`;
  $("#menuDlg").showModal();
}
async function leaveList() {
  $("#menuDlg").close();
  if (!await ask("Sair desta lista?", "Deixas de a ver. Para voltar, precisas de um convite novo.", "Sair", true)) return;
  const id = S.cur; goHome();
  updateDoc(doc(db, "lists", id), { memberIds: arrayRemove(uid()), ["names." + uid()]: deleteField() }).catch(fail);
}
async function deleteList() {
  $("#menuDlg").close();
  const l = curList(); if (!l) return;
  if (!await ask(`Eliminar ${l.name}?`, "A lista desaparece para toda a família. Não é possível desfazer.", "Eliminar", true)) return;
  goHome();
  try { if (l.inviteCode) await deleteDoc(doc(db, "invites", l.inviteCode)).catch(() => {}); await deleteDoc(doc(db, "lists", l.id)); toast("Lista eliminada."); }
  catch (e) { fail(e); }
}

/* ---------- Convites ---------- */
const inviteLink = code => location.origin + location.pathname + "#join=" + code;
async function makeInvite(replace) {
  const l = curList(); if (!l) return null;
  const code = randomCode();
  await setDoc(doc(db, "invites", code), { listId: l.id, listName: l.name, createdBy: uid(), createdAt: Date.now() });
  await updateDoc(doc(db, "lists", l.id), { inviteCode: code });
  if (replace && l.inviteCode) deleteDoc(doc(db, "invites", l.inviteCode)).catch(() => {});
  return code;
}
async function openInvite() {
  $("#menuDlg").close();
  const l = curList(); if (!l) return;
  $("#fInvite").value = "A criar o link…";
  $("#newInviteBtn").classList.toggle("hidden", !isOwner());
  $("#newInviteHint").classList.toggle("hidden", !isOwner());
  $("#shareInviteBtn").classList.toggle("hidden", !navigator.share);
  $("#inviteDlg").showModal();
  try { const code = l.inviteCode || await makeInvite(false); $("#fInvite").value = inviteLink(code); }
  catch (e) { $("#inviteDlg").close(); fail(e); }
}
async function newInvite() {
  if (!await ask("Criar um link novo?", "O link anterior deixa de funcionar. Quem já entrou na lista continua lá.", "Criar link novo")) return;
  try { $("#fInvite").value = inviteLink(await makeInvite(true)); toast("Link novo criado."); } catch (e) { fail(e); }
}
async function copyInvite() {
  const v = $("#fInvite").value;
  try { await navigator.clipboard.writeText(v); toast("Link copiado."); }
  catch { $("#fInvite").select(); toast("Seleciona o link e copia-o."); }
}
function shareInvite() {
  const l = curList();
  navigator.share({ title: "Presentes", text: `Junta-te à lista de presentes ${l ? l.name : ""}`, url: $("#fInvite").value }).catch(() => {});
}
let joining = null;
async function openJoin(code) {
  try {
    const s = await getDoc(doc(db, "invites", code));
    if (!s.exists()) return toast("Este convite já não é válido. Pede um link novo.");
    const inv = s.data();
    if (S.lists.some(l => l.id === inv.listId)) return goList(inv.listId);
    joining = { code, ...inv };
    $("#joinTitle").textContent = `Entrar na lista ${inv.listName}?`;
    $("#joinErr").textContent = "";
    $("#joinDlg").showModal();
  } catch (e) { fail(e); }
}
async function confirmJoin() {
  if (!joining) return;
  try {
    await updateDoc(doc(db, "lists", joining.listId), { memberIds: arrayUnion(uid()), ["names." + uid()]: myName(), joinCode: joining.code });
    $("#joinDlg").close(); goList(joining.listId); joining = null;
  } catch (e) { $("#joinErr").textContent = e.code === "permission-denied" ? "Este convite já não é válido. Pede um link novo." : "Não foi possível entrar. Tenta outra vez."; }
}

/* ---------- Pessoas ---------- */
function openPeople() {
  $("#menuDlg").close();
  renderPeople();
  $("#peopleDlg").showModal();
}
function renderPeople() {
  const l = curList(); if (!l) return;
  const owner = isOwner(), names = l.names || {};
  $("#memberRows").innerHTML = (l.memberIds || []).map(m => `<div class="row"><span>${esc(m === uid() ? myName() + " (eu)" : names[m] || "Sem nome")}<small>${m === l.ownerUid ? "Criou a lista" : "Membro"}</small></span>
    ${owner && m !== uid() ? `<button class="btn danger" type="button" data-action="removeMember" data-uid="${esc(m)}">Remover</button>` : ""}</div>`).join("");
  const taken = new Set(S.recipients.map(r => r.uid).filter(Boolean));
  const free = (l.memberIds || []).filter(m => !taken.has(m));
  const recs = [...S.recipients].sort((a, b) => a.name.localeCompare(b.name, "pt"));
  $("#recipientRows").innerHTML = recs.length ? recs.map(r => {
    let right = "";
    if (r.uid) right = owner ? `<button class="btn ghost" type="button" data-action="unlink" data-rid="${esc(r.id)}">Desligar</button>` : "";
    else right = `<select data-link="${esc(r.id)}"><option value="">Ligar a…</option>${free.map(m => `<option value="${esc(m)}">${esc(m === uid() ? "Eu" : names[m] || "Sem nome")}</option>`).join("")}</select>`;
    const sub = r.uid ? (r.uid === uid() ? "Ligado a ti" : "Ligado a " + (names[r.uid] || "um membro")) : "Sem conta ligada";
    return `<div class="row"><span>${esc(r.name)}<small>${esc(sub)}</small></span>${right}</div>`;
  }).join("") : `<div class="hint">Ainda não há destinatários. Aparecem quando alguém adiciona uma sugestão.</div>`;
}
async function removeMember(m) {
  const l = curList(); const n = (l.names || {})[m] || "esta pessoa";
  if (!await ask(`Remover ${n}?`, "Deixa de ver a lista. Os presentes que sugeriu ficam.", "Remover", true)) return;
  try {
    const b = writeBatch(db);
    b.update(doc(db, "lists", l.id), { memberIds: arrayRemove(m), ["names." + m]: deleteField() });
    S.recipients.filter(r => r.uid === m).forEach(r => b.update(doc(db, "lists", l.id, "recipients", r.id), { uid: null }));
    await b.commit(); renderPeople();
  } catch (e) { fail(e); }
}
async function linkRecipient(rid, m) {
  const r = S.recipients.find(x => x.id === rid), l = curList();
  const who = m === uid() ? "ti" : ((l.names || {})[m] || "essa pessoa");
  if (!await ask(`Ligar ${r.name} a ${who}?`, `As sugestões para ${r.name} ficam escondidas de ${who}. Só quem criou a lista pode desfazer.`, "Ligar")) { renderPeople(); return; }
  if (m === uid()) { const un = S.giftUnsubs.get(rid); if (un) { un(); S.giftUnsubs.delete(rid); delete S.gifts[rid]; } }
  updateDoc(doc(db, "lists", S.cur, "recipients", rid), { uid: m }).then(renderPeople, e => { fail(e); syncGiftSubs(); });
}
function unlink(rid) { updateDoc(doc(db, "lists", S.cur, "recipients", rid), { uid: null }).then(renderPeople, fail); }

/* ---------- Nome e conta ---------- */
function openName(required) {
  $("#fMyName").value = S.user && S.user.displayName || "";
  $("#nameErr").textContent = "";
  $("#nameCancel").classList.toggle("hidden", !!required);
  if (!$("#nameDlg").open) $("#nameDlg").showModal();
}
$("#nameDlg").addEventListener("cancel", e => { if (S.user && !S.user.displayName) e.preventDefault(); });
async function saveName() {
  const name = $("#fMyName").value.trim().slice(0, 40);
  if (!name) return $("#nameErr").textContent = "Escreve o teu nome.";
  try {
    await updateProfile(auth.currentUser, { displayName: name });
    S.user = auth.currentUser;
    $("#nameDlg").close();
    S.lists.forEach(l => { if ((l.names || {})[uid()] !== name) updateDoc(doc(db, "lists", l.id), { ["names." + uid()]: name }).catch(() => {}); });
    renderHome(); if (S.cur) renderList();
  } catch (e) { $("#nameErr").textContent = "Não foi possível guardar. Tenta outra vez."; }
}
function openAccount() {
  $("#accountTitle").textContent = myName();
  $("#accountEmail").textContent = S.user && S.user.email || "";
  $("#accountDlg").showModal();
}

/* ---------- Eventos ---------- */
document.addEventListener("click", e => {
  const open = e.target.closest("[data-open]"); if (open) return goList(open.dataset.open);
  const chip = e.target.closest("[data-rec]"); if (chip) { S.filterR = chip.dataset.rec; return renderList(); }
  const st = e.target.closest("[data-status]"); if (st) { S.filterS = st.dataset.status; return renderList(); }
  const b = e.target.closest("[data-action]"); if (!b) return;
  const g = findGift(b);
  switch (b.dataset.action) {
    case "google": google(); break;
    case "toggleSignup": toggleSignup(); break;
    case "resetPass": resetPass(); break;
    case "install": if (S.installEvt) { S.installEvt.prompt(); S.installEvt.userChoice.finally(() => { S.installEvt = null; renderHome(); }); } break;
    case "account": openAccount(); break;
    case "editName": $("#accountDlg").close(); openName(false); break;
    case "saveName": saveName(); break;
    case "signOut": $("#accountDlg").close(); location.hash = ""; signOut(auth); break;
    case "newList": openListName("new"); break;
    case "renameList": $("#menuDlg").close(); openListName("rename"); break;
    case "saveListName": saveListName(); break;
    case "home": goHome(); break;
    case "listMenu": openMenu(); break;
    case "leaveList": leaveList(); break;
    case "deleteList": deleteList(); break;
    case "invite": openInvite(); break;
    case "newInvite": newInvite(); break;
    case "copyInvite": copyInvite(); break;
    case "shareInvite": shareInvite(); break;
    case "confirmJoin": confirmJoin(); break;
    case "people": openPeople(); break;
    case "removeMember": removeMember(b.dataset.uid); break;
    case "unlink": unlink(b.dataset.rid); break;
    case "identity": openIdentity(); break;
    case "iam": linkMe(b.dataset.rid); break;
    case "addMe": addMe(); break;
    case "noGifts": noGifts(); break;
    case "newGift": openGift(null); break;
    case "edit": if (g) openGift(g); break;
    case "vote": if (g) vote(g); break;
    case "buy": if (g) openBuy(g); break;
    case "reopen": if (g) reopen(g); break;
    case "del": if (g) del(g); break;
    case "saveGift": saveGift(); break;
    case "confirmBuy": confirmBuy(); break;
    case "removePhoto": S.photo = { data: null, thumb: null, removed: true }; $("#fPhoto").value = ""; showPreview(""); break;
    case "confirmYes": answer(true); break;
    case "confirmNo": answer(false); break;
    case "close": b.closest("dialog").close(); break;
  }
});
document.addEventListener("change", e => { const s = e.target.closest("[data-link]"); if (s && s.value) linkRecipient(s.dataset.link, s.value); });
$("#gifts").addEventListener("toggle", e => {
  const d = e.target; if (!d.matches || !d.matches("details[data-gid]")) return;
  if (d.open) { S.open.add(d.dataset.gid); const g = findGift(d); if (g) loadPhoto(g); } else S.open.delete(d.dataset.gid);
}, true);
$("#fRecipient").addEventListener("input", updateGiftHints);
$("#fLink").addEventListener("change", updateGiftHints);
$("#fActual").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); confirmBuy(); } });
$("#fListName").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveListName(); } });
$("#fMyName").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); saveName(); } });

route();
