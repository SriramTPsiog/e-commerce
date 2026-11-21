import { initializeApp } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/12.0.0/firebase-auth.js";
import {
  collection, doc, documentId, getDoc, getDocs, getDocsFromServer, onSnapshot, getFirestore, limit, orderBy,
  query, runTransaction, serverTimestamp, startAfter, where
} from "https://www.gstatic.com/firebasejs/12.0.0/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { deviceBag, readItems, updateItems, capItems } from "./shop-bag.js";


const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);
// Replace with the HTTPS URL printed by Wrangler after deploying the Worker.
const checkoutUrl = "https://buyit-checkout.e-commerce-sriramtpsiog.workers.dev/checkout";
const record = snapshot => ({...snapshot.data(), id: snapshot.id});

function linkedBag(customerId) {
  let selected;
  async function ref() {
    if (selected) return selected;
    const open = await getDocs(query(collection(db, "carts"),
      where("customerId", "==", customerId), where("status", "==", "open"), limit(2)));
    if (open.size > 1) throw new Error("Multiple open carts are linked to your customer record.");
    selected = open.docs[0]?.ref || doc(db, "carts", customerId);
    return selected;
  }
  function current(snapshot) {
    if (!snapshot.exists()) return [];
    const cart = snapshot.data();
    if (cart.customerId !== customerId || cart.status !== "open") {
      selected = null;
      throw new Error("The saved cart is no longer open. Reopen the bag to refresh it.");
    }
    return readItems(cart.items);
  }
  return {
    cartId:async () => (await ref()).id,
    finish:async () => current(await getDoc(await ref())),
    async cap(catalog) {
      const cartRef = await ref();
      return runTransaction(db,async tx => {
        const snap = await tx.get(cartRef);
        const before = current(snap);
        const next = capItems(before,catalog);
        if (JSON.stringify(before) !== JSON.stringify(next))
          tx.update(cartRef,{items:next,updatedAt:serverTimestamp()});
        return next;
      });
    },
    label: "Saved to your customer account.",
    async read() { return current(await getDoc(await ref())); },
    async change(id, delta) {
      const cartRef = await ref();
      return runTransaction(db, async tx => {
        const cart = await tx.get(cartRef);
        const items = current(cart);
        const product = delta > 0 ? (await tx.get(doc(db, "products", id))).data() : null;
        const next = updateItems(items, id, delta, product);
        if (cart.exists()) tx.update(cartRef, {items: next, updatedAt: serverTimestamp()});
        else if (next.length) tx.set(cartRef, {customerId, status: "open", items: next, updatedAt: serverTimestamp()});
        return next;
      });
    }
  };
}

export async function openShop() {
  await auth.authStateReady();
  const user = auth.currentUser;
  if (!user) { location.replace("./index.html"); return; }
  onAuthStateChanged(auth, current => {
    if (current?.uid !== user.uid) location.replace("./index.html");
  });
  const profile = (await getDoc(doc(db, "users", user.uid))).data();
  if (profile?.role === "admin") { location.replace("./admin.html"); return; }
  if (profile?.role !== "customer") throw new Error("This account needs a customer profile to open the shop.");
  const customerId = profile.customerId;
  if (customerId != null && (typeof customerId !== "string" || !customerId.trim() || customerId.includes("/"))) {
    throw new Error("The customerId on this profile is invalid.");
  }

  const ownerId = customerId || user.uid;
  const accountId = profile.creditAccountId || ownerId;
  const productQuery = ids => query(collection(db,"products"),
    where("active","==",true), where(documentId(),"in",ids));
  async function findProducts(ids) {
    const result = new Map(ids.map(id => [id,null]));
    const batches = [];
    for (let i=0; i<ids.length; i+=30) batches.push(getDocsFromServer(productQuery(ids.slice(i,i+30))));
    for (const batch of await Promise.all(batches))
      for (const snap of batch.docs) result.set(snap.id,record(snap));
    return result;
  }
  async function findProduct(id) { return (await findProducts([id])).get(id); }
  return {
    uid:user.uid,
    findProducts,
    watchProducts(ids,receive,onError) {
      const stops = [];
      for (let i=0; i<ids.length; i+=30) {
        const group = ids.slice(i,i+30);
        stops.push(onSnapshot(productQuery(group),{includeMetadataChanges:true},snap => {
          if (snap.metadata.fromCache) return;
          const result = new Map(group.map(id => [id,null]));
          for (const row of snap.docs) result.set(row.id,record(row));
          receive(result);
        },onError));
      }
      return () => stops.forEach(stop => stop());
    },
    async orders() {
      const owner = ownerId === user.uid ? where("customerId","==",user.uid) :
        where("customerId","in",[ownerId,user.uid]);
      const snap = await getDocsFromServer(query(collection(db,"orders"),owner));
      return snap.docs.map(record).sort((a,b) =>
        ((b.createdAt || b.placedAt)?.toMillis?.() || 0) - ((a.createdAt || a.placedAt)?.toMillis?.() || 0));
    },
    async credit() {
      const account = (await getDoc(doc(db,"creditAccounts",accountId))).data();
      if (!account) return null;
      const {creditLimitPaise, outstandingPaise} = account;
      if (![creditLimitPaise,outstandingPaise].every(n => Number.isSafeInteger(n) && n >= 0))
        throw new Error("Your credit balance could not be read.");
      return {limit:creditLimitPaise,used:outstandingPaise,available:Math.max(0,creditLimitPaise-outstandingPaise)};
    },
    async purchase(data) {
      const token = await user.getIdToken();
      const response = await fetch(checkoutUrl, {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(data),
        signal: AbortSignal.timeout(125000)
      });
      const result = await response.json();
      if (!response.ok) throw Object.assign(new Error(result.message || "Checkout unavailable."), {
        code: result.code || "unavailable"
      });
      if (!result.orderId) throw new Error("Checkout returned no order ID.");
      return result;
    },
    name: profile.name || user.displayName || "Customer",
    signOut: () => signOut(auth),
    async categories() {
      return (await getDocs(collection(db, "categories"))).docs.map(record);
    },
    async products(cursor) {
      const parts = [where("active", "==", true), orderBy(documentId())];
      if (cursor) parts.push(startAfter(cursor));
      const batch = await getDocs(query(collection(db, "products"), ...parts, limit(49)));
      const page = batch.docs.slice(0, 48);
      return {items: page.map(record), cursor: page.at(-1), done: batch.size <= 48};
    },
    findProduct,
    bag: customerId ? linkedBag(customerId) : deviceBag(user.uid, findProduct)
  };
}
