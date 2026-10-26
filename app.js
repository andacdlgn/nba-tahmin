// NBA Tahmin — her gecenin maçlarına tahmin: kazanan, fark, en skorer.
// Seçimler Firebase'de (Firestore) tutulur, maç verisi ESPN'den canlı okunur,
// geçmiş puanlar GitHub'daki data/ dosyalarından gelir.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, connectAuthEmulator }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, deleteDoc, collection, query, where, writeBatch, serverTimestamp, Timestamp, arrayUnion, connectFirestoreEmulator }
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
// "Bugün" = bu akşamın maçları. Türkiye saatiyle 08.00'e kadar dün gecenin maçları, sonra bu akşamınkiler.
const espnToday = () => new Date(Date.now()-8*36e5).toLocaleDateString("sv-SE",{timeZone:"Europe/Istanbul"}).replaceAll("-","");
const timeTR = d => d.toLocaleTimeString("tr-TR",{timeZone:TZ,hour:"2-digit",minute:"2-digit"});
const dayNice = (s, o={day:"numeric",month:"long",weekday:"long"}) => parseYmd(s).toLocaleDateString("tr-TR",{timeZone:"UTC",...o});
// Takım logoları sitenin kendi logos/ klasöründen gelir (ESPN'e bağımlı değil).
// Yerel dosya yüklenemezse ESPN'in adresi denenir, o da olmazsa takım kısaltması gösterilir.
// Her güncellemede bir artır: sitenin en altında ve Kurallar'da görünür, yeni sürüm yüklendi mi diye bakmak için
const VERSION = "v15";
const LOGO_SMALL = a => `logos/${String(a).toLowerCase()}.png`;
const LOGO_FULL  = a => `https://a.espncdn.com/i/teamlogos/nba/500/${String(a).toLowerCase()}.png`;
document.addEventListener("error", e => {
  const img = e.target;
  if(!(img instanceof HTMLImageElement)) return;
  if(img.classList.contains("av-img") && !img.classList.contains("logo")){ img.closest(".av")?.classList.remove("has-img"); img.remove(); return; }
  const src = img.getAttribute("src") || "";
  const local = /^logos\/([a-z]+)\.png$/i.exec(src);
  if(local){ img.src = LOGO_FULL(local[1]); return; }
  const espn = /teamlogos\/nba\/500\/([a-z]+)\.png/i.exec(src);
  if(espn){
    const b = document.createElement("span");
    b.className = "logo-fb"; b.textContent = espn[1].toUpperCase();
    b.style.width = (img.width||28)+"px"; b.style.height = (img.height||28)+"px";
    img.replaceWith(b); return;
  }
  // oyuncu fotoğrafı vb. yüklenemezse boş gri kutu kalsın
  img.removeAttribute("src"); img.style.visibility = "hidden";
}, true);
const esc = s => String(s??"").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const bucket = m => m<=5?"1-5":m<=10?"6-10":m<=15?"11-15":"16+";
const slug = s => s.toLocaleLowerCase("tr").replace(/[çğıöşü]/g, c => ({ç:"c",ğ:"g",ı:"i",ö:"o",ş:"s",ü:"u"}[c])).replace(/[^a-z0-9]/g, "");
const weekKey = s => { const d = parseYmd(s); const w = (d.getUTCDay()+6)%7; d.setUTCDate(d.getUTCDate()-w); return ymd(d); };
// Gecenin bütün tahminleri ilk maç başladığı anda kilitlenir; rakiplerin seçimleri o an açılır.
// g.lock = o gecenin ilk maçının başlama saati (parseGames atar).
const LOCK_MS = 0;
const started = g => g.state !== "pre" || Date.now() >= g.lock.getTime();
// renk katılma sırasına sabit: herkes aynı oyuncuyu aynı renkte görür
const PKEYS = ["p0","p1","p2","p3","p4","p5","p6","p7","p8","p9"];
const col = uid => { const c=S.players[uid]?.color; return PKEYS.includes(c) ? `var(--${c})` : PCOL[Math.max(0, (S.colorOrder||S.order).indexOf(uid)) % PCOL.length]; };
// eski kayıtlarda küçük harfle başlayan adlar ekranda büyük harfle görünsün
const pname = uid => { const n=S.players[uid]?.name; return n ? n.charAt(0).toLocaleUpperCase("tr")+n.slice(1) : "?"; };
function toast(msg, ms=2600){ const t=$("#toast"); t.textContent=msg; t.classList.remove("hide"); clearTimeout(t._t); t._t=setTimeout(()=>t.classList.add("hide"), ms); }
async function getJSON(url){ const r = await fetch(url, {cache:"no-store"}); if(!r.ok) throw new Error(r.status); return r.json(); }
async function espn(path){
  let err;
  for(const b of ESPN_BASES){ try{ return await getJSON(b+path); }catch(e){ err=e; } }
  throw err;
}

// Arayüz simgeleri: hepsi aynı çizgi tarzında (emojiler yalnızca avatar, tepki ve şeritte)
const IC = (d, cls="ic") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
const ICON = {
  bolt: IC('<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>'),
  cards: IC('<rect x="7" y="3" width="13" height="17" rx="2"/><path d="M4 7v12a2 2 0 0 0 2 2h9"/>'),
  list: IC('<path d="M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01"/>'),
  tools: IC('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z"/>'),
  link: IC('<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>'),
  megaphone: IC('<path d="M3 11v2a1 1 0 0 0 1 1h3l6 4V6L7 10H4a1 1 0 0 0-1 1zM17 8a5 5 0 0 1 0 8"/>'),
  mail: IC('<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 7l9 6 9-6"/>'),
  palette: IC('<path d="M12 3a9 9 0 1 0 0 18c1 0 1.5-.8 1.5-1.6 0-.5-.3-.9-.3-1.4 0-.8.6-1.5 1.5-1.5H17a4 4 0 0 0 4-4c0-5-4-9.5-9-9.5z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="15" cy="7.5" r="1"/>'),
  star: IC('<path d="M12 3l2.8 5.7 6.2.9-4.5 4.4 1 6.2L12 17.3 6.5 20.2l1-6.2L3 9.6l6.2-.9z"/>'),
  question: IC('<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14M12 17.5h.01"/>'),
  download: IC('<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>'),
  medal: IC('<circle cx="12" cy="15" r="5"/><path d="M8.5 11L6 3h4l2 5 2-5h4l-2.5 8"/>'),
  home: IC('<path d="M4 11l8-7 8 7v9a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1z"/>', "ic ic-s"),
  plane: IC('<path d="M10 14l-6 2 1 2 6-1 3 5h2l-1-6 5-2a1.5 1.5 0 0 0-1-2.8L14 13l-4-8H8l2 7"/>', "ic ic-s"),
  chev: IC('<path d="M9 6l6 6-6 6"/>', "ic ic-s"),
  edit: IC('<path d="M4 20h4L19 9l-4-4L4 16z"/>', "ic ic-s"),
};
/* ====================================================== tema */
const ICON_MOON='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/></svg>';
const ICON_SUN='<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
const isDark = () => { const t=document.documentElement.dataset.theme; return t ? t==="dark" : matchMedia("(prefers-color-scheme: dark)").matches; };
function paintTheme(){ const b=$("#theme"); b.innerHTML=isDark()?ICON_SUN:ICON_MOON; b.setAttribute("aria-label", isDark()?"Açık moda geç":"Koyu moda geç"); }
$("#theme").onclick = () => { const n=isDark()?"light":"dark"; document.documentElement.dataset.theme=n; try{localStorage.setItem("theme",n);}catch(e){} paintTheme(); if(typeof applyTheme==="function"){ applyTheme(); render(); } };
paintTheme();

/* ====================================================== ESPN verisi */
function parseGames(raw){
  const list = (raw.events||[]).filter(ev => ev.season?.type !== 1).map(ev => {
    const c = ev.competitions[0], st = ev.status||c.status||{}, ty = st.type||{};
    const side = k => {
      const x = c.competitors.find(p => p.homeAway===k) || {};
      return { abbr:x.team?.abbreviation, id:x.team?.id, name:x.team?.shortDisplayName, logo:LOGO_SMALL(x.team?.abbreviation||""),
               score: x.score!=null && x.score!=="" ? +x.score : null, winner:!!x.winner,
               rec:(x.records||[])[0]?.summary||"", ls:(x.linescores||[]).map(l=>l.displayValue ?? l.value) };
    };
    const sr = c.series && ev.season?.type===3 ? (() => {
      const byId = Object.fromEntries(c.competitors.map(p=>[String(p.team?.id), p.team?.abbreviation]));
      const wins = Object.fromEntries((c.series.competitors||[]).map(x=>[byId[String(x.id)]||String(x.id), +x.wins||0]));
      const abbrs = Object.values(byId).sort();
      return { key:`${ev.season?.year||""}${abbrs.join("-")}`, wins, need:Math.floor((+c.series.totalCompetitions||7)/2)+1, done:!!c.series.completed, summary:c.series.summary||"" };
    })() : null;
    return { id:ev.id, start:new Date(ev.date), state:ty.state, series:sr, detail:ty.shortDetail||"", typeName:ty.name||"",
             period:st.period||0, clock:st.displayClock||"", home:side("home"), away:side("away"),
             seasonType:ev.season?.type ?? 2 };
  }).sort((a,b) => a.start-b.start);
  if(list.length){ const lock = new Date(Math.min(...list.map(g=>g.start.getTime()))); list.forEach(g => g.lock = lock); }
  return list;
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
    const p = {pts:arch[uid].pts+(arch[uid].sr||0), n:arch[uid].n??1, final:true, src:"arch", w:0, m:0, s:0, dp:arch[uid].dp||0, q:arch[uid].qp||0, sr:arch[uid].sr||0};
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
    const p = {pts:0, n:0, final:D.games.length>0, src:"live", w:0, m:0, s:0, dp:0, q:0, sr:0};
    const daily=D.daily[uid];
    for(const g of D.games){
      if(!started(g)) { p.final=false; continue; }
      if(g.state!=="post" || !topsOf(g)) p.final=false;   // skorer bilgisi gelmeden gece kesinleşmiş sayılmaz
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
    if(daily?.q){ p.n++; const qr = questionResult(day); if(qr?.final && qr.ans===daily.q){ p.q=1; p.pts+=1; } }
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
  snap.forEach(d => { const x=d.data({serverTimestamps:"estimate"});
    S.players[d.id] = {name:x.name, joined:x.joined?.toMillis?.()||Date.now(), color:x.color||"", emoji:x.emoji||"", favTeam:x.favTeam||"", theme:x.theme||"default", av:x.av||""}; });
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

S.loadingDay = {};
function loadDay(day, opts={}){
  // aynı gün için süren bir yükleme varsa onu bekle (açılışta iki kez istenmesin)
  if(S.loadingDay[day]) return S.loadingDay[day];
  return S.loadingDay[day] = loadDayNow(day, opts).finally(()=>{ delete S.loadingDay[day]; });
}
async function loadDayNow(day, {force=false}={}){
  const old = S.days[day];
  if(old && !force && Date.now()-old.at < 20e3) return old;
  let raw=null;
  if(S.preSB?.day===day){ raw=await S.preSB.p; S.preSB=null; }   // açılışta önceden istenmiş liste
  const games = parseGames(raw || await espn(`/scoreboard?dates=${day}&limit=50`));
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
  // kilitlenmiş maçlara bırakılan emoji ve yorumlar
  D.talk = old?.talk || {};
  if(games.some(started)) jobs.push(getDocs(query(collection(S.db,"talk"), where("day","==",day))).then(snap => {
    D.talk = {}; snap.forEach(x => { const t=x.data(); (D.talk[t.gid] ||= {})[t.uid] = t; });
  }).catch(()=>{}));
  // playoff seri tahminleri
  D.series = old?.series || {};
  for(const g of games.filter(g=>g.series)) for(const uid of S.order){
    if(uid!==S.uid && !started(g)) continue;
    jobs.push(getDoc(doc(S.db,"series",`${g.series.key}_${uid}`)).then(x => { (D.series[g.series.key] ||= {})[uid] = x.exists() ? x.data() : null; }).catch(()=>{}));
  }
  await Promise.all(jobs);
  S.days[day] = D;
  // biten / süren maçların özetleri (en skorer ve canlı takip için). Sayfayı bekletmez:
  // arka planda yüklenir, gelince ekran yeniden çizilir.
  const need = games.filter(g => g.state==="in" || (g.state==="post" && !S.arch.games[g.id]?.top));
  const fresh = need.filter(g => { const c=S.sums[g.id]; return !c || (g.state!=="post" && Date.now()-c.at>=25e3); });
  if(fresh.length) Promise.all(fresh.map(g => loadSummary(g).catch(()=>null))).then(()=>{ if(S.uid && S.days[day]===D) render(); });
  return D;
}

/* ====================================================== kaydetme */
async function savePick(g, {quiet=false}={}){
  const d = S.draft[g.id]; if(!d) return;
  if(!(d.winner && d.margin && d.scorerId)) return;
  if(started(g)){ toast("Tahminler kilitlendi (gecenin ilk maçı başladı)."); return; }
  const D = S.days[S.day];
  const prev = D.picks[g.id]?.[S.uid];
  if(prev && prev.winner===d.winner && prev.margin===d.margin && prev.scorerId===d.scorerId) return;
  d.saving = true; renderGames();
  try{
    // start = kilit saati (gecenin ilk maçı). Daha önce kaydedilmiş tahminde eski değer korunur (kural gereği değişmez).
    const data = { uid:S.uid, gameId:g.id, day:S.day, start: prev?.start || Timestamp.fromDate(g.lock),
      winner:d.winner, margin:d.margin, scorerId:d.scorerId, scorerName:d.scorerName, updatedAt:serverTimestamp() };
    await setDoc(pickRef(g.id, S.uid), data);
    D.picks[g.id][S.uid] = {...data, updatedAt:Timestamp.now()};
    d.err = null; d.justSaved = Date.now();
    if(!quiet) toast(pick(["Tahmin kaydedildi.","Tamamdır, tahminin kaydedildi.","Kaydedildi. Şimdi maçı bekle.","Tahminin alındı."]));
    setDoc(progressRef(S.day, S.uid), {uid:S.uid, day:S.day, gids:arrayUnion(g.id), updatedAt:serverTimestamp()}, {merge:true})
      .then(()=>{ (D.progress[S.uid] ||= new Set()).add(g.id); renderDayView(); }).catch(()=>{});
  }catch(e){
    d.err = started(g) ? "Kilitlendi, kaydedilemedi (gecenin ilk maçı başladı)." : "Kaydedilemedi, tekrar dene.";
  }
  d.saving = false; renderGames(); renderStatus();
  if(!d.err){ setTimeout(()=>{ S.edit.delete(g.id); if(S.tab==="tahmin" && S.sub==="maclar") renderGames(); }, 1500); }
}
async function saveDaily(patch){
  const D = S.days[S.day];
  const firstStart = Math.min(...D.games.map(g=>g.start.getTime()));
  const cur = D.daily[S.uid] || {};
  const data = { uid:S.uid, day:S.day, firstStart: cur.firstStart || Timestamp.fromMillis(firstStart) };
  for(const k of ["confGame","confStart","confAt","dayPlayerId","dayPlayerName","dayAt","q","qAt"]) if(cur[k]!==undefined) data[k]=cur[k];
  if(patch.confGame){ data.confGame=patch.confGame; data.confStart=Timestamp.fromDate(patch.confStart); data.confAt=serverTimestamp(); }
  if(patch.dayPlayerId){ data.dayPlayerId=patch.dayPlayerId; data.dayPlayerName=patch.dayPlayerName; data.dayAt=serverTimestamp(); }
  if(patch.q){ data.q=patch.q; data.qAt=serverTimestamp(); }
  try{
    await setDoc(dailyRef(S.day, S.uid), data);
    // sunucunun yazdığı saatleri geri oku; sonraki kayıt bunları aynen göndermeli
    D.daily[S.uid] = await readDaily(S.day, S.uid) || D.daily[S.uid];
    toast(patch.confGame ? pick(["Banko seçildi.","Bankon hazır, umarım tutar.","Banko kaydedildi."]) : patch.q ? pick(["Cevabın kaydedildi.","Cevabını aldık.","Kaydedildi, gece bitince belli olur."]) : pick(["Günün oyuncusu seçildi.","Günün oyuncusu kaydedildi.","Seçimin kaydedildi, umarım bu gece şov yapar."]));
  }catch(e){ toast("Kaydedilemedi: süre dolmuş olabilir."); }
  render();
}

/* ====================================================== görsel yardımcılar */
// Takım ana / ikincil renkleri (ESPN). Çok koyu renk koyu temada ikincisiyle değiştirilir.
const TEAM_COL = {ATL:["c8102e","fdb927"],BOS:["008348","ffffff"],BKN:["000000","ffffff"],CHA:["008ca8","1d1060"],CHI:["ce1141","000000"],CLE:["860038","bc945c"],
  DAL:["0064b1","bbc4ca"],DEN:["0e2240","fec524"],DET:["1d428a","c8102e"],GS:["fdb927","1d428a"],HOU:["ce0e2d","000000"],IND:["0c2340","ffd520"],LAC:["12173f","c8102e"],
  LAL:["552583","fdb927"],MEM:["5d76a9","12173f"],MIA:["98002e","000000"],MIL:["00471b","eee1c6"],MIN:["266092","79bc43"],NO:["0a2240","b4975a"],NY:["1d428a","f58426"],
  OKC:["007ac1","ef3b24"],ORL:["0150b5","9ca0a3"],PHI:["1d428a","e01234"],PHX:["29127a","e56020"],POR:["e03a3e","000000"],SAC:["5a2d81","6a7a82"],SA:["000000","c4ced4"],
  TOR:["d91244","000000"],UTAH:["4e008e","79a3dc"],WSH:["e31837","002b5c"]};
const lum = h => { const n=parseInt(h,16), c=[n>>16&255,n>>8&255,n&255].map(v=>{v/=255; return v<=.03928?v/12.92:((v+.055)/1.055)**2.4;}); return .2126*c[0]+.7152*c[1]+.0722*c[2]; };
function tcol(abbr){
  const c = TEAM_COL[abbr]; if(!c) return "var(--line)";
  return "#" + (isDark() && lum(c[0]) < .03 ? c[1] : c[0]);
}
// İki takımın rengi birbirine çok yakınsa ev sahibi ikinci rengini kullanır (ör. Lakers–Jazz)
function pairCols(a, h){
  const ca=tcol(a), ch=tcol(h), hx=c=>c.startsWith("#")?[1,3,5].map(i=>parseInt(c.slice(i,i+2),16)):null;
  const A=hx(ca), H=hx(ch);
  if(A && H && Math.hypot(A[0]-H[0],A[1]-H[1],A[2]-H[2]) < 90){ const alt=TEAM_COL[h]?.[1]; if(alt && lum(alt)>.03 && lum(alt)<.9) return [ca,"#"+alt]; }
  return [ca,ch];
}
const initials = n => String(n||"?").trim().split(/\s+/).slice(0,2).map(w=>w[0]).join("").toLocaleUpperCase("tr");
// Avatar olarak seçilebilen 50 oyuncu (CBS Sports 2026-27 ilk 50 sıralaması) ve 30 takım logosu
const STARS = [["5104157","Victor Wembanyama"],["4278073","Shai Gilgeous-Alexander"],["3112335","Nikola Jokic"],["3945274","Luka Doncic"],["4594268","Anthony Edwards"],["3032977","Giannis Antetokounmpo"],["3934672","Jalen Brunson"],["4432166","Cade Cunningham"],["4065648","Jayson Tatum"],["3975","Stephen Curry"],["6450","Kawhi Leonard"],["4396993","Tyrese Haliburton"],["4431678","Tyrese Maxey"],["3908809","Donovan Mitchell"],["3202","Kevin Durant"],["3136195","Karl-Anthony Towns"],["3917376","Jaylen Brown"],["4433134","Scottie Barnes"],["1966","LeBron James"],["4593803","Jalen Williams"],["3149673","Pascal Siakam"],["4432158","Evan Mobley"],["4066261","Bam Adebayo"],["3934719","OG Anunoby"],["5041939","Cooper Flagg"],["3136193","Devin Booker"],["4683021","Deni Avdija"],["4433255","Chet Holmgren"],["3936299","Jamal Murray"],["4701230","Jalen Johnson"],["4066457","Austin Reaves"],["4684740","Amen Thompson"],["3078576","Derrick White"],["4433621","Jalen Duren"],["4871144","Alperen Sengun"],["4277961","Jaren Jackson Jr."],["3059318","Joel Embiid"],["5037871","Dylan Harper"],["6583","Anthony Davis"],["4845367","Stephon Castle"],["4432816","LaMelo Ball"],["4066336","Lauri Markkanen"],["6442","Kyrie Irving"],["4566434","Franz Wagner"],["4432573","Paolo Banchero"],["3032976","Rudy Gobert"],["3992","James Harden"],["5061575","Kon Knueppel"],["4431671","Jaden McDaniels"],["4397688","Trey Murphy III"]];
const FACE = id => `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=96&h=70&scale=crop&cquality=70`;
const faceImg = (id, cls="face") => id ? `<img class="${cls}" src="${FACE(id)}" alt="" loading="lazy">` : "";
const HEADSHOT = id => `https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${id}.png&w=160&h=117&scale=crop&cquality=70`;
const avImg = av => { const m=/^(t|p):(\w+)$/.exec(av||""); if(!m) return ""; return m[1]==="t" ? `<img class="av-img logo" src="${LOGO_SMALL(m[2])}" alt="">` : `<img class="av-img" src="${HEADSHOT(m[2])}" alt="" loading="lazy">`; };
const avatar = (u, cls="") => { const p=S.players[u]||{}; const h=honors(); const img=avImg(p.av);
  const crown = h.week===u ? `<span class="av-crown" title="Geçen haftanın şampiyonu">👑</span>` : "";
  const star = h.night===u ? `<span class="av-star" title="Son gecenin kazananı">★</span>` : "";
  const badge = p.favTeam && p.av!==`t:${p.favTeam}` ? `<img class="av-team" src="${LOGO_SMALL(p.favTeam)}" alt="">` : "";
  return `<span class="av ${cls} ${img?"has-img":p.emoji?"emo":""}" style="--pc:${col(u)}">${img?`<span class="av-ini">${esc(initials(pname(u)))}</span>${img}`:p.emoji?p.emoji:esc(initials(pname(u)))}${badge}${crown}${star}</span>`; };
// Geçen haftanın tek şampiyonu ve son bitmiş gecenin tek kazananı (+ o gecenin puanları)
function honors(){
  const key = S.today + "|" + Object.keys(S.arch.scores.days||{}).length + "|" + S.order.length + "|" + (S.days[S.today]?.at||0) + "|" + (S.days[shiftDay(S.today,-1)]?.at||0);
  if(honors.k===key) return honors.v;
  const v={week:null, night:null, nightDay:null, nightPts:{}};
  const pw = S.arch.scores.weeks?.[shiftDay(weekKey(S.today),-7)];
  if(pw){ const vals=Object.entries(pw).filter(([u])=>S.order.includes(u)); const m=Math.max(...vals.map(x=>x[1])); const w=vals.filter(x=>x[1]===m); if(w.length===1 && m>0) v.week=w[0][0]; }
  for(const d of allDays()){ const w=dayWinner(d); if(!w || w.st==="live") continue; v.nightDay=d; if(w.st==="w") v.night=w.u; const p=dayPoints(d); for(const u of S.order) v.nightPts[u]=p[u]?.pts??null; break; }
  honors.k=key; honors.v=v; return v;
}
const deltaHTML = u => { const h=honors(), p=h.nightPts[u]; if(p==null) return "";
  return `<span class="delta ${p>0?"up":p<0?"down":""}" title="${dayNice(h.nightDay,{day:"numeric",month:"long"})} gecesi">${p>0?"▲":p<0?"▼":"•"} ${p>0?"+":""}${p} <small>son gece</small></span>`; };
// Son 5 bitmiş gece: G (tek başına en çok), B (berabere en çok), M
function formOf(u, n=5){
  const out=[];
  for(const d of allDays()){
    const p=dayPoints(d);
    if(S.order.some(x=>p[x] && !p[x].final) || !p[u]?.n) continue;
    const best=Math.max(...S.order.map(x=>p[x]?.pts??-99)); const w=S.order.filter(x=>(p[x]?.pts??-99)===best);
    out.push(w.includes(u) ? (w.length===1?"W":"T") : "L");
    if(out.length>=n) break;
  }
  return out.reverse();
}
const formHTML = u => { const f=formOf(u); return `<span class="form" title="Son 5 gece">${f.map(r=>`<i class="${r}"></i>`).join("")}${"<i></i>".repeat(5-f.length)}</span>`; };
// Skorbord rakamı: oyuncu renginde ışık, sayılar değişince sayarak gelir
const digitsHTML = (u, v) => `<div class="digits tnum" data-u="${u}" data-v="${v}" style="--pc:${col(u)}"><span>${v}</span></div>`;

/* ====================================================== skorbord */
// Sezon toplamı ve kırılımı: arşivdeki günler + henüz arşive girmemiş günler (canlı)
function seasonBreakdown(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d] && inLeague(d)) days.add(d);
  const b = {}; for(const u of S.order) b[u] = {pts:0, w:0, m:0, s:0, dp:0, q:0, sr:0};
  for(const d of days){
    const dp = dayPoints(d);
    for(const u of S.order){ const p=dp[u]; if(!p) continue; b[u].pts+=p.pts; b[u].w+=p.w; b[u].m+=p.m; b[u].s+=p.s; b[u].dp+=p.dp; b[u].q+=p.q||0; b[u].sr+=p.sr||0; }
  }
  return b;
}
function seasonTotals(){ const b=seasonBreakdown(); const t={}; for(const u of S.order) t[u]=b[u].pts; return t; }
function renderBoard(){
  const brk = seasonBreakdown();
  const tot = {}; for(const u of S.order) tot[u]=brk[u].pts;
  const tonight = S.days[S.today] && inLeague(S.today) ? dayPoints(S.today) : {};
  const ranked = [...S.order].sort((a,b)=>tot[b]-tot[a]);
  let html;
  if(S.order.length<=2){
    const [a,b] = S.order;
    const cell = u => u ? `<div class="pl" data-pu="${u}">${avatar(u)}<div class="nm" style="color:${col(u)}">${esc(pname(u))}</div>${digitsHTML(u, tot[u])}${deltaHTML(u)}${formHTML(u)}</div>` : `<div class="pl"><span class="av empty">?</span><div class="nm">Rakip bekleniyor</div><div class="digits">–</div></div>`;
    html = `<div class="duel">${cell(a)}<div class="vs">VS</div>${cell(b)}</div>`;
    if(a && b){
      // halat çekme: düğüm farka göre kayar
      const d = tot[a]-tot[b], span = Math.max(12, Math.abs(tot[a])+Math.abs(tot[b]));
      const pos = Math.min(92, Math.max(8, 50 + d/span*50));
      const lbl = d===0 ? "Berabere" : `${esc(pname(d>0?a:b))} +${Math.abs(d)}`;
      html += `<div class="tug" style="--a:${col(a)};--b:${col(b)};--pos:${pos}%"><div class="tug-bar"><i class="ta"></i><i class="tb"></i><span class="knot"></span></div><div class="tug-lbl" style="${d?`color:${col(d>0?a:b)}`:""}">${lbl}</div></div>`;
    }
  } else {
    const top = Math.max(1, ...ranked.map(u=>tot[u]));
    const showAll = S.boardAll || ranked.length<=4;
    const vis = showAll ? ranked : ranked.filter((u,i)=>i<3 || u===S.uid);
    html = `<div class="lb">${vis.map((u)=>{ const i=ranked.indexOf(u); return `<div class="lb-row" data-pu="${u}" style="--pc:${col(u)};--w:${Math.max(0,tot[u])/top*100}%"><span class="rk">${i+1}</span>${avatar(u,"sm")}<span class="nmw"><span class="nm" style="color:${col(u)};display:block">${esc(pname(u))}</span>${formHTML(u)}</span>${tonight[u]?.pts ? `<span class="td on">+${tonight[u].pts} bu gece</span>` : `<span class="td"></span>`}<span class="tn tnum">${tot[u]}${deltaHTML(u)}</span></div>`; }).join("")}</div>`
      + (ranked.length>4 ? `<button class="lb-more" id="lbMore" type="button">${S.boardAll?"Daralt":`Tümünü göster (${ranked.length})`}</button>` : "");
  }
  let lead = `<i></i>Henüz puan yok`;
  if(ranked.length>1){
    if(tot[ranked[0]]===tot[ranked[1]]) lead = `<i style="background:var(--amber)"></i>Şu an berabere`;
    else lead = `<i style="background:${col(ranked[0])}"></i>${esc(pname(ranked[0]))} önde`;
  }
  const tn = S.order.length<=2 && S.order.length ? `Bu gece <b>${S.order.map(u=>tonight[u]?.pts??0).join("–")}</b>` : "";
  const wk = weekKey(S.today), wkPts = {}; for(const u of S.order) wkPts[u]=(S.arch.scores.weeks?.[wk]?.[u]||0);
  for(const day of [S.today, shiftDay(S.today,-1)]){ if(weekKey(day)!==wk || !S.days[day] || !inLeague(day)) continue; const dp=dayPoints(day); for(const u of S.order) if(dp[u]?.src==="live") wkPts[u]+=dp[u].pts-(S.arch.scores.days?.[day]?.[u]?.pts||0); }
  const wkLead = [...S.order].sort((x,y)=>wkPts[y]-wkPts[x]);
  const wkTxt = !S.order.length ? "" : S.order.length<=2 ? `Bu hafta <b>${S.order.map(u=>wkPts[u]).join("–")}</b>`
    : wkPts[wkLead[0]]>0 ? `Haftanın lideri <b style="color:${col(wkLead[0])}">${esc(pname(wkLead[0]))}</b> · ${wkPts[wkLead[0]]} puan` : "Yeni hafta başladı";
  html += `<div class="board-foot"><div class="lead">${lead}</div><div class="bf-meta">${[tn,wkTxt].filter(Boolean).join(" · ")}</div></div>`;
  // sıralama değiştiyse satırlar kayarak yer değiştirsin (FLIP), öne geçenin yanında ▲ çıksın
  const before = {}; $$("#board .lb-row[data-pu]").forEach(el=>{ before[el.dataset.pu]=el.getBoundingClientRect().top; });
  const prevRank = S.prevRank || null;
  $("#board").innerHTML = html;
  const nowRank = $$("#board .lb-row[data-pu]").map(el=>el.dataset.pu);
  if(prevRank && nowRank.join()!==prevRank.join()){
    $$("#board .lb-row[data-pu]").forEach((el,i)=>{
      const u=el.dataset.pu, old=prevRank.indexOf(u);
      if(before[u]!=null){ const dy=before[u]-el.getBoundingClientRect().top; if(dy){ el.animate([{transform:`translateY(${dy}px)`},{transform:"none"}],{duration:650,easing:"cubic-bezier(.2,.8,.2,1)"}); } }
      if(old>i) el.insertAdjacentHTML("beforeend", `<span class="rk-up">▲ ${old-i}</span>`);
    });
  }
  if(nowRank.length) S.prevRank = nowRank;
  countUp();
  $("#mini").innerHTML = S.order.length<=2 && S.order.length===2 ? `<span style="color:${col(S.order[0])}">${esc(pname(S.order[0]))}</span><span class="ms tnum">${tot[S.order[0]]}–${tot[S.order[1]]}</span><span style="color:${col(S.order[1])}">${esc(pname(S.order[1]))}</span>` : "";
}

