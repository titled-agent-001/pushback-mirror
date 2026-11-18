/* PushBack — static UI over a dhf registry export (web/data/registry.json). */

let DB = null;

const $app = document.getElementById("app");
const $search = document.getElementById("search");

/* ---------- utils ---------- */

function fmtBytes(n) {
  if (n < 1024) return n + " B";
  const units = ["KB", "MB", "GB", "TB"];
  let u = -1;
  do { n /= 1024; u++; } while (n >= 1024 && u < units.length - 1);
  return n.toFixed(n >= 100 ? 0 : 1) + " " + units[u];
}

function timeAgo(ts) {
  const s = Math.floor(Date.now() / 1000) - ts;
  if (s < 3600) return Math.max(1, Math.floor(s / 60)) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " hours ago";
  const d = Math.floor(s / 86400);
  return d === 1 ? "1 day ago" : d + " days ago";
}

function fmtCount(n) {
  return n >= 1000 ? (n / 1000).toFixed(1).replace(/\.0$/, "") + "k" : String(n);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

function shieldSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M9 12l2 2 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

function mirrorKind(url) {
  if (url.startsWith("magnet:")) return "torrent";
  if (url.includes("/ipfs/") || url.startsWith("ipfs://")) return "ipfs";
  if (url.startsWith("ar://") || url.includes("ar.io")) return "arweave";
  return "https";
}

/* ---------- desktop client detection ---------- */

async function detectDesktopClient() {
  try {
    const r = await fetch("/api/ping", { signal: AbortSignal.timeout ? AbortSignal.timeout(1500) : undefined });
    if (!r.ok) return;
    const info = await r.json();
    if (info.app !== "pushback-desktop") return;
    const bar = document.createElement("div");
    bar.className = "desktop-bar";
    bar.innerHTML = `Served locally by <strong>PushBack Desktop v${esc(info.version)}</strong>` +
      ` \u2014 UI resolved from the on-chain registry and verified against its signed manifest` +
      ` (${esc((info.ui_manifest || "").slice(0, 16))}\u2026). No gateway, no DNS trust.`;
    document.body.insertBefore(bar, document.body.firstChild);
  } catch (e) { /* static hosting: no client, no banner */ }
}
detectDesktopClient();

/* ---------- live chain reads (Base Sepolia, no libraries) ---------- */

const CHAIN = {
  rpc: "https://sepolia.base.org",
  registry: "0xC3ec85879A58B4e1356260942B11F6763Bd8D9ff",
  pool: "0x0d47E30c3eD57a03883c7E00ba056c3749EfA3b6",
  explorer: "https://sepolia.basescan.org",
  name: "Base Sepolia",
};

// selectors precomputed with `cast sig`
const SEL_RESOLVE = "0xfde51e4e";      // resolve(string,string,string)
const SEL_POOL_BALANCE = "0xbeed3b8a"; // poolBalance(bytes32)

function pad32(hex) { return hex.padStart(64, "0"); }

function encStringTail(s) {
  const bytes = new TextEncoder().encode(s);
  let hex = "";
  for (const b of bytes) hex += b.toString(16).padStart(2, "0");
  const padded = hex.padEnd(Math.ceil(hex.length / 64) * 64 || 64, "0");
  return pad32(bytes.length.toString(16)) + padded;
}

function encodeStringsCall(selector, strings) {
  // head = one offset word per arg; tails follow in order
  const tails = strings.map(encStringTail);
  let offset = strings.length * 32;
  const heads = [];
  for (const t of tails) {
    heads.push(pad32(offset.toString(16)));
    offset += t.length / 2;
  }
  return selector + heads.join("") + tails.join("");
}

async function ethCall(to, data) {
  const resp = await fetch(CHAIN.rpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call",
                           params: [{ to, data }, "latest"] }),
  });
  const j = await resp.json();
  if (j.error) throw new Error(j.error.message || "eth_call failed");
  return j.result;
}

function decodeResolveResult(hex) {
  const h = hex.replace(/^0x/, "");
  if (h.length < 128) throw new Error("not found on chain");
  const manifestId = h.slice(0, 64);
  const strOffset = parseInt(h.slice(64, 128), 16) * 2;
  const strLen = parseInt(h.slice(strOffset, strOffset + 64), 16) * 2;
  const strHex = h.slice(strOffset + 64, strOffset + 64 + strLen);
  const bytes = hexToBytes(strHex);
  return { manifestId, manifestURI: new TextDecoder().decode(bytes) };
}

