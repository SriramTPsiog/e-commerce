import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  collection, doc, getDocsFromServer, getDocFromServer, getFirestore,
  runTransaction, setDoc
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app), db = getFirestore(app);
const $ = id => document.getElementById(id);
const store = {};
const rupees = new Intl.NumberFormat("en-IN", { style:"currency", currency:"INR" });
const whole = new Intl.NumberFormat("en-IN");
const dateText = new Intl.DateTimeFormat("en-IN", { dateStyle:"medium", timeZone:"Asia/Kolkata" });
const dayKey = new Intl.DateTimeFormat("en-CA", { year:"numeric",month:"2-digit",day:"2-digit",timeZone:"Asia/Kolkata" });
const screens = {
  Overview:["orders","products","categories","customers","users","creditAccounts","shopSettings"],
  Products:["products","categories","shopSettings"],
  Orders:["orders"],
  Customers:["customers","users","creditAccounts"],
  Reports:["orders","products","categories","customers","users","creditAccounts","shopSettings"],
  Settings:["shopSettings","categories"]
};
let view = "Overview", activeAdmin, request = 0, applyEditor;
let productPage = 0;
const productFilter = { term:"", category:"", stock:"" };
const orderFilter = { term:"", status:"", method:"" };
const reportFilter = { from:"", to:"", method:"" };