/* ====================================================== TAHMİN sekmesi */
// "3 saat sonra" gibi; 1 saatten az kaldıysa turuncu
function startsIn(g){
  const ms=g.start-Date.now(); if(ms<=0) return "";
  if(!started(g) && Math.abs(g.start-g.lock)<30*6e4) return "";   // gecenin ilk maçı: kilit halkası zaten aynı süreyi gösteriyor
  const m=Math.round(ms/6e4), h=Math.floor(m/60);
  const t = m<60 ? `${m} dk sonra` : h<24 ? `${h} saat sonra` : `${Math.floor(h/24)} gün sonra`;
  return ` <span class="starts ${m<60?"soon":""}">${t}</span>`;
}
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
  if(!D.games.length){ $("#dayStatus").innerHTML = EMPTY_NIGHT; return; }
  const pct = Math.round(mine/D.games.length*100);
  parts.push(`<span><b>${mine}/${D.games.length}</b> maçı tahmin ettin</span><span class="prog"><i style="width:${pct}%"></i></span>`);
  if(open.length){
    const missing = open.filter(g=>!D.picks[g.id]?.[S.uid]).length;
    if(missing) parts.push(`<span class="warn">${missing} maç eksik</span>`);
    if(!daily.confGame) parts.push(`<span class="warn">Banko seçilmedi</span>`);
    if(!daily.dayPlayerId && !D.games.some(started)) parts.push(`<span class="warn">Günün oyuncusu seçilmedi</span>`);
    if(!daily.q && !D.games.some(started)) parts.push(`<span class="warn">Gecenin sorusu cevaplanmadı</span>`);
    const inj = injuryAlerts(D);
    if(inj.length) parts.push(`<span class="bad">Oynamayacak: ${inj.map(esc).join(", ")}</span>`);
  }
  if(D.games.some(g=>g.seasonType===3)) parts.push(`<span class="playoff">Playoff: bütün puanlar iki katı</span>`);
  const allFinal = D.games.every(g=>g.state==="post");
  const anyPick = D.games.some(g=>Object.keys(D.picks[g.id]||{}).length);
  if(allFinal && anyPick) parts.push(`<button class="btn" id="sumBtn">Gece özeti</button>`);
  if(open.length) parts.push(`<button class="btn quick-btn" id="quickBtn" type="button">${ICON.bolt}Hızlı tahmin</button><button class="btn quick-btn" id="swipeBtn" type="button">${ICON.cards}Tek tek tahmin</button>`);
  $("#dayStatus").innerHTML = `<div class="status">${parts.join("")}</div>`;
  renderPickBar(D);
  $("#sumBtn")?.addEventListener("click", nightSummary);
  $("#quickBtn")?.addEventListener("click", openQuick);
  $("#swipeBtn")?.addEventListener("click", openSwipe);
}
function renderDayLabel(){
  const rel = S.day===S.today ? "Bugün" : S.day===shiftDay(S.today,-1) ? "Dün" : S.day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#dayLabel").innerHTML = (rel ? `${rel}<small>${dayNice(S.day)} (ABD)</small>` : `${dayNice(S.day)}<small>ABD tarihi</small>`)
    + (S.day!==S.today ? `<button class="today-chip" id="toToday" type="button">Bugüne dön</button>` : "");
  $("#toToday")?.addEventListener("click", e=>{ e.stopPropagation(); S.day=S.today; showDay?.(); render(); });
}
function renderDayPlayer(){
  const D = S.days[S.day]; if(!D?.games.length){ $("#dayPlayer").innerHTML=""; return; }
  const locked = D.games.some(started);
  const mine = D.daily[S.uid];
  if(!locked){
    $("#dayPlayer").innerHTML = `<button class="dp" id="dpBtn" style="width:100%;cursor:pointer;text-align:left">
      <span class="ico">${mine?.dayPlayerId?faceImg(mine.dayPlayerId,"dp-face"):ICON.star}</span><span class="tx"><b>Günün oyuncusu${mine?.dayPlayerName?": "+esc(mine.dayPlayerName):""}</b>
      <small>${mine?.dayPlayerName?"Değiştirmek için dokun.":"Gecenin en skorerini bilirsen 2 puan."} İlk maç başlayınca kilitlenir.</small></span></button>`;
    $("#dpBtn").onclick = () => openPlayerPicker({mode:"day"});
    $("#dayPlayer").insertAdjacentHTML("beforeend", questionCard());
    return;
  }
  const rows = S.order.map(u => {
    const r = dayPlayerResult(S.day, u);
    const st = !r ? `<span class="muted">seçmedi</span>` : r.final ? (r.hit?`<span class="ok">+2</span>`:`<span class="no">0</span>`) : r.leading ? `<span class="now">şu an önde</span>` : `<span class="muted">bekleniyor</span>`;
    return `<span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span>: ${r?esc(r.name):"–"} ${st}`;
  }).join(" · ");
  $("#dayPlayer").innerHTML = `<div class="dp"><span class="ico">${ICON.star}</span><span class="tx"><b>Günün oyuncusu</b><small>${rows}</small></span></div>` + questionCard();
}
function pickCell(g, pick, uid, conf){
  const r = scorePick(g, pick, conf);
  const live = g.state==="in", post = g.state==="post";
  const tops = post ? topsOf(g) : liveTops(g);
  const team = pick.winner===g.home.abbr ? g.home : g.away;
  const homeLead=(g.home.score??0)-(g.away.score??0);
  const winNow = homeLead!==0 && (homeLead>0?g.home.abbr:g.away.abbr)===pick.winner;
  // çip durumu: ok / no (bitti), nok / nno (canlı, şu anki duruma göre), boş (henüz yok)
  const st = (got, known=true) => post ? (got?"ok":"no") : live && known ? (got?"nok":"nno") : "";
  const ic = c => c==="ok"||c==="nok" ? "✓" : c==="no" ? "✗" : "";
  const chip = (txt, c, lbl, face="") => `<span class="rc ${c}${face?" has-face":""}" title="${lbl}">${ic(c)?`<i>${ic(c)}</i>`:""}${face}${txt}</span>`;
  const cW = st(winNow, homeLead!==0), cM = st(r.m>0, winNow), cS = st(r.s>0, !!tops);
  const state = live ? (winNow ? "winning" : homeLead!==0 ? "losing" : "") : "";
  const small = post ? "puan" : live ? (state==="winning"?"tutuyor":state==="losing"?"tutmuyor":"şu an") : "";
  return `<div class="prow ${state} ${!S.seen.has(g.id) && uid!==S.uid ? "reveal":""}" style="--pc:${col(uid)}">
    <span class="who">${esc(pname(uid))}${conf?' <span class="star" title="Günün bankosu">★</span>':""}</span>
    <span class="pk">${chip(esc(team.abbr||team.name), cW, "Kazanan")}${chip(pick.margin, cM, "Fark")}${chip(esc(pick.scorerName), cS, "En skorer", faceImg(pick.scorerId,"rc-face"))}</span>
    <span class="pts tnum">${(post||live)?(r.pts>0?"+":"")+r.pts:""}<small>${small}</small></span>
  </div>`;
}
// Çeyrek çeyrek skor tablosu
function lineScore(g){
  const a=g.away.ls||[], h=g.home.ls||[]; const n=Math.max(a.length,h.length);
  if(!n || g.state==="pre") return "";
  const hd=Array.from({length:n},(_,i)=>i<4?i+1:(n>5?"U"+(i-3):"UZ"));
  const cur = g.state==="in" ? n-1 : -1;
  const row=(t,arr)=>`<tr><th><img src="${t.logo||""}" alt="">${esc(t.abbr)}</th>${hd.map((_,i)=>`<td class="${i===cur?"cur":""}">${arr[i]??"–"}</td>`).join("")}<td class="tot">${t.score??""}</td></tr>`;
  return `<table class="ls"><thead><tr><th></th>${hd.map((x,i)=>`<td class="${i===cur?"cur":""}">${x}</td>`).join("")}<td class="tot">T</td></tr></thead><tbody>${row(g.away,a)}${row(g.home,h)}</tbody></table>`;
}
// Biten maç: tek satırlık küçük kart
S.open = new Set();
function compactCard(g){
  const D=S.days[S.day], my=D.picks[g.id]?.[S.uid], conf=D.daily[S.uid]?.confGame===g.id;
  const r = my ? scorePick(g, my, conf) : null;
  const side = k => { const t=g[k], o=k==="home"?g.away:g.home, lose=(t.score??0)<(o.score??0);
    return `<span class="cm-t ${lose?"lose":"win"}" style="--tc:${tcol(t.abbr)}"><img src="${t.logo||""}" alt=""><b>${esc(t.abbr)}</b><span class="sc">${t.score??""}</span></span>`; };
  const dots = r ? `<span class="cm-dots" title="Kazanan · fark · en skorer"><i class="${r.w>0?"ok":"no"}"></i><i class="${r.m>0?"ok":"no"}"></i><i class="${r.s>0?"ok":"no"}"></i></span>` : `<span class="muted cm-none">tahmin yapmadın</span>`;
  const badge = r ? `<span class="pt-badge ${r.pts>0?"pos":r.pts<0?"neg":"zero"}">${r.pts>0?"+":""}${r.pts}</span>` : "";
  return `<article class="game compact${r && r.pts<=0 ? " miss" : ""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <button class="cm" data-act="expand" data-g="${g.id}" aria-expanded="false">${side("away")}<span class="cm-sep">–</span>${side("home")}<span class="cm-r">${conf?'<span class="star">★</span>':""}${dots}${badge}<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span></button></article>`;
}
// Aşağı kaydırınca üstte kalan ince ilerleme şeridi (yalnızca tahmine açık gece)
function renderPickBar(D){
  const el=$("#pickBar"); if(!el) return;
  const open=D?.games.filter(g=>!started(g))||[];
  if(!open.length || S.tab!=="tahmin" || S.sub!=="maclar"){ el.innerHTML=""; el.classList.remove("show"); return; }
  const mine=D.games.filter(g=>D.picks[g.id]?.[S.uid]).length, dl=D.daily[S.uid]||{};
  const it=(ok,t)=>`<span class="${ok?"ok":"no"}">${ok?"✓":"✗"} ${t}</span>`;
  const ms=D.games[0].lock-Date.now(), h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  el.innerHTML=`<div class="wrap pb-in" title="Dokun: ilk eksik maça git"><b>${mine}/${D.games.length}</b><span class="pb-prog"><i style="width:${Math.round(mine/D.games.length*100)}%"></i></span>${it(dl.confGame,"Banko")}${it(dl.dayPlayerId,"Oyuncu")}${it(dl.q,"Soru")}<span class="pb-t">${ms>0?`${h?h+" sa ":""}${m} dk`:""}</span></div>`;
  el.classList.toggle("show", !!S.pbShow);
  el.onclick = () => { const g=open.find(x=>!D.picks[x.id]?.[S.uid]); const c=g && $(`#games [data-gid="${g.id}"]`);
    if(c){ scrollTo({top: c.getBoundingClientRect().top + scrollY - 110, behavior:"smooth"}); c.classList.add("ping"); setTimeout(()=>c.classList.remove("ping"),1200); } };
}
// Kaydedilmiş, değiştirilmemiş tahmin: tek satır (dokununca düzenlemek için açılır)
S.edit = new Set();
function isDone(g, D){
  if(started(g) || S.edit.has(g.id)) return false;
  const sv=D.picks[g.id]?.[S.uid], d=S.draft[g.id]; if(!sv) return false;
  if(d && (d.saving || (d.justSaved && Date.now()-d.justSaved<1400))) return false;
  return !d || (d.winner===sv.winner && d.margin===sv.margin && d.scorerId===sv.scorerId);
}
function pickedCard(g){
  const D=S.days[S.day], sv=D.picks[g.id][S.uid], conf=D.daily[S.uid]?.confGame===g.id;
  const tm = side => { const t=g[side], on=sv.winner===t.abbr; return `<span class="pc-tm ${on?"on":""}" style="--tc:${tcol(t.abbr)}"><img src="${t.logo||LOGO_SMALL(t.abbr)}" alt=""><b>${esc(t.abbr)}</b></span>`; };
  return `<article class="game picked" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <button class="pk-row" data-act="edit" data-g="${g.id}"><span class="pk-time">${timeTR(g.start)}</span>${tm("away")}<span class="pk-at">@</span>${tm("home")}
      <span class="pk-sel"><span class="rc ok"><i>✓</i>${esc(sv.winner)}</span><span class="rc">${sv.margin}</span><span class="rc has-face">${faceImg(sv.scorerId,"rc-face")}${esc(sv.scorerName.split(" ").slice(-1)[0])}</span>${conf?'<span class="rc star-chip">★</span>':""}</span>
      <span class="pk-edit">${ICON.edit}</span></button></article>`;
}
// Gece bitince en çok puan getiren tahmin
function bestPickCard(D){
  if(!D.games.length || !D.games.every(g=>g.state==="post")) return "";
  let best=null;
  for(const g of D.games) for(const u of S.order){ const p=D.picks[g.id]?.[u]; if(!p) continue;
    const r=scorePick(g,p,D.daily[u]?.confGame===g.id); if(r.pts>0 && (!best || r.pts>best.r.pts)) best={g,u,p,r}; }
  if(!best) return "";
  const {g,u,p,r}=best, team=p.winner===g.home.abbr?g.home:g.away;
  const ch=(t,ok)=>`<span class="rc ${ok?"ok":"no"}"><i>${ok?"✓":"✗"}</i>${t}</span>`;
  return `<div class="best" style="--pc:${col(u)}"><div class="best-l"><span class="best-k">Gecenin tahmini</span>${avatar(u)}</div>
    <div class="best-m"><b style="color:${col(u)}">${esc(pname(u))}</b><span class="best-g"><img src="${g.away.logo}" alt="">${esc(g.away.abbr)} ${g.away.score}–${g.home.score} ${esc(g.home.abbr)}<img src="${g.home.logo}" alt=""></span>
      <span class="pk">${ch(esc(team.abbr),r.w>0)}${ch(p.margin,r.m>0)}${ch(esc(p.scorerName),r.s>0)}${D.daily[u]?.confGame===g.id?'<span class="rc ok"><i>★</i>banko</span>':""}</span></div>
    <div class="best-p">+${r.pts}<small>puan</small></div></div>`;
}
// Kilide kalan süre halkası (6 saatten itibaren boşalır)
function ringHTML(g){
  const ms = g.lock.getTime() - Date.now();
  const f = Math.max(0, Math.min(1, ms/(6*36e5)));
  const cls = ms < 15*6e4 ? "urgent" : ms < 60*6e4 ? "warn" : "";
  const h=Math.floor(Math.max(0,ms)/36e5), m=Math.floor(Math.max(0,ms)%36e5/6e4);
  const txt = ms<=0 ? "Kilitli" : `${h?h+" sa ":""}${m} dk`;
  return `<span class="ring ${cls}" data-ring="${g.id}" title="Tahminlerin kapanmasına kalan süre"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="rt"/><circle cx="18" cy="18" r="15" class="rf" style="stroke-dashoffset:${(94.25*(1-f)).toFixed(1)}"/></svg><span>${txt}</span></span>`;
}
S.prevSc = {};
function gameCard(g){
  const D = S.days[S.day];
  const lock = started(g);
  const daily = D.daily[S.uid]||{};
  const confHere = daily.confGame===g.id;
  const confLocked = daily.confGame && D.games.find(x=>x.id===daily.confGame && started(x));
  const t = (side) => {
    const s = g[side], other = side==="home"?g.away:g.home;
    const loser = g.state==="post" && (s.score??0)<(other.score??0), winner = g.state==="post" && (s.score??0)>(other.score??0);
    const sel = (lock ? D.picks[g.id]?.[S.uid]?.winner : draftFor(g).winner)===s.abbr;
    const nm = g.state==="pre" ? esc(s.name) : `<span title="${esc(s.name)}">${s.abbr}</span>`;
    const key = g.id+side, prev = S.prevSc[key], flash = g.state==="in" && prev!=null && s.score!=null && s.score!==prev;
    if(s.score!=null) S.prevSc[key] = s.score;
    return `<button class="tbtn ${loser?"loser":""} ${winner?"winner":""}" style="--tc:${tcol(s.abbr)}" data-act="win" data-g="${g.id}" data-v="${s.abbr}" aria-pressed="${sel}" ${lock?"disabled":""}>
      <span class="tlogo"><img src="${s.logo||""}" alt=""></span><span class="tt"><b>${nm}</b>${s.rec&&g.state==="pre"?`<small class="rec">${s.rec}</small>`:""}<small class="ha">${side==="home"?ICON.home+"Ev sahibi":ICON.plane+"Deplasman"}</small></span>
      ${g.state!=="pre"?`<span class="sc ${flash?"flash":""}">${s.score??""}</span>`:""}</button>`;
  };
  let body = `<div class="teams">${t("away")}<span class="vs-mini">VS</span>${t("home")}</div>`;
  if(!lock){
    body += infoBox(g);
    const d = draftFor(g);
    body += `<div class="row-lbl">Fark</div><div class="margins">${MARGINS.map(m=>`<button class="mbtn" data-act="mar" data-g="${g.id}" data-v="${m}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>
      <div class="row-lbl">Maçın en skoreri</div>
      <button class="scorer-btn${d.scorerId?" has-face":""}" data-act="scorer" data-g="${g.id}">${d.scorerId ? `${faceImg(d.scorerId,"sb-face")}<b>${esc(d.scorerName)}</b><small>${ppg(d.scorerId)!=null?ppg(d.scorerId).toFixed(1)+" sayı ort.":""}</small>` : `<span class="ph">Oyuncu seç</span>`}</button>`;
    const saved = D.picks[g.id]?.[S.uid];
    const same = saved && saved.winner===d.winner && saved.margin===d.margin && saved.scorerId===d.scorerId;
    const missing = [!d.winner&&"kazanan", !d.margin&&"fark", !d.scorerId&&"en skorer"].filter(Boolean);
    const st = d.saving ? `<span class="muted">Kaydediliyor…</span>` : d.err ? `<span class="no">${d.err}</span>`
      : same ? `<span class="saved">✓ Kaydedildi</span>` : missing.length ? `<span class="need">Eksik: ${missing.join(", ")}</span>`
      : saved ? `<span class="need">Değişiklik kaydedilmedi</span>` : `<span class="need">Henüz kaydedilmedi</span>`;
    const canSave = !d.saving && !missing.length && !same;
    body += injuryNote(g) + seriesBox(g) + `<div class="g-foot">${st}</div>
      <button class="save-btn ${same && d.justSaved && Date.now()-d.justSaved<1500 ? "done":""}" data-act="save" data-g="${g.id}" ${canSave?"":"disabled"}>${same?'<span class="tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>Kaydedildi':saved?"Değişikliği kaydet":"Tahmini kaydet"}</button>
      <div class="lock-note">${lockLeft(g)}</div>`;
  } else {
    const rows = S.order.map(u => { const p = D.picks[g.id]?.[u]; return p ? pickCell(g, p, u, D.daily[u]?.confGame===g.id) : `<div class="prow" style="--pc:${col(u)}"><span class="who">${esc(pname(u))}</span><span class="pk muted">Tahmin yapmadı</span><span class="pts">0</span></div>`; }).join("");
    body += lineScore(g) + flowChart(g) + seriesBox(g) + `<div class="plist">${rows}</div>`;
    const tops = g.state==="post" ? topsOf(g) : liveTops(g);
    body += `<div class="g-foot"><span class="leaders">${tops?`En skorer: <b>${tops.map(x=>esc(x.name)).join(", ")}</b> ${tops[0].pts} sayı`:""}</span><span class="g-links">${g.state==="post"?`<button class="linkish" data-act="collapse" data-g="${g.id}">Küçült</button>`:""}<button class="linkish" data-act="box" data-g="${g.id}">İstatistikler</button></span></div>` + (g.state!=="pre" ? talkHTML(g) : "");
  }
  const conf = !lock ? `<button class="conf-btn" data-act="conf" data-g="${g.id}" aria-pressed="${confHere}" ${confLocked&&!confHere?"disabled":""} title="Günün bankosu: kazananı bilirsen +2, bilemezsen -1">★ ${confHere?"Banko":"Banko yap"}</button>`
    : confHere ? `<span class="conf-btn" aria-pressed="true">★ Banko</span>` : "";
  const dd = S.draft[g.id], sv = D.picks[g.id]?.[S.uid];
  const dirty = !lock && sv && dd && (dd.winner!==sv.winner || dd.margin!==sv.margin || dd.scorerId!==sv.scorerId);
  const missingCls = !lock && (!sv || dirty) ? " missing" : "";
  const myPick = D.picks[g.id]?.[S.uid];
  const myR = g.state==="post" && myPick ? scorePick(g, myPick, confHere) : null;
  const badge = myR ? `<span class="pt-badge ${myR.pts>0?"pos":myR.pts<0?"neg":"zero"}">${myR.pts>0?"+":""}${myR.pts}</span>` : "";
  let stt;
  if(g.state==="in"){
    const per = /half/i.test(g.typeName+g.detail) ? "Devre" : /end/i.test(g.typeName) ? (g.period<=4?`${g.period}. Ç sonu`:"UZ sonu") : g.period<=4 ? `${g.period}. Ç` : "UZ";
    const clk = /half|end/i.test(g.typeName+g.detail) ? "" : g.clock;
    stt = `<span class="badge-live">Canlı</span><span class="live-clock">${per}${clk?` <b>${clk}</b>`:""}</span>`;
  } else if(g.state==="pre") stt = `${gameStatusTR(g)}${startsIn(g)}${!lock ? ringHTML(g) : ' <span class="muted" style="font-weight:600">· Kilitli</span>'}`;
  else stt = gameStatusTR(g);
  const selAbbr = lock ? myPick?.winner : draftFor(g).winner;
  const glow = selAbbr ? `;--sel:${tcol(selAbbr)}` : "";
  return `<article class="game tex ${g.state==="in"?"is-live":""}${missingCls}${selAbbr?" has-sel":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}${glow}" data-gid="${g.id}">
    <div class="g-head"><span class="stt">${stt}</span><span class="g-hr">${badge}${conf}</span></div>${body}</article>`;
}
// Maç önü kutusu: ESPN kazanma olasılığı + son 5 maç + sakat sayısı (özet yüklendiyse)
function infoBox(g){
  const s = S.sums[g.id]?.data;
  let inner = `<span class="ib-loading">Maç öncesi bilgiler yükleniyor…</span>`;
  if(s){
    const pr = s.predictor;
    const a = pr?.awayTeam?.gameProjection!=null ? +pr.awayTeam.gameProjection : null;
    const h = pr?.homeTeam?.gameProjection!=null ? +pr.homeTeam.gameProjection : null;
    const l5 = t => ((s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[]).map(e=>`<i class="${e.gameResult}">${e.gameResult==="W"?"G":"M"}</i>`).join("");
    const inj = t => ((s.injuries||[]).find(x=>x.team?.abbreviation===t.abbr)?.injuries||[]).filter(i=>/out/i.test(i.status)).length;
    const side = (t,p,cls) => `<div class="ib-side ${cls}"><b>${esc(t.name)}${p!=null?` %${Math.round(p)}`:""}</b><span class="ib-l5">${l5(t)||""}</span><small>${inj(t)?`${inj(t)} oyuncu oynamıyor`:"Eksik oyuncu yok"}</small></div>`;
    inner = (a!=null ? `<div class="ib-bar"><i style="width:${a}%;background:${pairCols(g.away.abbr,g.home.abbr)[0]}"></i><i style="width:${h}%;background:${pairCols(g.away.abbr,g.home.abbr)[1]}"></i></div>` : "")
      + `<div class="ib-row">${side(g.away,a,"l")}${side(g.home,h,"r")}</div>`;
  }
  return `<button class="info-box" data-act="info" data-g="${g.id}"><span class="ib-h"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 20V10M10 20V4M16 20v-7M22 20H2"/></svg>Maç önü bilgileri<span class="ib-more">Ayrıntılar ›</span></span>${inner}</button>`;
}
function prefetchInfo(D){
  const need = D.games.filter(g => !started(g) && !S.sums[g.id]);
  if(!need.length || prefetchInfo.busy) return;
  prefetchInfo.busy = true;
  Promise.allSettled(need.map(g => loadSummary(g))).then(() => {
    prefetchInfo.busy = false;
    // kartları yeniden çiz ama yazılmakta olan seçimi bozma (taslaklar S.draft'ta)
    if(S.tab==="tahmin" && S.sub==="maclar" && S.days[S.day]===D) renderGames();
  });
}
function renderGames(){
  const D = S.days[S.day];
  if(!D){ $("#games").innerHTML = skeletonCards(); return; }
  $("#games").innerHTML = bestPickCard(D) + D.games.map(g => g.state==="post" && !S.open.has(g.id) ? compactCard(g) : isDone(g, D) ? pickedCard(g) : gameCard(g)).join("");
  celebrate(D);
  prefetchInfo(D);
  refreshInjuries(D);
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
  if(act==="edit"){ S.edit.add(g.id); return renderGames(); }
  if(act==="expand"){ S.open.add(g.id); if(!S.sums[g.id]) loadSummary(g).then(()=>{ if(S.tab==="tahmin") renderGames(); }).catch(()=>{}); return renderGames(); }
  if(act==="emo"){ const cur=D.talk?.[g.id]?.[S.uid]?.e; return saveTalk(g,{e: cur===b.dataset.v ? "" : b.dataset.v}); }
  if(act==="talk") return openTalk(g);
  if(act==="srw"||act==="srn"){ S.seriesDraft ||= {}; const k=g.series.key; const m=D.series?.[k]?.[S.uid]; const dd=(S.seriesDraft[k] ||= {w:m?.winner, n:m?.games}); if(act==="srw") dd.w=b.dataset.v; else dd.n=+b.dataset.v; return renderGames(); }
  if(act==="srsave") return saveSeries(g);
  if(act==="collapse"){ S.open.delete(g.id); return renderGames(); }
  if(act==="info") return openInfo(g);
  if(act==="box") return openBox(g);
  if(started(g)) return toast("Tahminler kilitlendi (gecenin ilk maçı başladı).");
  if(act==="save") return savePick(g);
  if(act==="win"){ d.winner=b.dataset.v; }
  if(act==="mar"){ d.margin=b.dataset.v; }
  if(act==="scorer"){ S.swipeReturn=false; return openPlayerPicker({mode:"game", g}); }
  if(act==="conf"){
    const cur = D.daily[S.uid]?.confGame;
    if(cur===g.id) return toast("Bankoyu başka maça taşıyabilirsin; kaldırılamaz.");
    return saveDaily({confGame:g.id, confStart:g.lock});
  }
  d.err=null; renderGames();
});