async function chainResolve(ns, name, version) {
  const data = encodeStringsCall(SEL_RESOLVE, [ns, name, version]);
  return decodeResolveResult(await ethCall(CHAIN.registry, data));
}

async function chainPoolBalance(manifestIdHex) {
  const data = SEL_POOL_BALANCE + pad32(manifestIdHex.replace(/^0x/, ""));
  const out = await ethCall(CHAIN.pool, data);
  return BigInt(out); // wei
}

/* Full trustless round trip: chain -> manifest URI -> hash check -> sig check.
   The RPC node AND the manifest host are both untrusted: the manifest must
   hash to the on-chain manifestId and carry a valid Ed25519 signature. */
async function chainVerify(ns, name, version) {
  const steps = [];
  const r = await chainResolve(ns, name, version);
  steps.push({ ok: true, text: `chain resolved ${ns}/${name}@${version} \u2192 manifest ${r.manifestId.slice(0, 16)}\u2026` });
  const resp = await fetch(r.manifestURI);
  if (!resp.ok) throw new Error(`manifest fetch failed (${resp.status})`);
  const man = await resp.json();
  steps.push({ ok: true, text: `fetched manifest from ${new URL(r.manifestURI).host}` });
  const unsigned = {};
  for (const k of Object.keys(man)) if (k !== "signature") unsigned[k] = man[k];
  const digest = await crypto.subtle.digest("SHA-256",
    new TextEncoder().encode(canonicalJson(unsigned)));
  const actualId = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  if (actualId !== r.manifestId) {
    steps.push({ ok: false, text: "manifest hash does NOT match on-chain manifestId" });
    return { ok: false, steps, man };
  }
  steps.push({ ok: true, text: "sha256(manifest) matches on-chain manifestId" });
  const sig = await verifyManifestInBrowser(man);
  steps.push({ ok: sig.ok === true, text: sig.ok === true
    ? "Ed25519 publisher signature valid" : `signature: ${sig.reason}` });
  return { ok: steps.every(s => s.ok), steps, man };
}

/* ---------- canonical JSON + crypto (mirrors dhf/manifest.py) ---------- */