function element(tag, text, className) {
  const node = document.createElement(tag);
  if (text !== undefined) node.textContent = text;
  if (className) node.className = className;
  return node;
}
function button(label, action, quiet = false) {
  const node = element("button", label, quiet ? "quiet" : "");
  node.type = "button";
  node.onclick = action;
  return node;
}
function group(className, ...children) {
  const node = element("div", undefined, className);
  node.append(...children);
  return node;
}
function panel(title, ...children) {
  const node = element("section", undefined, "panel");
  node.append(element("h2",title),...children);
  return node;
}
function table(headers, rows) {
  if (!rows.length) return element("p","No records match.", "muted");
  const grid = element("table");
  const head = grid.createTHead().insertRow();
  headers.forEach(name => head.append(element("th",name)));
  const body = grid.createTBody();
  rows.forEach(row => {
    const tr = body.insertRow();
    row.forEach(value => {
      const td = tr.insertCell();
      if (value instanceof Node) td.append(value);
      else td.textContent = value ?? "—";
    });
  });
  return group("table-wrap",grid);
}
function label(name, input, wide = false) {
  const node = element("label", undefined, wide ? "wide" : "");
  node.append(element("span",name),input);
  return node;
}
function input(type, name, value = "") {
  const node = element("input");
  node.type = type; node.name = name; node.value = value;
  return node;
}
function select(name, pairs, value) {
  const node = element("select");
  node.name = name;
  node.append(...pairs.map(([id,text]) => new Option(text,id)));
  node.value = value;
  return node;
}
function search(placeholder, value, changed) {
  const field = input("search","search",value);
  field.placeholder = placeholder;
  field.setAttribute("aria-label",placeholder);
  field.oninput = () => changed(field.value);
  return field;
}
function filterSelect(name, pairs, value, changed) {
  const field = select(name,pairs,value);
  field.setAttribute("aria-label",name);
  field.onchange = () => changed(field.value);
  return field;
}
function notice(text = "", error = false, id = "notice") {
  const target = $(id);
  target.textContent = text; target.toggleAttribute("data-error",error);
}
function list(name) { return [...(store[name]?.values() || [])]; }
function row(name,id) { return store[name]?.get(id); }
function cash(paise) { return rupees.format((Number(paise) || 0) / 100); }
function status(value) { return value ? String(value).replaceAll("_"," ") : "—"; }
function displayDate(order) { return orderDate(order) ? dateText.format(orderDate(order)) : "—"; }
function orderDate(order) { return (order.createdAt || order.placedAt)?.toDate?.(); }
function orderSort(a,b) { return (orderDate(b)?.getTime() || 0) - (orderDate(a)?.getTime() || 0); }
function category(id) { return row("categories",id)?.name || id || "Uncategorized"; }
function categoryOptions() { return list("categories").sort((a,b) => a.name.localeCompare(b.name)).map(c => [c.id,c.name]); }
function settings() { return row("shopSettings","qa-commerce-v1") || {}; }
function contains(text,...values) { return values.join(" ").toLowerCase().includes(text.trim().toLowerCase()); }
function productPhoto(source, className = "") {
  const img = element("img",undefined,className);
  img.alt = ""; img.loading = "lazy";
  if (/^https?:\/\//i.test(source || "") || /^data:image\/(?:png|jpeg|webp|gif);base64,/i.test(source || "")) {
    img.src = source;
    img.onerror = () => { img.removeAttribute("src"); };
  }
  return img;
}
function labelled(primary,secondary) {
  const node = element("div",primary);
  if (secondary) node.append(element("small",secondary));
  return node;
}
function metric(name,value) { return group("card",element("span",name),element("strong",value)); }
function stockLabel(qty) {
  if (qty === 0) return "Out of stock";
  if (qty < (settings().lowStockBelow ?? 15)) return "Low stock";
  if (qty > (settings().highStockAbove ?? 100)) return "High stock";
  return "In range";
}
function localUpdate(name,id,fields) {
  store[name] ||= new Map();
  store[name].set(id,{...row(name,id),...fields,id});
}
async function openView(name, refresh = false) {
  view = name;
  const version = ++request;
  $("view-title").textContent = name;
  $("content").replaceChildren();
  document.querySelectorAll("[data-view]").forEach(entry => {
    if (entry.dataset.view === name) entry.setAttribute("aria-current","page");
    else entry.removeAttribute("aria-current");
  });
  notice("Loading " + name.toLowerCase() + "…");
  try {
    await Promise.all(screens[name].filter(key => refresh || !store[key]).map(async key => {
      const snapshots = await getDocsFromServer(collection(db,key));
      store[key] = new Map(snapshots.docs.map(item => [item.id,{...item.data(),id:item.id}]));
    }));
    if (version !== request || !activeAdmin) return;
    notice();
    render();
  } catch (error) {
    if (version !== request) return;
    notice(error.code === "permission-denied" ?
      "Firestore denied access. Apply the BuyIt admin rules to this Firebase project." :
      "Could not load " + name.toLowerCase() + ". " + error.message,true);
    $("content").append(button("Try again",() => openView(name,true),true));
  }
}
function render() {
  const refresh = button("Refresh data",() => openView(view,true),true);
  $("content").replaceChildren(group("tools",refresh),renderers[view]());
}