/* ====================================================== doğru tahmin anı ve skor akışı */
// Maç gözünün önünde bittiğinde (canlıdan bitti'ye geçiş) tahminin tuttuysa kart parlar, puan yukarı uçar.
S.lastState = {};
function celebrate(D){
  for(const g of D.games){
    const prev = S.lastState[g.id]; S.lastState[g.id] = g.state;
    if(prev!=="in" || g.state!=="post") continue;
    const p = D.picks[g.id]?.[S.uid]; if(!p) continue;
    const r = scorePick(g, p, D.daily[S.uid]?.confGame===g.id);
    const card = $(`#games [data-gid="${g.id}"]`); if(!card) continue;
    if(r.pts>0){
      card.classList.add("win-flash");
      const f=document.createElement("span"); f.className="pts-fly"; f.textContent=`+${r.pts}`; card.append(f);
      setTimeout(()=>{ card.classList.remove("win-flash"); f.remove(); }, 2200);
    } else card.classList.add("lose-fade");
  }
}
// Skor akışı: maç boyunca ev sahibinin farkı (üstte ev sahibi, altta deplasman önde)
const clockSec = c => { const v=String(c?.displayValue??c??""); if(v.includes(":")){ const [m,s]=v.split(":"); return +m*60 + +s; } return +v||0; };
function flowChart(g){
  if(g.state==="pre") return "";
  const plays = S.sums[g.id]?.data?.plays; if(!plays?.length) return "";
  const pts=[[0,0]]; let last=null;
  for(const p of plays){
    const per=p.period?.number||1, len=per<=4?720:300, base=per<=4?(per-1)*720:2880+(per-5)*300;
    const t=base + len - clockSec(p.clock), d=(p.homeScore??0)-(p.awayScore??0);
    if(last===null || d!==last){ pts.push([t,d]); last=d; }
  }
  const lastP=plays.at(-1), lp=lastP.period?.number||1;
  const end = g.state==="post" ? Math.max(2880, pts.at(-1)[0]) : Math.max(...pts.map(x=>x[0]));
  pts.push([end, pts.at(-1)[1]]);
  const W=320, H=64, max=Math.max(8, ...pts.map(x=>Math.abs(x[1])));
  const X=t=>(t/Math.max(end,1)*W).toFixed(1), Y=d=>(H/2 - d/max*(H/2-3)).toFixed(1);
  let path=`M0 ${H/2}`; for(let i=1;i<pts.length;i++){ path+=` H${X(pts[i][0])} V${Y(pts[i][1])}`; }
  const area=path+` V${H/2} Z`;
  const [ca,ch]=pairCols(g.away.abbr,g.home.abbr);
  const qs=[720,1440,2160].filter(q=>q<end).map(q=>`<line x1="${X(q)}" x2="${X(q)}" y1="2" y2="${H-2}" class="fl-q"/>`).join("");
  const big=pts.reduce((a,b)=>Math.abs(b[1])>Math.abs(a[1])?b:a,[0,0]);
  const bigTxt = big[1] ? `En büyük fark: ${esc(big[1]>0?g.home.abbr:g.away.abbr)} +${Math.abs(big[1])}` : "";
  return `<div class="flow"><div class="fl-h"><span>Skor akışı</span><small>${bigTxt}</small></div>
    <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" aria-hidden="true">
      <defs><clipPath id="flT${g.id}"><rect x="0" y="0" width="${W}" height="${H/2}"/></clipPath><clipPath id="flB${g.id}"><rect x="0" y="${H/2}" width="${W}" height="${H/2}"/></clipPath></defs>
      ${qs}<line x1="0" x2="${W}" y1="${H/2}" y2="${H/2}" class="fl-0"/>
      <path d="${area}" fill="${ch}" opacity=".35" clip-path="url(#flT${g.id})"/><path d="${area}" fill="${ca}" opacity=".35" clip-path="url(#flB${g.id})"/>
      <path d="${path}" fill="none" stroke="currentColor" stroke-width="1.4" vector-effect="non-scaling-stroke"/></svg>
    <div class="fl-k"><span><i style="background:${ch}"></i>${esc(g.home.abbr)} önde</span><span><i style="background:${ca}"></i>${esc(g.away.abbr)} önde</span></div></div>`;
}

/* ====================================================== tek tek tahmin (kaydırmalı) */
S.swipeIdx = 0;
function openSwipe(){
  const D=S.days[S.day]; const games=D.games.filter(g=>!started(g));
  if(!games.length) return toast("Açık maç kalmadı.");
  const firstMissing = games.findIndex(g=>!D.picks[g.id]?.[S.uid]);
  S.swipeIdx = firstMissing>=0 ? firstMissing : 0;
  openSheet(`<div id="swipe" class="swipe"></div>`); paintSwipe();
  const el=$("#swipe"); let x0=null, y0=null;
  el.addEventListener("touchstart", e=>{ x0=e.touches[0].clientX; y0=e.touches[0].clientY; }, {passive:true});
  el.addEventListener("touchend", e=>{ if(x0==null) return; const dx=e.changedTouches[0].clientX-x0, dy=e.changedTouches[0].clientY-y0; x0=null;
    if(Math.abs(dx)>60 && Math.abs(dx)>Math.abs(dy)*1.5) swipeGo(dx<0?1:-1); }, {passive:true});
}
function swipeGames(){ const D=S.days[S.day]; return D.games.filter(g=>!started(g)); }
function swipeGo(dir){
  const gs=swipeGames(); const n=S.swipeIdx+dir; if(n<0||n>=gs.length){ if(n>=gs.length){ closeSheet(); toast("Bütün maçları gezdin."); } return; }
  const card=$("#swipe .sw-card"); if(card){ card.classList.add(dir>0?"out-l":"out-r"); }
  setTimeout(()=>{ S.swipeIdx=n; paintSwipe(dir); }, 170);
}
function paintSwipe(dir=0){
  const box=$("#swipe"); if(!box) return;
  const D=S.days[S.day], gs=swipeGames(); if(!gs.length){ closeSheet(); return; }
  S.swipeIdx=Math.min(S.swipeIdx, gs.length-1);
  const g=gs[S.swipeIdx], d=draftFor(g), saved=D.picks[g.id]?.[S.uid];
  const same = saved && saved.winner===d.winner && saved.margin===d.margin && saved.scorerId===d.scorerId;
  const ready = d.winner && d.margin && d.scorerId;
  const team = side => { const t=g[side]; return `<button class="sw-team" style="--tc:${tcol(t.abbr)}" data-sw="win" data-v="${t.abbr}" aria-pressed="${d.winner===t.abbr}"><img src="${t.logo||LOGO_SMALL(t.abbr)}" alt=""><b>${esc(t.name)}</b>${t.rec?`<small>${t.rec}</small>`:""}<small class="ha">${side==="home"?ICON.home+"Ev sahibi":ICON.plane+"Deplasman"}</small></button>`; };
  const dots = gs.map((x,i)=>`<i class="${i===S.swipeIdx?"on":""} ${D.picks[x.id]?.[S.uid]?"ok":""}"></i>`).join("");
  box.innerHTML = `<div class="sw-top"><b>${S.swipeIdx+1} / ${gs.length}</b><span class="sw-dots">${dots}</span></div>
    <div class="sw-card ${dir>0?"in-r":dir<0?"in-l":""}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}">
      <div class="sw-time">${timeTR(g.start)} · ${esc(g.away.abbr)} @ ${esc(g.home.abbr)}</div>
      <div class="sw-teams">${team("away")}<span class="sw-vs">VS</span>${team("home")}</div>
      <div class="row-lbl">Fark</div><div class="margins">${MARGINS.map(m=>`<button class="mbtn" data-sw="mar" data-v="${m}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>
      <div class="row-lbl">Maçın en skoreri</div>
      <button class="scorer-btn${d.scorerId?" has-face":""}" data-sw="scorer">${d.scorerId?`${faceImg(d.scorerId,"sb-face")}<b>${esc(d.scorerName)}</b>`:`<span class="ph">Oyuncu seç</span>`}</button>
      <div class="sw-st">${same?'<span class="saved">✓ Kaydedildi</span>':ready?'<span class="need">Kaydetmeye hazır</span>':'<span class="need">Kazanan, fark ve skoreri seç</span>'}</div>
    </div>
    <div class="sw-nav"><button class="btn" data-sw="prev" ${S.swipeIdx?"":"disabled"}>‹ Önceki</button>
      <button class="btn-primary" data-sw="next">${same||!ready ? (S.swipeIdx<gs.length-1?"Sonraki ›":"Bitir") : (S.swipeIdx<gs.length-1?"Kaydet ve geç ›":"Kaydet ve bitir")}</button></div>
    <small class="muted sw-hint">Kartı sağa sola kaydırarak da geçebilirsin.</small>`;
  box.onclick = async e => {
    const b=e.target.closest("[data-sw]"); if(!b || b.disabled) return;
    const a=b.dataset.sw;
    if(started(g)){ toast("Bu maçın tahminleri kilitlendi."); return paintSwipe(); }
    if(a==="win"){ d.winner=b.dataset.v; return paintSwipe(); }
    if(a==="mar"){ d.margin=b.dataset.v; return paintSwipe(); }
    if(a==="scorer"){ S.swipeReturn=true; return openPlayerPicker({mode:"game", g}); }
    if(a==="prev") return swipeGo(-1);
    if(a==="next"){ if(ready && !same){ await savePick(g,{quiet:true}); } swipeGo(1); }
  };
}

/* ====================================================== gecenin sorusu */
// scripts/sync.py'deki QUESTIONS ile aynı sırada olmalı (gün numarası % soru sayısı).
const topPts = g => Math.max(0, ...((g.state==="post" ? topsOf(g) : liveTops(g)) || []).map(t=>t.pts));
const gMargin = g => Math.abs((g.home.score??0)-(g.away.score??0));
const QUESTIONS = [
  {t:"Gecenin en skoreri 40 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(topPts))>=40, mono:true},
  {t:"Bu gece en az bir maç 20 sayı ya da daha fazla farkla biter mi?", f:gs=>Math.max(...gs.map(gMargin))>=20},
  {t:"Bu gece en az bir maç uzatmaya gider mi?", f:gs=>gs.some(g=>g.period>4), mono:true},
  {t:"Bu gece bir takım 130 ya da daha fazla sayı atar mı?", f:gs=>Math.max(...gs.map(g=>Math.max(g.home.score??0,g.away.score??0)))>=130, mono:true},
  {t:"Deplasman takımları bu gece ev sahiplerinden daha çok maç kazanır mı?", f:gs=>gs.filter(g=>(g.away.score??0)>(g.home.score??0)).length > gs.filter(g=>(g.home.score??0)>(g.away.score??0)).length},
  {t:"Bu gece en az bir maç 3 sayı ya da daha az farkla biter mi?", f:gs=>Math.min(...gs.map(gMargin))<=3},
];
const questionOf = day => QUESTIONS[Number(day) % QUESTIONS.length];
// {final, ans:'y'|'n', early:true (gece bitmeden kesinleşti)}
function questionResult(day){
  const D=S.days[day]; if(!D?.games.length) return null;
  const q=questionOf(day), done=D.games.every(g=>g.state==="post");
  const going=D.games.filter(g=>g.state!=="pre");
  if(done) return {final:true, ans:q.f(D.games)?"y":"n"};
  if(q.mono && going.length && q.f(going)) return {final:true, ans:"y", early:true};
  return {final:false};
}
function questionCard(){
  const D=S.days[S.day]; if(!D?.games.length) return "";
  const q=questionOf(S.day), locked=D.games.some(started), mine=D.daily[S.uid]?.q;
  const lbl = v => v==="y" ? "Evet" : "Hayır";
  if(!locked) return `<div class="qcard"><span class="ico">${ICON.question}</span><span class="tx"><b>Gecenin sorusu</b><span class="qt">${q.t}</span>
    <span class="qbtns"><button data-q="y" aria-pressed="${mine==="y"}">Evet</button><button data-q="n" aria-pressed="${mine==="n"}">Hayır</button></span>
    <small>Doğru cevap +1. Gecenin ilk maçı başlayınca kilitlenir.</small></span></div>`;
  const r=questionResult(S.day);
  const rows=S.order.map(u=>{ const a=D.daily[u]?.q; const st=!a?'<span class="muted">cevaplamadı</span>':r?.final?(a===r.ans?'<span class="ok">+1</span>':'<span class="no">0</span>'):"";
    return `<span><b style="color:${col(u)}">${esc(pname(u))}</b> ${a?lbl(a):""} ${st}</span>`; }).join("");
  return `<div class="qcard"><span class="ico">${ICON.question}</span><span class="tx"><b>Gecenin sorusu</b><span class="qt">${q.t}</span>
    ${r?.final?`<span class="qres">Cevap: <b>${lbl(r.ans)}</b></span>`:""}<span class="qrows">${rows}</span></span></div>`;
}
$("#dayPlayer").addEventListener("click", e => {
  const b=e.target.closest("[data-q]"); if(!b) return;
  const D=S.days[S.day]; if(D.games.some(started)) return toast("Soru kilitlendi, gecenin ilk maçı başladı.");
  saveDaily({q:b.dataset.q});
});

/* ====================================================== laf atma */
const TALK_EMOJI = ["😂","🔥","🤡","😱","👏","💀","🎯","🙏"];
const textProblem = t => { const f=foldName(t), joined=squeeze(f.replace(/[^a-z]/g,"")), words=f.split(/[^a-z]+/).filter(Boolean).map(squeeze);
  return BAD_SUB.some(x=>joined.includes(x)) || words.some(w=>BAD_WORD.has(w)); };
function talkHTML(g){
  const D=S.days[S.day], T=D.talk?.[g.id]||{};
  const list=S.order.filter(u=>T[u] && (T[u].e||T[u].t)).map(u=>`<div class="tk">${avatar(u,"xs")}<span><b style="color:${col(u)}">${esc(pname(u))}</b>${T[u].e?` <span class="tk-e">${T[u].e}</span>`:""}${T[u].t?` ${esc(T[u].t)}`:""}</span></div>`).join("");
  const me=T[S.uid]||{};
  return `<div class="talk">${list}<div class="tk-bar">${TALK_EMOJI.map(e=>`<button data-act="emo" data-g="${g.id}" data-v="${e}" aria-pressed="${me.e===e}">${e}</button>`).join("")}
    <button class="tk-write" data-act="talk" data-g="${g.id}">${me.t?"Yorumunu değiştir":"Yorum yaz"}</button></div></div>`;
}
async function saveTalk(g, patch){
  const D=S.days[S.day], cur=D.talk?.[g.id]?.[S.uid]||{e:"",t:""};
  const data={uid:S.uid, gid:g.id, day:S.day, e:cur.e||"", t:cur.t||"", ...patch, at:serverTimestamp()};
  (D.talk[g.id] ||= {})[S.uid] = data; renderGames();
  try{ await setDoc(doc(S.db,"talk",`${g.id}_${S.uid}`), data); }catch(e){ toast("Gönderilemedi, tekrar dene."); }
}
function openTalk(g){
  const cur=S.days[S.day].talk?.[g.id]?.[S.uid]?.t||"";
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} – ${esc(g.home.name)}</h3><p class="muted">En fazla 80 karakter. Herkes görür.</p>
    <textarea id="tkIn" maxlength="80" rows="2" class="tk-in" placeholder="Bir şey yaz…">${esc(cur)}</textarea><p class="err" id="tkErr"></p>
    <div style="display:flex;gap:8px"><button class="btn-primary" id="tkSend" type="button">Gönder</button>${cur?'<button class="btn" id="tkDel" type="button">Sil</button>':""}</div>`);
  $("#tkIn").focus();
  $("#tkSend").onclick=()=>{ const t=$("#tkIn").value.trim(); if(textProblem(t)){ $("#tkErr").textContent="Küfür ve hakaret yazılamaz."; return; } closeSheet(); saveTalk(g,{t}); };
  $("#tkDel")?.addEventListener("click",()=>{ closeSheet(); saveTalk(g,{t:""}); });
}

/* ====================================================== sakatlık uyarısı */
// Seçtiğin skorer ya da günün oyuncusu ESPN'e göre oynamıyorsa / belirsizse uyar
S.rosterAt = {};
async function refreshInjuries(D){
  if(refreshInjuries.busy) return;
  const open=D.games.filter(g=>!started(g)); if(!open.length) return;
  const teams=open.flatMap(g=>[g.away,g.home]).filter(t=>!S.rosterAt[t.id] || Date.now()-S.rosterAt[t.id]>20*60e3);
  if(!teams.length) return;
  refreshInjuries.busy=true;
  await Promise.allSettled(teams.map(t=>{ delete S.rosters[t.id]; return loadRoster(t).then(()=>{ S.rosterAt[t.id]=Date.now(); }); }));
  refreshInjuries.busy=false;
  if(S.days[S.day]===D) render();
}
function injuryOf(pid, teams){
  for(const t of teams){ const p=(S.rosters[t.id]||[]).find(x=>x.id===pid); if(p) return p.inj ? (/out/i.test(p.inj) ? "out" : "doubt") : "ok"; }
  return null;
}
function injuryNote(g){
  const d=draftFor(g); if(!d.scorerId || started(g)) return "";
  const st=injuryOf(d.scorerId,[g.away,g.home]);
  if(st==="out") return `<div class="inj-warn"><b>${esc(d.scorerName)} bu maçta oynamıyor.</b> Skorer seçimini değiştirmen iyi olur.</div>`;
  if(st==="doubt") return `<div class="inj-warn soft"><b>${esc(d.scorerName)}</b> için oynayıp oynamayacağı belirsiz.</div>`;
  return "";
}
function injuryAlerts(D){
  const out=[];
  for(const g of D.games){ if(started(g)) continue; const p=D.picks[g.id]?.[S.uid]; if(p && injuryOf(p.scorerId,[g.away,g.home])==="out") out.push(p.scorerName); }
  const dp=D.daily[S.uid]; if(dp?.dayPlayerId && !D.games.some(started) && injuryOf(dp.dayPlayerId, D.games.flatMap(g=>[g.away,g.home]))==="out") out.push(dp.dayPlayerName+" (günün oyuncusu)");
  return out;
}

