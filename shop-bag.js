export function readItems(value = []) {
  if (!Array.isArray(value)) throw new Error("Your bag has an invalid items field.");
  const seen = new Set();
  return value.map(item => {
    if (!item || typeof item.productId !== "string" || !item.productId ||
        item.productId.includes("/") || seen.has(item.productId) ||
        !Number.isSafeInteger(item.qty) || item.qty < 1) {
      throw new Error("An item in your bag could not be read.");
    }
    seen.add(item.productId);
    return {productId: item.productId, qty: item.qty};
  });
}

export function stockLimit(p) {
  return p?.active === true && Number.isSafeInteger(p.qty) && p.qty > 0 &&
    Number.isSafeInteger(p.pricePaise) && p.pricePaise >= 0 ? p.qty : 0;
}

export function updateItems(items, id, delta, product) {
  const next = readItems(items);
  const line = next.find(row => row.productId === id);
  const qty = (line?.qty || 0) + delta;
  if (delta > 0 && qty > stockLimit(product))
    throw new Error("All available units are already in your bag.");
  if (qty <= 0) return next.filter(row => row.productId !== id);
  if (line) line.qty = qty;
  else {
    if (next.length >= 100) throw new Error("You can check out up to 100 different products at once.");
    next.push({productId:id, qty});
  }
  return next;
}

export function capItems(items, catalog) {
  return items.map(({productId,qty}) => ({
    productId, qty: catalog.has(productId) ? Math.min(qty,stockLimit(catalog.get(productId))) : qty
  })).filter(line => line.qty > 0);
}

export function deviceBag(uid, lookup) {
  const key = "buyit.bag." + uid;
  function load() {
    const value = JSON.parse(localStorage.getItem(key) || "[]");
    return Array.isArray(value) ? {items:readItems(value)} : {...value,items:readItems(value.items)};
  }
  function mutate(fn) {
    const work = () => {
      const next = fn(load());
      localStorage.setItem(key,JSON.stringify(next));
      return next.items;
    };
    return navigator.locks ? navigator.locks.request(key,work) : work();
  }
  return {
    label:"Saved on this device for this account.",
    read:async () => load().items,
    cartId:async () => null,
    async change(id,delta) {
      const p = delta > 0 ? await lookup(id) : null;
      return mutate(s => ({...s,items:updateItems(s.items,id,delta,p)}));
    },
    cap:catalog => mutate(s => ({...s,items:capItems(s.items,catalog)})),
    finish(orderId, purchased) {
      return mutate(s => {
        if (s.lastOrder === orderId) return s;
        const sold = new Map(purchased.map(i => [i.productId,i.qty]));
        return {lastOrder:orderId,items:s.items.map(i => ({...i,qty:i.qty-(sold.get(i.productId)||0)})).filter(i=>i.qty>0)};
      });
    }
  };
}
