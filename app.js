// NBA Tahmin — her gecenin maçlarına tahmin: kazanan, fark, en skorer.
// Seçimler Firebase'de (Firestore) tutulur, maç verisi ESPN'den canlı okunur,
// geçmiş puanlar GitHub'daki data/ dosyalarından gelir.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, connectAuthEmulator }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, collection, writeBatch, serverTimestamp, Timestamp, arrayUnion, connectFirestoreEmulator }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-firestore.js";

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const TZ = "Europe/Istanbul";
const Q = new URLSearchParams(location.search);
const ESPN_BASES = Q.get("espn") ? [Q.get("espn")] :
  ["https://site.web.api.espn.com/apis/site/v2/sports/basketball/nba", "https://site.api.espn.com/apis/site/v2/sports/basketball/nba"];
const MARGINS = ["1-5", "6-10", "11-15", "16+"];
const PCOL = ["var(--p0)", "var(--p1)", "var(--p2)", "var(--p3)", "var(--p4)", "var(--p5)"];

const S = {
  cfg:null, db:null, auth:null, uid:null,
  players:{}, order:[],
  tab:"tahmin", day:null, today:null,
  days:{},                // gün -> {games, picks:{gid:{uid:pick}}, daily:{uid:doc}, at}
  rosters:{}, sums:{},    // takım kadroları, maç özetleri (ESPN summary)
  pstats:{}, arch:{games:{}, scores:{days:{}, games:{}, totals:{}, weeks:{}}},
  draft:{}, statFor:null, timer:null, seen:new Set(), sub:"maclar", viewFor:null
};
try{ S.seen = new Set(JSON.parse(localStorage.getItem("seenReveal")||"[]")); }catch(e){}

