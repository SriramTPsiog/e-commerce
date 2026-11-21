// All Firestore calls run under the function's service identity.
function encode(value) {
  if (value instanceof Date) return {timestampValue:value.toISOString()};
  if (typeof value === "number" && Number.isSafeInteger(value)) return {integerValue:String(value)};
  if (typeof value === "string") return {stringValue:value};
  if (Array.isArray(value)) return {arrayValue:{values:value.map(encode)}};
  if (value && typeof value === "object") return {mapValue:{fields:fields(value)}};
  throw new TypeError("Unsupported checkout value.");
}
function fields(value) { return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,encode(v)])); }
function decode(v) {
  if ("mapValue" in v) return unpack(v.mapValue.fields);
  if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode);
  if ("integerValue" in v) return Number(v.integerValue);
  return Object.values(v)[0];
}
function unpack(values={}) { return Object.fromEntries(Object.entries(values).map(([k,v]) => [k,decode(v)])); }
export function restStore(projectId, getAccessToken) {
  const prefix = "projects/"+projectId+"/databases/(default)/documents";
  const base = "https://firestore.googleapis.com/v1/" + prefix;
  async function call(action, body) {
    const token = await getAccessToken();
    const r = await fetch(base+":"+action,{
      method:"POST",headers:{Authorization:"Bearer "+token,"Content-Type":"application/json"},
      body:JSON.stringify(body),signal:AbortSignal.timeout(22000)
    });
    const payload = await r.json();
    if (!r.ok) {
      const e = new Error("Firestore "+action+" failed ("+r.status+").");
      e.status = payload.error?.status; throw e;
    }
    return payload;
  }
  return {
    async transaction(work) {
      for (let attempt=0; ; attempt++) {
        const {transaction} = await call("beginTransaction",{options:{readWrite:{}}});
        const writes=[];
        const name=path=>prefix+"/"+path;
        const write=(path,values,patch)=>writes.push({
          update:{name:name(path),fields:fields(values)},
          currentDocument:{exists:patch},
          ...(patch ? {updateMask:{fieldPaths:Object.keys(values)}} : {})
        });
        try {
          const result=await work({
            async read(paths, fieldPaths) {
              const rows=await call("batchGet",{transaction,documents:paths.map(name),mask:{fieldPaths}});
              const byName=new Map(rows.filter(r=>r.found).map(r=>[r.found.name,unpack(r.found.fields)]));
              return paths.map(p=>byName.get(name(p)));
            },
            patch:(p,v)=>write(p,v,true), create:(p,v)=>write(p,v,false)
          });
          await call("commit",{transaction,writes});
          return result;
        } catch (err) {
          await call("rollback",{transaction}).catch(()=>{});
          if (!["ABORTED","ALREADY_EXISTS"].includes(err.status) || attempt>=4) throw err;
          await new Promise(resolve=>setTimeout(resolve,(25+Math.random()*50)*2**attempt));
        }
      }
    }
  };
}