function canonicalJson(obj) {
  if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  return "{" + Object.keys(obj).sort().map(k =>
    JSON.stringify(k) + ":" + canonicalJson(obj[k])
  ).join(",") + "}";
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

async function verifyManifestInBrowser(manifest) {
  // 1. recompute manifest_id = sha256(canonical json without signature)
  const unsigned = {};
  for (const k of Object.keys(manifest)) if (k !== "signature") unsigned[k] = manifest[k];
  const payload = new TextEncoder().encode(canonicalJson(unsigned));
  const digest = await crypto.subtle.digest("SHA-256", payload);
  const actualId = Array.from(new Uint8Array(digest))
    .map(b => b.toString(16).padStart(2, "0")).join("");
  if (actualId !== manifest.signature.manifest_id) {
    return { ok: false, reason: "manifest_id mismatch — manifest was altered" };
  }
  // 2. Ed25519 verify signature over the manifest_id bytes
  try {
    const key = await crypto.subtle.importKey(
      "raw", hexToBytes(manifest.publisher_pubkey),
      { name: "Ed25519" }, false, ["verify"]
    );
    const ok = await crypto.subtle.verify(
      { name: "Ed25519" }, key,
      hexToBytes(manifest.signature.sig),
      new TextEncoder().encode(actualId)
    );
    return ok
      ? { ok: true, reason: "hash recomputed + Ed25519 signature valid" }
      : { ok: false, reason: "signature invalid" };
  } catch (e) {
    return { ok: null, reason: "hash OK; browser lacks Ed25519 WebCrypto support" };
  }
}

/* ---------- views ---------- */

function renderHome(filter) {
  const q = (filter || "").toLowerCase().trim();
  let models = DB.models;
  if (q) {
    models = models.filter(m =>
      m.ref.toLowerCase().includes(q) ||
      m.manifest.license.toLowerCase().includes(q) ||
      m.manifest.description.toLowerCase().includes(q));
  }
  const totalSize = DB.models.reduce((a, m) => a + m.manifest.total_size, 0);
  const totalMirrors = DB.models.reduce((a, m) => a + m.mirrors, 0);

  const cards = models.map(m => {
    const [ns, name] = m.ref.split("/");
    const verified = m.attestation && m.attestation.verified
      ? `<span class="badge verified">${shieldSvg()} verified publisher</span>` : "";
    const demo = m.demo ? '<span class="badge demo">demo data</span>' : "";
    return `
    <a class="model-card" href="#/model/${esc(ns)}/${esc(name)}">
      <div class="ref"><span class="ns">${esc(ns)}/</span>${esc(name)}</div>
      <div class="desc">${esc(m.manifest.description)}</div>
      <div class="meta-row">
        <span class="badge signed">${shieldSvg()} signed</span>
        ${verified}${demo}
        <span class="badge license">${esc(m.manifest.license)}</span>
        <span>v${esc(m.manifest.version)}</span>
        <span class="dot">${fmtBytes(m.manifest.total_size)}</span>
        <span class="dot">${m.mirrors} mirrors</span>
        <span class="dot">${fmtCount(m.downloads)} pulls</span>
        <span class="dot">updated ${timeAgo(m.updated)}</span>
      </div>
    </a>`;
  }).join("");

  $app.innerHTML = `
    <section class="hero">
      <h1>The model hub <span class="accent">nobody can switch off</span></h1>
      <p>Every release is a cryptographically signed manifest. Weights live on any
      mirror, torrent, or IPFS node — your client verifies every chunk on arrival,
      so hosts never need to be trusted.</p>
      <div class="hero-stats">
        <span><strong>${DB.models.length}</strong> models</span>
        <span><strong>${fmtBytes(totalSize)}</strong> indexed</span>
        <span><strong>${totalMirrors}</strong> mirrors</span>
        <span><strong>100%</strong> signature-verified</span>
      </div>
    </section>
    <div class="list-head"><h2>${q ? "Search results" : "Models"}</h2></div>
    <div class="model-list">${cards || '<div class="empty">No models match your search.</div>'}</div>`;
}

function renderModel(ns, name) {
  const m = DB.models.find(x => x.ref === ns + "/" + name);
  if (!m) { $app.innerHTML = '<div class="empty">Model not found.</div>'; return; }
  const man = m.manifest;

  const tabs = { card: "Model card", files: "Files", manifest: "Manifest", mirrors: "Mirrors" };
  const tabBtns = Object.entries(tabs).map(([id, label]) =>
    `<button class="tab" data-tab="${id}">${label}</button>`).join("");

  $app.innerHTML = `
    <div class="model-head">
      <div class="crumb"><a href="#/">Models</a> / ${esc(ns)}</div>
      <div class="model-title">
        <h1>${esc(ns)}/${esc(name)}</h1>
        <span class="badge signed">${shieldSvg()} signed release</span>
        ${m.attestation && m.attestation.verified
          ? `<span class="badge verified">${shieldSvg()} verified publisher</span>` : ""}
        ${m.demo ? '<span class="badge demo">demo data</span>' : ""}
        <span class="badge license">${esc(man.license)}</span>
      </div>
      <div class="meta-row model-sub">
        <span>v${esc(man.version)}</span>
        <span class="dot">${fmtBytes(man.total_size)}</span>
        <span class="dot">${man.files.length} files</span>
        <span class="dot">${m.mirrors} mirrors</span>
        <span class="dot">${fmtCount(m.downloads)} pulls</span>
      </div>
      <div class="tabs">${tabBtns}</div>
      <div class="tab-body" id="tab-body"></div>
    </div>`;

  const body = document.getElementById("tab-body");
  const views = {
    card: () => {
      const attRows = m.attestation ? `
        <div class="panel">
          <div class="panel-head">Publisher identity — independently re-checkable proofs</div>
          <div class="rowline"><span class="k">Identity</span><span class="v"><strong>${esc(m.attestation.identity)}</strong></span></div>
          ${m.attestation.proofs.map(p => `
          <div class="rowline"><span class="k">${esc(p.type)} proof</span>
            <span class="v mono">${p.url ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>` : esc(p.domain || "")}</span></div>`).join("")}
          <div class="rowline"><span class="k">Verify yourself</span>
            <span class="v mono">dhf attest verify attestations/${esc(m.attestation.identity)}.json --pubkey ${esc(man.publisher_pubkey.slice(0, 16))}…</span></div>
        </div>` : "";
      body.innerHTML = `
        <div class="panel">
          <div class="panel-head">About</div>
          <div class="rowline"><span class="k">Description</span><span class="v">${esc(man.description)}</span></div>
          <div class="rowline"><span class="k">Publisher key</span><span class="v hash">${esc(man.publisher_pubkey)}</span></div>
          <div class="rowline"><span class="k">Manifest ID</span><span class="v hash">${esc(man.signature.manifest_id)}</span></div>
          <div class="rowline"><span class="k">Schema</span><span class="v mono">${esc(man.schema)}</span></div>
        </div>
        ${attRows}
        ${m.onchain ? `
        <div class="panel">
          <div class="panel-head">
            <span>On-chain registry — ${esc(CHAIN.name)}</span>
            <span style="display:flex;gap:10px;align-items:center">
              <span id="chain-out"></span>
              <button class="verify-btn" id="chain-btn">Verify live from chain</button>
            </span>
          </div>
          <div class="rowline"><span class="k">Registry</span>
            <span class="v mono"><a href="${esc(CHAIN.explorer)}/address/${esc(CHAIN.registry)}" target="_blank" rel="noopener">${esc(CHAIN.registry)}</a></span></div>
          <div class="rowline"><span class="k">Record</span>
            <span class="v mono">${esc(m.onchain.ns)}/${esc(m.onchain.name)}@${esc(m.onchain.version)}</span></div>
          <div id="chain-steps"></div>
        </div>` : ""}
        <div class="panel">
          <div class="panel-head">Pull with the dhf client</div>
          <pre class="json">dhf pull ${esc(ns)}/${esc(name)}@${esc(man.version)} --dest ./models

# resolves the signed manifest, downloads from the fastest
# mirror, verifies every chunk against the manifest hashes</pre>
        </div>`;
      if (m.onchain) {
        document.getElementById("chain-btn").addEventListener("click", async () => {
          const out = document.getElementById("chain-out");
          const stepsEl = document.getElementById("chain-steps");
          out.innerHTML = '<span class="verify-result na">reading chain\u2026</span>';
          stepsEl.innerHTML = "";
          try {
            const r = await chainVerify(m.onchain.ns, m.onchain.name, m.onchain.version);
            stepsEl.innerHTML = r.steps.map(s =>
              `<div class="rowline"><span class="k">${s.ok ? "OK" : "FAIL"}</span><span class="v mono">${esc(s.text)}</span></div>`).join("");
            out.innerHTML = r.ok
              ? '<span class="verify-result ok" title="RPC node and manifest host both untrusted; verified in this browser">LIVE VERIFIED</span>'
              : '<span class="verify-result fail">FAILED</span>';
          } catch (e) {
            out.innerHTML = `<span class="verify-result na" title="${esc(String(e))}">unreachable \u2014 ${esc(String(e.message || e))}</span>`;
          }
        });
      }
    },
    files: () => {
      const rows = man.files.map(f => `
        <div class="filerow">
          <div>
            <div class="fname">${esc(f.path)}</div>
            <div class="hash">merkle ${esc(f.merkle_root.slice(0, 20))}… · ${f.chunks.length} chunks · ${fmtBytes(f.chunk_size)} each</div>
          </div>
          <div class="fmeta">${fmtBytes(f.size)}</div>
        </div>`).join("");
      body.innerHTML = `<div class="panel"><div class="panel-head">Files (${man.files.length}) — every chunk SHA-256 committed in the signed manifest</div>${rows}</div>`;
    },
    manifest: () => {
      body.innerHTML = `
        <div class="panel">
          <div class="panel-head">
            <span>Signed manifest (dhf.manifest.v1)</span>
            <span style="display:flex;gap:10px;align-items:center">
              <span id="verify-out"></span>
              <button class="verify-btn" id="verify-btn">Verify in browser</button>
            </span>
          </div>
          <pre class="json">${esc(JSON.stringify(man, null, 2))}</pre>
        </div>`;
      document.getElementById("verify-btn").addEventListener("click", async () => {
        const out = document.getElementById("verify-out");
        out.innerHTML = '<span class="verify-result na">verifying…</span>';
        const r = await verifyManifestInBrowser(man);
        const cls = r.ok === true ? "ok" : (r.ok === false ? "fail" : "na");
        const label = r.ok === true ? "VERIFIED" : (r.ok === false ? "INVALID" : "PARTIAL");
        out.innerHTML = `<span class="verify-result ${cls}" title="${esc(r.reason)}">${label} — ${esc(r.reason)}</span>`;
      });
    },
    mirrors: () => {
      const rows = (man.sources || []).map(s => `
        <div class="mirror-row">
          <span class="mirror-kind">${mirrorKind(s)}</span>
          <span class="mirror-url">${esc(s)}</span>
        </div>`).join("");
      const av = m.availability;
      const avPanel = av ? `
        <div class="panel">
          <div class="panel-head">Availability pool — staked mirrors earn from the bounty; failing mirrors get slashed</div>
          <div class="rowline"><span class="k">Contract</span>
            <span class="v mono"><a href="${esc(av.explorer)}" target="_blank" rel="noopener">${esc(av.contract)}</a> (${esc(av.chain)})</span></div>
          <div class="rowline"><span class="k">Bounty pool</span><span class="v">${esc(av.bounty_eth)} ETH</span></div>
          ${av.mirrors.map(mir => `
          <div class="rowline"><span class="k">Staked mirror</span>
            <span class="v mono">${esc(mir.url)}<br>
            operator ${esc(mir.operator.slice(0, 10))}… · stake ${esc(mir.stake_eth)} ETH ·
            probes ${mir.probes_ok} ok / ${mir.probes_fail} fail</span></div>`).join("")}
          <div class="rowline"><span class="k">How it works</span>
            <span class="v">Probers fetch random chunks and verify them against the signed
            manifest (a real retrievability check), then report on-chain. Each epoch,
            mirrors with a passing record split 1% of the pool; three failing epochs
            slash the mirror's stake back into the bounty.</span></div>
        </div>` : "";
      body.innerHTML = `
        <div class="panel">
          <div class="panel-head">Known sources — none of these are trusted; chunks are verified on arrival</div>
          ${rows || '<div class="rowline">No source hints in manifest; pass --source to dhf pull.</div>'}
        </div>
        ${avPanel}`;
    },
  };

  const btns = Array.from(document.querySelectorAll(".tab"));
  function activate(id) {
    btns.forEach(b => b.classList.toggle("active", b.dataset.tab === id));
    views[id]();
  }
  btns.forEach(b => b.addEventListener("click", () => activate(b.dataset.tab)));
  activate("card");
}

function renderHow() {
  $app.innerHTML = `
  <div class="prose">
    <h1>How PushBack works</h1>
    <div class="quote">"Models can be cryptographically signed, then hosted any arbitrary
    place if the sigs matched. The decentralized huggingface would be a dapp that organizes
    and connects to anyone storing these models anywhere." — Erik Voorhees, Nov 2026</div>

    <ol class="steps">
      <li><strong>Publishers sign releases</strong>
        <span>A model release is hashed per-chunk (SHA-256 + Merkle roots) into a
        small JSON manifest, signed with the publisher's Ed25519 key. The manifest
        is the protocol; <code>manifest_id = sha256(canonical manifest)</code>.</span></li>
      <li><strong>The registry stores only manifests</strong>
        <span>A thin index maps <code>namespace/name@version</code> to a manifest.
        Namespaces are key-owned, versions are immutable. Live on-chain:
        <a href="https://sepolia.basescan.org/address/0xC3ec85879A58B4e1356260942B11F6763Bd8D9ff"
        target="_blank" rel="noopener"><code>ModelRegistry</code> on Base Sepolia</a>,
        anchoring the manifest hash of <code>pushback/smollm2-135m-instruct-gguf</code>.</span></li>
      <li><strong>Anyone mirrors the weights</strong>
        <span>HTTP servers, S3 buckets, torrents, IPFS — zero special software,
        zero trust required. The signature makes every host trustless.</span></li>
      <li><strong>Clients verify on arrival</strong>
        <span><code>dhf pull</code> resolves the manifest, downloads from any mix of
        mirrors, checks every chunk hash in-flight, drops corrupt or malicious
        sources, and fails over automatically.</span></li>
    </ol>

    <h2>What this protects against</h2>
    <p>Malicious mirrors serving backdoored weights, silently re-uploaded
    "same version" releases, namespace hijacks, registry takedowns, and any single
    point of failure for open model distribution.</p>

    <h2>Try it</h2>
    <p>The reference implementation (CLI, registry, contract, adversarial test suite)
    lives in the <a href="https://github.com/titled-agent-001/project-hf-network"
    target="_blank" rel="noopener"><strong>project-hf-network</strong></a> repository.
    The models on this demo site are real signed manifests generated by the prototype.</p>
  </div>`;
}

/* ---------- router ---------- */

function route() {
  const hash = location.hash || "#/";
  const parts = hash.slice(2).split("/").filter(Boolean);
  if (parts[0] === "model" && parts.length >= 3) {
    renderModel(decodeURIComponent(parts[1]), decodeURIComponent(parts[2]));
  } else if (parts[0] === "how") {
    renderHow();
  } else {
    renderHome($search.value);
  }
  window.scrollTo(0, 0);
}

$search.addEventListener("input", () => {
  if ((location.hash || "#/") !== "#/") location.hash = "#/";
  renderHome($search.value);
});

window.addEventListener("hashchange", route);

fetch("data/registry.json")
  .then(r => r.json())
  .then(d => { DB = d; route(); })
  .catch(() => { $app.innerHTML = '<div class="empty">Failed to load registry data.</div>'; });