/* ====================================================== yardımcılar */
const pad = n => String(n).padStart(2, "0");
const ymd = d => d.getUTCFullYear() + pad(d.getUTCMonth()+1) + pad(d.getUTCDate());
const parseYmd = s => new Date(Date.UTC(+s.slice(0,4), +s.slice(4,6)-1, +s.slice(6,8)));
const shiftDay = (s, n) => { const d = parseYmd(s); d.setUTCDate(d.getUTCDate()+n); return ymd(d); };
const espnToday = () => new Date(Date.now()-6*36e5).toLocaleDateString("sv-SE",{timeZone:"America/New_York"}).replaceAll("-","");
const timeTR = d => d.toLocaleTimeString("tr-TR",{timeZone:TZ,hour:"2-digit",minute:"2-digit"});
const dayNice = (s, o={day:"numeric",month:"long",weekday:"long"}) => parseYmd(s).toLocaleDateString("tr-TR",{timeZone:"UTC",...o});
// Takım logoları: ESPN'in küçültülmüş (hızlı) adresi; yüklenemezse tam boy, o da olmazsa kısaltma.
const LOGO_SMALL = a => `https://a.espncdn.com/combiner/i?img=/i/teamlogos/nba/500/${String(a).toLowerCase()}.png&h=96&w=96`;
const LOGO_FULL  = a => `https://a.espncdn.com/i/teamlogos/nba/500/${String(a).toLowerCase()}.png`;
document.addEventListener("error", e => {
  const img = e.target;
  if(!(img instanceof HTMLImageElement)) return;
  const m = /teamlogos\/nba\/500\/([a-z]+)\.png/i.exec(img.src);
  if(!m) return;
  const abbr = m[1];
  if(img.src.includes("combiner")){ img.src = LOGO_FULL(abbr); return; }
  // son çare: logonun yerine kısaltma
  const b = document.createElement("span");
  b.className = "logo-fb"; b.textContent = abbr.toUpperCase();
  b.style.width = (img.width||28)+"px"; b.style.height = (img.height||28)+"px";
  img.replaceWith(b);
}, true);
const esc = s => String(s??"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const bucket = m => m<=5?"1-5":m<=10?"6-10":m<=15?"11-15":"16+";
const slug = s => s.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, c => ({ç:"c",ğ:"g",ı:"i",ö:"o",ş:"s",ü:"u"}[c])).replace(/[^a-z0-9]/g, "");
const weekKey = s => { const d = parseYmd(s); const w = (d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-w); return ymd(d); };
// Tahmin, maç saatinden 10 dakika önce kilitlenir; rakiplerin seçimleri o an açılır.
const LOCK_MS = 10*60e3;
const started = g => g.state !== "pre" || Date.now() >= g.start.getTime() - LOCK_MS;
// renk katılma sırasına sabit: herkes aynı oyuncuyu aynı renkte görür
const col = uid => PCOL[Math.max(0, (S.colorOrder||S.order).indexOf(uid)) % PCOL.length];
const pname = uid => S.players[uid]?.name || "?";
function toast(msg, ms=2600){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hide"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add("hide"), ms); }
async function getJSON(url){ const r = await fetch(url, {cache:"no-store"}); if(!r.ok) throw new Error(r.status); return r.json(); }
async function espn(path){
  let err;
  for(const b of ESPN_BASES){ try{ return await getJSON(b+path); }catch(e){ err=e; } }
  throw err;
}

/* ====================================================== tema */
const ICON_MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const ICON_SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const isDark = () => { const t=document.documentElement.dataset.theme; return t ? t==="dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
function paintTheme(){ const b=$("#theme"); b.innerHTML=isDark()?ICON_SUN:ICON_MOON; b.setAttribute("aria-label", isDark()?"Açık moda geç":"Koyu moda geç"); }
$("#theme").onclick = () => { const n=isDark()?"light":"dark"; document.documentElement.dataset.theme=n; try{localStorage.setItem("theme",n);}catch(e){} paintTheme(); };
paintTheme();

/* ====================================================== ESPN verisi */
function parseGames(raw){
  return (raw.events||[]).filter(ev => ev.season?.type !== 1).map(ev => {
    const c = ev.competitions[0], st = ev.status||c.status||{}, ty = st.type||{};
    const side = k => {
      const x = c.competitors.find(p => p.homeAway===k) || {};
      return { abbr:x.team?.abbreviation, id:x.team?.id, name:x.team?.shortDisplayName, logo:LOGO_SMALL(x.team?.abbreviation||""),
               score: x.score!=null && x.score!=="" ? +x.score : null, winner:!!x.winner,
               rec:(x.records||[])[0]?.summary||"" };
    };
    return { id:ev.id, start:new Date(ev.date), state:ty.state, detail:ty.shortDetail||"", typeName:ty.name||"",
             period:st.period||0, clock:st.displayClock||"", home:side("home"), away:side("away"),
             seasonType:ev.season?.type ?? 2 };
  }).sort((a,b) => a.start-b.start);
}
async function loadRoster(team){
  if(S.rosters[team.id]) return S.rosters[team.id];
  const raw = await espn(`/teams/${team.id}/roster`);
  const list = (raw.athletes||[]).map(a => ({
    id:String(a.id), name:a.displayName, pos:a.position?.abbreviation||"", jersey:a.jersey||"",
    img:a.headshot?.href||"", team:team.abbr, teamLogo:team.logo,
    inj:(a.injuries||[])[0]?.status || null
  }));
  S.rosters[team.id] = list;
  return list;
}
function ppg(id){ const p=S.pstats[id]; return p && p.gp ? p.pts/p.gp : null; }
async function loadSummary(g, force=false){
  const c = S.sums[g.id];
  const ttl = g.state==="post" ? Infinity : g.state==="in" ? 25e3 : 10*60e3;
  if(c && !force && Date.now()-c.at < ttl) return c.data;
  const data = await espn(`/summary?event=${g.id}`);
  S.sums[g.id] = {at:Date.now(), data};
  return data;
}
function boxPlayers(sum){
  const out=[];
  for(const team of sum?.boxscore?.players||[]){
    for(const st of team.statistics||[]){
      const keys = st.keys||[];
      for(const a of st.athletes||[]){
        if(a.didNotPlay || !a.stats?.length) continue;
        const r = Object.fromEntries(keys.map((k,i)=>[k,a.stats[i]]));
        out.push({ id:String(a.athlete.id), name:a.athlete.displayName, team:team.team.abbreviation, starter:a.starter,
          pts:+r.points||0, reb:+r.rebounds||0, ast:+r.assists||0, min:r.minutes||"0",
          fg:r["fieldGoalsMade-fieldGoalsAttempted"]||"", tp:r["threePointFieldGoalsMade-threePointFieldGoalsAttempted"]||"",
          ft:r["freeThrowsMade-freeThrowsAttempted"]||"", pm:r.plusMinus||"" });
      }
    }
  }
  return out;
}
function topsOf(g){
  const a = S.arch.games[g.id];
  if(a?.top?.length) return a.top;
  const s = S.sums[g.id]?.data; if(!s) return null;
  const bp = boxPlayers(s); if(!bp.length) return null;
  const m = Math.max(...bp.map(p=>p.pts));
  return bp.filter(p=>p.pts===m).map(p=>({id:p.id,name:p.name,team:p.team,pts:p.pts}));
}

/* ====================================================== puanlama (scripts/sync.py ile aynı) */
function scorePick(g, pick, conf){
  const mult = g.seasonType===3 ? 2 : 1;
  const r = {w:0,m:0,s:0,pts:0,final:g.state==="post"};
  if(!pick) return r;
  const homeLead = (g.home.score??0) - (g.away.score??0);
  const winner = homeLead>0 ? g.home.abbr : homeLead<0 ? g.away.abbr : null;
  const won = winner && pick.winner===winner;
  if(won){ r.w = conf?2:1; if(pick.margin===bucket(Math.abs(homeLead))) r.m=1; }
  else if(conf && winner) r.w = -1;
  const tops = g.state==="post" ? topsOf(g) : liveTops(g);
  if(tops && tops.some(t=>t.id===pick.scorerId)) r.s=1;
  r.pts = (r.w+r.m+r.s)*mult;
  return r;
}
function liveTops(g){
  const s=S.sums[g.id]?.data; if(!s) return null;
  const bp=boxPlayers(s); if(!bp.length) return null;
  const m=Math.max(...bp.map(p=>p.pts));
  return bp.filter(p=>p.pts===m).map(p=>({id:p.id,name:p.name,pts:p.pts}));
}
// Bir günün puanları, kırılımıyla: w = taraf (banko dahil), m = fark, s = en skorer, dp = günün oyuncusu
function dayPoints(day){
  const arch = S.arch.scores.days?.[day];
  const out = {};
  const D = S.days[day];
  const archParts = uid => {
    const p = {pts:arch[uid].pts, n:arch[uid].n??1, final:true, src:"arch", w:0, m:0, s:0, dp:arch[uid].dp||0};
    for(const [gid,row] of Object.entries(S.arch.scores.games||{})){
      const g = S.arch.games[gid]; const r = row[uid];
      if(!g || g.day!==day || !r) continue;
      const k = g.seasonType===3 ? 2 : 1;
      p.w += r.w*k; p.m += r.m*k; p.s += r.s*k;
    }
    return p;
  };
  for(const uid of S.order){
    if(arch?.[uid] && (!D || D.games.every(g=>g.state==="post") && !D.games.some(g=>!S.arch.games[g.id]))){ out[uid] = archParts(uid); continue; }
    if(!D){ out[uid] = arch?.[uid] ? archParts(uid) : null; continue; }
    const p = {pts:0, n:0, final:D.games.length>0, src:"live", w:0, m:0, s:0, dp:0};
    const daily=D.daily[uid];
    for(const g of D.games){
      if(!started(g)) { p.final=false; continue; }
      if(g.state!=="post") p.final=false;
      const pick = D.picks[g.id]?.[uid];
      if(pick) p.n++;
      if(g.state!=="post" && g.state!=="in") continue;
      const r = scorePick(g, pick, daily?.confGame===g.id);
      const k = g.seasonType===3 ? 2 : 1;
      p.w += r.w*k; p.m += r.m*k; p.s += r.s*k; p.pts += r.pts;
    }
    const dpr = dayPlayerResult(day, uid);
    if(dpr?.hit){ p.pts += 2; p.dp = 2; }
    if(daily?.dayPlayerId) p.n++;
    out[uid] = p;
  }
  return out;
}
function dayPlayerResult(day, uid){
  const D=S.days[day]; if(!D) return null;
  const d=D.daily[uid]; if(!d?.dayPlayerId) return null;
  const allFinal = D.games.length && D.games.every(g=>g.state==="post");
  let best=-1, ids=new Set(), anyData=false;
  for(const g of D.games){
    if(!started(g)) continue;
    const t = g.state==="post" ? topsOf(g) : liveTops(g);
    if(!t) continue; anyData=true;
    for(const x of t){ if(x.pts>best){best=x.pts; ids=new Set([x.id]);} else if(x.pts===best) ids.add(x.id); }
  }
  return { name:d.dayPlayerName, id:d.dayPlayerId, hit: allFinal && ids.has(d.dayPlayerId), leading: anyData && ids.has(d.dayPlayerId), final:allFinal };
}

/* ====================================================== Firebase */
async function initFirebase(){
  S.cfg = await getJSON("config.json?t="+Date.now());
  if(S.cfg.firebase.projectId==="BURAYA" && !Q.has("emu")) return false;
  const app = initializeApp(Q.has("emu") ? {apiKey:"demo", projectId:"demo-tahmin", authDomain:"demo"} : S.cfg.firebase);
  S.auth = getAuth(app); S.db = getFirestore(app);
  if(Q.has("emu")){ connectAuthEmulator(S.auth, "http://127.0.0.1:9099", {disableWarnings:true}); connectFirestoreEmulator(S.db, "127.0.0.1", 8085); }
  return true;
}
async function loadPlayers(){
  const snap = await getDocs(collection(S.db, "players"));
  S.players = {};
  // katılma saati henüz sunucudan gelmediyse "en yeni" say (renk sırası kaymasın)
  snap.forEach(d => S.players[d.id] = {name:d.data({serverTimestamps:"estimate"}).name, joined:d.data({serverTimestamps:"estimate"}).joined?.toMillis?.()||Date.now()});
  S.order = Object.keys(S.players).sort((a,b) => (S.players[a].joined-S.players[b].joined) || pname(a).localeCompare(pname(b),"tr"));
  S.colorOrder = [...S.order];
  // giriş yapan oyuncu her zaman ilk sırada (iki kişide solda)
  if(S.uid && S.order.includes(S.uid)) S.order = [S.uid, ...S.order.filter(u=>u!==S.uid)];
  $("#playerNames").innerHTML = S.order.map(u=>`<option value="${esc(pname(u))}">`).join("");
}
const pickRef = (gid, uid) => doc(S.db, "picks", `${gid}_${uid}`);
const dailyRef = (day, uid) => doc(S.db, "daily", `${day}_${uid}`);
const progressRef = (day, uid) => doc(S.db, "progress", `${day}_${uid}`);
async function readPick(gid, uid){ try{ const s=await getDoc(pickRef(gid,uid)); return s.exists()?s.data():null; }catch(e){ return null; } }
async function readDaily(day, uid){ try{ const s=await getDoc(dailyRef(day,uid)); return s.exists()?s.data():null; }catch(e){ return null; } }

async function loadDay(day, {force=false}={}){
  const old = S.days[day];
  if(old && !force && Date.now()-old.at < 20e3) return old;
  const games = parseGames(await espn(`/scoreboard?dates=${day}&limit=50`));
  const D = { games, picks: old?.picks||{}, daily: old?.daily||{}, progress: old?.progress||{}, at:Date.now() };
  const firstStart = games.length ? Math.min(...games.map(g=>g.start.getTime())) : Infinity;
  const jobs=[];
  for(const g of games){
    D.picks[g.id] = D.picks[g.id]||{};
    for(const uid of S.order){
      if(uid!==S.uid && !started(g)) continue;
      if(D.picks[g.id][uid] && started(g) && uid!==S.uid && D.picks[g.id][uid]._locked) continue;
      jobs.push(readPick(g.id, uid).then(p => { if(p){ p._locked = started(g); D.picks[g.id][uid]=p; } else delete D.picks[g.id][uid]; }));
    }
  }
  for(const uid of S.order){
    jobs.push(getDoc(progressRef(day, uid)).then(s => { D.progress[uid] = new Set(s.exists() ? s.data().gids||[] : []); }).catch(()=>{}));
    if(uid!==S.uid && Date.now()<firstStart-LOCK_MS) continue;
    jobs.push(readDaily(day, uid).then(d => { if(d) D.daily[uid]=d; else delete D.daily[uid]; }));
  }
  await Promise.all(jobs);
  // biten / süren maçların özetleri (en skorer ve canlı takip için)
  await Promise.all(games.filter(g => g.state==="in" || (g.state==="post" && !S.arch.games[g.id]?.top))
    .map(g => loadSummary(g).catch(()=>null)));
  S.days[day] = D;
  return D;
}

/* ====================================================== kaydetme */
async function savePick(g){
  const d = S.draft[g.id]; if(!d) return;
  if(!(d.winner && d.margin && d.scorerId)) return;
  if(started(g)){ toast("Tahmin kilitlendi (maçtan 10 dk önce kapanır)."); return; }
  const D = S.days[S.day];
  const prev = D.picks[g.id]?.[S.uid];
  if(prev && prev.winner===d.winner && prev.margin===d.margin && prev.scorerId===d.scorerId) return;
  d.saving = true; renderGames();
  try{
    const data = { uid:S.uid, gameId:g.id, day:S.day, start:Timestamp.fromDate(g.start),
      winner:d.winner, margin:d.margin, scorerId:d.scorerId, scorerName:d.scorerName, updatedAt:serverTimestamp() };
    await setDoc(pickRef(g.id, S.uid), data);
    D.picks[g.id][S.uid] = {...data, updatedAt:Timestamp.now()};
    d.err = null;
    toast("Tahmin kaydedildi.");
    setDoc(progressRef(S.day, S.uid), {uid:S.uid, day:S.day, gids:arrayUnion(g.id), updatedAt:serverTimestamp()}, {merge:true})
      .then(()=>{ (D.progress[S.uid] ||= new Set()).add(g.id); renderDayView(); }).catch(()=>{});
  }catch(e){
    d.err = started(g) ? "Kilitlendi, kaydedilemedi (maçtan 10 dk önce kapanır)." : "Kaydedilemedi, tekrar dene.";
  }
  d.saving = false; renderGames(); renderStatus();
}
async function saveDaily(patch){
  const D = S.days[S.day];
  const firstStart = Math.min(...D.games.map(g=>g.start.getTime()));
  const cur = D.daily[S.uid] || {};
  const data = { uid:S.uid, day:S.day, firstStart: cur.firstStart || Timestamp.fromMillis(firstStart) };
  for(const k of ["confGame","confStart","confAt","dayPlayerId","dayPlayerName","dayAt"]) if(cur[k]!==undefined) data[k]=cur[k];
  if(patch.confGame){ data.confGame=patch.confGame; data.confStart=Timestamp.fromDate(patch.confStart); data.confAt=serverTimestamp(); }
  if(patch.dayPlayerId){ data.dayPlayerId=patch.dayPlayerId; data.dayPlayerName=patch.dayPlayerName; data.dayAt=serverTimestamp(); }
  try{
    await setDoc(dailyRef(S.day, S.uid), data);
    // sunucunun yazdığı saatleri geri oku; sonraki kayıt bunları aynen göndermeli
    D.daily[S.uid] = await readDaily(S.day, S.uid) || D.daily[S.uid];
    toast(patch.confGame ? "Günün bankosu seçildi." : "Günün oyuncusu seçildi.");
  }catch(e){ toast("Kaydedilemedi: süre dolmuş olabilir."); }
  render();
}

/* ====================================================== skorbord */
// Sezon toplamı ve kırılımı: arşivdeki günler + henüz arşive girmemiş günler (canlı)
function seasonBreakdown(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d]) days.add(d);
  const b = {}; for(const u of S.order) b[u] = {pts:0, w:0, m:0, s:0, dp:0};
  for(const d of days){
    const dp = dayPoints(d);
    for(const u of S.order){ const p=dp[u]; if(!p) continue; b[u].pts+=p.pts; b[u].w+=p.w; b[u].m+=p.m; b[u].s+=p.s; b[u].dp+=p.dp; }
  }
  return b;
}
function seasonTotals(){ const b=seasonBreakdown(); const t={}; for(const u of S.order) t[u]=b[u].pts; return t; }
const brkHTML = p => `<div class="brk"><span>Maç <b>${p.w}</b></span><span>Fark <b>${p.m}</b></span><span>Oyuncu <b>${p.s+p.dp}</b></span></div>`;
function renderBoard(){
  const brk = seasonBreakdown();
  const tot = {}; for(const u of S.order) tot[u]=brk[u].pts;
  const tonight = S.days[S.today] ? dayPoints(S.today) : {};
  const ranked = [...S.order].sort((a,b)=>tot[b]-tot[a]);
  let html;
  if(S.order.length<=2){
    const [a,b] = S.order;
    const cell = u => u ? `<div class="pl"><div class="nm" style="color:${col(u)}">${esc(pname(u))}</div><div class="digits tnum">${tot[u]}</div>${brkHTML(brk[u])}</div>` : `<div class="pl"><div class="nm">Rakip bekleniyor</div><div class="digits">–</div><div class="brk">&nbsp;</div></div>`;
    html = `<div class="duel">${cell(a)}<div class="vs">VS</div>${cell(b)}</div>`;
  } else {
    html = `<div class="lb">${ranked.map((u,i)=>`<div class="lb-row"><span class="rk">${i+1}</span><span class="nmw"><span class="nm" style="color:${col(u)};display:block">${esc(pname(u))}</span>${brkHTML(brk[u])}</span><span class="td">bu gece ${tonight[u]?.pts??0}</span><span class="tn tnum">${tot[u]}</span></div>`).join("")}</div>`;
  }
  let lead = `<i></i>Henüz puan yok`;
  if(ranked.length>1){
    if(tot[ranked[0]]===tot[ranked[1]]) lead = `<i style="background:var(--amber)"></i>Şu anda berabere`;
    else lead = `<i style="background:${col(ranked[0])}"></i>Şu anda ${esc(pname(ranked[0]))} önde`;
  }
  const tn = S.order.length<=2 && S.order.length ? `Bu gece <b>${S.order.map(u=>tonight[u]?.pts??0).join("–")}</b>` : "";
  const wk = weekKey(S.today), wkPts = {}; for(const u of S.order) wkPts[u]=(S.arch.scores.weeks?.[wk]?.[u]||0);
  for(const day of [S.today, shiftDay(S.today,-1)]){ if(weekKey(day)!==wk || !S.days[day]) continue; const dp=dayPoints(day); for(const u of S.order) if(dp[u]?.src==="live") wkPts[u]+=dp[u].pts-(S.arch.scores.days?.[day]?.[u]?.pts||0); }
  const wkTxt = S.order.length ? `Bu hafta <b>${S.order.slice(0,4).map(u=>wkPts[u]).join("–")}</b>` : "";
  html += `<div class="board-foot"><div class="lead">${lead}</div><div class="bf-meta">${[tn,wkTxt].filter(Boolean).join(" · ")}</div></div>`;
  $("#board").innerHTML = html;
  $("#mini").innerHTML = S.order.length<=2 && S.order.length===2 ? `<span style="color:${col(S.order[0])}">${esc(pname(S.order[0]))}</span><span class="ms tnum">${tot[S.order[0]]}–${tot[S.order[1]]}</span><span style="color:${col(S.order[1])}">${esc(pname(S.order[1]))}</span>` : "";
}