/* ====================================================== playoff seri tahmini */
function seriesBox(g){
  const sr=g.series; if(!sr) return "";
  const D=S.days[S.day], picks=D.series?.[sr.key]||{}, mine=picks[S.uid];
  const [a,b]=[g.away,g.home];
  const score=`${esc(a.abbr)} ${sr.wins[a.abbr]??0}–${sr.wins[b.abbr]??0} ${esc(b.abbr)}`;
  const openPick = !started(g) && (sr.wins[a.abbr]??0)+(sr.wins[b.abbr]??0)===0;
  const res = S.arch.scores.series?.[sr.key];
  let body;
  if(openPick){
    const d = S.seriesDraft?.[sr.key] || {w:mine?.winner, n:mine?.games};
    body = `<div class="sr-pick"><span class="sr-q">Seriyi kim, kaç maçta alır? Kazananı bilirsen +3, maç sayısını da bilirsen +2 daha.</span>
      <div class="sr-row">${[a,b].map(t=>`<button data-act="srw" data-g="${g.id}" data-v="${t.abbr}" aria-pressed="${d.w===t.abbr}"><img src="${t.logo}" alt="">${esc(t.abbr)}</button>`).join("")}</div>
      <div class="sr-row">${[4,5,6,7].map(n=>`<button data-act="srn" data-g="${g.id}" data-v="${n}" aria-pressed="${+d.n===n}">${n} maç</button>`).join("")}</div>
      <button class="btn" data-act="srsave" data-g="${g.id}" ${d.w&&d.n&&!(mine&&mine.winner===d.w&&mine.games===+d.n)?"":"disabled"}>${mine&&mine.winner===d.w&&mine.games===+d.n?"✓ Kaydedildi":"Seri tahminini kaydet"}</button></div>`;
  } else {
    body = `<div class="sr-list">${S.order.map(u=>{ const p=picks[u]; const r=res?.row?.[u];
      return `<span><b style="color:${col(u)}">${esc(pname(u))}</b> ${p?`${esc(p.winner)}, ${p.games} maçta`:'<span class="muted">tahmin yapmadı</span>'}${r?` <span class="${r.pts>0?"ok":"no"}">${r.pts>0?"+"+r.pts:"0"}</span>`:""}</span>`; }).join("")}</div>`;
  }
  return `<div class="series"><div class="sr-h"><span>Playoff serisi</span><b>${score}</b>${res?`<small>${esc(res.winner)} ${res.games} maçta kazandı</small>`:""}</div>${body}</div>`;
}
async function saveSeries(g){
  const sr=g.series, d=S.seriesDraft?.[sr.key]; if(!d?.w || !d?.n) return;
  const D=S.days[S.day], prev=D.series?.[sr.key]?.[S.uid];
  const data={uid:S.uid, key:sr.key, winner:d.w, games:+d.n, start: prev?.start || Timestamp.fromDate(g.lock), updatedAt:serverTimestamp()};
  try{ await setDoc(doc(S.db,"series",`${sr.key}_${S.uid}`), data); (D.series[sr.key] ||= {})[S.uid]=data; toast(pick(["Seri tahminin kaydedildi.","Seri tahminin alındı.","Kaydedildi, seri başlasın."])); }
  catch(e){ toast("Kaydedilemedi, seri başlamış olabilir."); }
  renderGames();
}

/* ====================================================== hızlı tahmin */
// Bütün açık maçlar tek ekranda. Takım seçince fark (ESPN olasılığına göre) ve skorer (takımın sayı lideri) önerisi dolar.
function suggestMargin(g, abbr){
  const pr=S.sums[g.id]?.data?.predictor; const side = abbr===g.home.abbr ? pr?.homeTeam : pr?.awayTeam;
  const p = side?.gameProjection!=null ? +side.gameProjection : null;
  if(p==null || p<55) return "1-5";
  return p<68 ? "6-10" : p<80 ? "11-15" : "16+";
}
function teamTop(g, abbr){
  const t = abbr===g.home.abbr ? g.home : g.away;
  return (S.rosters[t.id]||[]).filter(p=>!/out/i.test(p.inj||"")).map(p=>({...p, ppg:ppg(p.id)})).sort((a,b)=>(b.ppg??-1)-(a.ppg??-1)).slice(0,8);
}
async function openQuick(){
  const D=S.days[S.day], games=D.games.filter(g=>!started(g));
  if(!games.length) return toast("Açık maç kalmadı.");
  openSheet(`<h3 id="shTitle">Hızlı tahmin</h3><p class="muted">Kadrolar yükleniyor…</p>`);
  await Promise.allSettled([...games.flatMap(g=>[g.away,g.home]).map(t=>loadRoster(t)), ...games.filter(g=>!S.sums[g.id]).map(g=>loadSummary(g))]);
  paintQuick();
}
function paintQuick(){
  const D=S.days[S.day], games=D.games.filter(g=>!started(g)); const box=$("#shBody"); if(!box) return;
  const rows=games.map(g=>{
    const d=draftFor(g), sv=D.picks[g.id]?.[S.uid];
    const same = sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId;
    const team = t => `<button class="qk-t ${d.winner===t.abbr?"on":""}" style="--tc:${tcol(t.abbr)}" data-qw="${t.abbr}" data-g="${g.id}"><img src="${t.logo}" alt="">${esc(t.abbr)}</button>`;
    const opts = d.winner ? teamTop(g,d.winner) : [];
    const sel = d.winner ? `<select class="qk-s" data-qs="${g.id}">${d.scorerId && !opts.some(o=>o.id===d.scorerId) ? `<option value="${d.scorerId}" selected>${esc(d.scorerName)}</option>` : ""}${opts.map(o=>`<option value="${o.id}" ${o.id===d.scorerId?"selected":""}>${esc(o.name)}${o.ppg!=null?` · ${o.ppg.toFixed(1)}`:""}</option>`).join("")}</select>` : `<span class="muted qk-hint">Önce kazananı seç</span>`;
    return `<div class="qk ${same?"saved":d.winner?"dirty":""}"><div class="qk-h"><span>${timeTR(g.start)}</span><span>${same?'<span class="ok">✓ Kaydedildi</span>':d.winner&&d.margin&&d.scorerId?'<span class="need">Kaydedilmedi</span>':""}</span></div>
      <div class="qk-teams">${team(g.away)}<span class="qk-at">@</span>${team(g.home)}</div>
      ${d.winner?`<div class="qk-m">${MARGINS.map(m=>`<button data-qm="${m}" data-g="${g.id}" aria-pressed="${d.margin===m}">${m}</button>`).join("")}</div>`:""}${sel}</div>`;
  }).join("");
  const ready=games.filter(g=>{ const d=draftFor(g), sv=D.picks[g.id]?.[S.uid]; return d.winner&&d.margin&&d.scorerId && !(sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId); }).length;
  box.innerHTML=`<h3 id="shTitle">Hızlı tahmin</h3><p class="muted">Kazananı seç; fark ESPN olasılığına göre, skorer takımın sayı liderine göre önerilir. İstersen değiştir, sonra hepsini birden kaydet.</p>
    <div class="qk-list">${rows}</div>
    <div class="qk-bar"><button class="btn-primary" id="qkSave" ${ready?"":"disabled"}>${ready?`${ready} tahmini kaydet`:"Kaydedilecek değişiklik yok"}</button></div>`;
  box.onclick=e=>{
    const w=e.target.closest("[data-qw]"), m=e.target.closest("[data-qm]");
    if(w){ const g=D.games.find(x=>x.id===w.dataset.g), d=draftFor(g); if(started(g)) return;
      const changed=d.winner!==w.dataset.qw; d.winner=w.dataset.qw;
      if(!d.margin || d.autoM){ d.margin=suggestMargin(g,d.winner); d.autoM=true; }
      if(!d.scorerId || (d.autoS && changed)){ const top=teamTop(g,d.winner)[0]; if(top){ d.scorerId=top.id; d.scorerName=top.name; d.autoS=true; } }
      return paintQuick(); }
    if(m){ const g=D.games.find(x=>x.id===m.dataset.g), d=draftFor(g); d.margin=m.dataset.qm; d.autoM=false; return paintQuick(); }
  };
  box.onchange=e=>{ const s=e.target.closest("[data-qs]"); if(!s) return; const g=D.games.find(x=>x.id===s.dataset.qs), d=draftFor(g);
    d.scorerId=s.value; d.scorerName=s.options[s.selectedIndex].text.split(" · ")[0]; d.autoS=false; paintQuick(); };
  $("#qkSave").onclick=async()=>{
    $("#qkSave").disabled=true; $("#qkSave").textContent="Kaydediliyor…";
    let n=0;
    for(const g of games){ const d=draftFor(g), sv=D.picks[g.id]?.[S.uid];
      if(!(d.winner&&d.margin&&d.scorerId) || (sv && sv.winner===d.winner && sv.margin===d.margin && sv.scorerId===d.scorerId)) continue;
      await savePick(g, {quiet:true}); if(!d.err) n++; }
    toast(n ? pick([`${n} tahmin kaydedildi.`,`Tamamdır, ${n} tahmin kaydedildi.`,`${n} maçın tahmini hazır.`]) : "Kaydedilemedi, tekrar dene."); paintQuick(); renderStatus();
  };
}

/* ====================================================== Günün tahminleri */
function lockLeft(g){
  const ms = g.lock.getTime() - Date.now();
  if(ms<=0) return "Kilitlendi";
  const h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  if(h>=12) return `${timeTR(g.lock)}'de, gecenin ilk maçıyla kilitlenir`;
  return `Kilide ${h?h+" sa ":""}${m} dk var · ${timeTR(g.lock)}'de, gecenin ilk maçıyla kilitlenir`;
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
  else dp = "Günün oyuncusu ilk maçla birlikte görünecek";
  let html = `<div class="chips" id="dvSel">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>
    <div class="dv-head"><span><b style="color:${col(u)}">${esc(pname(u))}</b> · ${count}/${D.games.length} maç girildi</span><span class="muted">${dp}</span></div><div class="dv-list">`;
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
      body = `<div class="dv-hidden">${prog.has(g.id)?"<b>✓ Tahmin yaptı</b> · ":"Henüz tahmin yapmadı · "}seçimler ${timeTR(g.lock)}'de açılacak</div>`;
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
  const teamsChips = mode==="game" ? `<div class="chips" id="tmF"><button class="chip" data-v="" aria-pressed="true">Hepsi</button><button class="chip" data-v="${g.away.abbr}" aria-pressed="false">${esc(g.away.name)}</button><button class="chip" data-v="${g.home.abbr}" aria-pressed="false">${esc(g.home.name)}</button></div>` : "";
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
    if(mode!=="game") S.swipeReturn=false;
    if(mode==="game"){
      if(started(g)) return toast("Tahminler kilitlendi (gecenin ilk maçı başladı).");
      const d=draftFor(g); d.scorerId=b.dataset.id; d.scorerName=b.dataset.name; d.err=null; renderGames();
      if(S.swipeReturn){ S.swipeReturn=false; openSheet(`<div id="swipe" class="swipe"></div>`); paintSwipe(); }
    } else {
      if(D.games.some(started)) return toast("Günün oyuncusu kilitlendi (gecenin ilk maçı başladı).");
      saveDaily({dayPlayerId:b.dataset.id, dayPlayerName:b.dataset.name});
    }
  };
}