function showEditor(title,fields,save) {
  $("editor-title").textContent = title;
  $("fields").replaceChildren(fields);
  $("save").hidden = !save;
  notice("",false,"editor-status");
  applyEditor = save;
  $("editor").showModal();
}
$("close-editor").onclick = () => $("editor").close();
$("editor-form").onsubmit = async event => {
  event.preventDefault();
  if (!applyEditor) return;
  $("save").disabled = $("close-editor").disabled = true;
  notice("Saving…",false,"editor-status");
  try {
    await applyEditor(new FormData(event.currentTarget));
    $("editor").close();
    render();
    notice("Saved.");
  } catch (error) {
    notice(error.code === "permission-denied" ? "Write refused by Firestore rules." : error.message,true,"editor-status");
  } finally { $("save").disabled = $("close-editor").disabled = false; }
};
$("editor").addEventListener("cancel",event => { if ($("save").disabled) event.preventDefault(); });
function text(data,key) { return String(data.get(key) || "").trim(); }
function integer(data,key) {
  const value = text(data,key);
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw Error("Enter a non-negative whole number.");
  return Number(value);
}
function paise(data,key) {
  const value = text(data,key);
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) throw Error("Enter a rupee amount with up to two decimal places.");
  const [major,minor = ""] = value.split(".");
  const total = Number(major) * 100 + Number(minor.padEnd(2,"0"));
  if (!Number.isSafeInteger(total)) throw Error("Amount is too large.");
  return total;
}
function docId(value) {
  if (!/^[\w-]{1,120}$/.test(value) || /^__.*__$/.test(value)) throw Error("Use a record ID of up to 120 letters, numbers, underscores or dashes.");
  return value;
}
function number(name,value,step = "1") {
  const field = input("number",name,value);
  field.min="0"; field.step=step; field.required=true;
  return field;
}
function required(name,value) {
  const field = input("text",name,value); field.required=true;
  return field;
}
async function compress(file) {
  if (!file || !["image/jpeg","image/png","image/webp","image/gif","image/avif"].includes(file.type)) throw Error("Choose a JPG, PNG, WebP, GIF or AVIF image.");
  if (file.size > 12*1024*1024) throw Error("Choose an image under 12 MB.");
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement("canvas");
  let scale = Math.min(1,800 / Math.max(bitmap.width,bitmap.height));
  try {
    for (let attempt=0; attempt<5; attempt++) {
      canvas.width = Math.max(1,Math.round(bitmap.width*scale));
      canvas.height = Math.max(1,Math.round(bitmap.height*scale));
      canvas.getContext("2d").drawImage(bitmap,0,0,canvas.width,canvas.height);
      const data = canvas.toDataURL("image/webp",.78);
      if (data.length <= 500000) return data;
      scale *= .68;
    }
  } finally { bitmap.close(); }
  throw Error("Could not fit this image in Firestore. Try a smaller image.");
}
function productEditor(product, imageOnly = false) {
  const idField = required("id",product?.id || ""); idField.readOnly = !!product;
  const title = required("title",product?.title || ""); title.maxLength = 160;
  const desc = element("textarea"); desc.name="description"; desc.rows=3; desc.maxLength=3000;
  desc.value = product?.description || "";
  const categoryField = select("categoryId", [["","Select a category"],...categoryOptions()],product?.categoryId || "");
  categoryField.required=true;
  const active = input("checkbox","active","yes"); active.checked=product?.active ?? true;
  const image = input("url","imageUrl", /^https?:/i.test(product?.imageUrl || "") ? product.imageUrl : "");
  const file = input("file","imageFile"); file.accept="image/png,image/jpeg,image/webp,image/gif,image/avif";
  const preview = productPhoto(product?.imageUrl,"photo");
  const remove = input("checkbox","removeImage","yes");
  image.oninput = () => { preview.src = image.value; file.value = ""; };
  file.onchange = async () => {
    const selected = file.files[0];
    if (!selected) return;
    try { const picked = await compress(selected); if (file.files[0] === selected) preview.src = picked; }
    catch(error) { if (file.files[0] === selected) { file.value = ""; notice(error.message,true,"editor-status"); } }
  };
  const imageFields = [preview,label("Image URL",image,true),label("Upload replacement image",file,true),label("Remove current image",remove)];
  const mainFields = [label("Product ID",idField),label("Title",title),label("Category",categoryField),
    label("Price in ₹",number("price",product ? product.pricePaise/100 : "",".01")),
    label("Available quantity",number("stock",product?.qty ?? 0)),label("Active in shop",active),label("Description",desc,true)];
  const fields = group("field-grid",...(imageOnly ? [] : mainFields),...imageFields);
  showEditor(imageOnly ? "Replace product image" : product ? "Edit product" : "Add product",fields,async data => {
    const id = product?.id || docId(text(data,"id"));
    const uploaded = data.get("imageFile");
    const typedUrl = text(data,"imageUrl");
    if (typedUrl && !/^https?:\/\//i.test(typedUrl)) throw Error("Image URL must start with https:// or http://.");
    const fields = {};
    if (uploaded?.size) fields.imageUrl = await compress(uploaded);
    else if (data.get("removeImage")) fields.imageUrl = "";
    else if (typedUrl) fields.imageUrl = typedUrl;
    if (!imageOnly) Object.assign(fields,{ title:text(data,"title"),description:text(data,"description"),
      categoryId:text(data,"categoryId"),pricePaise:paise(data,"price"),qty:integer(data,"stock"),active:data.has("active") });
    if (!imageOnly && (!fields.title || !row("categories",fields.categoryId))) throw Error("Enter a title and a valid category.");
    if (product) {
      for (const key of Object.keys(fields)) if (fields[key] === product[key]) delete fields[key];
    }
    if (!Object.keys(fields).length) return;
    const ref = doc(db,"products",id);
    await runTransaction(db,async tx => {
      const snapshot = await tx.get(ref);
      if (!product && snapshot.exists()) throw Error("This product ID already exists.");
      if (product && (!snapshot.exists() || Object.keys(fields).some(key => snapshot.get(key) !== product[key]))) {
        throw Error("This product changed while you were editing. Refresh Products and reopen it.");
      }
      if (product) tx.update(ref,fields);
      else tx.set(ref,{imageUrl:"",...fields});
    });
    localUpdate("products",id,fields);
  });
}
function productsView() {
  const lines = group("product-list");
  function paint() {
    const rows = list("products").sort((a,b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id)).filter(p =>
      contains(productFilter.term,p.title,p.id) && (!productFilter.category || p.categoryId === productFilter.category) &&
      (!productFilter.stock || stockLabel(p.qty) === productFilter.stock));
    const max = Math.max(0,Math.ceil(rows.length/12)-1);
    productPage = Math.min(max,productPage);
    const page = rows.slice(productPage*12,productPage*12+12);
    const previous = button("Previous",() => { productPage--; paint(); },true);
    const next = button("Next",() => { productPage++; paint(); },true);
    previous.disabled = productPage === 0; next.disabled = productPage === max;
    lines.replaceChildren(table(["Product","Category","Price","Stock","Visibility","Actions"],page.map(p => [
      group("product-cell",productPhoto(p.imageUrl),labelled(p.title,p.id)),category(p.categoryId),cash(p.pricePaise),
      labelled(whole.format(p.qty),stockLabel(p.qty)),p.active ? "Active" : "Inactive",
      group("row",button("Edit",() => productEditor(p),true),button("Replace image",() => productEditor(p,true),true))
    ])),group("pages",element("span",rows.length + " products"),previous,element("span",(productPage+1)+" / "+(max+1)),next));
  }
  const changed = key => value => { productFilter[key]=value; productPage=0; paint(); };
  paint();
  return panel("Inventory",group("tools",search("Search product title or ID",productFilter.term,changed("term")),
    filterSelect("Category",[["","All categories"],...categoryOptions()],productFilter.category,changed("category")),
    filterSelect("Stock",[["","All stock levels"],...["Out of stock","Low stock","High stock","In range"].map(x=>[x,x])],productFilter.stock,changed("stock")),
    button("Add product",() => productEditor())),lines);
}

const nextStatus = {placed:"processing",processing:"shipped",shipped:"completed"};
function orderEditor(order) {
  const next = nextStatus[order.status];
  const canPay = order.paymentMethod === "cash" && order.paymentStatus === "cash_due" &&
    !["cancelled","refunded"].includes(order.status);
  const advance = input("checkbox","advance","yes");
  const paid = input("checkbox","paid","yes");
  const fields = element("div");
  fields.append(element("p",order.customerName + " · " + displayDate(order) + " · " + cash(order.totalPaise)),
    element("p",status(order.status) + " · " + status(order.paymentMethod) + " · " + status(order.paymentStatus)),
    table(["Item","Quantity","Unit price","Total"],(order.items || order.lines || []).map(item => [
      labelled(item.title || item.productId,item.productId),item.qty,cash(item.unitPricePaise),
      cash(item.lineTotalPaise ?? item.qty * item.unitPricePaise)
    ])));
  if (next) fields.append(label("Move order to " + next,advance));
  if (canPay) fields.append(label("Confirm cash payment received",paid));
  showEditor("Order " + order.id,fields,next || canPay ? async data => {
    const changes = {};
    if (data.has("advance")) changes.status = next;
    if (data.has("paid")) changes.paymentStatus = "paid";
    if (!Object.keys(changes).length) throw Error("Select an update first.");
    const ref = doc(db,"orders",order.id);
    await runTransaction(db,async tx => {
      const latest = await tx.get(ref);
      if (!latest.exists() || latest.get("status") !== order.status || latest.get("paymentStatus") !== order.paymentStatus) {
        throw Error("This order changed. Refresh Orders before updating it.");
      }
      tx.update(ref,changes);
    });
    localUpdate("orders",order.id,changes);
  } : null);
}
function orderRows(orders) {
  return orders.map(o => [labelled(o.customerName || o.customerId,o.id),displayDate(o),status(o.paymentMethod),
    status(o.paymentStatus),status(o.status),cash(o.totalPaise),button("Open",() => orderEditor(o),true)]);
}
const orderColumns = ["Order","Date","Method","Payment","Status","Total","Actions"];
function ordersView() {
  const results = group("order-list");
  function paint() {
    const matching = list("orders").sort(orderSort).filter(o => contains(orderFilter.term,o.id,o.customerId,o.customerName) &&
      (!orderFilter.status || o.status === orderFilter.status) && (!orderFilter.method || o.paymentMethod === orderFilter.method));
    results.replaceChildren(table(orderColumns,orderRows(matching)));
  }
  const changed = key => value => { orderFilter[key]=value; paint(); };
  const states = [...new Set(list("orders").map(o => o.status).filter(Boolean))].sort();
  paint();
  return panel("Order management",group("tools",search("Find order or customer",orderFilter.term,changed("term")),
    filterSelect("Status",[["","All statuses"],...states.map(s => [s,status(s)])],orderFilter.status,changed("status")),
    filterSelect("Payment method",[["","All payments"],["cash","Cash"],["credit","Credit"]],orderFilter.method,changed("method"))),results);
}
function directory() {
  const logins = list("users").filter(u => u.role === "customer");
  const byCustomer = new Map(logins.map(u => [u.customerId || u.id,u]));
  const records = new Map(list("customers").map(c => [c.id,c]));
  for (const customerId of byCustomer.keys()) if (!records.has(customerId)) records.set(customerId,{id:customerId});
  return [...records.values()].map(record => {
    const login = byCustomer.get(record.id);
    const accountId = login?.creditAccountId || record.id;
    return { id:record.id, record, login, accountId, account:row("creditAccounts",accountId),
      name:record.name || login?.name || record.id, email:record.email || login?.email || "", mobile:record.mobile || "" };
  }).sort((a,b) => a.name.localeCompare(b.name));
}
function customerEditor(customer) {
  const name = required("name",customer.name); name.maxLength=160;
  const email = input("email","email",customer.email); email.maxLength=254;
  const mobile = input("tel","mobile",customer.mobile); mobile.maxLength=40;
  const active = input("checkbox","active","yes"); active.checked = customer.record.active !== false;
  const fields = group("field-grid",label("Customer name",name),label("Contact email",email),label("Mobile",mobile),
    label("Purchasing enabled",active),element("p",customer.login ? "Linked login: " + customer.login.id : "No linked login","wide"));
  showEditor("Edit customer",fields,async data => {
    const changes = {name:text(data,"name"),email:text(data,"email"),mobile:text(data,"mobile"),active:data.has("active")};
    if (!changes.name) throw Error("Enter a customer name.");
    await setDoc(doc(db,"customers",customer.id),changes,{merge:true});
    localUpdate("customers",customer.id,changes);
  });
}
function creditEditor(customer) {
  const account = customer.account;
  const info = element("p",account ? "Outstanding balance " + cash(account.outstandingPaise) : "This customer has no credit account.");
  showEditor("Credit limit for " + customer.name,
    group("field-grid",info,label("Credit limit in ₹",number("limit",(account?.creditLimitPaise ?? 0)/100,".01"))),async data => {
      const limit = paise(data,"limit"), ref = doc(db,"creditAccounts",customer.accountId);
      const committed = await runTransaction(db,async tx => {
        const latest = await tx.get(ref);
        if (latest.exists()) {
          tx.update(ref,{creditLimitPaise:limit});
          return {...latest.data(),creditLimitPaise:limit};
        }
        const account = {creditLimitPaise:limit,outstandingPaise:0};
        tx.set(ref,account);
        return account;
      });
      localUpdate("creditAccounts",customer.accountId,committed);
    });
}
function customersView() {
  const customers = directory(), results = group("customer-list");
  const paint = query => results.replaceChildren(table(["Name","Contact","Credit limit","Outstanding","Status","Actions"],
    customers.filter(c => contains(query,c.name,c.email,c.id,c.login?.id)).map(c => [
      labelled(c.name,c.id),labelled(c.email || "—",c.mobile),c.account ? cash(c.account.creditLimitPaise) : "—",
      c.account ? cash(c.account.outstandingPaise) : "—",c.record.active === false ? "Purchasing disabled" : c.login ? "Linked" : "No login linked",
      group("row",button("Edit",() => customerEditor(c),true),button("Credit limit",() => creditEditor(c),true))
    ])));
  paint("");
  const users = table(["Account","Role","Auth UID"],list("users").map(u => [
    labelled(u.name || u.id,u.email),u.role,u.id
  ]));
  return group("stack",panel("Customer directory",group("tools",search("Search customer","",paint),
    button("Export customers CSV",() => csv("buyit-customers.csv",
      [["Customer ID","Name","Email","Mobile","Limit paise","Outstanding paise","Active"],...customers.map(c =>
        [c.id,c.name,c.email,c.mobile,c.account?.creditLimitPaise,c.account?.outstandingPaise,c.record.active !== false])]),true)),results),
    panel("Sign-in accounts",users));
}
function aggregate(orders) {
  const result = { total:0, cash:0, credit:0, units:0, customers:new Map(), categories:new Map(), products:new Map() };
  const add = (map,id,name,value) => {
    const current = map.get(id);
    map.set(id,{id,name,value:(current?.value || 0)+value});
  };
  for (const order of orders) {
    const amount = Number(order.totalPaise) || 0;
    result.total += amount;
    if (["cash","credit"].includes(order.paymentMethod)) result[order.paymentMethod] += amount;
    add(result.customers,order.customerId,order.customerName || order.customerId,amount);
    for (const item of order.items || order.lines || []) {
      const qty = Number(item.qty) || 0;
      result.units += qty;
      add(result.products,item.productId,item.title || item.productId,qty);
      add(result.categories,item.categoryId,category(item.categoryId),item.lineTotalPaise ?? qty * (Number(item.unitPricePaise)||0));
    }
  }
  return result;
}
function reportOrders() {
  return list("orders").filter(o => {
    if (["cancelled","refunded"].includes(o.status) || ["void","refunded"].includes(o.paymentStatus)) return false;
    if (reportFilter.method && o.paymentMethod !== reportFilter.method) return false;
    const day = orderDate(o) ? dayKey.format(orderDate(o)) : "";
    return (!reportFilter.from || day >= reportFilter.from) && (!reportFilter.to || day && day <= reportFilter.to);
  });
}
function rank(entries, descending = true) {
  return [...entries].sort((a,b) => (descending ? b.value-a.value : a.value-b.value) ||
    String(a.id).localeCompare(String(b.id)));
}
function csv(name, rows) {
  const quote = value => {
    let text = String(value ?? "");
    if (typeof value === "string" && /^\s*[=+@-]|^[\r\t]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"','""') + '"';
  };
  const url = URL.createObjectURL(new Blob(["\ufeff",rows.map(r=>r.map(quote).join(",")).join("\r\n")],{type:"text/csv;charset=utf-8"}));
  const a = element("a"); a.href=url; a.download=name; a.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
}
function reportsView() {
  const results = group("reports");
  const from = input("date","from",reportFilter.from), to = input("date","to",reportFilter.to);
  const method = select("method",[["","All payments"],["cash","Cash"],["credit","Credit"]],reportFilter.method);
  function paint() {
    const orders = reportOrders(), totals = aggregate(orders);
    const top = rank(totals.products.values()).slice(0,10);
    const cashByCustomer = aggregate(orders.filter(o => o.paymentMethod === "cash")).customers;
    const creditByCustomer = aggregate(orders.filter(o => o.paymentMethod === "credit")).customers;
    const paymentRows = rank(totals.customers.values()).map(c => [
      labelled(c.name,c.id),cash(cashByCustomer.get(c.id)?.value),cash(creditByCustomer.get(c.id)?.value),cash(c.value)
    ]);
    const bottom = rank(list("products").filter(p => p.active && p.qty > 0).map(p =>
      totals.products.get(p.id) || {id:p.id,name:p.title,value:0}),false).slice(0,10);
    const ranked = (header,values,format) => table([header,"Total"],values.map(r=>[r.name,format(r.value)]));
    results.replaceChildren(
      group("metrics",metric("Orders",whole.format(orders.length)),metric("Order value",cash(totals.total)),
        metric("Cash order value",cash(totals.cash)),metric("Credit order value",cash(totals.credit))),
      group("split",panel("Top 10 customers",ranked("Customer",rank(totals.customers.values()).slice(0,10),cash)),
        panel("Sales by category",ranked("Category",rank(totals.categories.values()),cash)),
        panel("Top 10 products by units",ranked("Product",top,n=>whole.format(n))),
        panel("Bottom 10 stocked products by units",ranked("Product",bottom,n=>whole.format(n)))),
      panel("Cash and credit by customer",table(["Customer","Cash","Credit","Total"],paymentRows)),
      panel("Orders by payment method",button("Export orders CSV",() => csv("buyit-orders.csv",
        [["Order ID","Customer ID","Customer","Date","Method","Payment status","Order status","Total paise"],...orders.map(o=>
          [o.id,o.customerId,o.customerName,displayDate(o),o.paymentMethod,o.paymentStatus,o.status,o.totalPaise])]),true),
        table(orderColumns,orderRows([...orders].sort(orderSort)))),
      panel("Stock report",button("Export inventory CSV",() => csv("buyit-inventory.csv",
        [["Product ID","Title","Category","Quantity","Stock status","Active","Price paise"],...list("products").map(p=>
          [p.id,p.title,category(p.categoryId),p.qty,stockLabel(p.qty),p.active,p.pricePaise])]),true),
        table(["Product","Category","Quantity","Stock status"],list("products").filter(p => stockLabel(p.qty)!=="In range").slice(0,20).map(p=>
          [p.title,category(p.categoryId),p.qty,stockLabel(p.qty)])),
        element("p","Showing up to 20 flagged products. The CSV includes all inventory.","muted")));
  }
  const form = element("form",undefined,"tools");
  const submit = element("button","Apply filters"); submit.type="submit";
  form.append(label("Start date (India)",from),label("End date (India)",to),label("Payment method",method),submit);
  form.onsubmit = event => {
    event.preventDefault();
    if (from.value && to.value && from.value > to.value) { notice("End date must be on or after start date.",true); return; }
    Object.assign(reportFilter,{from:from.value,to:to.value,method:method.value});
    notice(); paint();
  };
  paint();
  return group("stack",panel("Sales and inventory reports",form,element("p","Totals include placed orders and exclude cancelled, refunded and void orders.","muted")),results);
}
function overviewView() {
  const orders = list("orders").sort(orderSort);
  const totals = aggregate(orders.filter(o => !["cancelled","refunded"].includes(o.status) && !["void","refunded"].includes(o.paymentStatus)));
  const products = list("products");
  return group("stack",
    group("metrics",metric("Order value",cash(totals.total)),metric("Orders to fulfill",orders.filter(o=>nextStatus[o.status]).length),
      metric("Low or out of stock",products.filter(p=>p.active && p.qty<(settings().lowStockBelow ?? 15)).length),
      metric("Customers",directory().length)),
    panel("Recent orders",table(orderColumns,orderRows(orders.slice(0,8)))),
    panel("Inventory",group("tools",button("Manage products",() => openView("Products")),button("Open reports",() => openView("Reports"),true))));
}
function categoryEditor(existing) {
  const id = required("id",existing?.id || ""); id.readOnly=!!existing;
  const name = required("name",existing?.name || ""); name.maxLength=100;
  showEditor(existing ? "Edit category" : "Add category",group("field-grid",label("Category ID",id),label("Name",name)),async data => {
    const key = existing?.id || docId(text(data,"id")), next = text(data,"name"), ref = doc(db,"categories",key);
    if (!next) throw Error("Enter a category name.");
    await runTransaction(db,async tx => {
      const latest = await tx.get(ref);
      if (!existing && latest.exists()) throw Error("Category ID already exists.");
      if (existing && (!latest.exists() || latest.get("name") !== existing.name)) throw Error("Refresh settings and reopen the category.");
      tx.set(ref,{name:next},{merge:true});
    });
    localUpdate("categories",key,{name:next});
  });
}
function settingsView() {
  const config = settings();
  const settingsButton = button("Edit settings",() => showEditor("Shop settings",group("field-grid",
    label("Low stock below",number("low",config.lowStockBelow ?? 15)),
    label("High stock above",number("high",config.highStockAbove ?? 100)),
    label("Default credit limit in ₹",number("default",(config.defaultCreditLimitPaise ?? 0)/100,".01"))), async data => {
    const low = integer(data,"low"), high = integer(data,"high");
    if (high < low) throw Error("The high stock threshold must be at least the low stock threshold.");
    const fields = {lowStockBelow:low,highStockAbove:high,defaultCreditLimitPaise:paise(data,"default")};
    await setDoc(doc(db,"shopSettings","qa-commerce-v1"),fields,{merge:true});
    localUpdate("shopSettings","qa-commerce-v1",fields);
  }));
  return group("stack",panel("Stock and credit defaults",
    table(["Setting","Value"],[["Low stock below",config.lowStockBelow ?? 15],["High stock above",config.highStockAbove ?? 100],
      ["Stored default credit limit",cash(config.defaultCreditLimitPaise)]]),
    element("p","Set an existing account’s limit from Customers.","muted"),settingsButton),
    panel("Categories",group("tools",button("Add category",() => categoryEditor())),
      table(["ID","Name","Actions"],categoryOptions().map(([id,name]) => [id,name,button("Edit",() => categoryEditor(row("categories",id)),true)]))));
}
const renderers = {Overview:overviewView,Products:productsView,Orders:ordersView,Customers:customersView,Reports:reportsView,Settings:settingsView};
document.querySelectorAll("[data-view]").forEach(button => { button.onclick = () => openView(button.dataset.view); });
$("logout").onclick = () => signOut(auth);
onAuthStateChanged(auth,async user => {
  if (!user) { location.replace("./index.html"); return; }
  try {
    const profile = await getDocFromServer(doc(db,"users",user.uid));
    if (auth.currentUser?.uid !== user.uid) return;
    if (profile.get("role") !== "admin") {
      location.replace(profile.get("role") === "customer" ? "./customer.html" : "./index.html");
      return;
    }
    activeAdmin = user.uid;
    $("session").textContent = profile.get("name") || user.email;
    $("navigation").hidden = $("logout").hidden = false;
    openView("Overview");
  } catch (error) { notice("Unable to verify your admin account. " + error.message,true); }
});
