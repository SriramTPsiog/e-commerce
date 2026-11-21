import { createHash } from "node:crypto";

class CheckoutError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
function fail(code, message) { throw new CheckoutError(code, message); }
function validId(id) {
  return typeof id === "string" && id.length > 0 && id.length <= 256 &&
    !id.includes("/") && id !== "." && id !== ".." && !/^__.*__$/.test(id);
}
function whole(value) { return Number.isSafeInteger(value) && value >= 0; }
function normalizeItems(items) {
  if (!Array.isArray(items) || !items.length || items.length > 100)
    fail("invalid-argument", "Choose between 1 and 100 different products per order.");
  const seen = new Set();
  return items.map(item => {
    if (!validId(item?.productId) || seen.has(item.productId) || !whole(item.qty) || item.qty === 0)
      fail("invalid-argument", "Each product needs one positive whole quantity.");
    seen.add(item.productId);
    return {productId:item.productId, qty:item.qty};
  }).sort((a,b) => a.productId < b.productId ? -1 : 1);
}

async function purchase(store, uid, data) {
  if (!validId(uid)) fail("unauthenticated", "Sign in before placing an order.");
  const {checkoutId, paymentMethod, expectedTotalPaise, cartId = null} = data || {};
  if (!/^[a-zA-Z0-9-]{16,80}$/.test(typeof checkoutId === "string" ? checkoutId : "") ||
      !["cash","credit"].includes(paymentMethod) || !whole(expectedTotalPaise) ||
      (cartId !== null && !validId(cartId))) fail("invalid-argument","Invalid checkout details.");
  const items = normalizeItems(data.items);
  const orderId = createHash("sha256").update(JSON.stringify([uid,checkoutId])).digest("hex");
  const signature = createHash("sha256").update(JSON.stringify([items,paymentMethod,expectedTotalPaise,cartId])).digest("hex");
  return store.transaction(async tx => {
    const [profile, previous] = await tx.read(["users/"+uid, "orders/"+orderId], [
      "role","customerId","creditAccountId","name","checkoutSignature","authUid","totalPaise","paymentMethod"
    ]);
    if (profile?.role !== "customer") fail("permission-denied","A customer account is required.");
    if (previous) {
      if (previous.checkoutSignature !== signature || previous.authUid !== uid)
        fail("already-exists","This checkout ID was used for a different purchase.");
      return {orderId,totalPaise:previous.totalPaise,paymentMethod:previous.paymentMethod};
    }
    const customerId = profile.customerId ?? uid;
    const accountId = profile.creditAccountId ?? customerId;
    if (!validId(customerId) || !validId(accountId)) fail("failed-precondition","Check your customer account mapping.");
    if (Boolean(profile.customerId) !== Boolean(cartId)) fail("failed-precondition","Your cart link changed. Refresh the shop.");
    const productPaths = items.map(i => "products/"+i.productId);
    const paths = [...productPaths, "customers/"+customerId];
    if (cartId) paths.push("carts/"+cartId);
    if (paymentMethod === "credit") paths.push("creditAccounts/"+accountId);
    const snapshots = await tx.read(paths, [
      "active","qty","pricePaise","title","categoryId","name","customerId","status","items","creditLimitPaise","outstandingPaise"
    ]);
    const byPath = new Map(paths.map((key,i) => [key,snapshots[i]]));
    const customer = byPath.get("customers/"+customerId);
    if (customer?.active === false) fail("permission-denied","This customer account is inactive.");
    if (cartId) {
      const cart = byPath.get("carts/"+cartId);
      if (cart?.customerId !== customerId || cart?.status !== "open" || !Array.isArray(cart.items) || !cart.items.length ||
          JSON.stringify(normalizeItems(cart.items)) !== JSON.stringify(items))
        fail("failed-precondition","Your saved bag changed. Reopen it and review the quantities.");
    }
    let totalPaise = 0;
    const lines = items.map(({productId,qty}) => {
      const p = byPath.get("products/"+productId);
      if (p?.active !== true || !whole(p.qty) || p.qty < qty)
        fail("failed-precondition", (p?.title || productId)+" has insufficient stock. Review your bag.");
      if (!whole(p.pricePaise)) fail("failed-precondition","Price unavailable for "+productId+".");
      const lineTotalPaise = qty*p.pricePaise;
      totalPaise += lineTotalPaise;
      if (!whole(lineTotalPaise) || !whole(totalPaise)) fail("out-of-range","Order total is too large.");
      return {productId,qty,title:p.title || productId,categoryId:p.categoryId || "",unitPricePaise:p.pricePaise,lineTotalPaise};
    });
    if (totalPaise !== expectedTotalPaise) fail("failed-precondition","Prices changed. Review your updated total.");
    const createdAt = new Date();
    if (paymentMethod === "credit") {
      const account = byPath.get("creditAccounts/"+accountId);
      if (!account || !whole(account.creditLimitPaise) || !whole(account.outstandingPaise) ||
          totalPaise > account.creditLimitPaise-account.outstandingPaise)
        fail("failed-precondition","Available store credit is too low. Choose cash or reduce your bag.");
      tx.patch("creditAccounts/"+accountId,{outstandingPaise:account.outstandingPaise+totalPaise});
      tx.create("creditTransactions/"+orderId+"-charge",{customerId,orderId,deltaPaise:totalPaise,type:"charge",createdAt});
    }
    tx.create("orders/"+orderId,{
      authUid:uid, checkoutSignature:signature, customerId,customerName:customer?.name || profile.name || "Customer",
      createdAt,currency:"INR",items:lines,totalPaise,paymentMethod,
      paymentStatus:paymentMethod === "credit" ? "on_credit" : "cash_due",status:"placed"
    });
    lines.forEach((line,i) => {
      const path=productPaths[i];
      tx.patch(path,{qty:byPath.get(path).qty-line.qty});
      tx.create("salesLines/"+orderId+"-"+(i+1),{...line,customerId,orderId,paymentMethod,createdAt});
    });
    tx.create("orderNotifications/"+orderId,{orderId,customerId,type:"orderConfirmation",status:"queued",createdAt});
    if (cartId) tx.patch("carts/"+cartId,{items:[],updatedAt:createdAt});
    return {orderId,totalPaise,paymentMethod};
  });
}
export { purchase, CheckoutError };