/* ====================================================== TAHMİN sekmesi */
function gameStatusTR(g){
  if(g.state==="pre") return timeTR(g.start);
  if(g.state==="post") return g.period>4 ? "Bitti (uzatma)" : "Bitti";
  if(/half/i.test(g.typeName+g.detail)) return "Devre arası";
  if(/end/i.test(g.typeName)) return g.period<=4 ? `${g.period}. çeyrek sonu` : "Uzatma sonu";
  return (g.period<=4 ? `${g.period}. çeyrek` : "Uzatma") + " " + g.clock;
}
function draftFor(g){
  if(!S.draft[g.id]){
    const p = S.days[S.day]?.picks[g.id]?.[S.uid];
    S.draft[g.id] = p ? {winner:p.winner, margin:p.margin, scorerId:p.scorerId, scorerName:p.scorerName} : {};
  }
  return S.draft[g.id];
}
function renderStatus(){
  const D = S.days[S.day]; if(!D){ $("#dayStatus").innerHTML=""; return; }
  const open = D.games.filter(g=>!started(g));
  const mine = D.games.filter(g=>D.picks[g.id]?.[S.uid]).length;
  const daily = D.daily[S.uid]||{};
  const parts = [];
  if(!D.games.length){ $("#dayStatus").innerHTML = `<div class="note">Bu gün maç yok. Oklarla diğer günlere geçebilirsin.</div>`; return; }
  const pct = Math.round(mine/D.games.length*100);
  parts.push(`<span><b>${mine}/${D.games.length}</b> maç tahmin edildi</span><span class="prog"><i style="width:${pct}%"></i></span>`);
  if(open.length){
    const missing = open.filter(g=>!D.picks[g.id]?.[S.uid]).length;
    if(missing) parts.push(`<span class="warn">${missing} maç eksik</span>`);
    if(!daily.confGame) parts.push(`<span class="warn">Banko seçilmedi</span>`);
    if(!daily.dayPlayerId && !D.games.some(started)) parts.push(`<span class="warn">Günün oyuncusu seçilmedi</span>`);
  }
  if(D.games.some(g=>g.seasonType===3)) parts.push(`<span class="playoff">Playoff: puanlar 2 katı</span>`);
  const allFinal = D.games.every(g=>g.state==="post");
  const anyPick = D.games.some(g=>Object.keys(D.picks[g.id]||{}).length);
  if(allFinal && anyPick) parts.push(`<button class="btn" id="sumBtn">Gece özeti</button>`);
  $("#dayStatus").innerHTML = `<div class="status">${parts.join("")}</div>`;
  $("#sumBtn")?.addEventListener("click", nightSummary);
}
function renderDayLabel(){
  const rel = S.day===S.today ? "Bugün" : S.day===shiftDay(S.today,-1) ? "Dün" : S.day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#dayLabel").innerHTML = rel ? `${rel}<small>${dayNice(S.day)} (ABD)</small>` : `${dayNice(S.day)}<small>ABD tarihi</small>`;
}
function renderDayPlayer(){
  const D = S.days[S.day]; if(!D?.games.length){ $("#dayPlayer").innerHTML=""; return; }
  const locked = D.games.some(started);
  const mine = D.daily[S.uid];
  if(!locked){
    $("#dayPlayer").innerHTML = `<button class="dp" id="dpBtn" style="width:100%;cursor:pointer;text-align:left">
      <span class="ico">⭐</span><span class="tx"><b>Günün oyuncusu ${mine?.dayPlayerName?": "+esc(mine.dayPlayerName):""}</b>
      <small>${mine?.dayPlayerName?"Değiştirmek için dokun. ":"Gecenin en çok sayı atanını bil, +2 puan. "}İlk maçtan 10 dk önce kilitlenir.</small></span></button>`;
    $("#dpBtn").onclick = () => openPlayerPicker({mode:"day"});
    return;
  }
  const rows = S.order.map(u => {
    const r = dayPlayerResult(S.day, u);
    const st = !r ? `<span class="muted">seçmedi</span>` : r.final ? (r.hit?`<span class="ok">+2</span>`:`<span class="no">0</span>`) : r.leading ? `<span class="now">şu an önde</span>` : `<span class="muted">bekleniyor</span>`;
    return `<span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span>: ${r?esc(r.name):"–"} ${st}`;
  }).join(" · ");
  $("#dayPlayer").innerHTML = `<div class="dp"><span class="ico">⭐</span><span class="tx"><b>Günün oyuncusu</b><small>${rows}</small></span></div>`;
}
function pickCell(g, pick, uid, conf){
  const r = scorePick(g, pick, conf);
  const live = g.state==="in";
  const tops = g.state==="post" ? topsOf(g) : liveTops(g);
  const team = pick.winner===g.home.abbr ? g.home : g.away;
  const mark = (got, partial) => g.state==="post" ? (got?`<span class="ok">✓</span>`:`<span class="no">✗</span>`) : live ? (got?`<span class="now">şu an ✓</span>`:"") : "";
  const homeLead=(g.home.score??0)-(g.away.score??0);
  const winNow = homeLead!==0 && (homeLead>0?g.home.abbr:g.away.abbr)===pick.winner;
  return `<div class="prow ${!S.seen.has(g.id) && uid!==S.uid ? "reveal":""}" style="--pc:${col(uid)}">
    <span class="who">${esc(pname(uid))}${conf?' <span class="star" title="Günün bankosu">★</span>':""}</span>
    <span class="pk"><span>${esc(team.name)} ${mark(winNow)}</span><span>${pick.margin} ${mark(r.m)}</span><span>${esc(pick.scorerName)} ${tops?mark(r.s):""}</span></span>
    <span class="pts tnum">${(g.state==="post"||live)?(r.pts>0?"+":"")+r.pts:""}<small>${g.state==="post"?"puan":live?"şu an":""}</small></span>
  </div>`;
}
function gameCard(g){
  const D = S.days[S.day];
  const lock = started(g);
  const daily = D.daily[S.uid]||{};
  const confHere = daily.confGame===g.id;
  const confLocked = daily.confGame && D.games.find(x=>x.id===daily.confGame && started(x));
  const t = (side) => {
    const s = g[side], other = side==="home"?g.away:g.home;
    const loser = g.state==="post" && (s.score??0)<(other.score??0);
    const sel = (lock ? D.picks[g.id]?.[S.uid]?.winner : draftFor(g).winner)===s.abbr;
    const nm = g.state==="pre" ? esc(s.name) : `<span title="${esc(s.name)}">${s.abbr}</span>`;
    return `<button class="tbtn ${loser?"loser":""}" data-act="win" data-g="${g.id}" data-v="${s.abbr}" aria-pressed="${sel}" ${lock?"disabled":""}>
      <img src="${s.logo||""}" alt=""><span class="tt"><b>${nm}</b><small>${side==="home"?"ev sahibi":"deplasman"}${s.rec&&g.state==="pre"?" · "+s.rec:""}</small></span>
      ${g.state!=="pre"?`<span class="sc">${s.score??""}</span>`:""}</button>`;
  };
  let body = `<div class="teams">${t("away")}${t("home")}</div>`;
  if(!lock){
    const d = draftFor(g);
    body += `<div class="row-lbl">Fark</div><div class="margins">${MARGINS.map(m=>`<button class="mbtn" data-act="mar" data-g="${g.id}" data-v="${m}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>
      <div class="row-lbl">Maçın en skoreri</div>
      <button class="scorer-btn" data-act="scorer" data-g="${g.id}">${d.scorerId ? `<b>${esc(d.scorerName)}</b><small>${ppg(d.scorerId)!=null?ppg(d.scorerId).toFixed(1)+" sayı ort.":""}</small>` : `<span class="ph">Oyuncu seç</span>`}</button>`;
    const saved = D.picks[g.id]?.[S.uid];
    const same = saved && saved.winner===d.winner && saved.margin===d.margin && saved.scorerId===d.scorerId;
    const missing = [!d.winner&&"taraf", !d.margin&&"fark", !d.scorerId&&"en skorer"].filter(Boolean);
    const st = d.saving ? `<span class="muted">Kaydediliyor…</span>` : d.err ? `<span class="no">${d.err}</span>`
      : same ? `<span class="saved">✓ Kaydedildi</span>` : missing.length ? `<span class="need">Eksik: ${missing.join(", ")}</span>`
      : saved ? `<span class="need">Değişiklik kaydedilmedi</span>` : `<span class="need">Kaydedilmedi</span>`;
    const canSave = !d.saving && !missing.length && !same;
    body += `<div class="g-foot">${st}<button class="linkish" data-act="info" data-g="${g.id}">Maç önü</button></div>
      <button class="save-btn" data-act="save" data-g="${g.id}" ${canSave?"":"disabled"}>${same?"✓ Kaydedildi":saved?"Değişikliği kaydet":"Tahmini kaydet"}</button>
      <div class="lock-note">${lockLeft(g)}</div>`;
  } else {
    const rows = S.order.map(u => { const p = D.picks[g.id]?.[u]; return p ? pickCell(g, p, u, D.daily[u]?.confGame===g.id) : `<div class="prow" style="--pc:${col(u)}"><span class="who">${esc(pname(u))}</span><span class="pk muted">tahmin yok</span><span class="pts">0</span></div>`; }).join("");
    body += `<div class="plist">${rows}</div>`;
    const tops = g.state==="post" ? topsOf(g) : liveTops(g);
    body += `<div class="g-foot"><span class="leaders">${tops?`En skorer: <b>${tops.map(x=>esc(x.name)).join(", ")}</b> ${tops[0].pts} sayı`:""}</span><button class="linkish" data-act="box" data-g="${g.id}">İstatistikler</button></div>`;
  }
  const conf = !lock ? `<button class="conf-btn" data-act="conf" data-g="${g.id}" aria-pressed="${confHere}" ${confLocked&&!confHere?"disabled":""} title="Günün bankosu: kazanan doğruysa 2 puan, yanlışsa -1">★ ${confHere?"Banko":"Banko yap"}</button>`
    : confHere ? `<span class="conf-btn" aria-pressed="true">★ Banko</span>` : "";
  const dd = S.draft[g.id], sv = D.picks[g.id]?.[S.uid];
  const dirty = !lock && sv && dd && (dd.winner!==sv.winner || dd.margin!==sv.margin || dd.scorerId!==sv.scorerId);
  const missingCls = !lock && (!sv || dirty) ? " missing" : "";
  return `<article class="game ${g.state==="in"?"is-live":""}${missingCls}" data-gid="${g.id}">
    <div class="g-head"><span class="stt">${g.state==="in"?'<span class="badge-live">Canlı</span> ':""}${gameStatusTR(g)}</span>${conf}</div>${body}</article>`;
}
function renderGames(){
  const D = S.days[S.day];
  if(!D){ $("#games").innerHTML = `<div class="note">Maçlar yükleniyor.</div>`; return; }
  $("#games").innerHTML = D.games.map(gameCard).join("");
  // açılış animasyonu bir kez oynasın
  let changed=false;
  for(const g of D.games) if(started(g) && !S.seen.has(g.id)){ S.seen.add(g.id); changed=true; }
  if(changed) try{ localStorage.setItem("seenReveal", JSON.stringify([...S.seen].slice(-400))); }catch(e){}
}
$("#games").addEventListener("click", e => {
  const b = e.target.closest("[data-act]"); if(!b || b.disabled) return;
  const D = S.days[S.day]; const g = D.games.find(x=>x.id===b.dataset.g); if(!g) return;
  const d = draftFor(g);
  const act = b.dataset.act;
  if(act==="info") return openInfo(g);
  if(act==="box") return openBox(g);
  if(started(g)) return toast("Tahmin kilitlendi (maçtan 10 dk önce kapanır).");
  if(act==="save") return savePick(g);
  if(act==="win"){ d.winner=b.dataset.v; }
  if(act==="mar"){ d.margin=b.dataset.v; }
  if(act==="scorer") return openPlayerPicker({mode:"game", g});
  if(act==="conf"){
    const cur = D.daily[S.uid]?.confGame;
    if(cur===g.id) return toast("Bankoyu başka maça taşıyabilirsin; kaldırılamaz.");
    return saveDaily({confGame:g.id, confStart:g.start});
  }
  d.err=null; renderGames();
});


/* ====================================================== Günün tahminleri */
function lockLeft(g){
  const ms = g.start.getTime() - LOCK_MS - Date.now();
  if(ms<=0) return "Kilitlendi";
  const h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  return `Değiştirmek için ${h?h+" sa ":""}${m} dk var · ${timeTR(new Date(g.start.getTime()-LOCK_MS))}'de kilitlenir`;
}
function renderDayView(){
  const D = S.days[S.day]; const box=$("#dayView"); if(!box) return;
  if(!D){ box.innerHTML=`<div class="note">Yükleniyor.</div>`; return; }
  if(!D.games.length){ box.innerHTML=""; return; }
  const u = S.order.includes(S.viewFor) ? S.viewFor : S.uid;
  const prog = D.progress[u] || new Set();
  const count = D.games.filter(g => D.picks[g.id]?.[u] || prog.has(g.id)).length;
  const daily = D.daily[u];
  const firstLocked = D.games.some(started);
  let dp;
  if(u===S.uid || firstLocked) dp = daily?.dayPlayerName ? `Günün oyuncusu: <b>${esc(daily.dayPlayerName)}</b>` : "Günün oyuncusu seçilmedi";
  else dp = "Günün oyuncusu ilk maçtan 10 dk önce açılır";
  let html = `<div class="chips" id="dvSel">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>
    <div class="dv-head"><span><b style="color:${col(u)}">${esc(pname(u))}</b> · ${count}/${D.games.length} maç girdi</span><span class="muted">${dp}</span></div><div class="dv-list">`;
  for(const g of D.games){
    const p = D.picks[g.id]?.[u];
    const conf = daily?.confGame===g.id;
    const st = g.state==="in" ? `<span class="badge-live">Canlı</span> ${g.away.score??0}–${g.home.score??0}` : g.state==="post" ? `Bitti ${g.away.score}–${g.home.score}` : timeTR(g.start);
    let body;
    if(p && (u===S.uid || started(g))){
      const t = p.winner===g.home.abbr ? g.home : g.away;
      const r = scorePick(g, p, conf);
      const pts = (g.state==="post"||g.state==="in") ? `<span class="p" style="color:${r.pts>0?"var(--win)":r.pts<0?"var(--lose)":"var(--muted)"}">${r.pts>0?"+":""}${r.pts}</span>` : "";
      body = `<div class="dv-pick"><img src="${t.logo||""}" alt=""><div><div class="w">${esc(t.name)} ${conf?'<span class="star">★</span>':""}</div><div class="m">${p.margin} fark · ${esc(p.scorerName)}</div></div>${pts}</div>`;
    } else if(u!==S.uid && !started(g)){
      body = `<div class="dv-hidden">${prog.has(g.id)?"<b>✓ Girdi</b> · ":"Henüz girmedi · "}seçim ${timeTR(new Date(g.start.getTime()-LOCK_MS))}'de açılır</div>`;
    } else {
      body = `<div class="dv-hidden">${started(g)?"Tahmin girilmedi":"Henüz kaydedilmedi"}</div>`;
    }
    html += `<div class="dv" style="--pc:${col(u)}"><div class="dv-top"><img src="${g.away.logo||""}" alt="">${esc(g.away.name)} @ <img src="${g.home.logo||""}" alt="">${esc(g.home.name)}<span class="t">${st}</span></div>${body}</div>`;
  }
  box.innerHTML = html + `</div>`;
  $("#dvSel").onclick = e => { const c=e.target.closest(".chip"); if(!c) return; S.viewFor=c.dataset.v; renderDayView(); };
}
$("#subSel").addEventListener("click", e => {
  const b=e.target.closest("button"); if(!b) return; S.sub=b.dataset.v;
  $$("#subSel button").forEach(x=>x.setAttribute("aria-pressed", x===b));
  $("#subMaclar").classList.toggle("hide", S.sub!=="maclar");
  $("#subTahminler").classList.toggle("hide", S.sub!=="tahminler");
  render();
});

/* ====================================================== oyuncu seçici */
async function openPlayerPicker({mode, g}){
  const D = S.days[S.day];
  const games = mode==="game" ? [g] : D.games.filter(x=>!started(x));
  openSheet(`<h3 id="shTitle">${mode==="game"?"Maçın en skoreri":"Günün oyuncusu"}</h3><p class="muted">Yükleniyor…</p>`);
  let list = [];
  try{
    const teams = games.flatMap(x=>[x.away, x.home]);
    const rs = await Promise.all(teams.map(t=>loadRoster(t).catch(()=>[])));
    list = rs.flat();
  }catch(e){}
  list.forEach(p => p.ppg = ppg(p.id));
  list.sort((a,b)=>(b.ppg??-1)-(a.ppg??-1) || a.name.localeCompare(b.name));
  const cur = mode==="game" ? draftFor(g).scorerId : D.daily[S.uid]?.dayPlayerId;
  const teamsChips = mode==="game" ? `<div class="chips" id="tmF"><button class="chip" data-v="" aria-pressed="true">İkisi</button><button class="chip" data-v="${g.away.abbr}" aria-pressed="false">${esc(g.away.name)}</button><button class="chip" data-v="${g.home.abbr}" aria-pressed="false">${esc(g.home.name)}</button></div>` : "";
  const injTxt = s => !s ? "" : /out/i.test(s) ? `<span class="inj">Oynamıyor</span>` : `<span class="inj q">${/day/i.test(s)?"Belirsiz":esc(s)}</span>`;
  const row = p => `<button class="plr" data-id="${p.id}" data-name="${esc(p.name)}" data-team="${p.team}" aria-pressed="${p.id===cur}">
    <img src="${p.img}" alt="" loading="lazy"><span class="pi"><b>${esc(p.name)}${injTxt(p.inj)}</b><small>${p.team} · ${p.pos}${p.jersey?" · #"+p.jersey:""}</small></span>
    <span class="ppg">${p.ppg!=null?p.ppg.toFixed(1):"–"}<small>sayı ort.</small></span></button>`;
  $("#shBody").innerHTML = `<h3 id="shTitle">${mode==="game"?"Maçın en skoreri":"Günün oyuncusu"}</h3>${teamsChips}
    <input class="search" id="plSearch" placeholder="Oyuncu ara" autocomplete="off"><div id="plList">${list.length?list.map(row).join(""):'<p class="muted">Kadro alınamadı.</p>'}</div>`;
  let tf="";
  const filter = () => { const q=slug($("#plSearch").value); $$("#plList .plr").forEach(el=>{ el.classList.toggle("hide", (tf && el.dataset.team!==tf) || (q && !slug(el.dataset.name).includes(q))); }); };
  $("#plSearch").oninput = filter;
  $("#tmF")?.addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(!c) return; tf=c.dataset.v; $$("#tmF .chip").forEach(x=>x.setAttribute("aria-pressed", x===c)); filter(); });
  $("#plList").onclick = e => {
    const b = e.target.closest(".plr"); if(!b) return;
    closeSheet();
    if(mode==="game"){
      if(started(g)) return toast("Tahmin kilitlendi (maçtan 10 dk önce kapanır).");
      const d=draftFor(g); d.scorerId=b.dataset.id; d.scorerName=b.dataset.name; d.err=null; renderGames();
    } else {
      if(D.games.some(started)) return toast("Günün oyuncusu kilitlendi (ilk maçtan 10 dk önce kapanır).");
      saveDaily({dayPlayerId:b.dataset.id, dayPlayerName:b.dataset.name});
    }
  };
}