/* ====================================================== maç önü ve kutu skoru */
async function openInfo(g){
  openSheet(`<h3 id="shTitle">${esc(g.away.name)} @ ${esc(g.home.name)}</h3><p class="muted">Yükleniyor…</p>`);
  let s; try{ s = await loadSummary(g); }catch(e){ $("#shBody").innerHTML += `<div class="note">Maç öncesi bilgilere şu an ulaşılamıyor.</div>`; return; }
  const teamSec = side => {
    const t=g[side];
    const l5 = (s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[];
    const inj = (s.injuries||[]).find(x=>x.team?.abbreviation===t.abbr)?.injuries||[];
    const ld = (s.leaders||[]).find(x=>x.team?.abbreviation===t.abbr)?.leaders||[];
    const pts = ld.find(x=>/points/i.test(x.name))?.leaders?.[0];
    const reb = ld.find(x=>/rebounds/i.test(x.name))?.leaders?.[0];
    const ast = ld.find(x=>/assists/i.test(x.name))?.leaders?.[0];
    return `<div class="box"><h4 style="margin:0 0 8px;display:flex;gap:8px;align-items:center"><img src="${t.logo}" alt="" width="26" height="26">${esc(t.name)} <small class="muted">${t.rec}</small><button class="linkish" data-tp="${t.abbr}" style="margin-left:auto;font-size:13px">Takım sayfası ›</button></h4>
      <div class="row-lbl">Son 5 maç</div><div class="l5">${l5.map(e=>`<span class="${e.gameResult}" title="${esc(e.atVs||"")} ${esc(e.opponent?.abbreviation||"")} ${esc(e.score||"")}">${e.gameResult==="W"?"G":"M"}</span>`).join("")||'<span class="muted">–</span>'}</div>
      <div class="row-lbl">Öne çıkan oyuncular (maç başına ortalama)</div><div style="font-size:14px">${[pts&&`${esc(pts.athlete.displayName)} ${pts.displayValue} sayı`,reb&&`${esc(reb.athlete.displayName)} ${reb.displayValue} ribaund`,ast&&`${esc(ast.athlete.displayName)} ${ast.displayValue} asist`].filter(Boolean).join("<br>")||"–"}</div>
      <div class="row-lbl">Sakatlar</div><div style="font-size:14px">${inj.length?inj.slice(0,6).map(i=>`${esc(i.athlete?.displayName)} <span class="inj ${/out/i.test(i.status)?"":"q"}">${/out/i.test(i.status)?"Oynamıyor":"Belirsiz"}</span>`).join("<br>"):'<span class="muted">Sakat oyuncu yok</span>'}</div></div>`;
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
      ${rows.map(p=>`<tr class="${p.pts===top?"top":""}"><td>${esc(p.name)}${p.starter?"":' <span class="muted">·</span>'}</td><td>${p.min}</td><td><b>${p.pts}</b></td><td>${p.reb}</td><td>${p.ast}</td><td>${p.fg}</td><td>${p.tp}</td><td>${p.ft}</td><td>${p.pm}</td></tr>`).join("")||'<tr><td colspan="9" class="muted">Maç başlayınca istatistikler burada görünecek</td></tr>'}
      </tbody></table></div></div>`;
  };
  $("#shBody").innerHTML = `<h3 id="shTitle">${esc(g.away.name)} ${g.away.score??""} – ${g.home.score??""} ${esc(g.home.name)}</h3><p class="muted" style="margin-top:-6px">${gameStatusTR(g)} · SA: isabet-deneme, 3S: üçlük, SB: serbest atış</p>${table("away")}${table("home")}`;
}
function openSheet(html){ if($("#sheet").classList.contains("hide")){ try{ history.pushState({sheet:1}, ""); }catch(e){} }
  $("#shBody").innerHTML=html; $("#sheet").classList.remove("hide"); $$("#sheet, #sheet *").forEach(el=>{ if(el.scrollTop) el.scrollTop=0; }); document.body.style.overflow="hidden"; $("#shClose").focus(); }
function closeSheet(fromPop){ if(S.sheetLocked){ if(fromPop) try{ history.pushState({sheet:1}, ""); }catch(e){} return; }
  if($("#sheet").classList.contains("hide")) return;
  $("#sheet").classList.add("hide"); document.body.style.overflow="";
  if(!fromPop && history.state?.sheet){ S.popSkip=true; history.back(); } }
addEventListener("popstate", ()=>{ if(S.popSkip){ S.popSkip=false; return; } if(!$("#sheet").classList.contains("hide")) closeSheet(true); });
$("#shClose").onclick = ()=>closeSheet();
$("#sheet").addEventListener("click", e => { if(e.target.id==="sheet") closeSheet(); });
document.addEventListener("keydown", e => { if(e.key==="Escape") closeSheet(); });


/* ====================================================== Kurallar */
function openRules(){
  openSheet(`<div class="rules"><h3 id="shTitle">Kurallar</h3>
    <p>Her gece o günün bütün NBA maçları için üç tahmin yaparsın: <b>kazanan takım</b>, <b>fark aralığı</b> ve <b>maçın en skoreri</b>. Üçünü de doldurup "Tahmini kaydet"e basman gerekir.</p>
    <h4>Puanlar</h4>
    <div class="pt"><span>Kazananı bilirsen</span><b>+1</b><span>Kazananla birlikte farkı da bilirsen</span><b>+1</b><span>Maçın en skorerini bilirsen</span><b>+1</b><span>Bir maçtan alınabilecek en yüksek puan</span><b>3 puan</b></div>
    <h4>Günün bankosu</h4>
    <p>Her gece bir maçı banko seçersin. O maçta kazananı bilirsen <b>+1</b> yerine <b>+2</b> alırsın, bilemezsen <b>-1</b> puan kaybedersin. Fark ve en skorer puanları değişmez. Bankoyu başka bir maça taşıyabilirsin ama tamamen kaldıramazsın.</p>
    <h4>Günün oyuncusu</h4>
    <p>O gecenin bütün maçları arasından bir oyuncu seçersin. Gecenin en çok sayı atan oyuncusu o olursa <b>+2</b>.</p>
    <h4>Gecenin sorusu</h4>
    <p>Her gece evet ya da hayır diye cevaplanan bir soru gelir (ör. "Bu gece uzatmaya giden maç olur mu?"). Doğru cevap <b>+1</b>. Sonuç, gecenin maçları bitince belli olur.</p>
    <h4>Playoff serileri</h4>
    <p>Playoff'ta her seri başlamadan önce seriyi kimin kaç maçta kazanacağını tahmin edersin. Kazananı bilirsen <b>+3</b>, maç sayısını da bilirsen <b>+2</b> daha. Tahminler serinin ilk maçı başlayınca kilitlenir.</p>
    <h4>Fark aralıkları</h4>
    <p>1-5 · 6-10 · 11-15 · 16+. Uzatmaya giden maçlarda da son skordaki fark geçerlidir. Fark puanını almak için kazananı da bilmen gerekir.</p>
    <h4>Kilit ve gizlilik</h4>
    <p>Gecenin bütün tahminleri (maçlar, banko, günün oyuncusu, gecenin sorusu) <b>gecenin ilk maçı başladığı anda</b> kilitlenir; o ana kadar istediğin kadar değiştirebilirsin. Kilitlenene kadar kimse başkasının seçimlerini göremez. Kimin kaç maçı doldurduğu ise "Günün tahminleri"nde görünür.</p>
    <h4>Eşitlikler</h4>
    <p>Birden fazla oyuncu aynı en yüksek sayıyı atarsa bunlardan birini seçen herkes bilmiş sayılır.</p>
    <h4>Gece, hafta, sezon</h4>
    <p>Gecenin en çok puanını tek başına alan, o geceyi kazanır. Haftalar pazartesi başlar, pazar biter. Sezon puanı bütün gecelerin toplamıdır. <b>Playoff'ta bütün puanlar iki katına çıkar.</b></p>
    <h4>Yeni oyuncu</h4>
    <p>Siteye girip "Yeni oyuncu" sekmesinde adını, güvenlik sorusunun cevabını, 6 haneli şifreni ve davet kodunu girerek katılırsın.</p>
    <h4>Yorumlar</h4>
    <p>Maçlar kilitlendikten sonra her maça emoji bırakabilir ya da kısa bir yorum yazabilirsin. Küfür ve hakaret yazılamaz.</p>
    <p class="muted" style="margin-top:18px;font-size:12px;text-align:center">Sürüm ${VERSION}</p></div>`);
}
$("#rulesBtn").onclick = openRules;

/* ====================================================== SONUÇLAR */
// Sonuçlar sekmesi açılınca: bu gecenin maçları başladıysa bugün, başlamadıysa oynanmış son gece (dün)
function resDay(){
  if(S.rday) return S.rday;
  if(S.day!==S.today) return S.day;
  const D=S.days[S.today];
  return D?.games.some(g=>g.state!=="pre") ? S.today : shiftDay(S.today,-1);
}
async function renderResults(){
  const day = resDay();
  const rel = day===S.today ? "Bugün" : day===shiftDay(S.today,-1) ? "Dün" : day===shiftDay(S.today,1) ? "Yarın" : "";
  $("#rdLabel").innerHTML = rel ? `${rel}<small>${dayNice(day)} (ABD)</small>` : `${dayNice(day)}<small>ABD tarihi</small>`;
  const D = S.days[day];
  if(!D){ $("#results").innerHTML=skeletonCards(2); loadDay(day).then(()=>{ if(S.tab==="sonuclar") renderResults(); }).catch(()=>{ $("#results").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor.</div>`; }); return; }
  if(!D.games.length){ $("#results").innerHTML=`<div class="note">Bu gece NBA'de maç yok. Oklarla diğer günlere bakabilirsin.</div>`; return; }
  const order={in:0,post:1,pre:2};
  const games=[...D.games].sort((a,b)=>(order[a.state]-order[b.state])||(a.start-b.start));
  const hl = inLeague(day) ? headlineOf(day) : "", hw = dayWinner(day);
  $("#results").innerHTML = (hl?`<div class="headline" style="--hc:${hw?.st==="w"?col(hw.u):"var(--amber)"}"><span>🌙</span><span><b>Gecenin manşeti</b>${esc(hl)}</span></div>`:"") + `<div class="res">${games.map(g=>{
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
      ${tm("away")}${tm("home")}${lineScore(g)}${lead?`<div class="rg-l">${lead}</div>`:""}</button>`;
  }).join("")}</div>`;
  // biten maçların oyuncu istatistiklerini arka planda getir
  const need = games.filter(g=>g.state==="post" && !S.sums[g.id]);
  if(need.length) Promise.all(need.slice(0,15).map(g=>loadSummary(g).catch(()=>null))).then(()=>{ if(S.tab==="sonuclar" && (resDay())===day) renderResults(); });
}
$("#results").addEventListener("click", e => {
  const b=e.target.closest(".rg"); if(!b) return;
  const D=S.days[resDay()]; const g=D?.games.find(x=>x.id===b.dataset.g); if(!g) return;
  if(g.state==="pre") return openInfo(g);
  openBox(g);
});
$("#rdPrev").onclick=()=>{ S.rday=shiftDay(resDay(),-1); renderResults(); };
$("#rdNext").onclick=()=>{ S.rday=shiftDay(resDay(),1); renderResults(); };

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
    const t=g[side], o=side==="home"?g.away:g.home, ps=picks.filter(x=>x[1].winner===t.abbr);
    const diff=(t.score??0)-(o.score??0);
    const cls = g.state==="post" ? (diff>0?"won":"lost") : g.state==="in" && diff>0 ? "leading" : "";
    const who = ps.map(([u,p])=>{
      const r = g.state!=="pre" ? scorePick(g,p,D.daily[u]?.confGame===g.id) : null;
      return `<div class="fo-p">${avatar(u,"sm")}<span class="fo-pi"><b style="color:${col(u)}">${esc(pname(u))}${D.daily[u]?.confGame===g.id?' <span class="star">★</span>':""}</b><small>${p.margin} · ${esc(p.scorerName)}</small></span>${r&&(g.state==="post"||g.state==="in")?`<span class="fo-pts ${r.pts>0?"pos":r.pts<0?"neg":""}">${r.pts>0?"+":""}${r.pts}</span>`:""}</div>`;
    }).join("") || `<small class="muted">kimse</small>`;
    return `<div class="fo-side ${cls}" style="--tc:${tcol(t.abbr)}"><div class="fo-tm"><img src="${t.logo}" alt=""><span><b>${esc(t.abbr)}</b><small>${esc(t.name)}</small></span>${g.state!=="pre"?`<span class="fo-sc">${t.score??""}</span>`:""}</div>${who}
      ${cls==="won"?'<span class="fo-flag">Haklı çıktı</span>':cls==="leading"?'<span class="fo-flag lead">Şu an önde</span>':""}</div>`;
  };
  let html = items.length ? `<div class="split">${items.map(({g,picks})=>{
      const st = g.state==="in"?`<span class="badge-live">Canlı</span> ${gameStatusTR(g)}`:gameStatusTR(g);
      return `<div class="faceoff ${g.state==="in"?"is-live":""}"><div class="fo-h"><span>${esc(g.away.name)} @ ${esc(g.home.name)}</span><small>${st}</small></div>
        <div class="fo-body">${sideBox(g,"away",picks)}<div class="fo-vs"><span>VS</span></div>${sideBox(g,"home",picks)}</div></div>`;
    }).join("")}</div>` : `<div class="note">${st.length?"Başlayan maçların hepsinde aynı takımı seçtiniz.":"Maçlar başlayınca kimin hangi takımı tuttuğu burada karşılaştırılacak."}</div>`;
  if(pending) html += `<div class="note">${pending} maçın seçimleri henüz kapalı. Kilit açılınca farklı tahmin ettiğiniz maçlar burada görünecek.</div>`;
  $("#ayrisma").innerHTML = html;
}

/* ====================================================== sezon grafiği ve gece takvimi */
function dayWinner(d){
  const p=dayPoints(d);
  if(!S.order.some(u=>p[u]?.n)) return null;
  if(S.order.some(u=>p[u] && !p[u].final)) return {st:"live"};
  const best=Math.max(...S.order.map(u=>p[u]?.pts??-99)); const w=S.order.filter(u=>(p[u]?.pts??-99)===best);
  return w.length===1 ? {st:"w", u:w[0], pts:best} : {st:"t", pts:best};
}
function seasonChart(){
  const days=[...allDays()].reverse();
  if(days.length<2) return "";
  const cum={}, series={}; S.order.forEach(u=>{cum[u]=0; series[u]=[0];});
  for(const d of days){ const p=dayPoints(d); for(const u of S.order){ cum[u]+=p[u]?.pts||0; series[u].push(cum[u]); } }
  const W=600, H=210, L=8, R=64, T=12, B=26, n=days.length;
  const max=Math.max(4,...S.order.map(u=>cum[u])), min=Math.min(0,...S.order.flatMap(u=>series[u]));
  const x=i=>L+(W-L-R)*i/n, y=v=>T+(H-T-B)*(1-(v-min)/(max-min||1));
  const step=Math.max(1,Math.ceil(max/4/5)*5);
  let g=""; for(let v=0; v<=max; v+=step) g+=`<line x1="${L}" x2="${W-R}" y1="${y(v)}" y2="${y(v)}" class="gl"/>${v?`<text x="${L}" y="${y(v)-4}" class="gt">${v}</text>`:""}`;
  const ranked=[...S.order].sort((a,b)=>cum[b]-cum[a]);
  const lines=ranked.slice().reverse().map(u=>{
    const pts=series[u].map((v,i)=>`${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const lx=x(n), ly=y(cum[u]);
    return `<polyline points="${pts}" fill="none" stroke="${col(u)}" stroke-width="3" stroke-linejoin="round" stroke-linecap="round" class="ln"/>
      <circle cx="${lx}" cy="${ly}" r="5" fill="${col(u)}" stroke="var(--panel)" stroke-width="2"/>`;
  }).join("");
  // uç etiketleri üst üste binmesin
  let lastY=-99; const labels=ranked.map(u=>{ let ly=Math.max(y(cum[u])+4, lastY+15); lastY=ly; return `<text x="${W-R+8}" y="${ly}" class="el" fill="${col(u)}">${cum[u]}</text>`; }).join("");
  const dl=d=>dayNice(d,{day:"numeric",month:"short"});
  return `<div class="sec-title"><h2>Sezon grafiği</h2><span class="aside">gece gece toplam puan</span></div>
    <div class="box chart"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Sezon boyunca toplam puan">${g}${lines}${labels}
    <text x="${L}" y="${H-6}" class="gt">${dl(days[0])}</text><text x="${W-R}" y="${H-6}" class="gt" text-anchor="end">${dl(days[n-1])}</text></svg>
    <div class="chart-leg">${ranked.map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))}</span>`).join("")}</div></div>`;
}
function nightCalendar(){
  const start=leagueStart()||"20261020";
  if(S.today<start) return "";
  const first=weekKey(start);
  const weeks=[]; for(let wk=first; wk<=S.today; wk=shiftDay(wk,7)) weeks.push(wk);
  const cell=d=>{
    if(d<start || d>S.today) return `<span class="cc out"></span>`;
    const w=dayWinner(d), tip=dayNice(d,{day:"numeric",month:"short",weekday:"short"});
    if(!w) return `<span class="cc none" title="${tip}: oynanmadı"></span>`;
    if(w.st==="live") return `<button class="cc live" data-day="${d}" title="${tip}: sürüyor"></button>`;
    if(w.st==="t") return `<button class="cc tie" data-day="${d}" title="${tip}: berabere"></button>`;
    return `<button class="cc" data-day="${d}" style="background:${col(w.u)}" title="${tip}: ${esc(pname(w.u))} kazandı"></button>`;
  };
  const rows=["Pzt","","Çar","","Cum","","Paz"].map((lb,r)=>`<span class="cl">${lb}</span>${weeks.map(wk=>cell(shiftDay(wk,r))).join("")}`).join("");
  const months=weeks.map((wk,i)=>{ const m=dayNice(wk,{month:"short"}); return i===0||m!==dayNice(weeks[i-1],{month:"short"})?`<span>${m}</span>`:"<span></span>"; }).join("");
  const counts={}; S.order.forEach(u=>counts[u]=0); let ties=0;
  for(const d of allDays()){ const w=dayWinner(d); if(w?.st==="w") counts[w.u]++; else if(w?.st==="t") ties++; }
  return `<div class="sec-title"><h2>Gece takvimi</h2><span class="aside">her kare bir gece</span></div>
    <div class="box"><div class="cal-wrap"><div class="cal" style="--wk:${weeks.length}"><span></span>${months}${rows}</div></div>
    <div class="chart-leg">${S.order.map(u=>`<span class="pn"><i style="background:${col(u)}"></i>${esc(pname(u))} ${counts[u]}</span>`).join("")}<span class="pn"><i style="background:var(--amber)"></i>Berabere ${ties}</span><span class="pn"><i class="none"></i>Oynanmadı</span></div></div>`;
}

/* ====================================================== sezon verisi: kayıtlar, rozetler, ödüller */
// Bir oyuncunun biten maçlardaki bütün tahmin kayıtları (arşiv + henüz arşive girmemiş canlı günler)
function userRecs(u){
  const recs=[];
  for(const [gid,row] of Object.entries(S.arch.scores.games||{})){ const r=row[u], g=S.arch.games[gid]; if(r?.pick && g) recs.push({gid, day:g.day, start:g.start, home:g.home, away:g.away, winner:g.winner, r}); }
  for(const day of [S.today, shiftDay(S.today,-1)]){
    const D=S.days[day]; if(!D || !inLeague(day)) continue;
    for(const g of D.games){ if(g.state!=="post" || S.arch.scores.games?.[g.id]?.[u]) continue; const p=D.picks[g.id]?.[u]; if(!p) continue;
      const c=D.daily[u]?.confGame===g.id, r=scorePick(g,p,c);
      recs.push({gid:g.id, day, start:g.start.toISOString(), home:g.home, away:g.away, winner:(g.home.score>g.away.score?g.home.abbr:g.away.abbr), r:{...r,c,pick:{w:p.winner,m:p.margin,s:p.scorerName}}}); }
  }
  return recs.sort((a,b)=>String(a.start).localeCompare(String(b.start)));
}
const pickW = (u, gid) => S.arch.scores.games?.[gid]?.[u]?.pick?.w ?? Object.values(S.days).find(D=>D.picks?.[gid])?.picks[gid]?.[u]?.winner ?? null;
function nightsOf(){ return [...allDays()].reverse().map(d=>({d, w:dayWinner(d), p:dayPoints(d)})).filter(x=>x.w && x.w.st!=="live"); }
const monthKey = d => d.slice(0,6);
const monthName = k => parseYmd(k+"01").toLocaleDateString("tr-TR",{timeZone:"UTC",month:"long",year:"numeric"});
function monthTable(){
  const m={};
  for(const d of allDays()){ const p=dayPoints(d), k=monthKey(d); m[k] ||= {pts:{}, live:false}; for(const u of S.order) m[k].pts[u]=(m[k].pts[u]||0)+(p[u]?.pts||0); if(S.order.some(u=>p[u] && !p[u].final)) m[k].live=true; }
  return m;
}
const BADGES = [
  {id:"kahin", ico:"🔮", name:"Kâhin", desc:"Bir gecede bütün maçların kazananını bil (en az 3 maç)"},
  {id:"kusursuz", ico:"💯", name:"Kusursuz maç", desc:"Bir maçta kazanan, fark ve en skorerin üçünü de bil"},
  {id:"banko", ico:"⭐", name:"Banko kralı", desc:"Üst üste 5 bankoyu tuttur"},
  {id:"skorer", ico:"🎯", name:"Skorer avcısı", desc:"10 kez maçın en skorerini bil"},
  {id:"fark", ico:"📏", name:"Fark ustası", desc:"Bir gecede 3 maçın farkını bil"},
  {id:"gece", ico:"🌙", name:"Gece kralı", desc:"Üst üste 3 gece kazan"},
  {id:"hafta", ico:"🏆", name:"Haftanın şampiyonu", desc:"Bir haftayı kazan"},
  {id:"ay", ico:"📅", name:"Ayın şampiyonu", desc:"Bir ayı kazan"},
  {id:"oyuncu", ico:"🌟", name:"Keskin göz", desc:"Günün oyuncusunu 3 kez bil"},
  {id:"bilge", ico:"🦉", name:"Bilge", desc:"Gecenin sorusunu 5 kez bil"},
];
function badgesOf(u){
  const recs=userRecs(u), got={};
  const byDay={}; for(const x of recs) (byDay[x.day] ||= []).push(x);
  got.kahin = Object.values(byDay).filter(a=>a.length>=3 && a.every(x=>x.r.w>0)).length;
  got.kusursuz = recs.filter(x=>x.r.w>0 && x.r.m>0 && x.r.s>0).length;
  got.fark = Object.values(byDay).filter(a=>a.filter(x=>x.r.m>0).length>=3).length;
  const sk=recs.filter(x=>x.r.s>0).length; got.skorer = Math.floor(sk/10); 
  let run=0; got.banko=0; for(const x of recs.filter(x=>x.r.c)){ if(x.r.w>0){ run++; if(run===5){ got.banko++; run=0; } } else run=0; }
  let nr=0; got.gece=0; for(const n of nightsOf()){ if(n.w.st==="w" && n.w.u===u){ nr++; if(nr===3){ got.gece++; nr=0; } } else nr=0; }
  const curWk=weekKey(S.today); got.hafta=0;
  for(const [wk,row] of Object.entries(S.arch.scores.weeks||{})){ if(wk===curWk) continue; const v=Object.entries(row).filter(([x])=>S.order.includes(x)); const m=Math.max(...v.map(x=>x[1])); const w=v.filter(x=>x[1]===m); if(w.length===1 && w[0][0]===u && m>0) got.hafta++; }
  const mt=monthTable(), curM=monthKey(S.today); got.ay=0;
  for(const [k,v] of Object.entries(mt)){ if(k===curM || v.live) continue; const m=Math.max(...S.order.map(x=>v.pts[x]||0)); const w=S.order.filter(x=>(v.pts[x]||0)===m); if(w.length===1 && w[0]===u && m>0) got.ay++; }
  const days=Object.values(S.arch.scores.days||{}).map(r=>r[u]).filter(Boolean);
  got.oyuncu = Math.floor(days.filter(x=>x.dp>0).length/3);
  got.bilge = Math.floor(days.filter(x=>x.qp>0).length/5);
  const prog = {skorer:`${sk%10}/10`, banko:`${run}/5`, gece:`${nr}/3`, oyuncu:`${days.filter(x=>x.dp>0).length%3}/3`, bilge:`${days.filter(x=>x.qp>0).length%5}/5`};
  return BADGES.map(b=>({...b, n:got[b.id]||0, prog:prog[b.id]||""}));
}
const badgeHTML = (list, compact=false) => `<div class="badges ${compact?"compact":""}">${list.map(b=>`<div class="bdg ${b.n?"on":""}" title="${esc(b.desc)}"><span class="bi">${b.ico}</span><span class="bt"><b>${esc(b.name)}${b.n>1?` <small>×${b.n}</small>`:""}</b>${compact?"":`<small>${b.n?esc(b.desc):esc(b.desc)+(b.prog?` · ${b.prog}`:"")}</small>`}</span></div>`).join("")}</div>`;
// Kafa kafaya: ayrışılan biten maçlarda kim haklı çıktı
function rivalry(u, v){
  const recs=userRecs(u); let n=0, me=0, them=0; const teams={};
  for(const x of recs){ const w2=pickW(v, x.gid); if(!w2 || w2===x.r.pick.w) continue; n++; if(x.r.pick.w===x.winner) me++; else if(w2===x.winner) them++;
    for(const t of [x.home.abbr, x.away.abbr]) teams[t]=(teams[t]||0)+1; }
  const top=Object.entries(teams).sort((a,b)=>b[1]-a[1])[0];
  return {n, me, them, team: top?.[0], tn: top?.[1]||0};
}
// Sezon ödülleri
function seasonAwards(){
  const P=S.order, recs=Object.fromEntries(P.map(u=>[u,userRecs(u)])), tot=seasonTotals();
  const nights=nightsOf(), days=S.arch.scores.days||{};
  const by = (f, minNeed=0) => { const v=P.map(u=>[u,f(u)]).filter(x=>x[1]!=null); if(!v.length) return null; const m=Math.max(...v.map(x=>x[1])); if(m<=minNeed) return null; return {us:v.filter(x=>x[1]===m).map(x=>x[0]), v:m}; };
  const pct = u => recs[u].length>=20 ? Math.round(recs[u].filter(x=>x.r.w>0).length/recs[u].length*100) : null;
  const streak = u => { let b=0,c=0; for(const n of nights){ if(n.w.st==="w"&&n.w.u===u){c++;b=Math.max(b,c);} else c=0; } return b; };
  return [
    {ico:"🏀", t:"Sezonun MVP'si", d:"En çok puan", r:by(u=>tot[u]), f:v=>`${v} puan`},
    {ico:"🔮", t:"Kâhin", d:"Kazanan isabeti en yüksek (en az 20 maç)", r:by(pct), f:v=>`%${v}`},
    {ico:"🌙", t:"Gecelerin hâkimi", d:"En çok gece kazanan", r:by(u=>nights.filter(n=>n.w.st==="w"&&n.w.u===u).length), f:v=>`${v} gece`},
    {ico:"🔥", t:"En uzun seri", d:"Üst üste kazanılan gece", r:by(streak), f:v=>`${v} gece`},
    {ico:"🎯", t:"Skorer avcısı", d:"En çok en skorer bilen", r:by(u=>recs[u].filter(x=>x.r.s>0).length), f:v=>`${v} kez`},
    {ico:"📏", t:"Fark ustası", d:"En çok fark bilen", r:by(u=>recs[u].filter(x=>x.r.m>0).length), f:v=>`${v} kez`},
    {ico:"⭐", t:"Banko kralı", d:"Bankodan en çok net puan", r:by(u=>recs[u].filter(x=>x.r.c).reduce((s,x)=>s+(x.r.w>0?2:-1),0)), f:v=>`${v>0?"+":""}${v} puan`},
    {ico:"🌟", t:"Keskin göz", d:"Günün oyuncusunu en çok bilen", r:by(u=>Object.values(days).filter(r=>r[u]?.dp>0).length), f:v=>`${v} kez`},
    {ico:"🦉", t:"Bilge", d:"Gecenin sorusunu en çok bilen", r:by(u=>Object.values(days).filter(r=>r[u]?.qp>0).length), f:v=>`${v} kez`},
  ];
}
function openAwards(){
  const list=seasonAwards();
  openSheet(`<h3 id="shTitle">Sezon ödülleri</h3><p class="muted">Sezon sürüyor; ödüller şu ana kadarki sonuçlara göre. Sezon bitince kesinleşir.</p>
    <div class="awards">${list.map(a=>`<div class="aw"><span class="aw-i">${a.ico}</span><span class="aw-t"><b>${a.t}</b><small>${a.d}</small></span>
      <span class="aw-w">${a.r?a.r.us.map(u=>`${avatar(u,"sm")}<b style="color:${col(u)}">${esc(pname(u))}</b>`).join(" ")+`<small>${a.f(a.r.v)}</small>`:'<small class="muted">henüz sahibi yok</small>'}</span></div>`).join("")}</div>`);
}

/* ====================================================== PUAN */
// Yalnızca en az bir oyuncunun tahmin girdiği geceler
function allDays(){
  const days = new Set(Object.keys(S.arch.scores.days||{}));
  for(const d of [S.today, shiftDay(S.today,-1)]) if(S.days[d]?.games.some(started)) days.add(d);
  return [...days].filter(d => inLeague(d) && (() => { const p=dayPoints(d); return S.order.some(u=>p[u]?.n); })()).sort().reverse();
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
  // podyum: ilk üç (puan varsa)
  const rk=[...S.order].sort((a,b)=>tot[b]-tot[a]);
  const pod = rk.length>=2 && tot[rk[0]]>0 ? `<div class="podium">${[1,0,2].filter(i=>rk[i]).map(i=>{ const u=rk[i];
    return `<div class="pd pd${i+1}" data-pu="${u}" style="--pc:${col(u)}">${avatar(u, i===0?"lg":"")}<b style="color:${col(u)}">${esc(pname(u))}</b><span class="pd-pts tnum">${tot[u]}</span><div class="pd-step"><span>${i+1}</span></div></div>`; }).join("")}</div>` : "";
  let html = pod + `<div class="sec-title"><h2>Puan tablosu</h2><span class="aside">${S.league?.start ? dayNice(leagueStart(),{day:"numeric",month:"long"})+" gecesinden beri" : "sezon"}</span></div>
    <div class="tbl"><div class="tr th t-lb"><span>#</span><span>Oyuncu</span><span class="r">Puan</span><span class="c">Gece</span><span class="c">Hafta</span></div>
    ${ranked.map((u,i)=>`<div class="tr t-lb"><span class="muted">${i+1}</span><span class="pn"><i style="background:${col(u)}"></i><span>${esc(pname(u))}</span></span><span class="r big tnum">${tot[u]}</span><span class="c tnum">${wins[u]}</span><span class="c tnum">${wks[u]}</span></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:6px 2px">Gece: tek başına en çok puan aldığın geceler. Hafta: kazandığın haftalar (pazartesi–pazar).</p>`;
  const brk = seasonBreakdown();
  html += `<div class="sec-title"><h2>Puanlar nereden geldi</h2></div>
    <div class="tbl"><div class="tr th t-br"><span>Oyuncu</span><span class="c">Kazanan</span><span class="c">Fark</span><span class="c">Skorer</span><span class="c">Diğer</span></div>
    ${ranked.map(u=>`<div class="tr t-br"><span class="pn"><i style="background:${col(u)}"></i><span>${esc(pname(u))}</span></span><span class="c tnum">${brk[u].w}</span><span class="c tnum">${brk[u].m}</span><span class="c tnum">${brk[u].s}</span><span class="c tnum">${brk[u].dp+brk[u].q+brk[u].sr}</span></div>`).join("")}</div>
    <p class="muted" style="font-size:13px;margin:6px 2px">Kazanan sütununa banko dahil. Diğer: günün oyuncusu, gecenin sorusu ve playoff serileri.</p>`;
  // aylık şampiyonlar duvarı
  const mt=monthTable(), curM=monthKey(S.today), mks=Object.keys(mt).sort().reverse();
  if(mks.length){
    html += `<div class="sec-title"><h2>Ayın şampiyonları</h2></div><div class="months">${mks.map(k=>{
      const v=mt[k], m=Math.max(...S.order.map(u=>v.pts[u]||0)), w=S.order.filter(u=>(v.pts[u]||0)===m), on=k===curM||v.live;
      const who = m<=0 ? '<small class="muted">henüz puan yok</small>' : w.length===1 ? `${avatar(w[0],"sm")}<b style="color:${col(w[0])}">${esc(pname(w[0]))}</b><small>${m} puan</small>` : `<b>Berabere</b><small>${m} puan</small>`;
      return `<div class="mo ${on?"live":"done"}"><span class="mo-n">${monthName(k)}</span><span class="mo-w">${on?"":"👑 "}${who}</span><span class="mo-s">${on?"sürüyor":"şampiyon"}</span></div>`; }).join("")}</div>`;
  }
  html += `<button class="btn awards-btn" id="awardsBtn" type="button">${ICON.medal}Sezon ödüllerine bak</button>`;
  const hist=[...(S.league?.history||[])].reverse();
  if(hist.length) html += `<div class="sec-title"><h2>Geçmiş ligler</h2></div><div class="months">${hist.map(h=>{ const w=h.rows?.[0];
    return `<div class="mo done"><span class="mo-n" style="text-transform:none">${dayNice(h.start,{day:"numeric",month:"short"})} – ${dayNice(h.end,{day:"numeric",month:"short"})}</span>
      <span class="mo-w">👑 <b>${esc(w?.name||"?")}</b><small>${w?.pts??0} puan</small></span><span class="mo-s">${(h.rows||[]).slice(1).map(r=>`${esc(r.name)} ${r.pts}`).join(" · ")}</span></div>`; }).join("")}</div>`;
  html += seasonChart() + nightCalendar();

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
      ${S.order.map(u=>`<div class="kpi"><b>${streak[u]}</b><small>Şu anki seri: <span style="color:${col(u)};font-weight:700">${esc(pname(u))}</span></small></div>`).join("")}</div>`;
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
    }).join("") : `<div class="note">İlk gece bitince puan tablosu burada dolmaya başlayacak.</div>`) + `</div>`;
  $("#puan").innerHTML = html;
}
$("#puan").addEventListener("click", e => { if(e.target.closest("#awardsBtn")) return openAwards(); const b=e.target.closest("[data-day]"); if(!b) return; S.day=b.dataset.day; location.hash="#tahmin"; showDay(); });

/* ====================================================== İSTATİSTİK */
function renderStats(){
  const u = S.statFor && S.order.includes(S.statFor) ? S.statFor : S.uid || S.order[0];
  if(!u){ $("#istatistik").innerHTML=`<div class="note">Henüz kimse katılmadı. Davet linkini paylaş, rakiplerin gelsin.</div>`; return; }
  const recs=userRecs(u), n=recs.length;
  const wOk=recs.filter(x=>x.r.w>0).length, mOk=recs.filter(x=>x.r.m>0).length, sOk=recs.filter(x=>x.r.s>0).length;
  const conf=recs.filter(x=>x.r.c), cOk=conf.filter(x=>x.r.w>0).length;
  const days=Object.values(S.arch.scores.days||{}).map(d=>d[u]).filter(Boolean);
  const dps=days.filter(x=>x.dpName), dpHit=dps.filter(x=>x.dp>0).length;
  const qs=days.filter(x=>x.q), qHit=qs.filter(x=>x.qp>0).length;
  const srPts=days.reduce((s,x)=>s+(x.sr||0),0);
  const pct=(a,b)=>b?Math.round(a/b*100):0;
  const kpi=(v,l,c)=>`<div class="kpi"><b>${v}</b><small>${l}</small>${c!=null?`<div class="bar2"><i style="width:${c}%;background:${col(u)}"></i></div>`:""}</div>`;
  let html = `<div class="chips" id="statSel" style="margin-top:4px">${S.order.map(x=>`<button class="chip" data-v="${x}" aria-pressed="${x===u}">${esc(pname(x))}</button>`).join("")}</div>`;
  if(!n){ $("#istatistik").innerHTML = html+`<div class="note">Tahmin yaptığın ilk maçlar bitince istatistiklerin burada birikmeye başlayacak.</div>`; bindStatSel(); return; }
  const net=cOk*2-(conf.length-cOk);
  html += `<div class="sec-title"><h2>İsabet</h2><span class="aside">${n} maç</span></div><div class="cards2">
    ${kpi("%"+pct(wOk,n),`Kazananı bildin (${wOk}/${n})`,pct(wOk,n))}
    ${kpi("%"+pct(mOk,wOk),`Kazananı bildiğin maçlarda farkı da bildin (${mOk}/${wOk})`,pct(mOk,wOk))}
    ${kpi("%"+pct(sOk,n),`En skoreri bildin (${sOk}/${n})`,pct(sOk,n))}
    ${kpi(`${cOk}/${conf.length}`,`Tutan banko (net ${net>0?"+":""}${net} puan)`,null)}
    ${kpi(`${dpHit}/${dps.length}`,"Günün oyuncusu",null)}
    ${kpi(`${qHit}/${qs.length}`,"Gecenin sorusu",null)}
    ${(()=>{ const ds=allDays().filter(d=>dayPoints(d)[u]?.n); const t=ds.reduce((s,d)=>s+(dayPoints(d)[u]?.pts||0),0); return kpi(ds.length?(t/ds.length).toFixed(1):"–",`Gece başına ortalama puan (${ds.length} gece)`,null); })()}</div>`;
  const totals=[["Kazanan (banko dahil)",recs.reduce((s,x)=>s+x.r.w,0)],["Fark",mOk],["En skorer",sOk],["Günün oyuncusu",dpHit*2],["Gecenin sorusu",qHit],["Playoff serileri",srPts]].filter(([l,v])=>v || !/Playoff/.test(l));
  const tmax=Math.max(1,...totals.map(x=>x[1]));
  html += `<div class="sec-title"><h2>Puanların nereden geliyor</h2></div><div class="box">${totals.map(([l,v])=>`<div style="margin:6px 0"><div style="display:flex;justify-content:space-between;font-size:14px"><span>${l}</span><b>${v}</b></div><div class="bar2"><i style="width:${Math.max(0,v)/tmax*100}%;background:${col(u)}"></i></div></div>`).join("")}</div>`;
  // rozetler
  html += `<div class="sec-title"><h2>Rozetler</h2><span class="aside">${badgesOf(u).filter(b=>b.n).length}/${BADGES.length}</span></div>${badgeHTML(badgesOf(u))}`;
  // takım karnesi: hangi takımın maçlarında ne kadar bildin oranı
  const tm={};
  for(const x of recs) for(const t of [x.home.abbr,x.away.abbr]){ tm[t] ||= {n:0,ok:0}; tm[t].n++; if(x.r.w>0) tm[t].ok++; }
  const tl=Object.entries(tm).map(([k,v])=>({k,...v,p:v.ok/v.n})).sort((a,b)=>b.p-a.p||b.n-a.n);
  if(tl.length){
    const heat=p=>`color-mix(in srgb, ${p>=.5?"var(--win)":"var(--lose)"} ${Math.round(Math.abs(p-.5)*2*60+12)}%, var(--panel))`;
    html += `<div class="sec-title"><h2>Takım karnesi</h2><span class="aside">hangi takımın maçlarında ne kadar bildin</span></div>
      <div class="tgrid">${tl.map(x=>`<div class="tcell" data-tp="${x.k}" style="background:${heat(x.p)}" title="${x.ok}/${x.n} maç"><img src="${LOGO_SMALL(x.k)}" alt=""><b>%${Math.round(x.p*100)}</b><small>${x.ok}/${x.n}</small></div>`).join("")}</div>`;
  }
  // rakip analizi
  const others=S.order.filter(v=>v!==u);
  if(others.length){
    html += `<div class="sec-title"><h2>Rakip analizi</h2><span class="aside">farklı tahmin ettiğiniz maçlar</span></div><div class="rivals">${others.map(v=>{
      const r=rivalry(u,v); if(!r.n) return `<div class="box rv"><b style="color:${col(v)}">${esc(pname(v))}</b><small class="muted">Henüz farklı taraf tuttuğunuz, biten bir maç yok.</small></div>`;
      const pu=Math.round(r.me/r.n*100);
      return `<div class="box rv"><div class="rv-h">${avatar(v,"sm")}<b style="color:${col(v)}">${esc(pname(v))}</b><span class="muted">${r.n} maçta farklı tahmin ettiniz</span></div>
        <div class="rv-bar"><i style="width:${pu}%;background:${col(u)}"></i><i style="width:${Math.round(r.them/r.n*100)}%;background:${col(v)}"></i></div>
        <div class="rv-t"><span><b>${r.me}</b> maçta ${esc(pname(u))} haklı çıktı</span><span><b>${r.them}</b> maçta ${esc(pname(v))}</span></div>
        ${r.team?`<small class="muted">En çok ${esc(ALLP?.teams.find(t=>t.a===r.team)?.n || r.team)} maçlarında ayrı düştünüz (${r.tn} maç).</small>`:""}</div>`; }).join("")}</div>`;
  }
  $("#istatistik").innerHTML = html; bindStatSel();
  if(!ALLP) allPlayers().then(()=>{ if(S.tab==="istatistik") renderStats(); }).catch(()=>{});
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
    x.fillStyle=(()=>{ const c=col(u); return c.startsWith("var(") ? getComputedStyle(document.documentElement).getPropertyValue(c.slice(4,-1)).trim()||cols[0] : c; })(); x.font="700 56px 'Barlow Condensed'"; x.fillText(pname(u), 110, y+92);
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


/* ====================================================== küçük animasyonlar */
const RM = matchMedia("(prefers-reduced-motion: reduce)");
S.shown = {};
function countUp(){
  for(const el of $$("#board .digits[data-u]")){
    const u=el.dataset.u, to=+el.dataset.v, from=S.shown[u];
    S.shown[u]=to;
    if(from==null || from===to || RM.matches) continue;
    const sp=el.querySelector("span"), t0=performance.now(), dur=Math.min(1200, 250+Math.abs(to-from)*120);
    el.classList.remove("bump"); void el.offsetWidth; el.classList.add("bump");
    const tick=now=>{ const k=Math.min(1,(now-t0)/dur), e=1-(1-k)**3; sp.textContent=Math.round(from+(to-from)*e); if(k<1) requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }
}
// Geceyi tek başına kazanınca bir kez konfeti
function maybeConfetti(){
  if(!S.uid || RM.matches) return;
  for(const d of [S.today, shiftDay(S.today,-1)]){
    if(!S.days[d]) continue;
    const w=dayWinner(d); if(w?.st!=="w" || w.u!==S.uid) continue;
    const key="confetti_"+d; try{ if(localStorage.getItem(key)) continue; localStorage.setItem(key,"1"); }catch(e){ continue; }
    confetti(); toast(pick([`🏆 ${dayNice(d,{day:"numeric",month:"long"})} gecesini kazandın!`,`🏆 Gece senin! ${dayNice(d,{day:"numeric",month:"long"})} gecesinin kazananı sensin.`,`🏆 Tebrikler, ${dayNice(d,{day:"numeric",month:"long"})} gecesini aldın!`]), 4000);
    return;
  }
}
function confetti(){
  const c=document.createElement("canvas"); c.className="confetti"; document.body.appendChild(c);
  const x=c.getContext("2d"), dpr=devicePixelRatio||1; c.width=innerWidth*dpr; c.height=innerHeight*dpr; x.scale(dpr,dpr);
  const cols=[col(S.uid),"#f2a83a","#4fd093","#ffffff","#7ea2f6","#f2737f"].map(v=>v.startsWith("var")?getComputedStyle(document.documentElement).getPropertyValue(v.slice(4,-1)).trim():v);
  const P=Array.from({length:140},()=>({x:innerWidth/2+(Math.random()-.5)*80,y:innerHeight*.35,vx:(Math.random()-.5)*14,vy:-Math.random()*13-4,
    w:6+Math.random()*6,h:8+Math.random()*8,r:Math.random()*6,vr:(Math.random()-.5)*.4,c:cols[Math.floor(Math.random()*cols.length)]}));
  const t0=performance.now();
  const step=now=>{
    const t=now-t0; x.clearRect(0,0,innerWidth,innerHeight);
    for(const p of P){ p.vy+=.35; p.vx*=.99; p.x+=p.vx; p.y+=p.vy; p.r+=p.vr;
      x.save(); x.translate(p.x,p.y); x.rotate(p.r); x.globalAlpha=Math.max(0,1-t/2600); x.fillStyle=p.c; x.fillRect(-p.w/2,-p.h/2,p.w,p.h*Math.abs(Math.cos(p.r))); x.restore(); }
    if(t<2600) requestAnimationFrame(step); else c.remove();
  };
  requestAnimationFrame(step);
}
// Yükleme iskeleti ve maçsız gün
const skeletonCards = (n=3) => Array.from({length:n},()=>`<div class="game skel" aria-hidden="true"><div class="sk sk-h"></div><div class="sk-teams"><div class="sk sk-t"></div><div class="sk sk-t"></div></div><div class="sk sk-l"></div><div class="sk sk-m"></div></div>`).join("") + `<span class="sr">Maçlar yükleniyor</span>`;
const EMPTY_NIGHT = `<div class="empty"><svg viewBox="0 0 160 120" aria-hidden="true">
  <rect x="38" y="8" width="84" height="54" rx="4" class="e-board"/><rect x="64" y="30" width="32" height="22" class="e-sq"/>
  <path d="M58 62h44l-6 34H64z" class="e-net"/><path d="M62 72h36M64 82h32M66 92h28M70 62l4 34M80 62v34M90 62l-4 34" class="e-net"/>
  <rect x="54" y="60" width="52" height="5" rx="2.5" class="e-rim"/>
  <circle cx="128" cy="100" r="14" class="e-ball"/><path d="M114 100h28M128 86v28M118 90c6 6 6 14 0 20M138 90c-6 6-6 14 0 20" class="e-ln"/></svg>
  <b>Bu gece maç yok</b><span>Oklarla diğer günlere bakabilirsin.</span></div>`;

/* ====================================================== Türkçe ekler, gecenin manşeti, kayan şerit */
const VOW="aeıioöuü";
const lastV = s => [...String(s).toLocaleLowerCase("tr")].reverse().find(c=>VOW.includes(c)) || "e";
const endsV = s => VOW.includes(String(s).slice(-1).toLocaleLowerCase("tr"));
// İlgi eki: Kemal'in, Mustafa'nın, Andaç'ın, Selin'in
const FRONT_NAMES = new Set(["kemal","celal","cemal","bilal","hilal","nihal","hayal","iclal","meral"]); // ince l: Kemal'in
const gen = n => n+"'"+(endsV(n)?"n":"")+({a:"ın",ı:"ın",e:"in",i:"in",o:"un",u:"un",ö:"ün",ü:"ün"}[FRONT_NAMES.has(String(n).toLocaleLowerCase("tr").split(/\s+/).pop()) ? "e" : lastV(n)]);
const pick = a => a[Math.floor(Math.random()*a.length)];
// Gecenin manşeti: bitmiş bir gece için tek cümle
function headlineOf(d){
  const w=dayWinner(d); if(!w || w.st==="live") return "";
  const p=dayPoints(d), played=S.order.filter(u=>p[u]?.n);
  if(w.st==="t"){ const ws=played.filter(u=>p[u].pts===w.pts).map(pname);
    return ws.length===played.length ? `Gece berabere bitti: herkes ${w.pts} puanda kaldı.` : `${ws.slice(0,-1).join(", ")} ve ${ws.at(-1)} geceyi ${w.pts} puanla paylaştı.`; }
  const n=pname(w.u), recs=userRecs(w.u).filter(x=>x.day===d), ok=recs.filter(x=>x.r.w>0).length;
  const second=Math.max(...played.filter(u=>u!==w.u).map(u=>p[u].pts), -99), diff=second>-99 ? w.pts-second : 0;
  const extra = p[w.u].dp>0 ? " Günün oyuncusunu da bildi." : recs.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0).length ? ` ${recs.filter(x=>x.r.w>0&&x.r.m>0&&x.r.s>0).length} maçta kazanan, fark ve en skorerin üçünü birden bildi.` : "";
  if(recs.length && ok===recs.length && recs.length>=3) return `${gen(n)} gecesi: ${recs.length} maçın hepsinde kazananı bildi, ${w.pts} puan topladı.${extra}`;
  if(diff>=5) return `${n} geceye damgasını vurdu: ${w.pts} puan, en yakın rakibinden ${diff} puan fazla.${extra}`;
  if(diff===1) return `${n} geceyi kıl payı aldı: ${w.pts} puan, sadece 1 puan farkla.${extra}`;
  return `${gen(n)} gecesi: ${recs.length?`${recs.length} maçın ${ok} tanesinde kazananı bildi, `:""}${w.pts} puan topladı.${extra}`;
}
// Kayan şerit: son 24 saatte katılanlara hoş geldin + ligden haberler
function tickerItems(){
  const out=[], now=Date.now();
  // son 24 saatte katılanlar tek satırda; giriş yapan kişi kendine "hoş geldin" görmez
  const fresh=S.order.filter(u=>{ const j=S.players[u]?.joined||0; return now-j<864e5 && now-j>=0; });
  const others=fresh.filter(u=>u!==S.uid).map(pname);
  if(others.length===1) out.push({cls:"hi", t:`👋 Ligimize hoş geldin, ${others[0]}! Bol puanlı geceler.`});
  else if(others.length>1) out.push({cls:"hi", t:`👋 Ligimize hoş geldiniz: ${others.slice(0,-1).join(", ")} ve ${others.at(-1)}! Bol puanlı geceler.`});
  if(fresh.includes(S.uid)) out.push({cls:"hi", t:`👋 Hoş geldin, ${pname(S.uid)}! Her akşam maçlara tahmin yap, puanları topla.`});
  const tot=seasonTotals(), ranked=[...S.order].sort((a,b)=>tot[b]-tot[a]);
  const nights=allDays().filter(d=>{ const w=dayWinner(d); return w && w.st!=="live"; });
  if(nights[0]){ const h=headlineOf(nights[0]); if(h) out.push({t:`🌙 ${nights[0]===shiftDay(S.today,-1)?"Dün gece":dayNice(nights[0],{day:"numeric",month:"long"})+" gecesi"} — ${h}`}); }
  if(ranked.length>1 && tot[ranked[0]]>0){ const d=tot[ranked[0]]-tot[ranked[1]];
    out.push({t: d ? `🏀 Zirvede ${pname(ranked[0])} var: ${tot[ranked[0]]} puan. ${pname(ranked[1])} ${d} puan geride.` : `🏀 Zirvede ortalık karışık: ${pname(ranked[0])} ve ${pname(ranked[1])} ${tot[ranked[0]]} puanla eşit.`}); }
  let run=0, ru=null; for(const d of nights){ const w=dayWinner(d); if(w.st!=="w") break; if(ru===null) ru=w.u; if(w.u!==ru) break; run++; }
  if(run>=2) out.push({t:`🔥 ${pname(ru)} üst üste ${run} gecedir kazanıyor. Durduran çıkacak mı?`});
  const wk=weekKey(S.today), wp={}; for(const d of allDays()) if(weekKey(d)===wk){ const p=dayPoints(d); for(const u of S.order) wp[u]=(wp[u]||0)+(p[u]?.pts||0); }
  const wr=[...S.order].sort((a,b)=>(wp[b]||0)-(wp[a]||0)); if(wr.length>1 && (wp[wr[0]]||0)>(wp[wr[1]]||0)) out.push({t:`📆 Bu haftanın lideri ${pname(wr[0])}: ${wp[wr[0]]} puan.`});
  const D=S.days[S.today];
  if(D?.games.length){ const open=!D.games.some(started);
    out.push({t: open ? `📅 Bu gece ${D.games.length} maç var. Tahminler ${timeTR(D.games[0].lock)} itibarıyla kapanıyor.` : (D.games.every(g=>g.state==="post") ? `🏁 Bu gecenin ${D.games.length} maçı bitti. Sonuçlar sekmesine bir göz at.` : `📺 Bu gecenin maçları başladı. Tahminler kapandı, herkesin seçimi artık görünüyor.`)});
    if(open){ const q=questionOf(S.today); out.push({t:`❓ Gecenin sorusu: ${q.t}`});
      const miss=S.order.filter(u=>!(D.progress?.[u]?.size)); if(miss.length && miss.length<S.order.length) out.push({t:`⏳ Henüz tahmin yapmayanlar: ${miss.map(pname).join(", ")}.`}); }
  }
  if(!out.length) out.push({t:"🏀 NBA Tahmin'e hoş geldin! Her gece maçlara tahmin yap, puanları topla."});
  return out;
}
function renderTicker(){
  const el=$("#ticker"); if(!el) return;
  const items=tickerItems(), key=items.map(x=>x.t).join("|");
  if(el.dataset.k===key) return; el.dataset.k=key;
  const row=items.map(x=>`<span class="tk-i ${x.cls||""}">${esc(x.t)}</span>`).join('<span class="tk-sep">•</span>');
  const len=items.reduce((s,x)=>s+x.t.length,0);
  el.innerHTML=`<div class="tk-track" style="--dur:${Math.max(25, Math.round(len/6))}s"><div class="tk-row">${row}<span class="tk-sep">•</span></div><div class="tk-row" aria-hidden="true">${row}<span class="tk-sep">•</span></div></div>`;
  el.classList.toggle("has-hi", items.some(x=>x.cls==="hi"));
}

/* ====================================================== duyuru ve mail uyarısı */
const lsGet = k => { try{ return localStorage.getItem(k); }catch(e){ return null; } };
const lsSet = (k,v) => { try{ localStorage.setItem(k,v); }catch(e){} };
function renderBanners(){
  const box=$("#banners"); if(!box) return;
  let html="";
  const n=S.notice;
  if(n?.text && lsGet("noticeSeen")!==String(n.at)) html += `<div class="banner notice"><span class="bn-i">${ICON.megaphone}</span><span class="bn-t">${esc(n.text)}</span><button class="bn-x" data-bn="notice" aria-label="Kapat">✕</button></div>`;
  const later=+(lsGet("mailNudge")||0);
  if(S.contactLoaded && !S.contact?.verified && Date.now()>later) html += `<div class="banner nudge"><span class="bn-i">${ICON.mail}</span><span class="bn-t"><b>Mail adresini ekle</b> Tahminin eksik kalınca ya da seçtiğin oyuncu sakatlanınca haber verelim.</span>
    <span class="bn-acts"><button class="btn sm" data-bn="mail">Ekle</button><button class="linkish" data-bn="later">Sonra</button></span></div>`;
  // Profilini özelleştirmemiş olana (favori takım ya da avatar seçmemiş) hatırlatma
  const me=S.players[S.uid];
  const missP = me ? [!me.favTeam && "favori takımını", !me.emoji && !me.av && "avatarını"].filter(Boolean) : [];
  if(missP.length && Date.now()>+(lsGet("profileNudge")||0)) html += `<div class="banner nudge"><span class="bn-i">${ICON.palette}</span><span class="bn-t"><b>Profilini özelleştir</b> ${missP.length===2?"Favori takımını, avatarını ve rengini seç":missP[0][0].toLocaleUpperCase("tr")+missP[0].slice(1)+" da seç"}, puan tablosunda öyle görün.</span>
    <span class="bn-acts"><button class="btn sm" data-bn="profile">Seç</button><button class="linkish" data-bn="plater">Sonra</button></span></div>`;
  box.innerHTML=html;
}
$("#banners").addEventListener("click", e=>{
  const b=e.target.closest("[data-bn]"); if(!b) return;
  if(b.dataset.bn==="notice"){ lsSet("noticeSeen", String(S.notice?.at)); }
  if(b.dataset.bn==="later"){ lsSet("mailNudge", String(Date.now()+3*864e5)); }
  if(b.dataset.bn==="plater"){ lsSet("profileNudge", String(Date.now()+3*864e5)); }
  if(b.dataset.bn==="profile"){ openProfile(); setTimeout(()=>{ $(".pf-avtab")?.closest(".pf-sec")?.scrollIntoView({block:"start"}); }, 300); }
  if(b.dataset.bn==="mail"){ openProfile(); setTimeout(()=>{ $("#pfMail")?.scrollIntoView({block:"center"}); $("#pfMail")?.focus(); }, 300); }
  renderBanners();
});

/* ====================================================== oyuncu kartı, tahmin geçmişi, takım sayfası */
document.addEventListener("click", e=>{ const p=e.target.closest(".podium [data-pu]"); if(p) openPlayer(p.dataset.pu); });
$("#board").addEventListener("click", e=>{ if(e.target.closest("#lbMore")){ S.boardAll=!S.boardAll; return renderBoard(); } const p=e.target.closest("[data-pu]"); if(p) openPlayer(p.dataset.pu); });
document.addEventListener("click", e=>{ const t=e.target.closest("[data-tp]"); if(t) { e.stopPropagation(); openTeam(t.dataset.tp); } });
function openPlayer(u){
  const p=S.players[u]||{}, recs=userRecs(u), n=recs.length, tot=seasonTotals();
  const rank=[...S.order].sort((a,b)=>(tot[b]||0)-(tot[a]||0)).indexOf(u)+1;
  const pct=(a,b)=>b?"%"+Math.round(a/b*100):"–";
  const nights=nightsOf().reverse(); const won=nights.filter(x=>x.w.st==="w"&&x.w.u===u).length;
  const conf=recs.filter(x=>x.r.c), cOk=conf.filter(x=>x.r.w>0).length;
  const last=nights.slice(0,5).map(x=>{ const pts=x.p[u]?.pts??0, r=x.w.st==="w"?(x.w.u===u?"W":"L"):"T";
    return `<div class="pc-n"><span>${dayNice(x.d,{day:"numeric",month:"short"})}</span><b>${pts}</b><i class="${r}"></i></div>`; }).join("");
  const tm={}; for(const x of recs) for(const t of [x.home.abbr,x.away.abbr]){ tm[t] ||= {n:0,ok:0}; tm[t].n++; if(x.r.w>0) tm[t].ok++; }
  const best=Object.entries(tm).filter(([,v])=>v.n>=2).sort((a,b)=>b[1].ok/b[1].n-a[1].ok/a[1].n||b[1].n-a[1].n).slice(0,3);
  const fav=p.favTeam && ALLP?.teams.find(t=>t.a===p.favTeam);
  const b=badgesOf(u).filter(x=>x.n);
  const m=/^(t|p):(\w+)$/.exec(p.av||"");
  const cover = m?.[1]==="p" ? `<div class="pc-cover photo" style="--pc:${col(u)};--cv:url('https://a.espncdn.com/combiner/i?img=/i/headshots/nba/players/full/${m[2]}.png&w=600&h=438&scale=crop&cquality=75')"></div>`
    : m?.[1]==="t" ? `<div class="pc-cover team" style="--tc:${tcol(m[2])}"><img src="${LOGO_SMALL(m[2])}" alt=""></div>`
    : p.favTeam ? `<div class="pc-cover team soft" style="--tc:${tcol(p.favTeam)}"><img src="${LOGO_SMALL(p.favTeam)}" alt=""></div>`
    : `<div class="pc-cover plain" style="--pc:${col(u)}"><span>${p.emoji||esc(initials(pname(u)))}</span></div>`;
  openSheet(`${cover}<div class="pc-head on-cover">${avatar(u,"lg")}<div><h3 id="shTitle" style="margin:0;color:${col(u)}">${esc(pname(u))}</h3>
      <small class="muted">${rank}. sırada · ${tot[u]||0} puan${p.favTeam?` · <span data-tp="${p.favTeam}" class="linkish" style="font-size:13px">${esc(fav?.n||p.favTeam)}</span> taraftarı`:""}</small></div></div>
    <div class="cards2" style="margin-top:12px">
      <div class="kpi"><b>${won}</b><small>Kazandığı gece</small></div>
      <div class="kpi"><b>${pct(recs.filter(x=>x.r.w>0).length,n)}</b><small>Kazananı bilme (${n} maç)</small></div>
      <div class="kpi"><b>${pct(recs.filter(x=>x.r.s>0).length,n)}</b><small>En skoreri bilme</small></div>
      <div class="kpi"><b>${cOk}/${conf.length}</b><small>Tutan banko</small></div></div>
    ${last?`<div class="sec-title"><h2 style="font-size:20px">Son geceler</h2></div><div class="pc-nights">${last}</div>`:""}
    ${b.length?`<div class="sec-title"><h2 style="font-size:20px">Rozetler</h2></div>${badgeHTML(b,true)}`:""}
    ${best.length?`<div class="sec-title"><h2 style="font-size:20px">En iyi bildiği takımlar</h2></div><div class="pc-teams">${best.map(([k,v])=>`<button class="pc-t" data-tp="${k}"><img src="${LOGO_SMALL(k)}" alt=""><b>%${Math.round(v.ok/v.n*100)}</b><small>${v.ok}/${v.n}</small></button>`).join("")}</div>`:""}
    <button class="btn" id="pcStats" style="margin-top:14px;width:100%">Tüm istatistiklerine bak</button>`);
  $("#pcStats").onclick=()=>{ S.statFor=u; closeSheet(); setTimeout(()=>{ if(location.hash==="#istatistik") { renderStats(); scrollTo({top:0}); } else location.hash="#istatistik"; }, 80); };
}
// Tahmin geçmişi (yalnızca kendi tahminlerin) + CSV
function openHistory(){
  const recs=userRecs(S.uid).reverse();
  const ch=(t,ok)=>`<span class="rc ${ok?"ok":"no"}"><i>${ok?"✓":"✗"}</i>${esc(t)}</span>`;
  const rows=recs.map(x=>`<div class="hs"><div class="hs-h"><span>${dayNice(x.day,{day:"numeric",month:"short"})}</span><b>${esc(x.away.abbr)} ${x.away.score??""}–${x.home.score??""} ${esc(x.home.abbr)}</b><span class="hs-p ${x.r.pts>0?"pos":x.r.pts<0?"neg":""}">${x.r.pts>0?"+":""}${x.r.pts}</span></div>
    <div class="pk">${ch(x.r.pick.w||"–",x.r.w>0)}${ch(x.r.pick.m||"–",x.r.m>0)}${ch(x.r.pick.s||"–",x.r.s>0)}${x.r.c?'<span class="rc"><i>★</i>banko</span>':""}</div></div>`).join("");
  openSheet(`<h3 id="shTitle">Tahmin geçmişin</h3><p class="muted">${recs.length} biten maç${leagueStart()>(S.cfg?.seasonStart||"")?" (bu lig)":""}.</p>
    ${recs.length?`<button class="btn" id="csvBtn" type="button">${ICON.download}Excel için indir (CSV)</button><div class="hs-list">${rows}</div>`:'<div class="note">Tahmin yaptığın maçlar bittikçe burada listelenecek.</div>'}`);
  $("#csvBtn")?.addEventListener("click", ()=>{
    const q=v=>`"${String(v??"").replace(/"/g,'""')}"`;
    const head=["Tarih","Deplasman","Ev sahibi","Skor","Kazanan","Tahminin","Fark tahmini","Skorer tahmini","Banko","Kazanan doğru","Fark doğru","Skorer doğru","Puan"];
    const lines=recs.map(x=>[`${x.day.slice(6)}.${x.day.slice(4,6)}.${x.day.slice(0,4)}`, x.away.abbr, x.home.abbr, `${x.away.score??""}-${x.home.score??""}`, x.winner, x.r.pick.w, x.r.pick.m, x.r.pick.s, x.r.c?"evet":"", x.r.w>0?"evet":"hayır", x.r.m>0?"evet":"hayır", x.r.s>0?"evet":"hayır", x.r.pts].map(q).join(";"));
    const blob=new Blob(["﻿"+[head.map(q).join(";"),...lines].join("\r\n")],{type:"text/csv;charset=utf-8"});
    const a=document.createElement("a"); a.href=URL.createObjectURL(blob); a.download=`nba-tahmin-${slug(pname(S.uid))||"tahminler"}.csv`; document.body.append(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(a.href),4000);
  });
}
// Takım sayfası: son maçlar, sıradaki maçlar, sakatlar ve senin bu takımla karnen
S.sched={};
async function openTeam(abbr){
  await allPlayers().catch(()=>{});
  const t=ALLP?.teams.find(x=>x.a===abbr) || {a:abbr,n:abbr};
  const id=t.id || Object.values(S.days).flatMap(D=>D.games).flatMap(g=>[g.home,g.away]).find(x=>x.abbr===abbr)?.id;
  openSheet(`<div class="pc-head"><img src="${LOGO_SMALL(abbr)}" alt="" width="56" height="56"><div><h3 id="shTitle" style="margin:0">${esc(t.n)}</h3><small class="muted" id="tmRec">Yükleniyor…</small></div></div><div id="tmBody"></div>`);
  let sch=null;
  if(id){ const c=S.sched[id]; if(c && Date.now()-c.at<10*60e3) sch=c.data; else { try{ sch=await espn(`/teams/${id}/schedule`); S.sched[id]={at:Date.now(), data:sch}; }catch(e){} } }
  const evs=(sch?.events||[]).filter(e=>e.seasonType?.type!==1 && e.season?.type!==1);
  const side=e=>{ const c=e.competitions[0], me=c.competitors.find(x=>x.team?.abbreviation===abbr), op=c.competitors.find(x=>x!==me); return {c,me,op}; };
  const done=evs.filter(e=>e.competitions[0].status?.type?.completed).slice(-5).reverse();
  const next=evs.filter(e=>!e.competitions[0].status?.type?.completed).slice(0,3);
  const sc=v=>v?.displayValue ?? v ?? "";
  const roster = id ? await loadRoster({id, abbr, logo:LOGO_SMALL(abbr)}).catch(()=>[]) : [];
  const inj=roster.filter(p=>p.inj);
  const my=userRecs(S.uid).filter(x=>x.home.abbr===abbr||x.away.abbr===abbr), ok=my.filter(x=>x.r.w>0).length;
  if(!$("#tmBody")) return;
  const DIV={Atlantic:"Atlantik",Central:"Merkez",Southeast:"Güneydoğu",Northwest:"Kuzeybatı",Pacific:"Pasifik",Southwest:"Güneybatı",Eastern:"Doğu",Western:"Batı"};
  const stand=(sch?.team?.standingSummary||"").replace(/^(\d+)\w*\s+in\s+(\w+)\s+(Division|Conference)$/i,(m,n,d,k)=>`${DIV[d]||d} ${/conf/i.test(k)?"Konferansı":"Grubu"}nda ${n}.`);
  $("#tmRec").textContent=[sch?.team?.recordSummary?`${sch.team.recordSummary} (G-M)`:"", stand].filter(Boolean).join(" · ");
  $("#tmBody").innerHTML=`
    <div class="sec-title"><h2 style="font-size:20px">Son maçlar</h2></div>
    ${done.length?`<div class="tm-list">${done.map(e=>{ const {me,op}=side(e); const w=me?.winner; return `<div class="tm-g"><span class="tm-r ${w?"W":"L"}">${w?"G":"M"}</span><img src="${LOGO_SMALL(op?.team?.abbreviation||"")}" alt=""><span>${me?.homeAway==="home"?"":"@ "}${esc(op?.team?.shortDisplayName||op?.team?.abbreviation||"")}</span><b>${sc(me?.score)}–${sc(op?.score)}</b><small>${new Date(e.date).toLocaleDateString("tr-TR",{timeZone:TZ,day:"numeric",month:"short"})}</small></div>`; }).join("")}</div>`:'<div class="note">Bu sezon henüz maçı yok.</div>'}
    ${next.length?`<div class="sec-title"><h2 style="font-size:20px">Sıradaki maçlar</h2></div><div class="tm-list">${next.map(e=>{ const {me,op}=side(e); return `<div class="tm-g"><span class="tm-r"></span><img src="${LOGO_SMALL(op?.team?.abbreviation||"")}" alt=""><span>${me?.homeAway==="home"?"":"@ "}${esc(op?.team?.shortDisplayName||"")}</span><small>${new Date(e.date).toLocaleString("tr-TR",{timeZone:TZ,day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"})}</small></div>`; }).join("")}</div>`:""}
    <div class="sec-title"><h2 style="font-size:20px">Sakatlar</h2></div>
    ${inj.length?`<div class="tm-list">${inj.map(p=>`<div class="tm-g"><span class="tm-r ${/out/i.test(p.inj)?"L":"T"}"></span><span>${esc(p.name)}</span><small>${/out/i.test(p.inj)?"Oynamıyor":"Belirsiz"}</small></div>`).join("")}</div>`:'<div class="note">Sakat oyuncu yok.</div>'}
    <div class="sec-title"><h2 style="font-size:20px">Senin karnen</h2></div>
    ${my.length?`<div class="box"><b style="font-size:20px">%${Math.round(ok/my.length*100)}</b> <span class="muted">bu takımın ${my.length} maçında kazananı bildin</span>
      <div class="pk" style="margin-top:8px;display:flex;flex-wrap:wrap;gap:4px">${my.slice(-6).reverse().map(x=>`<span class="rc ${x.r.w>0?"ok":"no"}"><i>${x.r.w>0?"✓":"✗"}</i>${esc(x.away.abbr)}–${esc(x.home.abbr)}</span>`).join("")}</div></div>`:'<div class="note">Bu takımın maçlarına tahmin yaptıkça karnen burada oluşacak.</div>'}`;
}

