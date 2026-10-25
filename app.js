// NBA Tahmin — her gecenin maçlarına tahmin: kazanan, fark, en skorer.
// Seçimler Firebase'de (Firestore) tutulur, maç verisi ESPN'den canlı okunur,
// geçmiş puanlar GitHub'daki data/ dosyalarından gelir.
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.4.0/firebase-app.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, signOut, connectAuthEmulator }
  from "https://www.gstatic.com/firebasejs/12.4.0/firebase-auth.js";
import { getFirestore, doc, getDoc, getDocs, setDoc, updateDoc, collection, writeBatch, serverTimestamp, Timestamp, arrayUnion, connectFirestoreEmulator }
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
// Takım logoları sitenin kendi logos/ klasöründen gelir (ESPN'e bağımlı değil).
// Yerel dosya yüklenemezse ESPN'in adresi denenir, o da olmazsa takım kısaltması gösterilir.
const LOGO_SMALL = a => `logos/${String(a).toLowerCase()}.png`;
const LOGO_FULL  = a => `https://a.espncdn.com/i/teamlogos/nba/500/${String(a).toLowerCase()}.png`;
document.addEventListener("error", e => {
  const img = e.target;
  if(!(img instanceof HTMLImageElement)) return;
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
    return { id:ev.id, start:new Date(ev.date), state:ty.state, detail:ty.shortDetail||"", typeName:ty.name||"",
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
  snap.forEach(d => { const x=d.data({serverTimestamps:"estimate"});
    S.players[d.id] = {name:x.name, joined:x.joined?.toMillis?.()||Date.now(), color:x.color||"", emoji:x.emoji||"", favTeam:x.favTeam||"", theme:x.theme||"default"}; });
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
    toast("Tahmin kaydedildi.");
    setDoc(progressRef(S.day, S.uid), {uid:S.uid, day:S.day, gids:arrayUnion(g.id), updatedAt:serverTimestamp()}, {merge:true})
      .then(()=>{ (D.progress[S.uid] ||= new Set()).add(g.id); renderDayView(); }).catch(()=>{});
  }catch(e){
    d.err = started(g) ? "Kilitlendi, kaydedilemedi (gecenin ilk maçı başladı)." : "Kaydedilemedi, tekrar dene.";
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
const avatar = (u, cls="") => { const p=S.players[u]||{}; const h=honors();
  const crown = h.week===u ? `<span class="av-crown" title="Geçen haftanın şampiyonu">👑</span>` : "";
  const star = h.night===u ? `<span class="av-star" title="Son gecenin kazananı">★</span>` : "";
  return `<span class="av ${cls} ${p.emoji?"emo":""}" style="--pc:${col(u)}">${p.emoji?p.emoji:esc(initials(pname(u)))}${p.favTeam?`<img class="av-team" src="${LOGO_SMALL(p.favTeam)}" alt="">`:""}${crown}${star}</span>`; };
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
    const cell = u => u ? `<div class="pl">${avatar(u)}<div class="nm" style="color:${col(u)}">${esc(pname(u))}</div>${digitsHTML(u, tot[u])}${deltaHTML(u)}${brkHTML(brk[u])}${formHTML(u)}</div>` : `<div class="pl"><span class="av empty">?</span><div class="nm">Rakip bekleniyor</div><div class="digits">–</div><div class="brk">&nbsp;</div></div>`;
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
    html = `<div class="lb">${ranked.map((u,i)=>`<div class="lb-row" style="--pc:${col(u)};--w:${Math.max(0,tot[u])/top*100}%"><span class="rk">${i+1}</span>${avatar(u,"sm")}<span class="nmw"><span class="nm" style="color:${col(u)};display:block">${esc(pname(u))}</span>${brkHTML(brk[u])}</span><span class="td">${formHTML(u)}<br>bu gece ${tonight[u]?.pts??0}</span><span class="tn tnum">${tot[u]}${deltaHTML(u)}</span></div>`).join("")}</div>`;
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
  countUp();
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
  if(!D.games.length){ $("#dayStatus").innerHTML = EMPTY_NIGHT; return; }
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
      <small>${mine?.dayPlayerName?"Değiştirmek için dokun. ":"Gecenin en çok sayı atanını bil, +2 puan. "}Gecenin ilk maçı başlayınca kilitlenir.</small></span></button>`;
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
  const live = g.state==="in", post = g.state==="post";
  const tops = post ? topsOf(g) : liveTops(g);
  const team = pick.winner===g.home.abbr ? g.home : g.away;
  const homeLead=(g.home.score??0)-(g.away.score??0);
  const winNow = homeLead!==0 && (homeLead>0?g.home.abbr:g.away.abbr)===pick.winner;
  // çip durumu: ok / no (bitti), nok / nno (canlı, şu anki duruma göre), boş (henüz yok)
  const st = (got, known=true) => post ? (got?"ok":"no") : live && known ? (got?"nok":"nno") : "";
  const ic = c => c==="ok"||c==="nok" ? "✓" : c==="no" ? "✗" : "";
  const chip = (txt, c, lbl) => `<span class="rc ${c}" title="${lbl}">${ic(c)?`<i>${ic(c)}</i>`:""}${txt}</span>`;
  const cW = st(winNow, homeLead!==0), cM = st(r.m>0, winNow), cS = st(r.s>0, !!tops);
  const state = live ? (winNow ? "winning" : homeLead!==0 ? "losing" : "") : "";
  const small = post ? "puan" : live ? (state==="winning"?"tutuyor":state==="losing"?"tutmuyor":"şu an") : "";
  return `<div class="prow ${state} ${!S.seen.has(g.id) && uid!==S.uid ? "reveal":""}" style="--pc:${col(uid)}">
    <span class="who">${esc(pname(uid))}${conf?' <span class="star" title="Günün bankosu">★</span>':""}</span>
    <span class="pk">${chip(esc(team.abbr||team.name), cW, "Kazanan")}${chip(pick.margin, cM, "Fark")}${chip(esc(pick.scorerName), cS, "En skorer")}</span>
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
    return `<span class="cm-t ${lose?"lose":""}"><img src="${t.logo||""}" alt=""><b>${esc(t.abbr)}</b><span class="sc">${t.score??""}</span></span>`; };
  const dots = r ? `<span class="cm-dots" title="Kazanan · fark · skorer"><i class="${r.w>0?"ok":"no"}"></i><i class="${r.m>0?"ok":"no"}"></i><i class="${r.s>0?"ok":"no"}"></i></span>` : `<span class="muted cm-none">tahmin yok</span>`;
  const badge = r ? `<span class="pt-badge ${r.pts>0?"pos":r.pts<0?"neg":"zero"}">${r.pts>0?"+":""}${r.pts}</span>` : "";
  return `<article class="game compact" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <button class="cm" data-act="expand" data-g="${g.id}" aria-expanded="false">${side("away")}<span class="cm-sep">–</span>${side("home")}<span class="cm-r">${conf?'<span class="star">★</span>':""}${dots}${badge}<svg class="chev" viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg></span></button></article>`;
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
  const txt = ms<=0 ? "kilitlendi" : `${h?h+" sa ":""}${m} dk`;
  return `<span class="ring ${cls}" data-ring="${g.id}" title="Kilide kalan süre"><svg viewBox="0 0 36 36"><circle cx="18" cy="18" r="15" class="rt"/><circle cx="18" cy="18" r="15" class="rf" style="stroke-dashoffset:${(94.25*(1-f)).toFixed(1)}"/></svg><span>${txt}</span></span>`;
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
    const loser = g.state==="post" && (s.score??0)<(other.score??0);
    const sel = (lock ? D.picks[g.id]?.[S.uid]?.winner : draftFor(g).winner)===s.abbr;
    const nm = g.state==="pre" ? esc(s.name) : `<span title="${esc(s.name)}">${s.abbr}</span>`;
    const key = g.id+side, prev = S.prevSc[key], flash = g.state==="in" && prev!=null && s.score!=null && s.score!==prev;
    if(s.score!=null) S.prevSc[key] = s.score;
    return `<button class="tbtn ${loser?"loser":""}" style="--tc:${tcol(s.abbr)}" data-act="win" data-g="${g.id}" data-v="${s.abbr}" aria-pressed="${sel}" ${lock?"disabled":""}>
      <img src="${s.logo||""}" alt=""><span class="tt"><b>${nm}</b><small>${side==="home"?"ev sahibi":"deplasman"}${s.rec&&g.state==="pre"?" · "+s.rec:""}</small></span>
      ${g.state!=="pre"?`<span class="sc ${flash?"flash":""}">${s.score??""}</span>`:""}</button>`;
  };
  let body = `<div class="teams">${t("away")}${t("home")}</div>`;
  if(!lock){
    body += infoBox(g);
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
    body += `<div class="g-foot">${st}</div>
      <button class="save-btn ${same && d.justSaved && Date.now()-d.justSaved<1500 ? "done":""}" data-act="save" data-g="${g.id}" ${canSave?"":"disabled"}>${same?'<span class="tick"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg></span>Kaydedildi':saved?"Değişikliği kaydet":"Tahmini kaydet"}</button>
      <div class="lock-note">${lockLeft(g)}</div>`;
  } else {
    const rows = S.order.map(u => { const p = D.picks[g.id]?.[u]; return p ? pickCell(g, p, u, D.daily[u]?.confGame===g.id) : `<div class="prow" style="--pc:${col(u)}"><span class="who">${esc(pname(u))}</span><span class="pk muted">tahmin yok</span><span class="pts">0</span></div>`; }).join("");
    body += lineScore(g) + `<div class="plist">${rows}</div>`;
    const tops = g.state==="post" ? topsOf(g) : liveTops(g);
    body += `<div class="g-foot"><span class="leaders">${tops?`En skorer: <b>${tops.map(x=>esc(x.name)).join(", ")}</b> ${tops[0].pts} sayı`:""}</span><span class="g-links">${g.state==="post"?`<button class="linkish" data-act="collapse" data-g="${g.id}">Küçült</button>`:""}<button class="linkish" data-act="box" data-g="${g.id}">İstatistikler</button></span></div>`;
  }
  const conf = !lock ? `<button class="conf-btn" data-act="conf" data-g="${g.id}" aria-pressed="${confHere}" ${confLocked&&!confHere?"disabled":""} title="Günün bankosu: kazanan doğruysa 2 puan, yanlışsa -1">★ ${confHere?"Banko":"Banko yap"}</button>`
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
  } else if(g.state==="pre") stt = `${gameStatusTR(g)}${!lock ? ringHTML(g) : ' <span class="muted" style="font-weight:600">· kilitli</span>'}`;
  else stt = gameStatusTR(g);
  return `<article class="game ${g.state==="in"?"is-live":""}${missingCls}" style="--ca:${pairCols(g.away.abbr,g.home.abbr)[0]};--ch:${pairCols(g.away.abbr,g.home.abbr)[1]}" data-gid="${g.id}">
    <div class="g-head"><span class="stt">${stt}</span><span class="g-hr">${badge}${conf}</span></div>${body}</article>`;
}
// Maç önü kutusu: ESPN kazanma olasılığı + son 5 maç + sakat sayısı (özet yüklendiyse)
function infoBox(g){
  const s = S.sums[g.id]?.data;
  let inner = `<span class="ib-loading">Maç önü bilgileri yükleniyor…</span>`;
  if(s){
    const pr = s.predictor;
    const a = pr?.awayTeam?.gameProjection!=null ? +pr.awayTeam.gameProjection : null;
    const h = pr?.homeTeam?.gameProjection!=null ? +pr.homeTeam.gameProjection : null;
    const l5 = t => ((s.lastFiveGames||[]).find(x=>x.team?.abbreviation===t.abbr)?.events||[]).map(e=>`<i class="${e.gameResult}">${e.gameResult==="W"?"G":"M"}</i>`).join("");
    const inj = t => ((s.injuries||[]).find(x=>x.team?.abbreviation===t.abbr)?.injuries||[]).filter(i=>/out/i.test(i.status)).length;
    const side = (t,p,cls) => `<div class="ib-side ${cls}"><b>${esc(t.name)}${p!=null?` %${Math.round(p)}`:""}</b><span class="ib-l5">${l5(t)||""}</span><small>${inj(t)?`${inj(t)} oyuncu oynamıyor`:"Sakat yok"}</small></div>`;
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
  $("#games").innerHTML = bestPickCard(D) + D.games.map(g => g.state==="post" && !S.open.has(g.id) ? compactCard(g) : gameCard(g)).join("");
  prefetchInfo(D);
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
  if(act==="expand"){ S.open.add(g.id); return renderGames(); }
  if(act==="collapse"){ S.open.delete(g.id); return renderGames(); }
  if(act==="info") return openInfo(g);
  if(act==="box") return openBox(g);
  if(started(g)) return toast("Tahminler kilitlendi (gecenin ilk maçı başladı).");
  if(act==="save") return savePick(g);
  if(act==="win"){ d.winner=b.dataset.v; }
  if(act==="mar"){ d.margin=b.dataset.v; }
  if(act==="scorer") return openPlayerPicker({mode:"game", g});
  if(act==="conf"){
    const cur = D.daily[S.uid]?.confGame;
    if(cur===g.id) return toast("Bankoyu başka maça taşıyabilirsin; kaldırılamaz.");
    return saveDaily({confGame:g.id, confStart:g.lock});
  }
  d.err=null; renderGames();
});