/* ====================================================== maç önü ve kutu skoru */
async function openInfo(g){
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><p class="muted">Yükleniyor…</p>`);
  let s; try{ s = await loadSummary(g); }catch(e){ $("#shBody").innerHTML += `<div class="note">Maç önü bilgisine şu an ulaşılamıyor.</div>`; return; }
  const teamSec = side => {
    const t=g[side];
    const l5 = (s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[];
    const inj = (s.injuries||[]).find(x=>x.team?.abbreviation===t.abbr)?.injuries||[];
    const ld = (s.leaders||[]).find(x=>x.team?.abbreviation===t.abbr)?.leaders||[];
    const pts = ld.find(x=>/points/i.test(x.name))?.leaders?.[0];
    const reb = ld.find(x=>/rebounds/i.test(x.name))?.leaders?.[0];
    const ast = ld.find(x=>/assists/i.test(x.name))?.leaders?.[0];
    return `<div class="box"><h4 style="margin:0 0 8px;display:flex;gap:8px;align-items:center"><img src="${t.logo}" alt="" width="26" height="26">${esc(t.name)} <small class="muted">${t.rec}</small></h4>
      <div class="row-lbl">Son 5 maç</div><div class="l5">${l5.map(e=>`<span class="${e.gameResult}" title="${esc(e.atVs||"")} ${esc(e.opponent?.abbreviation||"")} ${esc(e.score||"")}">${e.gameResult==="W"?"G":"M"}</span>`).join("")||'<span class="muted">–</span>'}</div>
      <div class="row-lbl">Öne çıkanlar (maç başı)</div><div style="font-size:14px">${[pts&&`${esc(pts.athlete.displayName)} ${pts.displayValue} sayı`,reb&&`${esc(reb.athlete.displayName)} ${reb.displayValue} ribaund`,ast&&`${esc(ast.athlete.displayName)} ${ast.displayValue} asist`].filter(Boolean).join("<br>")||"–"}</div>
      <div class="row-lbl">Sakatlar</div><div style="font-size:14px">${inj.length?inj.slice(0,6).map(i=>`${esc(i.athlete?.displayName)} <span class="inj ${/out/i.test(i.status)?"":"q"}">${/out/i.test(i.status)?"Oynamıyor":"Belirsiz"}</span>`).join("<br>"):'<span class="muted">Bildirilen yok</span>'}</div></div>`;
  };
  const pr = s.predictor; let pred="";
  if(pr?.homeTeam?.gameProjection){
    const h=+pr.homeTeam.gameProjection, a=+pr.awayTeam.gameProjection;
    pred = `<div class="box"><div class="row-lbl" style="margin-top:0">ESPN kazanma olasılığı</div><div class="pred"><i style="width:${a}%;background:var(--p0)"></i><i style="width:${h}%;background:var(--p1)"></i></div>
      <div style="display:flex;justify-content:space-between;font-weight:700;font-size:14px"><span>${esc(g.away.name)} %${a.toFixed(0)}</span><span>${esc(g.home.name)} %${h.toFixed(0)}</span></div></div>`;
  }
  $("#shBody").innerHTML = `<h3 id="shTitle">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><p class="muted" style="margin-top:-6px">${dayNice(S.day,{day:"numeric",month:"long"})} · ${timeTR(g.start)}</p>${pred}${teamSec("away")}${teamSec("home")}`;
}
async function openBox(g){
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} ${g.away.score??""} – ${g.home.score??""} ${esc(g.home.name)}</h3><p class="muted">Yükleniyor…</p>`);
  let s; try{ s = await loadSummary(g, g.state==="in"); }catch(e){ $("#shBody").innerHTML += `<div class="note">İstatistiklere şu an ulaşılamıyor.</div>`; return; }
  const bp = boxPlayers(s);
  const top = Math.max(0,...bp.map(p=>p.pts));
  const table = side => {
    const t=g[side], rows=bp.filter(p=>p.team===t.abbr).sort((a,b)=>b.pts-a.pts);
    return `<div class="box"><h4 style="margin:0 0 6px;display:flex;gap:8px;align-items:center"><img src="${t.logo}" alt="" width="24" height="24">${esc(t.name)} <span class="big" style="margin-left:auto">${t.score??""}</span></h4>
      <div style="overflow-x:auto"><table class="bx"><thead><tr><th>Oyuncu</th><th>DK</th><th>SAY</th><th>RİB</th><th>AST</th><th>SA</th><th>3S</th><th>SB</th><th>+/-</th></tr></thead><tbody>
      ${rows.map(p=>`<tr class="${p.pts===top?"top":""}"><td>${esc(p.name)}${p.starter?"":' <span class="muted">·</span>'}</td><td>${p.min}</td><td><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td><td>${p.fg}</td><td>${p.tp}</td><td>${p.ft}</td><td>${p.pm}</td></tr>`).join("")||'<tr><td colspan="9" class="muted">Henüz veri yok</td></tr>'}
      </tbody></table></div></div>`;
  };
  $("#shBody").innerHTML = `<h3 id="shTitle">${esc(g.away.name)} ${g.away.score??""} – ${g.home.score??""} ${esc(g.home.name)}</h3><p class="muted" style="margin-top:-6px">${gameStatusTR(g)} · SA: isabet-deneme, 3S: üçlük, SB: serbest atış</p>${table("away")}${table("home")}`;
}
function openSheet(html){ $("#shBody").innerHTML=html; $("#sheet").classList.remove("hide"); document.body.style.overflow="hidden"; $("#shClose").focus(); }
function closeSheet(){ $("#sheet").classList.add("hide"); document.body.style.overflow=""; }
$("#shClose").onclick = closeSheet;
$("#sheet").addEventListener("click", e => { if(e.target.id==="sheet") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key==="Escape") closeSheet(); });