/* ====================================================== Eksik tahmin uyarısı */
function renderAlert(){
  const el=$("#alert"); if(!el) return;
  const D=S.days[S.today];
  el.classList.remove("sticky");
  if(!S.uid || !D || !D.games.length){ el.innerHTML=""; return; }
  const open = D.games.filter(g=>!started(g));
  if(!open.length){ el.innerHTML=""; return; }
  const missing = open.filter(g=>!D.picks[g.id]?.[S.uid]);
  const daily = D.daily[S.uid]||{};
  const noBanko = !daily.confGame;
  const noDp = !daily.dayPlayerId && !D.games.some(started);
  const noQ = !daily.q && !D.games.some(started);
  const inj = injuryAlerts(D);
  if(!missing.length && !noBanko && !noDp && !noQ && !inj.length){ el.innerHTML=""; return; }
  // en yakın kilit: eksik maçlar ya da (günün oyuncusu eksikse) ilk maç
  const locks = missing.map(g=>g.lock.getTime());
  if(noDp || noBanko || noQ || inj.length) locks.push(Math.min(...open.map(g=>g.lock.getTime())));
  const ms = Math.min(...locks) - Date.now();
  if(ms > 12*36e5 && !inj.length){ el.innerHTML=""; return; }   // 12 saatten uzaksa gösterme (sakatlık hariç)
  const h=Math.floor(ms/36e5), m=Math.max(0,Math.floor(ms%36e5/6e4));
  const when = ms<=0 ? "Tahminler kilitleniyor" : `Kilide ${h?h+" sa ":""}${m} dk kaldı`;
  const parts=[];
  if(inj.length) parts.push(`<b>${inj.map(esc).join(", ")} oynamayacak</b>`);
  if(missing.length) parts.push(`<b>${missing.length} maç eksik</b>`);
  if(noBanko) parts.push("banko seçilmedi");
  if(noDp) parts.push("günün oyuncusu seçilmedi");
  if(noQ) parts.push("soru cevaplanmadı");
  const urgent = ms < 60*60e3;
  el.classList.toggle("sticky", urgent);   // son 1 saatte ekranın üstüne yapışır
  el.innerHTML = `<button class="alert ${urgent?"urgent":""}" id="alertBtn"><span class="al-dot"></span><span class="al-tx"><span>${when}</span><span>${parts.join(" · ")}</span></span><span class="al-go">Tamamla ›</span></button>`;
  $("#alertBtn").onclick = () => {
    if(S.day!==S.today){ S.day=S.today; }
    S.sub="maclar"; $$("#subSel button").forEach(x=>x.setAttribute("aria-pressed", x.dataset.v==="maclar"));
    $("#subMaclar").classList.remove("hide"); $("#subTahminler").classList.add("hide");
    if(location.hash!=="#tahmin") location.hash="#tahmin"; else showDay();
    setTimeout(()=>{ const first=$(".game.missing"); first?.scrollIntoView({behavior:"smooth",block:"center"}); }, 900);
  };
}
setInterval(()=>{ if(S.uid) { renderAlert(); if(S.tab==="tahmin" && S.sub==="maclar") $$(".lock-note").forEach(el=>{ const g=S.days[S.day]?.games.find(x=>x.id===el.closest(".game")?.dataset.gid); if(g) el.textContent=lockLeft(g); });
  $$("[data-ring]").forEach(el=>{ const g=S.days[S.day]?.games.find(x=>x.id===el.dataset.ring); if(g) el.outerHTML=ringHTML(g); }); } }, 30e3);

