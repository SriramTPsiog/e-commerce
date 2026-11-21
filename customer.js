const $ = id => document.getElementById(id);
const products = new Map();
const catalogIds = new Set();
const categories = new Map();
const pageSize = 12;
const money = new Intl.NumberFormat("en-IN", {
  style: "currency", currency: "INR", minimumFractionDigits: 0, maximumFractionDigits: 2
});
const priceOK = p => Number.isSafeInteger(p?.pricePaise) && p.pricePaise >= 0;
const available = p => priceOK(p) && Number.isSafeInteger(p.qty) && p.qty > 0;
const price = p => priceOK(p) ? money.format(p.pricePaise / 100) : "Price unavailable";
const categoryName = p => categories.get(p.categoryId) || p.categoryId || "Uncategorized";
let shop, cursor, pendingBatch, done = false, page = 0, revision = 0;
let bagItems = [], changingBag = false, noticeTimer;
let applied, selectedDetail, visibleIds = [], watcherKey = "", stopWatching;
let checkoutBusy = false, bagReady = false, credit, creditMessage = "", quotedTotal = null;
let stockUpdates = new Map(), syncingStock = false;
let pendingKey, orderLoad = 0;
const asMoney = paise => money.format(paise / 100);

function element(tag, className, text) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (text != null) item.textContent = text;
  return item;
}
function button(text, handler, className = "action") {
  const b = element("button", className, text);
  b.type = "button";
  b.addEventListener("click", handler);
  return b;
}
function friendly(error, context) {
  if (error?.code === "permission-denied") return context + " Firestore denied this account access.";
  if (error?.code === "unavailable") return context + " Check your connection and try again.";
  return context + (error?.message ? " " + error.message : "");
}
function notify(message) {
  clearTimeout(noticeTimer);
  const open = document.querySelector("dialog[open]");
  const output = open?.querySelector(".dialog-note") || $("announcement");
  output.textContent = message;
  noticeTimer = setTimeout(() => { output.textContent = ""; }, 5200);
}
function picture(p) {
  const src = p.imageUrl;
  const fallback = element("span", "feedback", "Image unavailable");
  if (typeof src !== "string" || !/^(data:image\/(webp|png|jpe?g|gif|avif);base64,|https?:\/\/|\.\/assets\/)/i.test(src)) return fallback;
  const image = document.createElement("img");
  image.alt = p.title || p.id;
  image.loading = "lazy";
  image.addEventListener("error", () => image.replaceWith(fallback), {once:true});
  image.src = src;
  return image;
}
function stock(p) {
  return Number.isSafeInteger(p.qty) && p.qty > 0 ? p.qty + " in stock" : "Out of stock";
}
function addButton(p) {
  const control = element("div","bag-control");
  control.dataset.product = p.id;
  paintControl(control,p);
  return control;
}
function paintControl(control,p) {
  const qty = bagItems.find(i => i.productId === p.id)?.qty || 0;
  const locked = changingBag || checkoutBusy || !!pending();
  if (!qty) {
    const add = button(available(p) ? "Add to bag" : "Unavailable",() => changeBag(p.id,1));
    add.disabled = locked || !available(p);
    control.replaceChildren(add);
    return;
  }
  const stepper = element("div","stepper");
  const minus = button("−",() => changeBag(p.id,-1),"");
  const plus = button("+",() => changeBag(p.id,1),"");
  minus.setAttribute("aria-label","Decrease " + (p.title || p.id));
  plus.setAttribute("aria-label","Increase " + (p.title || p.id));
  minus.disabled = locked;
  plus.disabled = locked || !available(p) || qty >= p.qty;
  stepper.append(minus,element("span","",Math.min(qty,Math.max(0,p.qty || 0))+" in bag"),plus);
  control.replaceChildren(stepper);
}
function updateControls() {
  for (const node of document.querySelectorAll(".bag-control")) {
    const p = products.get(node.dataset.product);
    if (p) paintControl(node,p);
  }
}
function card(p) {
  const article = element("article", "card");
  const visual = button("", () => showProduct(p), "visual");
  visual.setAttribute("aria-label", "View " + (p.title || p.id));
  visual.append(picture(p));
  const info = element("div", "card-info");
  const title = element("h3");
  title.append(button(p.title || p.id, () => showProduct(p), "product-title"));
  const row = element("div", "price-row");
  row.append(element("span","price",price(p)), element("span", p.qty > 0 ? "stock" : "stock sold", stock(p)));
  info.append(element("p","category-name",categoryName(p)),title,row,addButton(p));
  article.append(visual,info);
  return article;
}
function showProduct(p) {
  selectedDetail = p.id;
  const title = element("h3", "", p.title || p.id);
  title.id = "detail-title";
  const art = element("div","detail-image");
  art.append(picture(p));
  const note = element("p","dialog-note"); note.setAttribute("role","status");
  $("detail-body").replaceChildren(art,element("p","category-name",categoryName(p) + " · " + p.id),title,
    element("p","",p.description || ""),element("strong","price",price(p)),element("p","stock",stock(p)),addButton(p),note);
  if (!$("detail").open) $("detail").showModal();
}