/* ====================================================== Kurallar */
function openRules(){
  openSheet(`<div class="rules"><h3 id="shTitle">Kurallar</h3>
    <p>Her gece, o günün tüm NBA maçları için üç tahmin yapılır: <b>kazanan taraf</b>, <b>fark aralığı</b> ve <b>maçın en skoreri</b>. Üçü de zorunlu; doldurup "Tahmini kaydet"e basınca kaydedilir.</p>
    <h4>Puanlar</h4>
    <div class="pt"><span>Kazananı bilmek</span><b>1</b><span>Kazananla birlikte farkı da bilmek</span><b>+1</b><span>Maçın en skorerini bilmek</span><b>+1</b><span>Bir maçtan en fazla</span><b>3</b></div>
    <h4>Günün bankosu</h4>
    <p>Her gece bir maçı banko yaparsın. O maçta kazananı bilirsen 1 yerine <b>2 puan</b>, bilemezsen <b>-1</b>. Fark ve en skorer puanları normal sayılır. Banko başka bir maça taşınabilir ama kaldırılamaz.</p>
    <h4>Günün oyuncusu</h4>
    <p>Gecenin tüm maçlarından bir oyuncu seçersin. O gece en çok sayıyı o atarsa <b>+2</b>.</p>
    <h4>Fark aralıkları</h4>
    <p>1-5 · 6-10 · 11-15 · 16+. Uzatmaya giden maçta da son skordaki fark sayılır. Fark puanı yalnızca kazanan doğruysa geçerli.</p>
    <h4>Kilit ve gizlilik</h4>
    <p>Tahminler maç saatinden <b>10 dakika öncesine</b> kadar değiştirilebilir. Günün bankosu kendi maçından, günün oyuncusu ilk maçtan 10 dakika önce kilitlenir. Kilitlenene kadar rakiplerin seçimleri gizli; kimin hangi maçları girdiği ise "Günün tahminleri"nde görünür.</p>
    <h4>Eşitlikler</h4>
    <p>Birden fazla oyuncu aynı en yüksek sayıyı atarsa, bunlardan herhangi birini seçen bilmiş sayılır.</p>
    <h4>Gece, hafta, sezon</h4>
    <p>Gece: o gecenin en çok puanını tek başına alan kazanır. Hafta pazartesi–pazar. Sezon puanı tüm gecelerin toplamı. <b>Playoffta tüm puanlar 2 katı.</b></p>
    <h4>Yeni oyuncu</h4>
    <p>Siteye girip "Yeni oyuncu" sekmesinden ad, 6 haneli şifre ve davet koduyla katılınır.</p></div>`);
}
$("#rulesBtn").onclick = openRules;