/* ====================================================== Günün tahminleri */
function lockLeft(g){
  const ms = g.lock.getTime() - Date.now();
  if(ms<=0) return "Kilitlendi";
  const h=Math.floor(ms/36e5), m=Math.floor(ms%36e5/6e4);
  return `Değiştirmek için ${h?h+" sa ":""}${m} dk var · ${timeTR(g.lock)}'de kilitlenir (gecenin ilk maçı)`;
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
  else dp = "Günün oyuncusu ilk maç başlayınca açılır";
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
      body = `<div class="dv-hidden">${prog.has(g.id)?"<b>✓ Girdi</b> · ":"Henüz girmedi · "}seçim ${timeTR(g.lock)}'de açılır</div>`;
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
      if(started(g)) return toast("Tahminler kilitlendi (gecenin ilk maçı başladı).");
      const d=draftFor(g); d.scorerId=b.dataset.id; d.scorerName=b.dataset.name; d.err=null; renderGames();
    } else {
      if(D.games.some(started)) return toast("Günün oyuncusu kilitlendi (gecenin ilk maçı başladı).");
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
function closeSheet(){ if(S.sheetLocked) return; $("#sheet").classList.add("hide"); document.body.style.overflow=""; }
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
    <p>Gecenin bütün tahminleri (maçlar, banko, günün oyuncusu) <b>gecenin ilk maçı başladığı anda</b> kilitlenir; o ana kadar istediğin kadar değiştirebilirsin. Kilitlenene kadar rakiplerin seçimleri gizli; kimin hangi maçları girdiği ise "Günün tahminleri"nde görünür.</p>
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
  if(!D){ $("#results").innerHTML=skeletonCards(2); loadDay(day).then(()=>{ if(S.tab==="sonuclar") renderResults(); }).catch(()=>{ $("#results").innerHTML=`<div class="note">Maçlara şu an ulaşılamıyor.</div>`; }); return; }
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
      ${tm("away")}${tm("home")}${lineScore(g)}${lead?`<div class="rg-l">${lead}</div>`:""}</button>`;
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
    }).join("")}</div>` : `<div class="note">${st.length?"Başlamış maçlarda hepiniz aynı tarafı seçtiniz.":"Henüz başlamış maç yok."}</div>`;
  if(pending) html += `<div class="note">${pending} maçın seçimleri, maç başlayınca açılacak ve ayrıştığınız maçlar buraya düşecek.</div>`;
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
  const start=S.cfg?.seasonStart||"20261020";
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
    confetti(); toast(`🏆 ${dayNice(d,{day:"numeric",month:"long"})} gecesini kazandın!`, 4000);
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
  <b>Bu gece maç yok</b><span>Oklarla diğer günlere geçebilirsin.</span></div>`;

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
  if(!missing.length && !noBanko && !noDp){ el.innerHTML=""; return; }
  // en yakın kilit: eksik maçlar ya da (günün oyuncusu eksikse) ilk maç
  const locks = missing.map(g=>g.lock.getTime());
  if(noDp || noBanko) locks.push(Math.min(...open.map(g=>g.lock.getTime())));
  const ms = Math.min(...locks) - Date.now();
  if(ms > 12*36e5){ el.innerHTML=""; return; }          // 12 saatten uzaksa gösterme
  const h=Math.floor(ms/36e5), m=Math.max(0,Math.floor(ms%36e5/6e4));
  const when = ms<=0 ? "Kilitleniyor" : `Sıradaki kilit ${h?h+" sa ":""}${m} dk sonra`;
  const parts=[];
  if(missing.length) parts.push(`<b>${missing.length} maçın eksik</b>`);
  if(noBanko) parts.push("banko seçilmedi");
  if(noDp) parts.push("günün oyuncusu seçilmedi");
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
function render(){
  if(!S.uid) return;
  renderBoard();
  renderAlert();
  maybeConfetti();
  const nLive = S.days[S.today]?.games.filter(g=>g.state==="in").length || 0;
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
  render();
}
window.addEventListener("hashchange", ()=>{ route(); scrollTo({top:0}); });
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
      : `<div class="reset-box"><div class="spin"></div><b>İsteğin alındı</b><p>Yeni şifren genelde 5–15 dakika içinde geçerli olur. Bu sayfayı açık bırakabilir ya da sonra dönebilirsin, sonuç burada görünür.</p></div><button class="linkish" id="rwBack" type="button">Girişe dön</button>`;
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
const EMOJIS = ["🏀","🔥","🐐","👑","🦅","🐺","🦁","🐻","🐍","🦈","⚡","🌪️","🎯","💎","🚀","🧊","☄️","🌙","⭐","🍀","🎲","🛡️","🥷","🤖"];
$("#me").onclick=()=>openProfile();
async function saveProfile(patch){
  const me=S.players[S.uid]; const old={...me};
  Object.assign(me, patch); applyTheme(); render(); paintProfile();
  try{ await updateDoc(doc(S.db,"players",S.uid), patch); }
  catch(e){ Object.assign(me, old); applyTheme(); render(); paintProfile(); toast("Kaydedilemedi, tekrar dene."); }
}
function openProfile(){
  openSheet(`<div id="prof"></div>`); paintProfile();
}
function paintProfile(){
  const box=$("#prof"); if(!box) return;
  const me=S.players[S.uid]||{};
  const usedBy = c => S.order.filter(u=>u!==S.uid && S.players[u]?.color===c).map(pname);
  const teams = ALLP?.teams || Object.keys(TEAM_COL).map(a=>({a,n:a}));
  box.innerHTML = `<div class="pf-head">${avatar(S.uid,"lg")}<div><h3 id="shTitle" style="margin:0">${esc(pname(S.uid))}</h3><small class="muted">Profilin herkese böyle görünür</small></div></div>
    <div class="pf-sec"><h4>Rengin</h4><div class="pf-colors">${PKEYS.map(c=>{ const u=usedBy(c); return `<button class="pf-col" data-col="${c}" style="--c:var(--${c})" aria-pressed="${col(S.uid)===`var(--${c})`}" title="${u.length?esc(u.join(", "))+" de kullanıyor":""}">${u.length?"<i></i>":""}</button>`; }).join("")}</div>
      <small class="muted">Noktalı renkleri başka oyuncular da kullanıyor.</small></div>
    <div class="pf-sec"><h4>Avatar</h4><div class="pf-emojis"><button class="pf-emo ini" data-emo="" aria-pressed="${!me.emoji}">${esc(initials(pname(S.uid)))}</button>${EMOJIS.map(e=>`<button class="pf-emo" data-emo="${e}" aria-pressed="${me.emoji===e}">${e}</button>`).join("")}</div></div>
    <div class="pf-sec"><h4>Favori takım</h4><small class="muted">Avatarında logosu görünür. Güvenlik sorusundan bağımsızdır.</small>
      <div class="pf-teams"><button class="pf-tm none" data-tm="" aria-pressed="${!me.favTeam}">Yok</button>${teams.map(t=>`<button class="pf-tm" data-tm="${t.a}" aria-pressed="${me.favTeam===t.a}" title="${esc(t.n)}"><img src="${LOGO_SMALL(t.a)}" alt="${esc(t.n)}"></button>`).join("")}</div></div>
    <div class="pf-sec"><h4>Site renkleri</h4><div class="seg2 pf-theme"><button data-th="default" aria-pressed="${me.theme!=="team"}">Varsayılan</button><button data-th="team" aria-pressed="${me.theme==="team"}" ${me.favTeam?"":"disabled"}>Favori takımım</button></div>
      <small class="muted">${me.favTeam?"Üst alan ve vurgu renkleri takımının renklerine geçer. Yalnızca sende görünür.":"Önce bir favori takım seç."}</small></div>
    <div class="pf-sec"><h4>Hatırlatma maili</h4><small class="muted" style="margin:0 0 8px">Gecenin ilk maçına 2 saat kala eksik tahminin varsa mail gelir. Adresini yalnızca sen görürsün.</small>
      <div class="pf-mail"><input id="pfMail" type="email" inputmode="email" autocomplete="email" placeholder="ornek@gmail.com" value="${esc(S.contact?.email||"")}">
      <label class="pf-sw"><input type="checkbox" id="pfRemind" ${S.contact?.remind?"checked":""}><span></span>Hatırlat</label></div>
      <button class="btn" id="pfMailSave" style="margin-top:8px">Kaydet</button><small class="muted" id="pfMailMsg"></small></div>
    <div class="pf-sec pf-acts"><button class="btn" id="secChange">Güvenlik sorusunu değiştir</button><button class="btn" id="logout">Çıkış yap</button></div>`;
  if(!ALLP) allPlayers().then(()=>paintProfile()).catch(()=>{});
  box.onclick = e => {
    const c=e.target.closest("[data-col]"); if(c) return saveProfile({color:c.dataset.col});
    const m=e.target.closest("[data-emo]"); if(m) return saveProfile({emoji:m.dataset.emo});
    const t=e.target.closest("[data-tm]"); if(t) return saveProfile(t.dataset.tm ? {favTeam:t.dataset.tm} : {favTeam:"", theme:"default"});
    const h=e.target.closest("[data-th]"); if(h && !h.disabled) return saveProfile({theme:h.dataset.th});
  };
  $("#secChange").onclick=()=>openRecoverySheet(false);
  $("#logout").onclick=async()=>{ closeSheet(); S.contact=null; await signOut(S.auth); applyTheme(); };
  if(!S.contact && !S.contactLoading){
    S.contactLoading=true;
    getDoc(doc(S.db,"contacts",S.uid)).then(r=>{ S.contactLoading=false; S.contact = r.exists() ? r.data() : {email:"",remind:false}; if($("#pfMail")){ $("#pfMail").value=S.contact.email||""; $("#pfRemind").checked=!!S.contact.remind; } }).catch(()=>{ S.contactLoading=false; });
  }
  $("#pfMailSave").onclick = async () => {
    const email=$("#pfMail").value.trim(), remind=$("#pfRemind").checked, msg=$("#pfMailMsg");
    if(email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)){ msg.textContent="E-posta adresi geçerli görünmüyor."; return; }
    if(remind && !email){ msg.textContent="Hatırlatma için bir e-posta adresi yaz."; return; }
    $("#pfMailSave").disabled=true;
    try{ await setDoc(doc(S.db,"contacts",S.uid), {email, remind, updatedAt:serverTimestamp()}); S.contact={email,remind}; msg.textContent = remind ? "Kaydedildi. Eksik tahminde mail gelecek." : "Kaydedildi. Hatırlatma kapalı."; }
    catch(e){ msg.textContent="Kaydedilemedi, tekrar dene."; }
    $("#pfMailSave").disabled=false;
  };
}
// Takım teması: üst alan ve vurgu rengi favori takımın renklerine geçer (yalnızca o oyuncuda)
function paintMe(){ const p=S.players[S.uid]||{}; $("#me").innerHTML = p.emoji || esc(pname(S.uid).slice(0,1).toLocaleUpperCase("tr")); $("#me").style.setProperty("--pc", col(S.uid)); $("#me").classList.add("me-btn"); }
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

/* ====================================================== başlangıç */
if("serviceWorker" in navigator && location.protocol==="https:") navigator.serviceWorker.register("sw.js").catch(()=>{});
(async()=>{
  let ok=false;
  try{ ok = await initFirebase(); }catch(e){ console.error(e); }
  if(!ok){ $("#auth").classList.remove("hide"); $("#authForm").innerHTML=`<div class="note">Kurulum bekleniyor: config.json içine Firebase bilgileri girilince oyun açılacak.</div>`; return; }
  S.today = espnToday(); S.day = S.today;
  await Promise.all([loadPlayers().catch(()=>{}), loadArchive().catch(()=>{})]);
  onAuthStateChanged(S.auth, async user=>{
    if(!user){ S.uid=null; $("#app").classList.add("hide"); $("#me").classList.add("hide"); $("#auth").classList.remove("hide"); showResetWait(); return; }
    S.uid=user.uid;
    await loadPlayers().catch(()=>{});
    if(!S.players[S.uid]){ // kayıt yarıda kaldıysa
      await new Promise(r=>setTimeout(r,800)); await loadPlayers().catch(()=>{});
      if(!S.players[S.uid]){ $("#authErr").textContent="Hesap bulunamadı. Tekrar katılmayı dene."; await signOut(S.auth); return; }
    }
    $("#auth").classList.add("hide"); $("#app").classList.remove("hide");
    $("#me").classList.remove("hide"); paintMe(); applyTheme();
    S.statFor=S.uid;
    $("#foot").innerHTML="Kazanan 1 · fark +1 · en skorer +1 · banko 2 / -1 · günün oyuncusu +2<br>Veriler ESPN'den alınır. Maç varken 30 saniyede bir yenilenir.";
    route(); showDay(); refresh();
    checkRecovery();
  });
})();