/* ====================================================== gezinme ve yenileme */
// Yeni kazanılan rozeti bir kez kutla (sayılar telefonda saklanır; ilk açılışta sessizce kaydedilir)
function checkNewBadges(){
  if(!S.uid || checkNewBadges.busy) return;
  const cur=Object.fromEntries(badgesOf(S.uid).map(b=>[b.id,b.n]));
  const key="badges:"+S.uid; let old=null; try{ old=JSON.parse(localStorage.getItem(key)||"null"); }catch(e){}
  try{ localStorage.setItem(key, JSON.stringify(cur)); }catch(e){}
  if(!old) return;
  const fresh=BADGES.filter(b=>(cur[b.id]||0)>(old[b.id]||0));
  if(!fresh.length) return;
  const b=fresh[0]; checkNewBadges.busy=true;
  const el=document.createElement("div"); el.className="badge-pop"; el.setAttribute("role","status");
  el.innerHTML=`<div class="bp-card"><div class="bp-ico">${b.ico}</div><b>Yeni rozet!</b><span>${esc(b.name)}</span><small>${esc(b.desc)}</small></div>`;
  document.body.append(el); confetti?.();
  const close=()=>{ el.classList.add("out"); setTimeout(()=>{ el.remove(); checkNewBadges.busy=false; },350); };
  el.onclick=close; setTimeout(close, 4200);
}
function render(){
  if(!S.uid) return;
  renderBoard();
  renderTicker();
  renderBanners();
  renderAlert();
  maybeConfetti();
  if(!render.bt || Date.now()-render.bt>20e3){ render.bt=Date.now(); setTimeout(checkNewBadges, 1500); }
  const nLive = [S.today, shiftDay(S.today,-1)].reduce((n,d)=>n+(S.days[d]?.games.filter(g=>g.state==="in").length||0),0);
  $("#navLive").classList.toggle("hide", !nLive); $("#navLive").textContent = nLive || "";
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
  movePill();
  if(S.tab!=="tahmin"){ $("#pickBar").innerHTML=""; $("#pickBar").classList.remove("show"); }
  render();
}
S.scrollY = {};
window.addEventListener("hashchange", ()=>{ route(); scrollTo({top:S.scrollY[S.tab]||0}); });
addEventListener("scroll", ()=>{ if(S.tab) S.scrollY[S.tab]=scrollY; }, {passive:true});
document.addEventListener("click", e=>{ const a=e.target.closest(".nav a[data-tab]"); if(a && a.dataset.tab===S.tab){ e.preventDefault(); scrollTo({top:0, behavior:"smooth"}); } });
function movePill(){
  const a=$(`.nav a[data-tab="${S.tab}"]`), pill=$("#navPill"); if(!a||!pill) return;
  pill.style.width=a.offsetWidth+"px"; pill.style.transform=`translateX(${a.offsetLeft}px)`;
}
addEventListener("resize", movePill);
async function showDay(){
  S.draft={}; renderDayLabel(); $("#games").innerHTML=skeletonCards(); $("#dayStatus").innerHTML=""; $("#dayPlayer").innerHTML="";
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
  S.archRaw = S.arch.scores;
  await loadLeague();
}
// Lig: yönetim panelinden sıfırlanınca yalnızca başlangıç gecesinden sonraki geceler sayılır
const leagueStart = () => [S.cfg?.seasonStart||"", S.league?.start||""].sort().pop();
const inLeague = d => d >= leagueStart();
async function loadLeague(){
  try{ const r=await getDoc(doc(S.db,"league","settings")); S.league = r.exists() ? r.data() : {}; }catch(e){ S.league = S.league || {}; }
  try{ const n=await getDoc(doc(S.db,"league","notice")); S.notice = n.exists() ? n.data() : null; }catch(e){}
  applyLeague();
}
function applyLeague(){
  const raw=S.archRaw||S.arch.scores, st=leagueStart();
  const days=Object.fromEntries(Object.entries(raw.days||{}).filter(([d])=>d>=st));
  const games=Object.fromEntries(Object.entries(raw.games||{}).filter(([gid])=>(S.arch.games[gid]?.day||"")>=st));
  const series=Object.fromEntries(Object.entries(raw.series||{}).filter(([,x])=>(x.day||"")>=st));
  // haftaları lig gecelerinden yeniden hesapla
  const weeks={};
  for(const [d,row] of Object.entries(days)) for(const [u,v] of Object.entries(row)){ const w=weekKey(d); (weeks[w] ||= {}); weeks[w][u]=(weeks[w][u]||0)+(v.tot ?? (v.pts+(v.sr||0))); }
  S.arch.scores={...raw, days, games, series, weeks};
  honors.k=null;
}
async function refresh(){
  // gün döndüyse (sabah 08.00) "bugün"ü ilerlet; kullanıcı bugündeyse onu da taşı
  const nt=espnToday(); if(nt!==S.today){ if(S.day===S.today) S.day=nt; S.today=nt; renderDayLabel?.(); }
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
new IntersectionObserver(([e])=>{ S.pbShow = !e.isIntersecting && e.boundingClientRect.top<0; $("#pickBar")?.classList.toggle("show", S.pbShow && !!$("#pickBar").innerHTML); },{rootMargin:"-60px 0px 0px 0px"}).observe($("#dayStatus"));
new IntersectionObserver(([e])=>{ const on=!e.isIntersecting && !!$("#mini").innerHTML; $("#mini").classList.toggle("show",on); $(".topbar").classList.toggle("scrolled",on); },{rootMargin:"-52px 0px 0px 0px"}).observe($("#board"));

/* ====================================================== ad kuralı */
// Ad büyük harfle başlar, küfür/argo/hakaret içermez. Firebase kuralları da en bariz olanları ayrıca engeller.
const LEET={"0":"o","1":"i","2":"z","3":"e","4":"a","5":"s","6":"g","7":"t","8":"b","9":"g","@":"a","$":"s","!":"i","|":"i","€":"e"};
const foldName = s => s.toLocaleLowerCase("tr").replace(/[0-9@$!|€]/g, c=>LEET[c]).normalize("NFD").replace(/[̀-ͯ]/g,"").replace(/ı/g,"i");
const squeeze = s => s.replace(/(.)\1+/g, "$1");
// birleşik yazımda (boşluk/nokta atlatmaları dahil) aranan kökler
const BAD_SUB = ["orospu","orosbu","oruspu","siktir","sikerim","sikeyim","sikiyim","sikik","sikis","sikici","sikko","sokuk",
  "yarrak","yarak","yarag","dalyarak","tasak","tasag","aminak","aminako","amcik","amcig","amck","ibne","ipne","kahpe","kaltak",
  "pezevenk","gavat","yavsak","yavsag","serefsiz","surtuk","fahise","kevase","gerizekali","dangalak","angut","godos","kancik","gotveren",
  "gotlek","gotunu","ananisik","anasini","avradini","bacini","pic kurusu","haysiyetsiz","oglanci",
  "fuck","shit","bitch","cunt","asshole","bastard","whore","slut","nigger","nigga","faggot","retard","pussy","motherf","wanker",
  "dildo","penis","vagina","porn","hitler"].map(x=>squeeze(x.replace(/ /g,"")));
// yalnızca tek başına kelime olarak yasak olanlar (başka adların içinde geçebildikleri için)
const BAD_WORD = new Set(["amk","aq","amq","mk","oc","pic","got","sik","sg","mal","salak","aptal","pust","lan","ulan","ananı","anani","dick","cock","fag","ass","fck","sex","seks","kro","pezo","fuk","nazi","amina","sikim"].map(x=>squeeze(foldName(x))));
function nameProblem(name){
  if(!name) return "Adını yaz.";
  if(name.length > 40) return "Ad en fazla 40 karakter olabilir.";
  if(!/^\p{Lu}/u.test(name)) return "Ad büyük harfle başlamalı (ör. Andaç).";
  if(!/^\p{Lu}[\p{L}\p{N} .'\-]*$/u.test(name)) return "Adda yalnızca harf, rakam, boşluk ve . - ' olabilir.";
  const f = foldName(name), joined = squeeze(f.replace(/[^a-z]/g,"")), words = f.split(/[^a-z]+/).filter(Boolean).map(squeeze);
  if(BAD_SUB.some(x=>joined.includes(x)) || words.some(w=>BAD_WORD.has(w))) return "Bu ad uygun değil. Küfür, argo ya da hakaret içermeyen bir ad seç.";
  return null;
}

/* ====================================================== güvenlik sorusu */
// Herkes bir takım ve bir basketbolcu seçer. Cevap tuzlu SHA-256 olarak saklanır (recovery/{uid});
// "Şifremi unuttum" isteğini GitHub'daki görev birkaç dakikada bir işler.
let ALLP=null;
async function allPlayers(){ if(!ALLP) ALLP = await getJSON("data/allplayers.json"); return ALLP; }
const hex = buf => [...new Uint8Array(buf)].map(x=>x.toString(16).padStart(2,"0")).join("");
const randHex = n => hex(crypto.getRandomValues(new Uint8Array(n)));
const sha256hex = async s => hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
async function saveRecovery(uid, v){
  const salt = randHex(16), h = await sha256hex(`${salt}${v.team}:${v.playerId}`);
  await setDoc(doc(S.db,"recovery",uid), {salt, h, setAt:serverTimestamp()});
}
function secPicker(box){
  const st = {team:"", pid:""};
  box.innerHTML = `<label class="fld"><span>En sevdiğin takım</span><select class="sec-team"><option value="">Yükleniyor…</option></select></label>
    <label class="fld"><span>En sevdiğin basketbolcu</span><input class="sec-pl" autocomplete="off" placeholder="Ara: ör. Curry"></label>
    <div class="sec-res"></div>`;
  const sel = box.querySelector(".sec-team"), inp = box.querySelector(".sec-pl"), res = box.querySelector(".sec-res");
  allPlayers().then(d => {
    sel.innerHTML = `<option value="">Takım seç</option>` + d.teams.map(t=>`<option value="${esc(t.a)}">${esc(t.n)}</option>`).join("");
  }).catch(() => { sel.innerHTML = `<option value="">Liste yüklenemedi, sayfayı yenile</option>`; });
  sel.onchange = () => { st.team = sel.value; };
  inp.oninput = async () => {
    st.pid = ""; inp.classList.remove("chosen");
    const q = slug(inp.value);
    if(q.length < 2){ res.innerHTML = ""; return; }
    const d = await allPlayers().catch(()=>null); if(!d) return;
    const hits = d.players.filter(p=>slug(p.n).includes(q)).slice(0,8);
    res.innerHTML = hits.length ? hits.map(p=>`<button type="button" data-id="${esc(p.id)}" data-n="${esc(p.n)}"><img src="${LOGO_SMALL(p.t)}" alt="">${esc(p.n)}<small>${esc(p.t)}</small></button>`).join("")
      : `<p class="muted">Bulunamadı.</p>`;
  };
  res.onclick = e => {
    const b = e.target.closest("button"); if(!b) return;
    st.pid = b.dataset.id; inp.value = b.dataset.n; inp.classList.add("chosen"); res.innerHTML = "";
  };
  return { value: () => (st.team && st.pid) ? {team:st.team, playerId:st.pid} : null, focus: () => sel.focus() };
}
function openRecoverySheet(required){
  S.sheetLocked = required;
  $("#shClose").classList.toggle("hide", required);
  openSheet(`<h3 id="shTitle">Güvenlik sorusu</h3>
    <p class="muted">${required?"Şifreni unutursan sıfırlayabilmen için bir kez seçmen gerekiyor.":"Yeni cevabın eskisinin yerine geçer."} Takım ve oyuncuyu başkalarına söyleme.</p>
    <div id="recBox"></div><p class="err" id="recErr"></p><button class="btn-primary" id="recSave" type="button">Kaydet</button>`);
  const pk = secPicker($("#recBox"));
  $("#recSave").onclick = async () => {
    const v = pk.value(); if(!v){ $("#recErr").textContent = "Takımı seç ve listeden bir oyuncuya dokun."; return; }
    $("#recSave").disabled = true;
    try{ await saveRecovery(S.uid, v); S.sheetLocked=false; $("#shClose").classList.remove("hide"); closeSheet(); toast("Güvenlik sorusu kaydedildi."); }
    catch(e){ $("#recErr").textContent = "Kaydedilemedi, tekrar dene."; $("#recSave").disabled = false; }
  };
}
async function checkRecovery(){
  if(S.joinP) await S.joinP.catch(()=>{});
  try{ const r = await getDoc(doc(S.db,"recovery",S.uid)); if(!r.exists()) openRecoverySheet(true); }catch(e){}
}

/* ====================================================== giriş */
let authMode="login", authSec=null;
function setAuthMode(m){
  authMode=m;
  $$("#authMode .chip").forEach(x=>x.setAttribute("aria-pressed", x.dataset.v===(m==="reset"?"login":m)));
  $("#fInvite").classList.toggle("hide", m!=="join");
  $("#nameHint").classList.toggle("hide", m!=="join");
  $("#fSec").classList.toggle("hide", m==="login");
  $("#secHead").innerHTML = m==="reset" ? `Güvenlik sorusu <small>Kayıtta seçtiğin takım ve oyuncu.</small>` : `Güvenlik sorusu <small>Şifreni unutursan bu ikisiyle sıfırlarsın.</small>`;
  if(m!=="login" && !authSec) authSec = secPicker($("#secPick"));
  $("#pinLbl").textContent = m==="reset" ? "Yeni şifre (6 hane)" : "Şifre (6 hane)";
  $("#inPin").autocomplete = m==="login" ? "current-password" : "new-password";
  $("#authBtn").textContent = {login:"Giriş yap", join:"Oyuna katıl", reset:"Şifremi sıfırla"}[m];
  $("#forgotBtn").textContent = m==="reset" ? "Girişe dön" : "Şifremi unuttum";
  $("#forgotBtn").classList.toggle("hide", m==="join");
  $("#authTitle").textContent = m==="reset" ? "Şifreni sıfırla" : "Oyuna gir";
  $("#authErr").textContent="";
}
$("#authMode").addEventListener("click", e=>{ const c=e.target.closest(".chip"); if(c) setAuthMode(c.dataset.v); });
$("#forgotBtn").onclick = () => setAuthMode(authMode==="reset" ? "login" : "reset");
$("#inName").addEventListener("input", () => {
  if(authMode!=="join") return;
  const p = $("#inName").value.trim() ? nameProblem($("#inName").value.trim()) : null;
  $("#nameHint").textContent = p || "Büyük harfle başlamalı. Küfür, argo ya da hakaret içeremez.";
  $("#nameHint").classList.toggle("bad", !!p);
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
  if(authMode==="join"){ const p=nameProblem(name); if(p) return err(p); }
  if(!/^\d{6}$/.test(pin)) return err(authMode==="reset" ? "Yeni şifre 6 rakam olmalı." : "Şifre 6 rakam olmalı.");
  const sec = authMode==="login" ? null : authSec.value();
  if(authMode!=="login" && !sec) return err("Takımı seç ve listeden bir oyuncuya dokun.");
  if(authMode==="join" && !inv) return err("Davet kodunu gir.");
  const email=`${slug(name)}@${S.cfg.authEmailDomain}`;
  $("#authBtn").disabled=true; err("");
  try{
    if(authMode==="login"){ await signInWithEmailAndPassword(S.auth, email, pin); }
    else if(authMode==="reset"){
      const id = randHex(12);
      await setDoc(doc(S.db,"resets",id), {name, team:sec.team, playerId:sec.playerId, pin, at:serverTimestamp()});
      try{ localStorage.setItem("resetReq", JSON.stringify({id, name, t:Date.now()})); }catch(x){}
      showResetWait();
    }
    else{
      S.joinP = (async()=>{
        const cred=await createUserWithEmailAndPassword(S.auth, email, pin);
        try{
          const b=writeBatch(S.db);
          b.set(doc(S.db,"joins",cred.user.uid),{invite:inv});
          b.set(doc(S.db,"players",cred.user.uid),{name, joined:serverTimestamp()});
          await b.commit();
        }catch(x){ await cred.user.delete().catch(()=>{}); throw {code:"invite"}; }
        await saveRecovery(cred.user.uid, sec).catch(()=>{}); // olmazsa girişte tekrar sorulur
      })();
      await S.joinP;
    }
  }catch(x){ err(x.code==="invite"?"Davet kodu yanlış ya da ad uygun değil.":AUTH_ERR[x.code]||(authMode==="reset"?"İstek gönderilemedi, tekrar dene.":"Giriş yapılamadı, tekrar dene.")); }
  S.joinP=null;
  $("#authBtn").disabled=false;
});

// Şifre sıfırlama isteğinin sonucunu bekle (GitHub görevi birkaç dakikada bir çalışır)
const RESET_MSG = {
  ok:      ["ok",   "Şifren değişti. Yeni şifrenle giriş yapabilirsin."],
  wrong:   ["bad",  "Takım ya da oyuncu tutmadı. Tekrar deneyebilirsin (3 yanlıştan sonra 1 saat beklenir)."],
  locked:  ["bad",  "Çok fazla yanlış deneme oldu. 1 saat sonra tekrar dene."],
  nouser:  ["bad",  "Bu adla bir oyuncu bulunamadı. Adı kayıttaki gibi yazdığından emin ol."],
  nosetup: ["bad",  "Bu hesapta güvenlik sorusu yok. Oyunu kuran kişiden yardım iste."],
  error:   ["bad",  "İstek işlenemedi. Tekrar dene."]
};
let resetTimer=null;
function showResetWait(){
  let rq=null; try{ rq=JSON.parse(localStorage.getItem("resetReq")||"null"); }catch(e){}
  if(!rq) return;
  if(Date.now()-rq.t > 6*36e5){ try{localStorage.removeItem("resetReq");}catch(e){} return; }
  $("#authForm").classList.add("hide"); $("#authMode").classList.add("hide");
  const box=$("#resetWait"); box.classList.remove("hide");
  const done = () => { clearTimeout(resetTimer); try{localStorage.removeItem("resetReq");}catch(e){} };
  const back = (keep) => { clearTimeout(resetTimer); if(!keep) done(); box.classList.add("hide"); $("#authForm").classList.remove("hide"); $("#authMode").classList.remove("hide"); $("#inName").value=rq.name; $("#inPin").value=""; setAuthMode("login"); };
  const paint = st => {
    const m = st && RESET_MSG[st];
    box.innerHTML = m
      ? `<div class="reset-box ${m[0]}"><b>${m[0]==="ok"?"✓ Tamam":"Olmadı"}</b><p>${m[1]}</p></div><button class="btn-primary" id="rwBack" type="button">${m[0]==="ok"?"Giriş yap":"Geri dön"}</button>`
      : `<div class="reset-box"><div class="spin"></div><b>İsteğin alındı</b><p>Yeni şifren genelde 1-2 dakika içinde geçerli olur. Bu sayfayı açık bırakabilir ya da sonra dönebilirsin, sonuç burada görünür.</p></div><button class="linkish" id="rwBack" type="button">Girişe dön</button>`;
    $("#rwBack").onclick = () => m ? (back(false), m[0]!=="ok" && st!=="locked" && setAuthMode("reset")) : back(true);
    if(m) done();
  };
  paint(null);
  const poll = async () => {
    try{ const r=await getDoc(doc(S.db,"resetStatus",rq.id)); if(r.exists()){ paint(r.data().state); return; } }catch(e){}
    resetTimer=setTimeout(poll, 20e3);
  };
  poll();
}
let avTab = "emo";
const EMOJIS = ["🏀","🔥","🐐","👑","🦅","🐺","🦁","🐻","🐍","🦈","⚡","🌪️","🎯","💎","🚀","🧊","☄️","🌙","⭐","🍀","🎲","🛡️","🥷","🤖"];
$("#me").onclick=()=>openProfile();
async function saveProfile(patch){
  const me=S.players[S.uid]; const old={...me};
  Object.assign(me, patch); applyTheme(); render(); paintProfile();
  try{ await updateDoc(doc(S.db,"players",S.uid), patch); }
  catch(e){ Object.assign(me, old); applyTheme(); render(); paintProfile(); toast("Kaydedilemedi, tekrar dene."); }
}
function paintMail(){
  const inp=$("#pfMail"); if(!inp) return;
  const email=inp.value.trim(), ver=!!(S.contact?.verified && S.contact.email===email);
  $("#pfMailSt").innerHTML = !email ? "" : ver ? '<span class="ok">✓ Onaylı</span>' : '<span class="need">Onaylanmadı</span>';
  $("#pfSendCode").classList.toggle("hide", !email || ver || S.otpSentTo===email);
  $("#pfOtp").classList.toggle("hide", ver || !S.otpSentTo || S.otpSentTo!==email);
}
function openProfile(){
  const av=S.players[S.uid]?.av||""; avTab = av.startsWith("p:") ? "oyu" : av.startsWith("t:") ? "tak" : "emo";
  openSheet(`<div id="prof"></div>`); paintProfile();
}
function paintProfile(){
  const box=$("#prof"); if(!box) return;
  const me=S.players[S.uid]||{};
  const usedBy = c => S.order.filter(u=>u!==S.uid && S.players[u]?.color===c).map(pname);
  const teams = ALLP?.teams || Object.keys(TEAM_COL).map(a=>({a,n:a}));
  box.innerHTML = `<div class="pf-head">${avatar(S.uid,"lg")}<div><h3 id="shTitle" style="margin:0">${esc(pname(S.uid))}</h3><small class="muted">Profilin herkese böyle görünür</small></div></div>
    <div class="pf-sec"><h4>Rozetlerin</h4>${(()=>{ const b=badgesOf(S.uid).filter(x=>x.n); return b.length ? badgeHTML(b,true) : '<small class="muted" style="margin:0">Henüz rozetin yok. Neler kazanabileceğini İstatistik sekmesinde görebilirsin.</small>'; })()}</div>
    <div class="pf-sec"><h4>Rengin</h4><div class="pf-colors">${PKEYS.map(c=>{ const u=usedBy(c); return `<button class="pf-col" data-col="${c}" style="--c:var(--${c})" aria-pressed="${col(S.uid)===`var(--${c})`}" title="${u.length?esc(u.join(", "))+" de kullanıyor":""}">${u.length?"<i></i>":""}</button>`; }).join("")}</div>
      <small class="muted">Noktalı renkleri başka oyuncular da kullanıyor.</small></div>
    <div class="pf-sec"><h4>Avatar</h4>
      <div class="seg2 pf-avtab">${[["emo","Emoji"],["tak","Takım"],["oyu","Oyuncu"]].map(([k,l])=>`<button data-avtab="${k}" aria-pressed="${avTab===k}">${l}</button>`).join("")}</div>
      ${avTab==="emo" ? `<div class="pf-emojis"><button class="pf-emo ini" data-emo="" aria-pressed="${!me.emoji && !me.av}">${esc(initials(pname(S.uid)))}</button>${EMOJIS.map(e=>`<button class="pf-emo" data-emo="${e}" aria-pressed="${me.emoji===e && !me.av}">${e}</button>`).join("")}</div>`
      : avTab==="tak" ? `<div class="pf-avs">${teams.map(t=>`<button class="pf-av logo" data-av="t:${t.a}" aria-pressed="${me.av===`t:${t.a}`}" title="${esc(t.n)}"><img src="${LOGO_SMALL(t.a)}" alt="${esc(t.n)}"></button>`).join("")}</div>`
      : `<div class="pf-avs">${STARS.map(([id,n])=>`<button class="pf-av" data-av="p:${id}" aria-pressed="${me.av===`p:${id}`}" title="${esc(n)}"><img src="${HEADSHOT(id)}" alt="" loading="lazy"><small>${esc(n.split(" ").slice(-1)[0])}</small></button>`).join("")}</div>
        <small class="muted">CBS Sports'un 2026-27 sezonu ilk 50 oyuncu sıralaması.</small>`}
      ${me.av?`<button class="linkish" data-emo="" style="font-size:13px">Görseli kaldır</button>`:""}</div>
    <div class="pf-sec"><h4>Favori takım</h4><small class="muted">Avatarında logosu görünür. Güvenlik sorusundan bağımsızdır.</small>
      <div class="pf-teams"><button class="pf-tm none" data-tm="" aria-pressed="${!me.favTeam}">Yok</button>${teams.map(t=>`<button class="pf-tm" data-tm="${t.a}" aria-pressed="${me.favTeam===t.a}" title="${esc(t.n)}"><img src="${LOGO_SMALL(t.a)}" alt="${esc(t.n)}"></button>`).join("")}</div></div>
    <div class="pf-sec"><h4>Site renkleri</h4><div class="seg2 pf-theme"><button data-th="default" aria-pressed="${me.theme!=="team"}">Varsayılan</button><button data-th="team" aria-pressed="${me.theme==="team"}" ${me.favTeam?"":"disabled"}>Favori takımım</button></div>
      <small class="muted">${me.favTeam?"Üst alan ve vurgu renkleri takımının renklerine geçer. Yalnızca sende görünür.":"Önce bir favori takım seç."}</small></div>
    <div class="pf-sec"><h4>Hatırlatma maili</h4><small class="muted" style="margin:0 0 8px">Tahminin eksikse her akşam 21.00'de (ilk maç daha erkense maçtan 1 saat önce), seçtiğin oyuncu sakatlanırsa hemen mail gelir. Mail gelmesi için adresini bir kez onaylaman gerekir. Adresini yalnızca sen görürsün.</small>
      <div class="pf-mail"><input id="pfMail" type="email" inputmode="email" autocomplete="email" placeholder="ornek@gmail.com" value="${esc(S.contact?.email||"")}"><span class="mail-st" id="pfMailSt"></span></div>
      <div id="pfOtp" class="pf-otp hide"><small class="muted" id="pfOtpMsg"></small>
        <div class="adm-row"><input id="pfCode" class="adm-in otp-in" inputmode="numeric" maxlength="6" placeholder="6 haneli kod" autocomplete="one-time-code"><button class="btn" id="pfCodeOk" type="button">Onayla</button></div>
        <button class="linkish" id="pfResend" type="button">Kodu tekrar gönder</button></div>
      <button class="btn" id="pfSendCode" type="button" style="margin-top:8px">Onay kodu gönder</button>
      <label class="pf-sw pf-sw2"><input type="checkbox" id="pfRemind" ${S.contact?.remind?"checked":""}><span></span>Eksik tahmin ve sakatlık uyarıları</label>
      <label class="pf-sw pf-sw2"><input type="checkbox" id="pfWeekly" ${S.contact?.weekly?"checked":""}><span></span>Pazartesi günleri haftalık özet</label>
      <button class="btn" id="pfMailSave" style="margin-top:10px">Tercihleri kaydet</button><small class="muted" id="pfMailMsg"></small></div>
    <div class="pf-sec"><button class="btn admin-btn" id="histBtn" type="button">${ICON.list}Tahmin geçmişim</button></div>
    ${S.isAdmin?`<div class="pf-sec"><button class="btn admin-btn" id="adminBtn" type="button">${ICON.tools}Yönetim paneli</button></div>`:""}
    <div class="pf-sec pf-acts"><button class="btn" id="secChange">Güvenlik sorusunu değiştir</button><button class="btn" id="logout">Çıkış yap</button></div>`;
  if(!ALLP) allPlayers().then(()=>paintProfile()).catch(()=>{});
  box.onclick = e => {
    const c=e.target.closest("[data-col]"); if(c) return saveProfile({color:c.dataset.col});
    const at=e.target.closest("[data-avtab]"); if(at){ avTab=at.dataset.avtab; return paintProfile(); }
    const av=e.target.closest("[data-av]"); if(av) return saveProfile({av:av.dataset.av, emoji:""});
    const m=e.target.closest("[data-emo]"); if(m) return saveProfile({emoji:m.dataset.emo, av:""});
    const t=e.target.closest("[data-tm]"); if(t) return saveProfile(t.dataset.tm ? {favTeam:t.dataset.tm} : {favTeam:"", theme:"default"});
    const h=e.target.closest("[data-th]"); if(h && !h.disabled) return saveProfile({theme:h.dataset.th});
  };
  $("#secChange").onclick=()=>openRecoverySheet(false);
  $("#adminBtn")?.addEventListener("click", openAdmin);
  $("#histBtn").onclick = openHistory;
  $("#logout").onclick=async()=>{ closeSheet(); S.contact=null; await signOut(S.auth); applyTheme(); };
  if(!S.contact && !S.contactLoading){
    S.contactLoading=true;
    getDoc(doc(S.db,"contacts",S.uid)).then(r=>{ S.contactLoading=false; S.contact = r.exists() ? r.data() : {email:"",remind:false}; if($("#pfMail")){ $("#pfMail").value=S.contact.email||""; $("#pfRemind").checked=!!S.contact.remind; $("#pfWeekly").checked=!!S.contact.weekly; paintMail(); } }).catch(()=>{ S.contactLoading=false; });
  }
  const contactData = (extra={}) => { const email=$("#pfMail").value.trim();
    const ver = !!(S.contact?.verified && S.contact.email===email);
    return {email, remind:$("#pfRemind").checked, weekly:$("#pfWeekly").checked, verified:ver, updatedAt:serverTimestamp(), ...extra}; };
  const validMail = e => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
  $("#pfMail").oninput = paintMail;
  $("#pfMailSave").onclick = async () => {
    const d=contactData(), msg=$("#pfMailMsg");
    if(d.email && !validMail(d.email)){ msg.textContent="E-posta adresi geçerli görünmüyor."; return; }
    if((d.remind||d.weekly) && !d.email){ msg.textContent="Önce bir e-posta adresi yaz."; return; }
    $("#pfMailSave").disabled=true;
    try{ await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d};
      msg.textContent = !(d.remind||d.weekly) ? "Kaydedildi. Mail gelmeyecek." : d.verified ? "Kaydedildi." : "Kaydedildi. Mail gelmesi için adresini onaylaman gerekiyor."; paintMail(); }
    catch(e){ msg.textContent="Kaydedilemedi, tekrar dene."; }
    $("#pfMailSave").disabled=false;
  };
  const sendCode = async () => {
    const email=$("#pfMail").value.trim(), msg=$("#pfOtpMsg");
    if(!validMail(email)){ $("#pfMailMsg").textContent="Önce geçerli bir e-posta adresi yaz."; return; }
    $("#pfSendCode").disabled=true;
    try{
      const d=contactData(); await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d};
      await setDoc(doc(S.db,"verifyReq",S.uid), {email, at:serverTimestamp()});
      S.otpSentTo=email; paintMail();
      msg.textContent=`Kod ${email} adresine gönderilecek. Genelde 1-2 dakika içinde gelir, gelince buraya yaz. Gereksiz klasörüne de bak.`;
    }catch(e){ $("#pfMailMsg").textContent="İstek gönderilemedi, tekrar dene."; }
    $("#pfSendCode").disabled=false;
  };
  $("#pfSendCode").onclick = sendCode;
  $("#pfResend").onclick = sendCode;
  $("#pfCodeOk").onclick = async () => {
    const code=$("#pfCode").value.trim(), msg=$("#pfOtpMsg");
    if(!/^\d{6}$/.test(code)){ msg.textContent="Kod 6 rakam olmalı."; return; }
    $("#pfCodeOk").disabled=true;
    try{ const d=contactData({verified:true, code}); await setDoc(doc(S.db,"contacts",S.uid), d); S.contact={...d, code:undefined}; S.otpSentTo=null;
      $("#pfMailMsg").textContent="E-posta adresin onaylandı."; paintMail(); renderBanners(); toast("E-posta adresin onaylandı."); }
    catch(e){ msg.textContent="Kod yanlış ya da süresi dolmuş. Tekrar dene ya da yeni kod iste."; }
    $("#pfCodeOk").disabled=false;
  };
  paintMail();

}
// Takım teması: üst alan ve vurgu rengi favori takımın renklerine geçer (yalnızca o oyuncuda)
function paintMe(){ const p=S.players[S.uid]||{}; const img=avImg(p.av); $("#me").innerHTML = img ? img.replace('class="av-img','class="me-img') : (p.emoji || esc(pname(S.uid).slice(0,1).toLocaleUpperCase("tr"))); $("#me").style.setProperty("--pc", col(S.uid)); $("#me").classList.add("me-btn"); }
function applyTheme(){
  if(S.uid) paintMe();
  const r=document.documentElement.style, me=S.uid && S.players[S.uid];
  const keys=["--board","--board-2","--board-line","--amber","--amber-ink","--amber-soft"];
  const tc = me && me.theme==="team" && TEAM_COL[me.favTeam];
  if(!tc){ keys.forEach(k=>r.removeProperty(k)); $('meta[name="theme-color"]')?.setAttribute("content","#0f1620"); return; }
  const [c1,c2] = tc.map(h=>"#"+h);
  const acc = lum(tc[1]) > .12 && lum(tc[1]) < .85 ? c2 : lum(tc[0]) > .06 ? c1 : c2;
  const base = `color-mix(in srgb, ${c1} 32%, #070b10)`;
  r.setProperty("--board", base);
  r.setProperty("--board-2", `color-mix(in srgb, ${c1} 30%, #18222e)`);
  r.setProperty("--board-line", `color-mix(in srgb, ${c1} 35%, #2a3646)`);
  r.setProperty("--amber", acc);
  r.setProperty("--amber-ink", isDark() ? acc : `color-mix(in srgb, ${acc} 70%, #000)`);
  r.setProperty("--amber-soft", `color-mix(in srgb, ${acc} 18%, var(--panel))`);
  // tarayıcı çubuğunun rengi
  const n=parseInt(tc[0],16), mix=v=>Math.round(v*.32+ [7,11,16][mixi++]*.68); let mixi=0;
  $('meta[name="theme-color"]')?.setAttribute("content", "#"+[n>>16&255,n>>8&255,n&255].map(v=>mix(v).toString(16).padStart(2,"0")).join(""));
}

/* ====================================================== yönetim paneli (yalnızca yönetici) */
// İki adımlı onay: ilk dokunuşta düğme "Emin misin?" olur, 4 sn içinde ikinci dokunuş işi yapar
function confirmBtn(btn, label, fn){
  if(btn.dataset.armed){ delete btn.dataset.armed; clearTimeout(btn._t); fn(); return; }
  const old=btn.textContent; btn.dataset.armed="1"; btn.textContent=label; btn.classList.add("armed");
  btn._t=setTimeout(()=>{ delete btn.dataset.armed; btn.textContent=old; btn.classList.remove("armed"); }, 4000);
}
async function openAdmin(){
  S.sheetLocked=false;
  openSheet(`<h3 id="shTitle">Yönetim paneli</h3><p class="muted">Bu bölümü yalnızca sen görüyorsun.</p><div id="adm"><p class="muted">Yükleniyor…</p></div>`);
  let banned=[];
  try{ const snap=await getDocs(collection(S.db,"banned")); snap.forEach(x=>banned.push({uid:x.id,...x.data()})); }catch(e){}
  await loadLeague();
  const st=leagueStart(), hist=S.league?.history||[];
  const first=S.days[S.today]?.games.some(started);
  const opts=[[first?shiftDay(S.today,1):S.today, first?"Yarın geceden":"Bu geceden"], [shiftDay(S.today,first?2:1), first?"Öbür geceden":"Yarın geceden"]];
  const tot=seasonTotals();
  $("#adm").innerHTML = `
    <div class="pf-sec"><h4>Lig</h4>
      <p class="muted" style="margin:0 0 8px">Şu anki lig <b>${dayNice(st,{day:"numeric",month:"long"})}</b> gecesinden beri sayılıyor${hist.length?`, ${hist.length} geçmiş lig var`:""}.</p>
      <p style="margin:0 0 8px;font-size:14px">Ligi sıfırlarsan bütün puanlar, rozetler ve istatistikler seçtiğin geceden itibaren sıfırdan sayılır. Şu anki puan durumu "Geçmiş ligler"e kaydedilir, tahminler silinmez.</p>
      <div class="adm-row"><select id="admStart" class="adm-in">${opts.map(([d,l])=>`<option value="${d}">${l} (${dayNice(d,{day:"numeric",month:"long"})})</option>`).join("")}<option value="custom">Başka bir gece…</option></select>
      <input type="date" id="admDate" class="adm-in hide"></div>
      <button class="btn danger" id="admReset" type="button">Ligi sıfırla</button><small class="muted" id="admResetMsg"></small></div>
    <div class="pf-sec"><h4>Oyuncular</h4><div class="adm-pl">${S.order.map(u=>`<div class="adm-p">${avatar(u,"sm")}<span><b>${esc(pname(u))}</b><small>${tot[u]??0} puan · ${new Date(S.players[u].joined).toLocaleDateString("tr-TR",{timeZone:TZ,day:"numeric",month:"long"})} katıldı</small></span>
      ${u===S.uid?'<small class="muted">sen</small>':`<button class="btn danger sm" data-kick="${u}" type="button">Ligden çıkar</button>`}</div>`).join("")}</div>
      ${banned.length?`<h4 style="margin-top:12px">Çıkarılanlar</h4><div class="adm-pl">${banned.map(b=>`<div class="adm-p"><span class="av sm empty">?</span><span><b>${esc(b.name||"?")}</b><small>tekrar katılamaz</small></span><button class="btn sm" data-unban="${b.uid}" type="button">Geri al</button></div>`).join("")}</div>`:""}
      <small class="muted">Çıkarılan oyuncu sitede görünmez, puanları sayılmaz ve davet koduyla yeniden katılamaz.</small></div>
    <div class="pf-sec"><h4>Davet kodu</h4><div class="adm-row"><input id="admInv" class="adm-in" value="${esc(S.invite||"")}" maxlength="40"><button class="btn" id="admInvSave" type="button">Kaydet</button></div>
      <small class="muted" id="admInvMsg">Yeni oyuncular bu kodla katılır. Kodu değiştirince eski kod ve eski link çalışmaz.</small>
      <button class="btn" id="admLink" type="button" style="margin-top:8px">${ICON.link}Davet linkini paylaş</button></div>
    <div class="pf-sec"><h4>Duyuru</h4><small class="muted" style="margin:0 0 8px">Sitenin üstünde herkese görünür. Kapatan bir daha görmez; yeni duyuru yine çıkar.</small>
      <textarea id="admNotice" class="adm-in" rows="2" maxlength="200" placeholder="ör. Yeni oyuncu: Zeki 👋">${esc(S.notice?.text||"")}</textarea>
      <div class="adm-row" style="margin-top:8px"><button class="btn" id="admNoticeSave" type="button">Yayınla</button>${S.notice?.text?'<button class="btn danger" id="admNoticeDel" type="button">Kaldır</button>':""}</div>
      <small class="muted" id="admNoticeMsg"></small></div>`;
  $("#admStart").onchange=()=>$("#admDate").classList.toggle("hide", $("#admStart").value!=="custom");
  $("#admReset").onclick=e=>confirmBtn(e.currentTarget,"Emin misin? Tekrar dokun",async()=>{
    let ns=$("#admStart").value; if(ns==="custom"){ const v=$("#admDate").value; if(!v){ $("#admResetMsg").textContent="Bir tarih seç."; return; } ns=v.replaceAll("-",""); }
    const t=seasonTotals(), nights={}; for(const n of nightsOf()) if(n.w.st==="w") nights[n.w.u]=(nights[n.w.u]||0)+1;
    const rows=[...S.order].sort((a,b)=>(t[b]||0)-(t[a]||0)).map(u=>({uid:u, name:pname(u), pts:t[u]||0, nights:nights[u]||0}));
    const entry={start:leagueStart(), end:shiftDay(ns,-1), rows, at:new Date().toISOString()};
    const history=[...(S.league?.history||[]), ...(rows.some(r=>r.pts) ? [entry] : [])];
    try{ await setDoc(doc(S.db,"league","settings"), {start:ns, history}); S.league={start:ns, history}; applyLeague(); render(); toast("Lig sıfırlandı."); openAdmin(); }
    catch(err){ $("#admResetMsg").textContent="Kaydedilemedi, tekrar dene."; }
  });
  $("#adm").addEventListener("click", e=>{
    const k=e.target.closest("[data-kick]"); if(k) return confirmBtn(k,"Emin misin?",async()=>{
      const u=k.dataset.kick, p=S.players[u];
      try{ await setDoc(doc(S.db,"banned",u), {name:p.name, joined:Timestamp.fromMillis(p.joined), at:serverTimestamp()}); await deleteDoc(doc(S.db,"players",u));
        await loadPlayers(); render(); toast(`${p.name} ligden çıkarıldı.`); openAdmin(); }catch(err){ toast("Yapılamadı, tekrar dene."); }
    });
    const ub=e.target.closest("[data-unban]"); if(ub) return confirmBtn(ub,"Emin misin?",async()=>{
      const b=banned.find(x=>x.uid===ub.dataset.unban);
      try{ await setDoc(doc(S.db,"players",b.uid), {name:b.name, joined:b.joined}); await deleteDoc(doc(S.db,"banned",b.uid));
        await loadPlayers(); render(); toast(`${b.name} geri alındı.`); openAdmin(); }catch(err){ toast("Yapılamadı, tekrar dene."); }
    });
  });
  $("#admLink").onclick=async()=>{
    const url=`${location.origin}${location.pathname}?davet=${encodeURIComponent(S.invite||"")}`;
    const text=`NBA Tahmin'e katıl! Her gece maçlara tahmin yapıyoruz: ${url}`;
    try{ if(navigator.share){ await navigator.share({title:"NBA Tahmin", text, url}); return; } }catch(e){ if(e.name==="AbortError") return; }
    try{ await navigator.clipboard.writeText(url); $("#admInvMsg").textContent="Link kopyalandı: "+url; }catch(e){ $("#admInvMsg").textContent=url; }
  };
  $("#admNoticeSave").onclick=async()=>{ const text=$("#admNotice").value.trim(); if(!text) return;
    const n={text, at:Date.now()};
    try{ await setDoc(doc(S.db,"league","notice"), n); S.notice=n; renderBanners(); $("#admNoticeMsg").textContent="Duyuru yayınlandı."; }catch(e){ $("#admNoticeMsg").textContent="Yayınlanamadı."; } };
  $("#admNoticeDel")?.addEventListener("click", async()=>{ try{ await deleteDoc(doc(S.db,"league","notice")); S.notice=null; renderBanners(); openAdmin(); }catch(e){ $("#admNoticeMsg").textContent="Kaldırılamadı."; } });
  $("#admInvSave").onclick=async()=>{ const v=$("#admInv").value.trim(); if(!v) return;
    try{ await setDoc(doc(S.db,"config","secret"),{invite:v}); S.invite=v; $("#admInvMsg").textContent="Davet kodu değişti."; }catch(err){ $("#admInvMsg").textContent="Kaydedilemedi."; } };
}
/* ====================================================== başlangıç */
if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
(async()=>{
  // Hız: bugünün maç listesi Firebase ve giriş beklenmeden hemen istenir
  { const d=espnToday(); S.preSB = {day:d, p:espn(`/scoreboard?dates=${d}&limit=50`).catch(()=>null)}; }
  let ok=false;
  try{ ok = await initFirebase(); }catch(e){ console.error(e); }
  if(!ok){ $("#auth").classList.remove("hide"); $("#authForm").innerHTML=`<div class="note">Kurulum bekleniyor: config.json içine Firebase bilgileri girilince oyun açılacak.</div>`; return; }
  S.today = espnToday(); S.day = S.today;
  if(Q.get("davet")){ setAuthMode("join"); $("#inInvite").value = Q.get("davet"); }
  await Promise.all([loadPlayers().catch(()=>{}), loadArchive().catch(()=>{})]);
  onAuthStateChanged(S.auth, async user=>{
    if(!user){ S.uid=null; $("#app").classList.add("hide"); $("#me").classList.add("hide"); $("#auth").classList.remove("hide"); showResetWait(); dispatchEvent(new Event("app-ready")); return; }
    S.uid=user.uid;
    if(S.players?.[S.uid]) S.order=[S.uid, ...S.order.filter(u=>u!==S.uid)];
    else await loadPlayers().catch(()=>{});
    if(!S.players[S.uid]){ // kayıt yarıda kaldıysa
      await new Promise(r=>setTimeout(r,800)); await loadPlayers().catch(()=>{});
      if(!S.players[S.uid]){
        const ban = await getDoc(doc(S.db,"banned",S.uid)).then(r=>r.exists()).catch(()=>false);
        $("#authErr").textContent = ban ? "Bu hesap ligden çıkarıldı. Oyunu kuran kişiyle konuş." : "Hesap bulunamadı. Tekrar katılmayı dene.";
        await signOut(S.auth); return; }
    }
    $("#auth").classList.add("hide"); $("#app").classList.remove("hide");
    $("#me").classList.remove("hide"); paintMe(); applyTheme();
    S.statFor=S.uid;
    $("#foot").innerHTML=`Kazanan +1 · fark +1 · en skorer +1 · banko +2 / -1 · günün oyuncusu +2 · gecenin sorusu +1<br>Veriler ESPN'den alınır. Maç varken 30 saniyede bir yenilenir.<br><span class="ver">${VERSION}</span>`;
    route(); showDay(); Promise.resolve(refresh()).catch(()=>{}).finally(()=>dispatchEvent(new Event("app-ready")));
    checkRecovery();
    getDoc(doc(S.db,"config","secret")).then(r=>{ S.isAdmin=true; S.invite=r.data()?.invite||""; }).catch(()=>{ S.isAdmin=false; });
    getDoc(doc(S.db,"contacts",S.uid)).then(r=>{ S.contact = r.exists() ? r.data() : {email:"",remind:false}; }).catch(()=>{}).finally(()=>{ S.contactLoaded=true; renderBanners(); });
  });
})();