/* ====================================================== SONUÇLAR */
async function renderResults(){
  const day = S.rday || S.day;
  const rel = day===S.today ? "Bugün" : day===shiftDay(S.today,-1) ? "Dün" : day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#rdLabel").innerHTML = rel ? `${rel}<small>${dayNice(day)} (ABD)</small>` : `${dayNice(day)}<small>ABD tarihi</small>`;
  const D = S.days[day];
  if(!D){ $("#results").innerHTML=`<div class="note">Maçlar yükleniyor.</div>`; loadDay(day).then(()=>{ if(S.tab==="sonuclar") renderResults(); }).catch(()=>{ $("#results").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor.</div>`; }); return; }
  if(!D.games.length){ $("#results").innerHTML=`<div class="note">Bu gün maç yok.</div>`; return; }
  const order={in:0,post:1,pre:2};
  const games=[...D.games].sort((a,b)=>(order[a.state]-order[b.state])||(a.start-b.start));
  $("#results").innerHTML = `<div class="res">${games.map(g=>{
    const tm = side => { const t=g[side], o=side==="home"?g.away:g.home; const lose=g.state==="post" && (t.score??0)<(o.score??0);
      return `<div class="rg-t ${lose?"lose":""}"><img src="${t.logo||""}" alt=""><span class="n">${esc(t.name)}<small>${t.rec}</small></span><span class="sc">${g.state==="pre"?"":t.score??""}</span></div>`; };
    const tops = g.state==="post" ? topsOf(g) : g.state==="in" ? liveTops(g) : null;
    const s = S.sums[g.id]?.data;
    let lead = "";
    if(s && g.state!=="pre"){
      const bp = boxPlayers(s);
      const best = side => { const arr=bp.filter(p=>p.team===g[side].abbr).sort((a,b)=>b.pts-a.pts)[0]; return arr?`${esc(g[side].name)}: <b>${esc(arr.name)}</b> ${arr.pts} sayı, ${arr.reb} rib, ${arr.ast} ast`:""; };
      lead = [best("away"),best("home")].filter(Boolean).join("<br>");
    } else if(tops){ lead = `En skorer: <b>${tops.map(t=>esc(t.name)).join(", ")}</b> ${tops[0].pts} sayı`; }
    return `<button class="rg ${g.state==="in"?"is-live":""}" data-g="${g.id}"><div class="rg-h"><span class="s">${g.state==="in"?'<span class="badge-live">Canlı</span> ':""}${gameStatusTR(g)}</span><span>${g.state==="pre"?"Türkiye saati":"İstatistikler ›"}</span></div>
      ${tm("away")}${tm("home")}${lead?`<div class="rg-l">${lead}</div>`:""}</button>`;
  }).join("")}</div>`;
  // biten maçların oyuncu istatistiklerini arka planda getir
  const need = games.filter(g=>g.state==="post" && !S.sums[g.id]);
  if(need.length) Promise.all(need.slice(0,15).map(g=>loadSummary(g).catch(()=>null))).then(()=>{ if(S.tab==="sonuclar" && (S.rday||S.day)===day) renderResults(); });
}
$("#results").addEventListener("click", e => {
  const b=e.target.closest(".rg"); if(!b) return;
  const D=S.days[S.rday||S.day]; const g=D?.games.find(x=>x.id===b.dataset.g); if(!g) return;
  if(g.state==="pre") return openInfo(g);
  openBox(g);
});
$("#rdPrev").onclick=()=>{ S.rday=shiftDay(S.rday||S.day,-1); renderResults(); };
$("#rdNext").onclick=()=>{ S.rday=shiftDay(S.rday||S.day,1); renderResults(); };

/* ====================================================== AYRIŞMA */
function renderAyrisma(){
  const D = S.days[S.day];
  $("#ayrDay").textContent = S.day ? dayNice(S.day,{day:"numeric",month:"long"}) : "";
  if(!D){ $("#ayrisma").innerHTML=`<div class="note">Yükleniyor.</div>`; return; }
  const st = D.games.filter(started), pending = D.games.length - st.length;
  const items = st.map(g => {
    const picks = S.order.map(u=>[u, D.picks[g.id]?.[u]]).filter(x=>x[1]);
    const sides = new Set(picks.map(x=>x[1].winner));
    return {g, picks, split: sides.size>1};
  }).filter(x=>x.split);
  const sideBox = (g, side, picks) => {
    const t=g[side], ps=picks.filter(x=>x[1].winner===t.abbr);
    return `<div><div class="tm"><img src="${t.logo}" alt="">${esc(t.name)} ${g.state!=="pre"?`<span class="big" style="margin-left:auto;font-size:20px">${t.score??""}</span>`:""}</div>
      ${ps.map(([u,p])=>`<span class="nm" style="color:${col(u)}">${esc(pname(u))}${D.daily[u]?.confGame===g.id?' <span class="star">★</span>':""}</span><small class="muted">${p.margin} · ${esc(p.scorerName)}</small>`).join("")||'<small class="muted">kimse</small>'}</div>`;
  };
  let html = items.length ? `<div class="split">${items.map(({g,picks})=>{
      const st = g.state==="in"?`<span class="badge-live">Canlı</span> ${gameStatusTR(g)}`:gameStatusTR(g);
      return `<div class="box"><h4><img src="${g.away.logo}" alt="">${esc(g.away.name)} @ <img src="${g.home.logo}" alt="">${esc(g.home.name)}<small class="muted" style="margin-left:auto;font-weight:600">${st}</small></h4>
        <div class="side-col">${sideBox(g,"away",picks)}${sideBox(g,"home",picks)}</div></div>`;
    }).join("")}</div>` : `<div class="note">${st.length?"Başlamış maçlarda hepiniz aynı tarafı seçtiniz.":"Henüz başlamış maç yok."}</div>`;
  if(pending) html += `<div class="note">${pending} maçın seçimleri, maç başlayınca açılacak ve ayrıştığınız maçlar buraya düşecek.</div>`;
  $("#ayrisma").innerHTML = html;
}

/* ====================================================== PUAN */
// Yalnızca en az bir oyuncunun tahmin girdiği geceler
function allDays(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d]?.games.some(started)) days.add(d);
  return [...days].filter(d => { const p=dayPoints(d); return S.order.some(u=>p[u]?.n); }).sort().reverse();
}
function renderPuan(){
  const tot = seasonTotals();
  const days = allDays();
  const dayRows = days.map(d => ({d, pts: dayPoints(d)}));
  const wins = {}, wks = {}; S.order.forEach(u=>{wins[u]=0; wks[u]=0;});
  for(const {pts} of dayRows){
    const vals = S.order.map(u=>pts[u]?.pts??null).filter(v=>v!=null);
    if(!vals.length || S.order.some(u=>pts[u] && !pts[u].final)) continue;
    const best = Math.max(...vals); const w = S.order.filter(u=>pts[u]?.pts===best);
    if(w.length===1) wins[w[0]]++;
  }
  const curWk = weekKey(S.today);
  for(const [wk,row] of Object.entries(S.arch.scores.weeks||{})){
    if(wk===curWk) continue;
    const best=Math.max(...Object.values(row)); const w=Object.keys(row).filter(u=>row[u]===best);
    if(w.length===1 && wks[w[0]]!==undefined) wks[w[0]]++;
  }
  const ranked=[...S.order].sort((a,b)=>tot[b]-tot[a]);
  let html = `<div class="sec-title"><h2>Puan tablosu</h2><span class="aside">sezon</span></div>
    <div class="tbl"><div class="tr th t-lb"><span>#</span><span>Oyuncu</span><span class="r">Puan</span><span class="c">Gece</span><span class="c">Hafta</span></div>
    ${ranked.map((u,i)=>`<div class="tr t-lb"><span class="muted">${i+1}</span><span class="pn"><i style="background:${col(u)}"></i><span>${esc(pname(u))}</span></span><span class="r big tnum">${tot[u]}</span><span class="c tnum">${wins[u]}</span><span class="c tnum">${wks[u]}</span></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:6px 2px">Gece: tek başına en çok puan alınan gece sayısı. Hafta: kazanılan haftalar (pazartesi–pazar).</p>`;

  // bu hafta
  const wk = weekKey(S.today);
  const wkDays = dayRows.filter(x=>weekKey(x.d)===wk).reverse();
  if(wkDays.length){
    const wt={}; S.order.forEach(u=>wt[u]=wkDays.reduce((s,x)=>s+(x.pts[u]?.pts||0),0));
    html += `<div class="sec-title"><h2>Bu hafta</h2><span class="aside">${dayNice(wk,{day:"numeric",month:"short"})}'den beri</span></div>
      <div class="box"><div style="display:flex;flex-wrap:wrap;gap:6px 18px">${[...S.order].sort((a,b)=>wt[b]-wt[a]).map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))} <span class="big tnum">${wt[u]}</span></span>`).join("")}</div></div>`;
  }

  // rekorlar
  let bestNight=null, streak={}, maxStreak={};
  S.order.forEach(u=>{streak[u]=0; maxStreak[u]=0;});
  for(const {d,pts} of [...dayRows].reverse()){
    if(S.order.some(u=>pts[u] && !pts[u].final)) continue; // süren gece rekora sayılmaz
    for(const u of S.order){ const p=pts[u]?.pts; if(p!=null && (!bestNight||p>bestNight.p)) bestNight={u,p,d}; }
    const vals=S.order.map(u=>pts[u]?.pts??-99); const best=Math.max(...vals); const w=S.order.filter(u=>(pts[u]?.pts??-99)===best);
    for(const u of S.order){ if(w.length===1 && w[0]===u){ streak[u]++; maxStreak[u]=Math.max(maxStreak[u],streak[u]); } else streak[u]=0; }
  }
  if(bestNight){
    const ms = S.order.map(u=>[u,maxStreak[u]]).sort((a,b)=>b[1]-a[1])[0];
    html += `<div class="sec-title"><h2>Rekorlar</h2></div><div class="cards2">
      <div class="kpi"><b>${bestNight.p}</b><small>En iyi gece: <span style="color:${col(bestNight.u)};font-weight:700">${esc(pname(bestNight.u))}</span>, ${dayNice(bestNight.d,{day:"numeric",month:"short"})}</small></div>
      <div class="kpi"><b>${ms[1]}</b><small>Üst üste kazanılan gece: <span style="color:${col(ms[0])};font-weight:700">${esc(pname(ms[0]))}</span></small></div>
      ${S.order.map(u=>`<div class="kpi"><b>${streak[u]}</b><small><span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span> şu anki gece serisi</small></div>`).join("")}</div>`;
  }

  // gün gün
  html += `<div class="sec-title"><h2>Gece gece</h2><span class="aside">dokun, o geceye git</span></div><div class="daylist">` +
    (dayRows.length ? dayRows.map(({d,pts})=>{
      const vals=S.order.map(u=>pts[u]?.pts??null); const best=Math.max(...vals.filter(v=>v!=null));
      const w=S.order.filter(u=>pts[u]?.pts===best);
      const prov = S.order.some(u=>pts[u] && !pts[u].final);
      return `<button class="dayrow" data-day="${d}"><span class="d">${dayNice(d,{day:"numeric",month:"short",weekday:"short"})}</span>
        <span class="sc">${S.order.map(u=>`<span style="color:${col(u)}">${esc(pname(u))} ${pts[u]?.pts??0}</span>`).join("")}</span>
        <span class="w">${prov?"sürüyor":w.length===1?esc(pname(w[0])):"berabere"}</span></button>`;
    }).join("") : `<div class="note">İlk gecenin puanları maçlar bitince burada görünecek.</div>`) + `</div>`;
  $("#puan").innerHTML = html;
}
$("#puan").addEventListener("click", e => { const b=e.target.closest("[data-day]"); if(!b) return; S.day=b.dataset.day; location.hash="#tahmin"; showDay(); });

/* ====================================================== İSTATİSTİK */
function renderStats(){
  const u = S.statFor && S.order.includes(S.statFor) ? S.statFor : S.uid || S.order[0];
  if(!u){ $("#istatistik").innerHTML=`<div class="note">Henüz oyuncu yok.</div>`; return; }
  // arşiv + canlı günler
  const recs=[];
  for(const [gid,row] of Object.entries(S.arch.scores.games||{})){ const r=row[u]; const g=S.arch.games[gid]; if(r?.pick && g) recs.push({g:{home:g.home,away:g.away,winner:g.winner}, r}); }
  for(const day of [S.today, shiftDay(S.today,-1)]){
    const D=S.days[day]; if(!D || S.arch.scores.days?.[day]) continue;
    for(const g of D.games){ if(g.state!=="post") continue; const p=D.picks[g.id]?.[u]; if(!p) continue;
      const r=scorePick(g,p,D.daily[u]?.confGame===g.id); recs.push({g:{home:g.home,away:g.away,winner:(g.home.score>g.away.score?g.home.abbr:g.away.abbr)}, r:{...r,c:D.daily[u]?.confGame===g.id,pick:{w:p.winner}}}); }
  }
  const n=recs.length;
  const wOk=recs.filter(x=>x.r.w>0).length, mOk=recs.filter(x=>x.r.m>0).length, sOk=recs.filter(x=>x.r.s>0).length;
  const conf=recs.filter(x=>x.r.c); const cOk=conf.filter(x=>x.r.w>0).length;
  const dps=Object.values(S.arch.scores.days||{}).map(d=>d[u]).filter(x=>x?.dpName); const dpHit=dps.filter(x=>x.dp>0).length;
  const pct=(a,b)=>b?Math.round(a/b*100):0;
  const totals={taraf:recs.reduce((s,x)=>s+Math.max(0,x.r.w)-(x.r.w<0?1:0),0), fark:mOk, skorer:sOk, oyuncu:dpHit*2};
  // takımlar: o takımın maçlarında kazananı bilme oranı
  const tm={};
  for(const {g,r} of recs) for(const t of [g.home,g.away]){ const k=t.abbr; tm[k]=tm[k]||{n:0,ok:0,logo:null}; tm[k].n++; if(r.w>0) tm[k].ok++; }
  const tl=Object.entries(tm).filter(([,v])=>v.n>=3).map(([k,v])=>({k,...v,p:v.ok/v.n}));
  const best=[...tl].sort((a,b)=>b.p-a.p||b.n-a.n).slice(0,4), worst=[...tl].sort((a,b)=>a.p-b.p||b.n-a.n).slice(0,4);
  const logo = abbr => LOGO_SMALL(abbr);
  const kpi=(v,l,c)=>`<div class="kpi"><b>${v}</b><small>${l}</small>${c!=null?`<div class="bar2"><i style="width:${c}%;background:${col(u)}"></i></div>`:""}</div>`;
  let html = `<div class="chips" id="statSel" style="margin-top:4px">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>`;
  if(!n){ $("#istatistik").innerHTML = html+`<div class="note">İlk maçlar bitince istatistikler burada görünecek.</div>`; bindStatSel(); return; }
  html += `<div class="sec-title"><h2>İsabet</h2><span class="aside">${n} maç</span></div><div class="cards2">
    ${kpi("%"+pct(wOk,n),`Kazanan (${wOk}/${n})`,pct(wOk,n))}
    ${kpi("%"+pct(mOk,wOk),`Fark, kazananı bildiğinde (${mOk}/${wOk})`,pct(mOk,wOk))}
    ${kpi("%"+pct(sOk,n),`En skorer (${sOk}/${n})`,pct(sOk,n))}
    ${kpi(`${cOk}–${conf.length-cOk}`,`Banko (net ${cOk*2-(conf.length-cOk)>0?"+":""}${cOk*2-(conf.length-cOk)})`,null)}
    ${kpi(`${dpHit}/${dps.length}`,"Günün oyuncusu",null)}
    ${(()=>{ const ds=allDays().filter(d=>dayPoints(d)[u]?.n); const t=ds.reduce((s,d)=>s+(dayPoints(d)[u]?.pts||0),0); return kpi(ds.length?(t/ds.length).toFixed(1):"–",`Gece başına ortalama puan (${ds.length} gece)`,null); })()}</div>`;
  const tmax=Math.max(1,...Object.values(totals));
  html += `<div class="sec-title"><h2>Puanlar nereden geliyor</h2></div><div class="box">${[["Taraf (banko dahil)",totals.taraf],["Fark",totals.fark],["En skorer",totals.skorer],["Günün oyuncusu",totals.oyuncu]].map(([l,v])=>`<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span>${l}</span><b>${v}</b></div><div class="bar2"><i style="width:${Math.max(0,v)/tmax*100}%;background:${col(u)}"></i></div></div>`).join("")}</div>`;
  if(tl.length){
    const tbl=(t,arr)=>`<div class="box"><h4 style="margin:0 0 4px">${t}</h4>${arr.map(x=>`<div class="trow3"><img src="${logo(x.k)}" alt=""><span>${x.k} <small class="muted">${x.ok}/${x.n}</small></span><b style="text-align:right">%${Math.round(x.p*100)}</b></div>`).join("")}</div>`;
    html += `<div class="sec-title"><h2>Takımlar</h2><span class="aside">en az 3 maç</span></div><div class="split" style="grid-template-columns:1fr 1fr;display:grid;gap:8px">${tbl("En iyi okuduğun",best)}${tbl("En çok yanıldığın",worst)}</div>`;
  }
  // kafa kafaya
  if(S.order.length>=2){
    const days=allDays(); const h2h={}; S.order.forEach(x=>h2h[x]=0); let ties=0;
    for(const d of days){ const p=dayPoints(d); if(S.order.some(x=>p[x] && !p[x].final)) continue; const v=S.order.map(x=>p[x]?.pts??0); const m=Math.max(...v); const w=S.order.filter(x=>(p[x]?.pts??0)===m); if(w.length===1) h2h[w[0]]++; else ties++; }
    html += `<div class="sec-title"><h2>Kafa kafaya</h2><span class="aside">kazanılan geceler</span></div><div class="box"><div style="display:flex;flex-wrap:wrap;gap:6px 18px;align-items:baseline">${S.order.map(x=>`<span class="pn"><i style="background:${col(x)}"></i>${esc(pname(x))} <span class="big tnum">${h2h[x]}</span></span>`).join("")}<span class="muted">berabere ${ties}</span></div></div>`;
  }
  $("#istatistik").innerHTML = html; bindStatSel();
}
function bindStatSel(){ $("#statSel")?.addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(!c) return; S.statFor=c.dataset.v; renderStats(); }); }

/* ====================================================== gece özeti (paylaşılabilir görsel) */
async function nightSummary(){
  const D=S.days[S.day]; const pts=dayPoints(S.day);
  const W=1080, H=1350, c=document.createElement("canvas"); c.width=W; c.height=H; const x=c.getContext("2d");
  await document.fonts.ready;
  x.fillStyle="#121a24"; x.fillRect(0,0,W,H);
  x.fillStyle="#e09410"; x.fillRect(0,0,W,14);
  x.fillStyle="#8b98a8"; x.font="600 38px Barlow"; x.fillText("NBA Tahmin · Gece özeti", 70, 110);
  x.fillStyle="#f4f6f8"; x.font="800 72px 'Barlow Condensed'"; x.fillText(dayNice(S.day), 70, 190);
  const cols=["#7ea2f6","#f2737f","#4fd0aa","#b38cf5","#f0a35c","#5cc6ec"];
  const ranked=[...S.order].sort((a,b)=>(pts[b]?.pts||0)-(pts[a]?.pts||0));
  let y=300;
  ranked.slice(0,4).forEach((u,i)=>{
    x.fillStyle="#1b2633"; x.beginPath(); x.roundRect(70,y,W-140,150,26); x.fill();
    x.fillStyle=cols[S.colorOrder.indexOf(u)%6]; x.font="700 56px 'Barlow Condensed'"; x.fillText(pname(u), 110, y+92);
    x.fillStyle="#f4f6f8"; x.font="800 110px 'Barlow Condensed'"; x.textAlign="right"; x.fillText(String(pts[u]?.pts??0), W-110, y+112); x.textAlign="left";
    if(i===0 && (pts[ranked[1]]?.pts??-1)<(pts[u]?.pts??0)){ x.fillStyle="#e09410"; x.font="700 30px Barlow"; x.fillText("GECENİN KAZANANI", 110, y+132); }
    y+=172;
  });
  // en iyi tahmin: en çok puan getiren tek maç
  let best=null;
  for(const g of D.games) for(const u of S.order){ const p=D.picks[g.id]?.[u]; if(!p) continue; const r=scorePick(g,p,D.daily[u]?.confGame===g.id); if(!best||r.pts>best.r.pts) best={g,u,p,r}; }
  y+=20; x.fillStyle="#8b98a8"; x.font="600 34px Barlow";
  if(best){ x.fillText("Gecenin tahmini", 70, y); x.fillStyle="#f4f6f8"; x.font="700 44px Barlow";
    const t=best.p.winner===best.g.home.abbr?best.g.home.name:best.g.away.name;
    x.fillText(`${pname(best.u)}: ${t} ${best.p.margin}, ${best.p.scorerName}`.slice(0,46), 70, y+58);
    x.fillStyle="#4fd093"; x.fillText(`+${best.r.pts} puan`, 70, y+116); y+=170; }
  const tops=D.games.map(g=>topsOf(g)?.[0]).filter(Boolean).sort((a,b)=>b.pts-a.pts)[0];
  if(tops){ x.fillStyle="#8b98a8"; x.font="600 34px Barlow"; x.fillText("Gecenin en skoreri", 70, y); x.fillStyle="#f4f6f8"; x.font="700 44px Barlow"; x.fillText(`${tops.name} · ${tops.pts} sayı`, 70, y+58); }
  x.fillStyle="#8b98a8"; x.font="500 28px Barlow"; x.fillText((location.host+location.pathname).replace(/index\.html$/,""), 70, H-60);
  const blob=await new Promise(r=>c.toBlob(r,"image/png"));
  const file=new File([blob],`gece-ozeti-${S.day}.png`,{type:"image/png"});
  if(navigator.canShare?.({files:[file]})){ try{ await navigator.share({files:[file], title:"Gece özeti"}); return; }catch(e){ if(e.name==="AbortError") return; } }
  const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=file.name; a.click(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
}

/* ====================================================== gezinme ve yenileme */
function render(){
  if(!S.uid) return;
  renderBoard();
  $("#navLive").classList.toggle("hide", !(S.days[S.today]?.games.some(g=>g.state==="in")));
  if(S.tab==="tahmin"){ renderDayLabel(); renderStatus(); if(S.sub==="maclar"){ renderDayPlayer(); renderGames(); } else renderDayView(); }
  if(S.tab==="sonuclar") renderResults();
  if(S.tab==="ayrisma") renderAyrisma();
  if(S.tab==="puan") renderPuan();
  if(S.tab==="istatistik") renderStats();
}
function route(){
  const t=(location.hash||"#tahmin").slice(1);
  S.tab=["tahmin","sonuclar","ayrisma","puan","istatistik"].includes(t)?t:"tahmin";
  $$("[data-view]").forEach(v=>v.classList.toggle("hide", v.id!=="view-"+S.tab));
  $$(".nav a").forEach(a=>a.dataset.tab===S.tab?a.setAttribute("aria-current","page"):a.removeAttribute("aria-current"));
  render();
}
window.addEventListener("hashchange", ()=>{ route(); scrollTo({top:0}); });
async function showDay(){
  S.draft={}; renderDayLabel(); $("#games").innerHTML=`<div class="note">Maçlar yükleniyor.</div>`; $("#dayStatus").innerHTML=""; $("#dayPlayer").innerHTML="";
  try{ await loadDay(S.day, {force:true}); }catch(e){ $("#games").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor. Biraz sonra tekrar dene.</div>`; return; }
  render();
}
$("#dayPrev").onclick=()=>{ S.day=shiftDay(S.day,-1); showDay(); };
$("#dayNext").onclick=()=>{ S.day=shiftDay(S.day,1); showDay(); };

async function loadArchive(){
  const base = (() => { const h=location.hostname; if(!h.endsWith(".github.io")) return "data/";
    const owner=h.split(".")[0], seg=location.pathname.split("/").filter(Boolean)[0];
    return `https://raw.githubusercontent.com/${owner}/${seg && !seg.includes(".")?seg:h}/main/data/`; })();
  const get = async n => { try{ return await getJSON(base+n+"?t="+Date.now()); }catch(e){ return getJSON("data/"+n+"?t="+Date.now()).catch(()=>null); } };
  const [g,p,s] = await Promise.all([get("games.json"), get("players.json"), get("scores.json")]);
  if(g) S.arch.games=g; if(p) S.pstats=p.p||{}; if(s) S.arch.scores={days:{},games:{},totals:{},weeks:{},...s};
}
async function refresh(){
  const jobs=[loadDay(S.today,{force:true})];
  if(S.tab==="sonuclar" && S.rday && S.rday!==S.today) jobs.push(loadDay(S.rday,{force:true}));
  if(S.day!==S.today) jobs.push(loadDay(S.day,{force:true}));
  // dün henüz arşive (tüm oyuncular için) girmediyse canlı hesap için yükle
  const yd=shiftDay(S.today,-1), archYd=S.arch.scores.days?.[yd];
  if(!archYd || S.order.some(u=>!archYd[u])) jobs.push(loadDay(yd).catch(()=>null));
  await Promise.allSettled(jobs);
  render(); schedule();
}
function schedule(){
  clearTimeout(S.timer);
  const live = Object.values(S.days).some(D=>D.games.some(g=>g.state==="in"));
  S.timer=setTimeout(refresh, document.hidden?10*60e3: live?30e3: 3*60e3);
}
document.addEventListener("visibilitychange", ()=>{ if(!document.hidden && S.uid) refresh(); });
new IntersectionObserver(([e])=>{ const on=!e.isIntersecting && !!$("#mini").innerHTML; $("#mini").classList.toggle("show",on); $(".topbar").classList.toggle("scrolled",on); },{rootMargin:"-52px 0px 0px 0px"}).observe($("#board"));

/* ====================================================== giriş */
let authMode="login";
$("#authMode").addEventListener("click", e=>{
  const c=e.target.closest(".chip"); if(!c) return; authMode=c.dataset.v;
  $$("#authMode .chip").forEach(x=>x.setAttribute("aria-pressed",x===c));
  $("#fInvite").classList.toggle("hide", authMode!=="join");
  $("#inPin").autocomplete = authMode==="join"?"new-password":"current-password";
  $("#authBtn").textContent = authMode==="join"?"Oyuna katıl":"Giriş yap";
  $("#authErr").textContent="";
});
const AUTH_ERR = {
  "auth/invalid-credential":"Ad ya da şifre yanlış.", "auth/wrong-password":"Ad ya da şifre yanlış.", "auth/user-not-found":"Bu adla oyuncu yok. Yeni oyuncu sekmesinden katıl.",
  "auth/email-already-in-use":"Bu ad alınmış. Giriş sekmesinden gir ya da başka bir ad seç.", "auth/too-many-requests":"Çok fazla deneme oldu. Birkaç dakika sonra tekrar dene.",
  "auth/network-request-failed":"İnternet bağlantısı yok gibi görünüyor."
};
$("#authForm").addEventListener("submit", async e=>{
  e.preventDefault();
  const name=$("#inName").value.trim(), pin=$("#inPin").value.trim(), inv=$("#inInvite").value.trim();
  const err=t=>{$("#authErr").textContent=t;};
  if(!slug(name)) return err("Adında en az bir harf ya da rakam olmalı.");
  if(!/^\d{6}$/.test(pin)) return err("Şifre 6 rakam olmalı.");
  if(authMode==="join" && !inv) return err("Davet kodunu gir.");
  const email=`${slug(name)}@${S.cfg.authEmailDomain}`;
  $("#authBtn").disabled=true; err("");
  try{
    if(authMode==="login"){ await signInWithEmailAndPassword(S.auth, email, pin); }
    else{
      const cred=await createUserWithEmailAndPassword(S.auth, email, pin);
      try{
        const b=writeBatch(S.db);
        b.set(doc(S.db,"joins",cred.user.uid),{invite:inv});
        b.set(doc(S.db,"players",cred.user.uid),{name, joined:serverTimestamp()});
        await b.commit();
      }catch(x){ await cred.user.delete().catch(()=>{}); throw {code:"invite"}; }
    }
  }catch(x){ err(x.code==="invite"?"Davet kodu yanlış.":AUTH_ERR[x.code]||"Giriş yapılamadı, tekrar dene."); }
  $("#authBtn").disabled=false;
});
$("#me").onclick=()=>{
  openSheet(`<h3 id="shTitle">${esc(pname(S.uid))}</h3><p class="muted">Bu cihazda girişli kalırsın. Başka cihazda adın ve şifrenle girebilirsin.</p>
    <button class="btn" id="logout" style="margin-top:12px">Çıkış yap</button>`);
  $("#logout").onclick=async()=>{ closeSheet(); await signOut(S.auth); };
};

/* ====================================================== başlangıç */
(async()=>{
  let ok=false;
  try{ ok = await initFirebase(); }catch(e){ console.error(e); }
  if(!ok){ $("#auth").classList.remove("hide"); $("#authForm").innerHTML=`<div class="note">Kurulum bekleniyor: config.json içine Firebase bilgileri girilince oyun açılacak.</div>`; return; }
  S.today = espnToday(); S.day = S.today;
  await Promise.all([loadPlayers().catch(()=>{}), loadArchive().catch(()=>{})]);
  onAuthStateChanged(S.auth, async user=>{
    if(!user){ S.uid=null; $("#app").classList.add("hide"); $("#me").classList.add("hide"); $("#auth").classList.remove("hide"); return; }
    S.uid=user.uid;
    await loadPlayers().catch(()=>{});
    if(!S.players[S.uid]){ // kayıt yarıda kaldıysa
      await new Promise(r=>setTimeout(r,800)); await loadPlayers().catch(()=>{});
      if(!S.players[S.uid]){ $("#authErr").textContent="Hesap bulunamadı. Tekrar katılmayı dene."; await signOut(S.auth); return; }
    }
    $("#auth").classList.add("hide"); $("#app").classList.remove("hide");
    $("#me").classList.remove("hide"); $("#me").textContent=pname(S.uid).slice(0,1).toLocaleUpperCase("tr");
    S.statFor=S.uid;
    $("#foot").innerHTML="Kazanan 1 · fark +1 · en skorer +1 · banko 2 / -1 · günün oyuncusu +2<br>Veriler ESPN'den alınır. Maç varken 30 saniyede bir yenilenir.";
    route(); showDay(); refresh();
  });
})();