function nextBatch() {
  if (!pendingBatch) {
    pendingBatch = shop.products(cursor).then(batch => {
      for (const p of batch.items) { catalogIds.add(p.id); products.set(p.id,p); }
      cursor = batch.cursor;
      done = batch.done;
    }).finally(() => { pendingBatch = null; });
  }
  return pendingBatch;
}
function filters() {
  return {term:$("search").value.trim().toLowerCase(), category:$("category").value,
    sort:$("sort").value, stock:$("in-stock").checked};
}
function isFiltered(f) { return Boolean(f.term || f.category || f.stock || f.sort !== "catalog"); }
function matches(f) {
  const result = Array.from(catalogIds,id => products.get(id)).filter(p =>
    p.active !== false && (!f.category || p.categoryId === f.category) && (!f.stock || p.qty > 0) &&
    (!f.term || [p.title,p.id,categoryName(p)].some(s => String(s || "").toLowerCase().includes(f.term))));
  if (f.sort === "low" || f.sort === "high") result.sort((a,b) =>
    Number(priceOK(b))-Number(priceOK(a)) || (priceOK(a) && priceOK(b) ?
      (a.pricePaise-b.pricePaise) * (f.sort === "low" ? 1 : -1) : 0));
  const name = p => String(p.title || p.id);
  if (["name","reverse-name"].includes(f.sort)) result.sort((a,b) =>
    name(a).localeCompare(name(b),"en-IN") * (f.sort === "name" ? 1 : -1));
  if (["stock-high","stock-low"].includes(f.sort)) result.sort((a,b) =>
    ((a.qty || 0)-(b.qty || 0)) * (f.sort === "stock-low" ? 1 : -1));
  if (f.sort === "category-name") result.sort((a,b) =>
    categoryName(a).localeCompare(categoryName(b),"en-IN") || name(a).localeCompare(name(b),"en-IN"));
  if (f.sort === "catalog") result.sort((a,b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return result;
}
function draw(f) {
  const result = matches(f);
  if (done) page = Math.min(page,Math.max(0,Math.ceil(result.length/pageSize)-1));
  const start = page * pageSize;
  const slice = result.slice(start,start + pageSize);
  visibleIds = slice.map(p => p.id);
  $("products").replaceChildren(...slice.map(card));
  watch();
  $("status").textContent = slice.length ?
    `Showing ${start + 1}–${start + slice.length}${done ? " of " + result.length : ""} products` :
    isFiltered(f) ? "No products match these filters." : "There are no active products in the catalog yet.";
  $("clear").hidden = !isFiltered(f);
  $("pages").hidden = !page && done && result.length <= pageSize;
  $("prev").disabled = page === 0;
  $("next").disabled = done && start + pageSize >= result.length;
  $("page-label").textContent = "Page " + (page+1);
}
async function refresh(reset = true) {
  if (!shop) return;
  const ticket = ++revision;
  if (reset) page = 0;
  $("problem").hidden = $("retry").hidden = true;
  const f = applied;
  $("prev").disabled = $("next").disabled = true;
  $("status").textContent = isFiltered(f) && !done ? "Checking the full catalog…" : "Loading products…";
  try {
    while (!done && (isFiltered(f) || matches(f).length < (page + 1) * pageSize)) {
      await nextBatch();
      if (ticket !== revision) return;
    }
    if (done) page = Math.min(page,Math.max(0,Math.ceil(matches(f).length / pageSize)-1));
    draw(f);
  } catch (error) {
    if (ticket !== revision) return;
    $("status").textContent = "";
    $("problem").textContent = friendly(error,"Couldn’t load the catalog.");
    $("problem").hidden = $("retry").hidden = false;
  }
}
function pending() {
  return pendingKey ? JSON.parse(localStorage.getItem(pendingKey) || "null") : null;
}
function setBag(items) {
  bagItems = items;
  $("bag-count").textContent = String(items.reduce((sum,line) => sum + line.qty,0));
  updateControls();
  watch();
}
function watch() {
  if (!shop) return;
  const ids = [...new Set([...visibleIds,...bagItems.map(i => i.productId)])].sort();
  const key = JSON.stringify(ids);
  if (key === watcherKey) return;
  stopWatching?.();
  watcherKey = key;
  stopWatching = shop.watchProducts(ids, updates => {
    if (key !== watcherKey) return;
    for (const [id,p] of updates) stockUpdates.set(id,p);
    flushStock();
  }, () => {
    if (key === watcherKey) notify("Live stock updates paused. Stock will be checked again at checkout.");
  });
}
function changedProduct(id,p) {
  const old = products.get(id);
  if (!p) {
    if (!old || old.active === false) return false;
    products.set(id,{...old,active:false,qty:0});
  } else {
    if (old && ["qty","active","pricePaise","title","categoryId","description","imageUrl"].every(k=>old[k]===p[k])) return false;
    products.set(id,p);
  }
  return true;
}
async function applyStock(updates) {
  let dirty = false;
  for (const [id,p] of updates) if (changedProduct(id,p)) dirty = true;
  const over = bagItems.some(i => updates.has(i.productId) &&
    i.qty > (available(updates.get(i.productId)) ? updates.get(i.productId).qty : 0));
  if (over && !pending()) {
    setBag(await shop.bag.cap(updates));
    notify("Stock changed. Your bag now shows the available quantities.");
  }
  if (dirty && applied) {
    draw(applied);
    if ($("detail").open && products.has(selectedDetail)) showProduct(products.get(selectedDetail));
  }
  if ($("bag").open) renderBag();
}
async function flushStock() {
  if (syncingStock || changingBag || checkoutBusy) return;
  syncingStock = true;
  try {
    while (stockUpdates.size && !changingBag && !checkoutBusy) {
      const batch = stockUpdates;
      stockUpdates = new Map();
      await applyStock(batch);
    }
  } catch (error) { notify(friendly(error,"Couldn’t refresh stock.")); }
  finally { syncingStock = false; }
}
async function changeBag(id,delta) {
  if (changingBag || checkoutBusy || pending()) return;
  changingBag = true;
  updateControls();
  try {
    setBag(await shop.bag.change(id,delta));
    if ($("bag").open) renderBag();
  } catch (error) {
    notify(friendly(error,"Couldn’t update your bag."));
    try { await applyStock(await shop.findProducts([id])); } catch { /* Next checkout rechecks stock. */ }
  } finally {
    changingBag = false;
    updateControls();
    if ($("bag").open) renderBag();
    flushStock();
  }
}
function renderBag() {
  let total = 0, valid = bagItems.length > 0;
  const rows = bagItems.map(({productId,qty}) => {
    const p = products.get(productId);
    const row = element("div","bag-line");
    row.append(element("h3","",p?.title || productId));
    if (p) row.append(addButton(p));
    const lineTotal = priceOK(p) ? p.pricePaise * qty : null;
    if (!available(p) || qty > p.qty || !Number.isSafeInteger(lineTotal)) valid = false;
    else total += lineTotal;
    row.append(element("p","feedback",p ? price(p) + " each" : "Product unavailable"));
    return row;
  });
  $("bag-lines").replaceChildren(...(rows.length ? rows : [element("p","","Your bag is empty.")]));
  quotedTotal = valid && Number.isSafeInteger(total) ? total : null;
  $("subtotal").textContent = !rows.length ? "" : quotedTotal === null ? "Review quantities before checkout" : "Subtotal " + asMoney(total);
  const saved = pending();
  const creditOK = credit && quotedTotal !== null && quotedTotal <= credit.available;
  $("checkout-form").hidden = !saved && (!rows.length || !bagReady);
  $("payment-options").disabled = Boolean(saved) || checkoutBusy;
  $("pay-credit").disabled = !creditOK;
  if (saved) $("checkout-form").elements.method.value = saved.paymentMethod;
  const creditSelected = $("checkout-form").elements.method.value === "credit";
  $("credit-balance").textContent = creditMessage + (bagReady && !saved && creditSelected && !creditOK ?
    " Choose cash or reduce your bag to continue." : "");
  $("place-order").textContent = checkoutBusy ? "Placing order…" : saved ? "Retry this checkout" : "Place order";
  $("place-order").disabled = checkoutBusy || changingBag || (!saved && (!bagReady || quotedTotal === null || (creditSelected && !creditOK)));
}
async function loadCredit() {
  credit = null;
  try {
    credit = await shop.credit();
    creditMessage = credit ? "Available " + asMoney(credit.available) + " · Used " + asMoney(credit.used) +
      " of " + asMoney(credit.limit) : "Store credit has not been set up for this account.";
  } catch (error) { creditMessage = friendly(error,"Couldn’t load store credit."); }
  if ($("bag").open) renderBag();
}
async function loadBag() {
  bagReady = false;
  setBag(await shop.bag.read());
  await applyStock(await shop.findProducts(bagItems.map(i => i.productId)));
  bagReady = true;
  renderBag();
}
async function openBag() {
  $("bag-source").textContent = shop.bag.label;
  $("bag-lines").textContent = "Loading items…";
  $("subtotal").textContent = "";
  $("checkout-form").hidden = true;
  if (!pending()) $("checkout-form").elements.method.value = "cash";
  $("checkout-status").textContent = pending() ? "A previous checkout needs confirmation. Retry it to retrieve the result." : "";
  $("bag").showModal();
  credit = null;
  creditMessage = "Loading store credit…";
  bagReady = false;
  loadCredit();
  try { await loadBag(); }
  catch (error) {
    renderBag();
    $("bag-lines").textContent = friendly(error,"Couldn’t refresh your bag.");
  }
}
function sameItems(a,b) {
  const quantities = new Map(a.map(i=>[i.productId,i.qty]));
  return a.length === b.length && b.every(i=>quantities.get(i.productId) === i.qty);
}
async function placeOrder(event) {
  event.preventDefault();
  if (checkoutBusy || changingBag || $("place-order").disabled) return;
  const reviewed = bagItems.map(i=>({...i}));
  const amount = quotedTotal;
  const method = $("checkout-form").elements.method.value;
  const retry = pending();
  checkoutBusy = true;
  $("checkout-status").textContent = "Confirming your order…";
  renderBag();
  updateControls();
  async function submit() {
    let attempt = pending() || retry;
    if (!attempt) {
      if (!sameItems(await shop.bag.read(),reviewed) || !reviewed.length || amount === null) {
        $("checkout-status").textContent = "Your bag changed. Review it before placing the order.";
        return;
      }
      attempt = {checkoutId:crypto.randomUUID(),items:reviewed,expectedTotalPaise:amount,paymentMethod:method,cartId:await shop.bag.cartId()};
      localStorage.setItem(pendingKey,JSON.stringify(attempt));
    }
    let receipt;
    try { receipt = await shop.purchase(attempt); }
    catch (error) {
      const code = (error.code || "").replace(/^functions\//,"");
      if (["invalid-argument","out-of-range","failed-precondition","permission-denied","unauthenticated"].includes(code)) {
        localStorage.removeItem(pendingKey);
        $("checkout-status").textContent = error.message;
      } else if (code === "not-found") {
        $("checkout-status").textContent = "The checkout service is unavailable. Retry once it is back online.";
      } else {
        $("checkout-status").textContent = "Order confirmation is pending. Retry this checkout to check the same order.";
      }
      return;
    }
    await shop.bag.finish(receipt.orderId,attempt.items);
    localStorage.removeItem(pendingKey);
    $("checkout-status").textContent = "Order placed · " + asMoney(receipt.totalPaise) + ". You can view the receipt in My orders.";
  }
  try {
    if (navigator.locks) await navigator.locks.request(pendingKey,submit);
    else await submit();
  } catch (error) { $("checkout-status").textContent = friendly(error,"Couldn’t confirm checkout."); }
  finally {
    checkoutBusy = false;
    try { await loadBag(); } catch (error) { notify(friendly(error,"Couldn’t refresh your bag.")); }
    await loadCredit();
    renderBag();
    updateControls();
    flushStock();
  }
}

function orderRow(order) {
  const item = element("details","order-entry");
  const timestamp = (order.createdAt || order.placedAt)?.toDate?.();
  const date = timestamp ? timestamp.toLocaleDateString("en-IN",{day:"numeric",month:"short",year:"numeric"}) : "Date unavailable";
  const total = Number.isSafeInteger(order.totalPaise) ? asMoney(order.totalPaise) : "Total unavailable";
  item.append(element("summary","",date + " · " + total + " · " + (order.status || "Order")));
  item.append(element("p","","Order " + order.id),element("p","", [order.paymentMethod,order.paymentStatus].filter(Boolean).join(" · ").replaceAll("_"," ")));
  const list = element("ul");
  for (const line of order.items || []) {
    const amount = Number.isSafeInteger(line.lineTotalPaise) ? " · " + asMoney(line.lineTotalPaise) : "";
    list.append(element("li","",(line.title || line.productId) + " × " + line.qty + amount));
  }
  item.append(list);
  return item;
}
async function loadOrders() {
  const ticket = ++orderLoad;
  $("order-list").textContent = "Loading your orders…";
  try {
    const orders = await shop.orders();
    if (ticket !== orderLoad) return;
    $("order-list").replaceChildren(...(orders.length ? orders.map(orderRow) : [element("p","feedback","You haven’t placed an order yet.")]));
  } catch (error) { if (ticket === orderLoad) $("order-list").textContent = friendly(error,"Couldn’t load your orders."); }
}
for (const b of document.querySelectorAll("[data-close]")) b.onclick = () => b.closest("dialog").close();
const bagNote = element("p","dialog-note"); bagNote.setAttribute("role","status"); $("bag").append(bagNote);
$("bag-open").onclick = openBag;
$("orders-open").onclick = () => { $("orders").showModal(); loadOrders(); };
$("reload-orders").onclick = loadOrders;
$("checkout-form").onsubmit = placeOrder;
$("payment-options").onchange = renderBag;
$("retry").onclick = () => location.reload();
$("filters").onsubmit = event => { event.preventDefault(); applied = filters(); refresh(); };
$("clear").onclick = () => { $("filters").reset(); applied = filters(); refresh(); };
$("prev").onclick = () => { page = Math.max(0,page-1); refresh(false); };
$("next").onclick = () => { page++; refresh(false); };
window.addEventListener("storage", async event => {
  if (!shop || ![pendingKey,"buyit.bag."+shop.uid].includes(event.key)) return;
  try {
    setBag(await shop.bag.read());
    if ($("bag").open && !checkoutBusy) await loadBag();
  } catch (error) { notify(friendly(error,"Couldn’t refresh your bag.")); }
});

async function start() {
  try {
    const {openShop} = await import("./shop-data.js");
    shop = await openShop();
    if (!shop) return;
    $("account-name").textContent = shop.name;
    $("sign-out").hidden = false;
    $("sign-out").onclick = () => Promise.resolve(shop.signOut()).catch(() => notify("Sign-out failed. Try again."));
    pendingKey = "buyit.checkout." + shop.uid;
    $("bag-open").disabled = $("orders-open").disabled = false;
    try { setBag(await shop.bag.read()); } catch { $("bag-count").textContent = "–"; }
    const all = await shop.categories();
    all.sort((a,b) => String(a.name || a.id).localeCompare(String(b.name || b.id)));
    for (const c of all) {
      categories.set(c.id,c.name || c.id);
      $("category").add(new Option(c.name || c.id,c.id));
    }
    for (const id of ["search","category","sort","in-stock","apply"]) $(id).disabled = false;
    applied = filters();
    await refresh();
  } catch (error) {
    $("status").textContent = "";
    $("problem").textContent = friendly(error,"Couldn’t open the shop.");
    $("problem").append(" ",Object.assign(element("a","","Return to sign in"),{href:"./index.html"}));
    $("problem").hidden = $("retry").hidden = false;
  }
}
start();
