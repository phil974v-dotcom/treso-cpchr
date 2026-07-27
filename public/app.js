// ============================================================================
// Trésorerie CPCHR — SaaS (Supabase)
// Toutes les données sont partagées et sécurisées par rôle (RLS côté base).
// Gestion multi-exercices : chaque adhérent, opération, échéance, achat et
// relevé est rattaché à l'exercice sélectionné en haut de page.
// ============================================================================

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const fmt = n => (n < 0 ? '-' : '') + Math.abs(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const compteLabel = c => ({ 'C.Courant': 'Compte Courant', 'C.Hospit': 'Compte Hospitalier', 'Epargne': 'Épargne' }[c] || c);
function escAttr(s){ return String(s).replace(/"/g,'&quot;'); }
function escapeHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function formatDateFr(iso){ if(!iso) return ''; const [y,m,d]=iso.split('-'); return `${d}/${m}/${y}`; }
function dateAddDays(iso, days){ const dt=new Date(iso+'T00:00:00'); dt.setDate(dt.getDate()+days); return dt.toISOString().slice(0,10); }

let currentProfile = null;
let canWrite = false;   // tresorier ou tresorier_adjoint
let isTresorier = false; // tresorier uniquement (gestion des profils/rôles)
let currentMemberId = null;
const selectedMembers = new Set();

let state = { currentExercice: 2026, availableExercices: [2026],
  parametres:{cotisation_permanent:400, cotisation_affilie:219.5},
  forfaits:[], categories:[], categoryRows:[], membres:[], operations:[], releves:[] };

/* ====================== AUTHENTIFICATION ====================== */

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const msg = document.getElementById('login-msg');
  if (!email) { msg.textContent = 'Merci de renseigner votre email.'; return; }
  msg.textContent = 'Envoi en cours...';
  const { error } = await sb.auth.signInWithOtp({ email, options: { emailRedirectTo: window.location.href } });
  msg.textContent = error ? ('Erreur : ' + error.message) : 'Lien envoyé ! Vérifiez votre boîte mail (et vos spams).';
});

document.getElementById('btn-logout').addEventListener('click', async () => {
  await sb.auth.signOut();
  window.location.reload();
});

async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    document.getElementById('login-screen').style.display = 'block';
    document.getElementById('app').style.display = 'none';
    return;
  }

  let { data: profile } = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  if (!profile) {
    await new Promise(r => setTimeout(r, 800));
    const retry = await sb.from('profiles').select('*').eq('id', session.user.id).single();
    profile = retry.data;
  }
  currentProfile = profile;
  canWrite = !!profile && ['tresorier', 'tresorier_adjoint'].includes(profile.role);
  isTresorier = !!profile && profile.role === 'tresorier';

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('user-info').textContent = session.user.email;
  document.getElementById('role-badge').textContent = profile ? roleLabel(profile.role) : 'rôle non défini';

  const years = await loadAvailableExercices();
  state.availableExercices = years.length ? years : [2026];
  state.currentExercice = state.availableExercices[0];

  await refresh();
}

function roleLabel(r) {
  return { tresorier: 'Trésorier', tresorier_adjoint: 'Trésorier adjoint', bureau: 'Bureau (lecture seule)', membre: 'Accès personnel' }[r] || r;
}

sb.auth.onAuthStateChange(() => { boot(); });

/* ====================== EXERCICE ====================== */

async function loadAvailableExercices(){
  const { data } = await sb.from('parametres').select('exercice').order('exercice', { ascending: false });
  return (data || []).map(r => r.exercice);
}

function renderExerciceUI(){
  const sel = document.getElementById('exercice-select');
  sel.innerHTML = state.availableExercices.map(y => `<option value="${y}" ${y===state.currentExercice?'selected':''}>${y}</option>`).join('');
  const y = state.currentExercice, ny = y + 1;
  ['cloture-year-a','cloture-year-b'].forEach(id=>{ document.getElementById(id).textContent = y; });
  document.getElementById('cloture-year-c').textContent = ny;
  document.getElementById('cloture-year-d').textContent = y;
  const btn = document.getElementById('btn-cloture-exercice');
  const exists = state.availableExercices.includes(ny);
  btn.style.display = canWrite ? 'inline-block' : 'none';
  btn.disabled = exists;
  btn.textContent = exists ? `L'exercice ${ny} existe déjà` : `🔒 Clôturer l'exercice ${y} et créer ${ny}`;
}

document.getElementById('exercice-select').addEventListener('change', async e => {
  state.currentExercice = parseInt(e.target.value);
  await refresh();
});

/* ====================== CHARGEMENT DES DONNEES ====================== */

async function loadAll(){
  const ex = state.currentExercice;
  const [membresRes, echeancesRes, achatsRes, forfaitsRes, categoriesRes, operationsRes, relevesRes, parametresRes] = await Promise.all([
    sb.from('membres').select('*').eq('exercice', ex),
    sb.from('echeances').select('*').eq('exercice', ex),
    sb.from('achats').select('*').eq('exercice', ex),
    sb.from('forfaits').select('*'),
    sb.from('categories').select('*').order('label'),
    sb.from('operations').select('*').eq('exercice', ex),
    sb.from('releves').select('*').eq('exercice', ex),
    sb.from('parametres').select('*').eq('exercice', ex).single(),
  ]);

  const achatsAll = achatsRes.data || [];
  const echeancesAll = echeancesRes.data || [];

  const membres = (membresRes.data || []).map(m => ({
    ...m,
    achats: achatsAll.filter(a => a.membre_id === m.id),
    echeancier: Array.from({length:12}, (_,i) => {
      const mois = i+1;
      const e = echeancesAll.find(x => x.membre_id === m.id && x.mois === mois);
      return e ? { mois, valide: e.valide, date: e.date_paiement, montant: e.montant, _id: e.id }
                : { mois, valide: false, date: null, montant: null, _id: null };
    }),
  }));

  const categoryRows = categoriesRes.data || [];

  state.parametres = parametresRes.data || { cotisation_permanent:400, cotisation_affilie:219.5 };
  state.forfaits = forfaitsRes.data || [];
  state.categories = categoryRows.map(c => c.label);
  state.categoryRows = categoryRows;
  state.membres = membres;
  state.operations = operationsRes.data || [];
  state.releves = relevesRes.data || [];
}

async function refresh(){
  await loadAll();
  render();
}

/* ====================== HELPERS METIER ====================== */

function memberName(id){ const m = state.membres.find(x=>x.id===id); return m ? m.nom : '—'; }
function getMember(id){ return state.membres.find(x=>x.id===id); }

function cotisationBase(m){
  if(m.cotisation_override != null && m.cotisation_override !== '') return parseFloat(m.cotisation_override);
  return m.statut === 'Affilié' ? state.parametres.cotisation_affilie : state.parametres.cotisation_permanent;
}
function cotisationAppelee(m){ return cotisationBase(m) - (m.report_n1 || 0); }
function achatsTotal(m){ return (m.achats||[]).reduce((s,a)=>s+a.montant,0); }
function totalDu(m){ return cotisationAppelee(m) + achatsTotal(m); }
function totalVerse(m){
  return state.operations.filter(o=>o.membre_id===m.id && o.montant>0).reduce((s,o)=>s+o.montant,0);
}

function computeTotals(){
  let recettes=0, depenses=0;
  const byCat = {};
  state.operations.forEach(o=>{
    if(o.montant>=0) recettes+=o.montant; else depenses+=o.montant;
    if(!byCat[o.categorie]) byCat[o.categorie]={pos:0,neg:0};
    if(o.montant>=0) byCat[o.categorie].pos += o.montant; else byCat[o.categorie].neg += o.montant;
  });
  return {recettes, depenses, solde: recettes+depenses, byCat};
}

function soldeCompte(compte){
  const releve = state.releves.find(r=>r.compte===compte);
  const ouverture = releve ? releve.solde_debut : 0;
  const mouvements = state.operations.filter(o=>o.compte===compte).reduce((s,o)=>s+o.montant,0);
  return (ouverture||0) + mouvements;
}

/* ====================== NAVIGATION ====================== */
document.getElementById('nav').addEventListener('click', e=>{
  const btn = e.target.closest('button[data-view]');
  if(!btn) return;
  document.querySelectorAll('#nav button').forEach(b=>b.classList.remove('active'));
  btn.classList.add('active');
  document.querySelectorAll('.view').forEach(v=>v.classList.remove('active'));
  document.getElementById('view-'+btn.dataset.view).classList.add('active');
});

function openModal(id){ document.getElementById(id).classList.add('open'); }
function closeModal(id){ document.getElementById(id).classList.remove('open'); }
window.closeModal = closeModal;

/* ====================== DASHBOARD ====================== */
let chartCat, chartCotis;
function renderDashboard(){
  const t = computeTotals();
  document.getElementById('kpi-solde-courant').textContent = fmt(soldeCompte('C.Courant'));
  document.getElementById('kpi-solde-hosp').textContent = fmt(soldeCompte('C.Hospit'));
  document.getElementById('kpi-solde-epargne').textContent = fmt(soldeCompte('Epargne'));
  document.getElementById('solde-header').textContent = 'Exercice '+state.currentExercice+' — Solde Compte Courant : ' + fmt(soldeCompte('C.Courant'));

  const restant = state.membres.reduce((s,m)=>s + Math.max(0, totalDu(m)-totalVerse(m)), 0);
  document.getElementById('kpi-restant').textContent = fmt(restant);

  const recent = [...state.operations].sort((a,b)=> (b.date||'').localeCompare(a.date||'')).slice(0,8);
  document.getElementById('tbody-recent').innerHTML = recent.map(o=>`
    <tr>
      <td>${o.date||''}</td>
      <td>${o.libelle}</td>
      <td><span class="tag">${o.categorie||''}</span></td>
      <td><span class="tag tag-compte">${compteLabel(o.compte)}</span></td>
      <td style="text-align:right" class="${o.montant>=0?'amt-pos':'amt-neg'}">${fmt(o.montant)}</td>
    </tr>`).join('') || '<tr><td colspan="5" class="empty">Aucune opération visible</td></tr>';

  const catTotals = Object.entries(t.byCat).map(([c,v])=>({c, tot:v.pos+v.neg, pos:v.pos, neg:v.neg}));
  catTotals.sort((a,b)=>Math.abs(b.tot)-Math.abs(a.tot));
  const top = catTotals.slice(0,9);
  const rest = catTotals.slice(9);
  if(rest.length){
    top.push({c:'Autres', pos: rest.reduce((s,r)=>s+r.pos,0), neg: rest.reduce((s,r)=>s+r.neg,0)});
  }
  const labels = top.map(x=>(x.c||'').length>28 ? x.c.slice(0,26)+'…' : x.c);
  if(window.Chart){
    if(chartCat) chartCat.destroy();
    chartCat = new Chart(document.getElementById('chart-cat'), {
      type:'bar',
      data:{ labels, datasets:[
        {label:'Recettes', data:top.map(x=>x.pos), backgroundColor:'#2f6f4f'},
        {label:'Dépenses', data:top.map(x=>Math.abs(x.neg)), backgroundColor:'#b5423a'},
      ]},
      options:{ responsive:true, devicePixelRatio:2, plugins:{legend:{position:'bottom'}}, scales:{x:{ticks:{autoSkip:false, maxRotation:60, minRotation:30}}} }
    });

    const enRegle = state.membres.filter(m=>totalVerse(m) >= totalDu(m)).length;
    const enRetard = state.membres.length - enRegle;
    if(chartCotis) chartCotis.destroy();
    chartCotis = new Chart(document.getElementById('chart-cotis'), {
      type:'doughnut',
      data:{ labels:['À jour','En attente'], datasets:[{ data:[enRegle, enRetard], backgroundColor:['#2f6f4f','#b5423a'] }]},
      options:{ responsive:true, devicePixelRatio:2, plugins:{legend:{position:'bottom'}} }
    });
  }
}

/* ====================== OPERATIONS ====================== */
function populateOpFilters(){
  const catSel = document.getElementById('op-filter-cat');
  catSel.innerHTML = '<option value="">Toutes catégories</option>' + state.categories.map(c=>`<option value="${escAttr(c)}">${c}</option>`).join('');
  const mbSel = document.getElementById('op-filter-membre');
  mbSel.innerHTML = '<option value="">Tous les adhérents</option>' + state.membres.map(m=>`<option value="${escAttr(m.id)}">${m.nom}</option>`).join('');
}

function renderOperations(){
  const search = document.getElementById('op-search').value.trim().toLowerCase();
  const fcat = document.getElementById('op-filter-cat').value;
  const fcompte = document.getElementById('op-filter-compte').value;
  const fmb = document.getElementById('op-filter-membre').value;
  let ops = [...state.operations].sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  if(search) ops = ops.filter(o=>(o.libelle||'').toLowerCase().includes(search));
  if(fcat) ops = ops.filter(o=>o.categorie===fcat);
  if(fcompte) ops = ops.filter(o=>o.compte===fcompte);
  if(fmb) ops = ops.filter(o=>o.membre_id===fmb);

  document.getElementById('ops-empty').style.display = ops.length?'none':'block';
  document.getElementById('tbody-ops').innerHTML = ops.map(o=>`
    <tr>
      <td>${o.date||''}</td>
      <td>${o.libelle}</td>
      <td><span class="tag">${o.categorie||''}</span></td>
      <td><span class="tag tag-compte">${compteLabel(o.compte)}</span></td>
      <td>${o.membre_id ? `<span class="link" onclick="openMemberDetail('${escAttr(o.membre_id)}')">${memberName(o.membre_id)}</span>` : '—'}</td>
      <td style="text-align:right" class="${o.montant>=0?'amt-pos':'amt-neg'}">${fmt(o.montant)}</td>
      <td class="checkbox-cell"><input type="checkbox" ${o.pointee?'checked':''} ${canWrite?'':'disabled'} onchange="togglePointee(${o.id})"></td>
      <td class="actions-col">
        ${canWrite ? `<button class="icon-btn" onclick="editOp(${o.id})">✎</button><button class="icon-btn" onclick="deleteOp(${o.id})">🗑</button>` : ''}
      </td>
    </tr>`).join('');
}
document.getElementById('op-search').addEventListener('input', renderOperations);
document.getElementById('op-filter-cat').addEventListener('change', renderOperations);
document.getElementById('op-filter-compte').addEventListener('change', renderOperations);
document.getElementById('op-filter-membre').addEventListener('change', renderOperations);

window.togglePointee = async function(id){
  if(!canWrite) return;
  const o = state.operations.find(x=>x.id===id);
  if(!o) return;
  const { error } = await sb.from('operations').update({ pointee: !o.pointee }).eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};

function populateOpModalSelects(){
  document.getElementById('op-categorie').innerHTML = state.categories.map(c=>`<option value="${escAttr(c)}">${c}</option>`).join('');
  document.getElementById('op-membre').innerHTML = '<option value="">—</option>' + state.membres.map(m=>`<option value="${escAttr(m.id)}">${m.nom}</option>`).join('');
}

document.getElementById('btn-new-op').addEventListener('click', ()=>{
  if(!canWrite) return;
  document.getElementById('modal-op-title').textContent = 'Nouvelle opération';
  document.getElementById('op-id').value = '';
  document.getElementById('op-echeance-membre').value = '';
  document.getElementById('op-echeance-mois').value = '';
  document.getElementById('op-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('op-libelle').value = '';
  document.getElementById('op-montant').value = '';
  document.getElementById('op-compte').value = 'C.Courant';
  document.getElementById('op-pointee').checked = false;
  populateOpModalSelects();
  document.getElementById('op-membre').value = '';
  openModal('modal-op');
});

window.editOp = function(id){
  if(!canWrite) return;
  const o = state.operations.find(x=>x.id===id);
  if(!o) return;
  document.getElementById('modal-op-title').textContent = "Modifier l'opération";
  document.getElementById('op-id').value = o.id;
  document.getElementById('op-echeance-membre').value = '';
  document.getElementById('op-echeance-mois').value = '';
  document.getElementById('op-date').value = o.date||'';
  document.getElementById('op-libelle').value = o.libelle;
  document.getElementById('op-montant').value = o.montant;
  document.getElementById('op-compte').value = o.compte || 'C.Courant';
  document.getElementById('op-pointee').checked = !!o.pointee;
  populateOpModalSelects();
  if(o.categorie && ![...document.getElementById('op-categorie').options].some(opt=>opt.value===o.categorie)){
    const opt = document.createElement('option'); opt.value = o.categorie; opt.textContent = o.categorie;
    document.getElementById('op-categorie').appendChild(opt);
  }
  document.getElementById('op-categorie').value = o.categorie || '';
  document.getElementById('op-membre').value = o.membre_id||'';
  openModal('modal-op');
};

window.deleteOp = async function(id){
  if(!canWrite) return;
  if(!confirm('Supprimer cette opération ?')) return;
  const { error } = await sb.from('operations').delete().eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};

document.getElementById('btn-save-op').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const idVal = document.getElementById('op-id').value;
  const libelle = document.getElementById('op-libelle').value.trim();
  const montant = parseFloat(document.getElementById('op-montant').value);
  if(!libelle || isNaN(montant)){ alert('Merci de renseigner le libellé et le montant.'); return; }
  const payload = {
    date: document.getElementById('op-date').value || null,
    libelle,
    montant,
    compte: document.getElementById('op-compte').value,
    categorie: document.getElementById('op-categorie').value || null,
    membre_id: document.getElementById('op-membre').value || null,
    pointee: document.getElementById('op-pointee').checked,
  };
  let error;
  if(idVal){
    ({ error } = await sb.from('operations').update(payload).eq('id', parseInt(idVal)));
  } else {
    ({ error } = await sb.from('operations').insert({ ...payload, exercice: state.currentExercice }));
  }
  if(error){ alert('Erreur : '+error.message); return; }

  const echMembre = document.getElementById('op-echeance-membre').value;
  const echMois = document.getElementById('op-echeance-mois').value;
  if(echMembre && echMois){
    await sb.from('echeances').upsert({
      membre_id: echMembre, exercice: state.currentExercice, mois: parseInt(echMois), valide: true,
      date_paiement: payload.date, montant: payload.montant,
    }, { onConflict: 'membre_id,exercice,mois' });
  }
  closeModal('modal-op');
  await refresh();
  if(echMembre) openMemberDetail(echMembre);
});

/* ====================== MEMBRES ====================== */
function renderMembres(){
  const search = document.getElementById('mb-search').value.trim().toLowerCase();
  let list = state.membres.slice();
  if(search) list = list.filter(m=>m.nom.toLowerCase().includes(search));
  list.sort((a,b)=>a.nom.localeCompare(b.nom));

  [...selectedMembers].forEach(id=>{ if(!state.membres.some(m=>m.id===id)) selectedMembers.delete(id); });

  document.getElementById('tbody-membres').innerHTML = list.map(m=>{
    const due = totalDu(m), verse = totalVerse(m);
    const diff = due - verse; // >0 reste à payer, <=0 réglé / trop perçu
    const ok = diff <= 0.004;
    const overpaid = diff < -0.004;
    const pct = due>0 ? (verse/due)*100 : (verse>0 ? 100 : 100);
    const barWidth = Math.min(100, Math.max(0,pct));
    const statutClass = m.statut === 'Affilié' ? 'tag-statut-Affilie' : 'tag-statut-Permanent';
    const checked = selectedMembers.has(m.id) ? 'checked' : '';
    return `
    <tr>
      <td class="checkbox-cell"><input type="checkbox" class="mb-select" data-id="${escAttr(m.id)}" ${checked}></td>
      <td><span class="link" onclick="openMemberDetail('${escAttr(m.id)}')">${m.nom}</span></td>
      <td><span class="tag ${statutClass}">${m.statut}</span></td>
      <td>${fmt(cotisationAppelee(m))}</td>
      <td>${fmt(achatsTotal(m))}</td>
      <td><strong>${fmt(due)}</strong></td>
      <td>${fmt(verse)}</td>
      <td style="min-width:120px">
        ${pct.toFixed(0)}% ${ok?'<span class="badge-ok">✓</span>':''}
        <div class="bar ${overpaid?'over':(ok?'':'warn')}"><div style="width:${barWidth}%"></div></div>
      </td>
      <td class="actions-col">
        ${canWrite ? `<button class="icon-btn" onclick="deleteMb('${escAttr(m.id)}')">🗑</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="9" class="empty">Aucun adhérent visible</td></tr>';

  document.getElementById('mb-select-all').checked = list.length>0 && list.every(m=>selectedMembers.has(m.id));
  updateExportWordButton();
  document.getElementById('btn-new-membre').style.display = canWrite ? 'inline-block' : 'none';
}
document.getElementById('mb-search').addEventListener('input', renderMembres);

document.getElementById('tbody-membres').addEventListener('change', e=>{
  const cb = e.target.closest('.mb-select');
  if(!cb) return;
  if(cb.checked) selectedMembers.add(cb.dataset.id); else selectedMembers.delete(cb.dataset.id);
  document.getElementById('mb-select-all').checked = [...document.querySelectorAll('.mb-select')].every(c=>c.checked);
  updateExportWordButton();
});
document.getElementById('mb-select-all').addEventListener('change', e=>{
  document.querySelectorAll('.mb-select').forEach(cb=>{
    cb.checked = e.target.checked;
    if(e.target.checked) selectedMembers.add(cb.dataset.id); else selectedMembers.delete(cb.dataset.id);
  });
  updateExportWordButton();
});
function updateExportWordButton(){
  document.getElementById('btn-export-word').disabled = selectedMembers.size===0;
}

document.getElementById('btn-new-membre').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const nom = prompt('Nom du nouvel adhérent :');
  if(!nom) return;
  const { error } = await sb.from('membres').insert({ id: nom, exercice: state.currentExercice, nom, statut:'Permanent', report_n1:0 });
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
  openMemberDetail(nom);
});

window.deleteMb = async function(id){
  if(!canWrite) return;
  if(!confirm("Supprimer cet adhérent de l'exercice "+state.currentExercice+" ? (ses opérations resteront mais ne seront plus associées ; les autres exercices ne sont pas affectés)")) return;
  const { error } = await sb.from('membres').delete().eq('id', id).eq('exercice', state.currentExercice);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};

window.openMemberDetail = function(id){
  currentMemberId = id;
  const m = getMember(id);
  if(!m) return;
  document.getElementById('modal-mb-title').textContent = m.nom;
  document.getElementById('mb-id').value = m.id;
  document.getElementById('mb-nom').value = m.nom;
  document.getElementById('mb-statut').value = m.statut;
  document.getElementById('mb-report').value = m.report_n1;
  document.getElementById('mb-override').value = m.cotisation_override != null ? m.cotisation_override : '';
  ['mb-nom','mb-statut','mb-report','mb-override'].forEach(id2=>{ document.getElementById(id2).disabled = !canWrite; });
  document.getElementById('btn-save-mb').style.display = canWrite ? 'inline-block' : 'none';
  document.getElementById('mb-achats-toolbar').style.display = canWrite ? 'flex' : 'none';
  document.getElementById('mb-mensualise-toggle').style.pointerEvents = canWrite ? 'auto' : 'none';
  document.getElementById('mb-mensualite').disabled = !canWrite;

  renderMemberRecap(m);
  renderMemberAchats(m);
  renderMemberForfaitSelect();
  renderMemberMensualisation(m);
  renderMemberVersements(m);
  openModal('modal-mb');
};

function renderMemberRecap(m){
  const base = cotisationBase(m);
  const appelee = cotisationAppelee(m);
  const achats = achatsTotal(m);
  const due = totalDu(m);
  const verse = totalVerse(m);
  const diff = due - verse;
  const label = diff <= 0.004 ? 'Trop perçu' : 'Reste à payer';
  const amount = Math.abs(diff);
  const pct = due>0 ? (verse/due*100) : (verse>0?100:100);
  document.getElementById('mb-recap').innerHTML = `
    Cotisation de base (${m.statut}) : <strong>${fmt(base)}</strong> —
    Report N-1 : <strong>${fmt(m.report_n1||0)}</strong> →
    Cotisation appelée : <strong>${fmt(appelee)}</strong><br>
    Achats/forfaits : <strong>${fmt(achats)}</strong> —
    Total dû : <strong>${fmt(due)}</strong> —
    Versé : <strong>${fmt(verse)}</strong> —
    ${label} : <strong class="${diff<=0.004?'badge-ok':'badge-warn'}">${fmt(amount)}</strong>
    (${pct.toFixed(0)}% réglé)`;
}

function renderMemberAchats(m){
  document.getElementById('mb-achats-list').innerHTML = (m.achats||[]).map(a=>`
    <div class="mini-row">
      <span style="flex:1">${a.nom}</span>
      <span style="width:90px; text-align:right">${fmt(a.montant)}</span>
      ${canWrite ? `<button class="icon-btn" onclick="deleteAchat(${a.id})">🗑</button>` : ''}
    </div>`).join('') || '<div class="small">Aucun achat enregistré.</div>';
}

function renderMemberForfaitSelect(){
  const sel = document.getElementById('mb-new-achat-forfait');
  sel.innerHTML = state.forfaits.map(f=>`<option value="${f.id}">${escapeHtml(f.nom)} (${fmt(f.montant)})</option>`).join('')
    + '<option value="__autre__">Autre (préciser)</option>';
  sel.onchange = ()=>{
    const isAutre = sel.value === '__autre__';
    document.getElementById('mb-new-achat-nom').style.display = isAutre ? 'block' : 'none';
    const f = state.forfaits.find(x=>String(x.id)===sel.value);
    document.getElementById('mb-new-achat-montant').value = f ? f.montant : '';
  };
  sel.onchange();
}

document.getElementById('btn-add-achat').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const m = getMember(currentMemberId);
  if(!m) return;
  const sel = document.getElementById('mb-new-achat-forfait');
  const montant = parseFloat(document.getElementById('mb-new-achat-montant').value);
  if(isNaN(montant)){ alert('Merci de renseigner un montant.'); return; }
  let nom;
  if(sel.value === '__autre__'){
    nom = document.getElementById('mb-new-achat-nom').value.trim();
    if(!nom){ alert("Merci de préciser le nom de l'achat."); return; }
  } else {
    const f = state.forfaits.find(x=>String(x.id)===sel.value);
    nom = f ? f.nom : 'Achat';
  }
  const { error } = await sb.from('achats').insert({ membre_id: m.id, exercice: state.currentExercice, nom, montant, date: new Date().toISOString().slice(0,10) });
  if(error){ alert('Erreur : '+error.message); return; }
  await loadAll();
  const mm = getMember(currentMemberId);
  renderMemberRecap(mm); renderMemberAchats(mm);
  renderMembres();
});

window.deleteAchat = async function(achatId){
  if(!canWrite) return;
  const { error } = await sb.from('achats').delete().eq('id', achatId);
  if(error){ alert('Erreur : '+error.message); return; }
  await loadAll();
  const mm = getMember(currentMemberId);
  renderMemberRecap(mm); renderMemberAchats(mm);
  renderMembres();
};

function renderMemberMensualisation(m){
  const toggle = document.getElementById('mb-mensualise-toggle');
  [...toggle.children].forEach(b=>b.classList.toggle('active', (b.dataset.val==='1') === !!m.mensualise));
  document.getElementById('mb-mensualite').value = m.mensualite || '';
  renderEcheancier(m);
}
document.getElementById('mb-mensualise-toggle').addEventListener('click', async (e)=>{
  if(!canWrite) return;
  const btn = e.target.closest('button');
  if(!btn) return;
  const m = getMember(currentMemberId);
  if(!m) return;
  const mensualise = btn.dataset.val === '1';
  const { error } = await sb.from('membres').update({ mensualise }).eq('id', m.id).eq('exercice', state.currentExercice);
  if(error){ alert('Erreur : '+error.message); return; }
  await loadAll();
  const mm = getMember(currentMemberId);
  [...document.getElementById('mb-mensualise-toggle').children].forEach(b=>b.classList.toggle('active', b===btn));
  renderEcheancier(mm);
});
document.getElementById('mb-mensualite').addEventListener('change', async (e)=>{
  if(!canWrite) return;
  const m = getMember(currentMemberId);
  if(!m) return;
  const mensualite = parseFloat(e.target.value) || 0;
  const { error } = await sb.from('membres').update({ mensualite }).eq('id', m.id).eq('exercice', state.currentExercice);
  if(error){ alert('Erreur : '+error.message); return; }
  await loadAll();
  renderEcheancier(getMember(currentMemberId));
});

const MOIS_LABELS = ['Jan','Fév','Mar','Avr','Mai','Juin','Juil','Août','Sep','Oct','Nov','Déc'];
function renderEcheancier(m){
  const el = document.getElementById('mb-echeancier');
  if(!m.mensualise){ el.innerHTML = "<div class=\"small\">Activez la mensualisation pour générer l'échéancier.</div>"; return; }
  el.innerHTML = m.echeancier.map(e=>`
    <div class="month-cell ${e.valide?'valide':''}">
      <div class="m-label">${MOIS_LABELS[e.mois-1]} — ${fmt(m.mensualite||0)}</div>
      ${e.valide
        ? `<div class="small">✓ Payé le ${e.date||''}</div>`
        : (canWrite ? `<button class="btn small secondary" onclick="validerEcheance('${escAttr(m.id)}',${e.mois})">Valider le paiement</button>` : '<div class="small">En attente</div>')}
    </div>`).join('');
}
window.validerEcheance = function(memberId, mois){
  if(!canWrite) return;
  const m = getMember(memberId);
  document.getElementById('modal-op-title').textContent = 'Nouvelle opération';
  document.getElementById('op-id').value = '';
  document.getElementById('op-date').value = new Date().toISOString().slice(0,10);
  document.getElementById('op-libelle').value = 'Mensualité cotisation — ' + m.nom;
  document.getElementById('op-montant').value = m.mensualite || 0;
  document.getElementById('op-compte').value = 'C.Courant';
  document.getElementById('op-pointee').checked = false;
  populateOpModalSelects();
  const catGuess = state.categories.find(c=>/cotisation/i.test(c)) || state.categories[0];
  if(catGuess) document.getElementById('op-categorie').value = catGuess;
  document.getElementById('op-membre').value = m.id;
  document.getElementById('op-echeance-membre').value = memberId;
  document.getElementById('op-echeance-mois').value = mois;
  openModal('modal-op');
};

function renderMemberVersements(m){
  const ops = state.operations.filter(o=>o.membre_id===m.id).sort((a,b)=>(b.date||'').localeCompare(a.date||''));
  document.getElementById('mb-versements').innerHTML = ops.map(o=>`
    <tr>
      <td>${o.date||''}</td><td>${o.libelle}</td><td><span class="tag">${o.categorie||''}</span></td>
      <td style="text-align:right" class="${o.montant>=0?'amt-pos':'amt-neg'}">${fmt(o.montant)}</td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">Aucun versement enregistré</td></tr>';
}

document.getElementById('btn-save-mb').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const m = getMember(currentMemberId);
  if(!m) return;
  const ov = document.getElementById('mb-override').value;
  const payload = {
    nom: document.getElementById('mb-nom').value.trim() || m.nom,
    statut: document.getElementById('mb-statut').value,
    report_n1: parseFloat(document.getElementById('mb-report').value) || 0,
    cotisation_override: ov === '' ? null : parseFloat(ov),
  };
  const { error } = await sb.from('membres').update(payload).eq('id', currentMemberId).eq('exercice', state.currentExercice);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
  closeModal('modal-mb');
});

/* ====================== RELEVES ====================== */
function renderReleves(){
  const list = [...state.releves].sort((a,b)=>(a.compte||'').localeCompare(b.compte||'') || (a.date_debut||'').localeCompare(b.date_debut||''));
  document.getElementById('tbody-releves').innerHTML = list.map(r=>{
    const mvts = state.operations.filter(o=>o.compte===r.compte && o.pointee &&
      (!r.date_debut || (o.date||'') >= r.date_debut) && (!r.date_fin || (o.date||'') <= r.date_fin)
    ).reduce((s,o)=>s+o.montant,0);
    const calcule = (r.solde_debut||0) + mvts;
    const ecart = r.solde_fin != null ? (r.solde_fin - calcule) : null;
    return `
    <tr>
      <td><span class="tag tag-compte">${compteLabel(r.compte)}</span></td>
      <td>${r.date_debut||'?'} → ${r.date_fin||'en cours'}</td>
      <td>${fmt(r.solde_debut)}</td>
      <td>${r.solde_fin != null ? fmt(r.solde_fin) : '<span class="small">non renseigné</span>'}</td>
      <td>${fmt(calcule)}</td>
      <td>${ecart == null ? '—' : `<span class="${Math.abs(ecart)<0.01?'badge-ok':'badge-warn'}">${fmt(ecart)}</span>`}</td>
      <td class="actions-col">
        ${canWrite ? `<button class="icon-btn" onclick="editReleve(${r.id})">✎</button><button class="icon-btn" onclick="deleteReleve(${r.id})">🗑</button>` : ''}
      </td>
    </tr>`;
  }).join('') || '<tr><td colspan="7" class="empty">Aucun relevé enregistré</td></tr>';
  document.getElementById('btn-new-releve').style.display = canWrite ? 'inline-block' : 'none';
}

document.getElementById('btn-new-releve').addEventListener('click', ()=>{
  if(!canWrite) return;
  document.getElementById('rl-id').value = '';
  document.getElementById('rl-compte').value = 'C.Courant';
  document.getElementById('rl-debut').value = '';
  document.getElementById('rl-fin').value = '';
  document.getElementById('rl-solde-debut').value = '';
  document.getElementById('rl-solde-fin').value = '';
  openModal('modal-releve');
});
window.editReleve = function(id){
  if(!canWrite) return;
  const r = state.releves.find(x=>x.id===id);
  if(!r) return;
  document.getElementById('rl-id').value = r.id;
  document.getElementById('rl-compte').value = r.compte;
  document.getElementById('rl-debut').value = r.date_debut || '';
  document.getElementById('rl-fin').value = r.date_fin || '';
  document.getElementById('rl-solde-debut').value = r.solde_debut;
  document.getElementById('rl-solde-fin').value = r.solde_fin != null ? r.solde_fin : '';
  openModal('modal-releve');
};
window.deleteReleve = async function(id){
  if(!canWrite) return;
  if(!confirm('Supprimer ce relevé ?')) return;
  const { error } = await sb.from('releves').delete().eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};
document.getElementById('btn-save-releve').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const idVal = document.getElementById('rl-id').value;
  const payload = {
    compte: document.getElementById('rl-compte').value,
    date_debut: document.getElementById('rl-debut').value || null,
    date_fin: document.getElementById('rl-fin').value || null,
    solde_debut: parseFloat(document.getElementById('rl-solde-debut').value) || 0,
    solde_fin: document.getElementById('rl-solde-fin').value === '' ? null : parseFloat(document.getElementById('rl-solde-fin').value),
  };
  let error;
  if(idVal){
    ({ error } = await sb.from('releves').update(payload).eq('id', parseInt(idVal)));
  } else {
    ({ error } = await sb.from('releves').insert({ ...payload, exercice: state.currentExercice }));
  }
  if(error){ alert('Erreur : '+error.message); return; }
  closeModal('modal-releve');
  await refresh();
});

/* ====================== PARAMETRES ====================== */
function renderParametres(){
  document.getElementById('param-cotis-permanent').value = state.parametres.cotisation_permanent;
  document.getElementById('param-cotis-affilie').value = state.parametres.cotisation_affilie;
  ['param-cotis-permanent','param-cotis-affilie'].forEach(id=>{ document.getElementById(id).disabled = !canWrite; });
  document.getElementById('btn-save-params').style.display = canWrite ? 'inline-block' : 'none';

  document.getElementById('forfaits-list').innerHTML = state.forfaits.map(f=>`
    <div class="mini-row">
      <input type="text" value="${escAttr(f.nom)}" ${canWrite?'':'disabled'} onchange="updateForfait(${f.id},'nom',this.value)">
      <input type="number" step="0.01" style="width:100px" value="${f.montant}" ${canWrite?'':'disabled'} onchange="updateForfait(${f.id},'montant',this.value)">
      ${canWrite ? `<button class="icon-btn" onclick="deleteForfait(${f.id})">🗑</button>` : ''}
    </div>`).join('');
  document.getElementById('btn-add-forfait').style.display = canWrite ? 'inline-block' : 'none';

  document.getElementById('categories-list').innerHTML = state.categoryRows.map(c=>`
    <div class="mini-row">
      <input type="text" value="${escAttr(c.label)}" ${canWrite?'':'disabled'} onchange="updateCategorie(${c.id},this.value)">
      ${canWrite ? `<button class="icon-btn" onclick="deleteCategorie(${c.id})">🗑</button>` : ''}
    </div>`).join('');
  document.getElementById('btn-add-cat').style.display = canWrite ? 'inline-block' : 'none';

  renderProfiles();
}

document.getElementById('btn-save-params').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const payload = {
    cotisation_permanent: parseFloat(document.getElementById('param-cotis-permanent').value) || 0,
    cotisation_affilie: parseFloat(document.getElementById('param-cotis-affilie').value) || 0,
  };
  const { error } = await sb.from('parametres').update(payload).eq('exercice', state.currentExercice);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
});

window.updateForfait = async function(id, field, value){
  if(!canWrite) return;
  const payload = { [field]: field==='montant' ? (parseFloat(value)||0) : value };
  const { error } = await sb.from('forfaits').update(payload).eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};
window.deleteForfait = async function(id){
  if(!canWrite) return;
  if(!confirm('Supprimer ce forfait ?')) return;
  const { error } = await sb.from('forfaits').delete().eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};
document.getElementById('btn-add-forfait').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const nom = document.getElementById('new-forfait-nom').value.trim();
  const montant = parseFloat(document.getElementById('new-forfait-montant').value) || 0;
  if(!nom){ alert('Merci de renseigner un nom.'); return; }
  const { error } = await sb.from('forfaits').insert({ nom, montant });
  if(error){ alert('Erreur : '+error.message); return; }
  document.getElementById('new-forfait-nom').value = '';
  document.getElementById('new-forfait-montant').value = '';
  await refresh();
});

window.updateCategorie = async function(id, value){
  if(!canWrite) return;
  const { error } = await sb.from('categories').update({ label: value }).eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};
window.deleteCategorie = async function(id){
  if(!canWrite) return;
  if(!confirm('Supprimer cette catégorie ?')) return;
  const { error } = await sb.from('categories').delete().eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  await refresh();
};
document.getElementById('btn-add-cat').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const nom = document.getElementById('new-cat-nom').value.trim();
  if(!nom){ return; }
  const { error } = await sb.from('categories').insert({ label: nom });
  if(error){ alert('Erreur : '+error.message); return; }
  document.getElementById('new-cat-nom').value = '';
  await refresh();
});

/* ---------- Utilisateurs & rôles ---------- */
async function renderProfiles(){
  const tbody = document.getElementById('tbody-profiles');
  if(!isTresorier){
    tbody.innerHTML = '<tr><td colspan="4" class="small">Réservé au trésorier.</td></tr>';
    return;
  }
  const { data: profiles, error } = await sb.from('profiles').select('*').order('created_at');
  if(error){ tbody.innerHTML = `<tr><td colspan="4" class="small">Erreur : ${error.message}</td></tr>`; return; }
  const roleOptions = ['tresorier','tresorier_adjoint','bureau','membre'];
  tbody.innerHTML = (profiles||[]).map(p=>`
    <tr>
      <td>${escapeHtml(p.nom||'')}</td>
      <td><input type="text" value="${escAttr(p.nom||'')}" onchange="updateProfile('${p.id}','nom',this.value)" style="width:140px"></td>
      <td>
        <select onchange="updateProfile('${p.id}','role',this.value)">
          ${roleOptions.map(r=>`<option value="${r}" ${p.role===r?'selected':''}>${roleLabel(r)}</option>`).join('')}
        </select>
      </td>
      <td>
        <select onchange="updateProfile('${p.id}','membre_id',this.value)">
          <option value="">—</option>
          ${state.membres.map(m=>`<option value="${escAttr(m.id)}" ${p.membre_id===m.id?'selected':''}>${m.nom}</option>`).join('')}
        </select>
      </td>
    </tr>`).join('') || '<tr><td colspan="4" class="empty">Aucun utilisateur</td></tr>';
}
window.updateProfile = async function(id, field, value){
  if(!isTresorier) return;
  const payload = { [field]: value === '' ? null : value };
  const { error } = await sb.from('profiles').update(payload).eq('id', id);
  if(error){ alert('Erreur : '+error.message); return; }
  renderProfiles();
};

/* ====================== EXPORT WORD (situation adhérents) ====================== */
function rtfEscape(str){
  return String(str==null?'':str).replace(/[\\{}]/g, m => '\\'+m).replace(/[\u0080-\uffff]/g, c => '\\u'+c.charCodeAt(0)+'?');
}

function buildAndDownloadWord(memberIds, filename){
  const members = state.membres.filter(m=>memberIds.includes(m.id)).sort((a,b)=>a.nom.localeCompare(b.nom));
  if(!members.length) return;
  const dateEdition = new Date().toLocaleDateString('fr-FR');

  let body = '';
  members.forEach((m, idx)=>{
    const base = cotisationBase(m);
    const appelee = cotisationAppelee(m);
    const achats = achatsTotal(m);
    const due = totalDu(m);
    const verse = totalVerse(m);
    const diff = due - verse;
    const label = diff <= 0.004 ? 'Trop perçu' : 'Reste à payer';
    const amount = Math.abs(diff);
    const pct = due>0 ? (verse/due)*100 : (verse>0?100:100);
    const versements = state.operations.filter(o=>o.membre_id===m.id).sort((a,b)=>(a.date||'').localeCompare(b.date||''));

    body += `{\\pard\\qc\\b\\fs28 ${rtfEscape('Situation individuelle')}\\b0\\fs22\\par}`;
    body += `{\\pard\\qc ${rtfEscape('Exercice '+state.currentExercice+' — Édité le ' + dateEdition)}\\par\\par}`;
    body += `{\\pard\\b\\fs26 ${rtfEscape(m.nom)}\\b0\\fs22\\par}`;
    body += `{\\pard ${rtfEscape('Statut : ' + m.statut)}\\par\\par}`;

    body += `{\\pard\\b ${rtfEscape('Cotisation')}\\b0\\par}`;
    body += `{\\pard ${rtfEscape('Cotisation de base : ' + fmt(base))}\\par}`;
    body += `{\\pard ${rtfEscape('Solde reporté N-1 : ' + fmt(m.report_n1||0))}\\par}`;
    body += `{\\pard ${rtfEscape('Cotisation appelée : ' + fmt(appelee))}\\par\\par}`;

    body += `{\\pard\\b ${rtfEscape('Achats / forfaits')}\\b0\\par}`;
    if(m.achats && m.achats.length){
      m.achats.forEach(a=>{ body += `{\\pard  - ${rtfEscape(a.nom + ' : ' + fmt(a.montant))}\\par}`; });
    } else {
      body += `{\\pard  ${rtfEscape('Aucun achat enregistré')}\\par}`;
    }
    body += `{\\pard ${rtfEscape('Total achats : ' + fmt(achats))}\\par\\par}`;

    body += `{\\pard\\b ${rtfEscape('Récapitulatif')}\\b0\\par}`;
    body += `{\\pard\\b ${rtfEscape('Total dû : ' + fmt(due))}\\b0\\par}`;
    body += `{\\pard ${rtfEscape('Total versé : ' + fmt(verse))}\\par}`;
    body += `{\\pard\\b ${rtfEscape(label + ' : ' + fmt(amount) + '  (' + pct.toFixed(0) + '% réglé)')}\\b0\\par\\par}`;

    body += `{\\pard\\b ${rtfEscape('Détail des versements')}\\b0\\par}`;
    if(versements.length){
      versements.forEach(o=>{
        body += `{\\pard  ${rtfEscape((o.date||'?') + ' — ' + o.libelle + ' — ' + fmt(o.montant))}\\par}`;
      });
    } else {
      body += `{\\pard  ${rtfEscape('Aucun versement enregistré')}\\par}`;
    }

    if(idx < members.length-1) body += '\\page ';
  });

  const rtf = `{\\rtf1\\ansi\\ansicpg1252\\deff0{\\fonttbl{\\f0 Calibri;}}\\f0\\fs22 ${body}}`;
  const blob = new Blob([rtf], {type:'application/rtf'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
}

document.getElementById('btn-export-word').addEventListener('click', ()=>{
  buildAndDownloadWord([...selectedMembers], 'situation-adherents-'+new Date().toISOString().slice(0,10)+'.rtf');
});

/* ====================== EXPORT EXCEL — RECAP RECETTES/DEPENSES ====================== */
document.getElementById('recap-periode').addEventListener('change', e=>{
  document.getElementById('recap-date').style.display = e.target.value==='intermediaire' ? 'inline-block' : 'none';
});

function buildAndDownloadRecap(compte, periode, dateInterm){
  const exercice = state.currentExercice;
  const dateDebut = exercice + '-01-01';
  let dateFin = exercice + '-12-31';
  let labelFin = '31/12/' + exercice;
  if(periode === 'intermediaire'){
    dateFin = dateInterm || new Date().toISOString().slice(0,10);
    labelFin = formatDateFr(dateFin);
  }

  const releve = state.releves.find(r=>r.compte===compte);
  const soldeN1 = releve ? (releve.solde_debut||0) : 0;
  const releveLabelN1 = releve && releve.date_debut ? formatDateFr(dateAddDays(releve.date_debut,-1)) : ('31/12/' + (exercice-1));

  const ops = state.operations.filter(o=>o.compte===compte && (o.date||'') >= dateDebut && (o.date||'') <= dateFin);
  const recettesByCat = {};
  const depensesByCat = {};
  let totalRecettes = 0, totalDepenses = 0;
  ops.forEach(o=>{
    const cat = o.categorie || 'Autres';
    if(o.montant >= 0){
      recettesByCat[cat] = (recettesByCat[cat]||0) + o.montant;
      totalRecettes += o.montant;
    } else {
      depensesByCat[cat] = (depensesByCat[cat]||0) + Math.abs(o.montant);
      totalDepenses += Math.abs(o.montant);
    }
  });
  const soldeFin = soldeN1 + totalRecettes - totalDepenses;

  const recKeys = Object.keys(recettesByCat).sort();
  const depKeys = Object.keys(depensesByCat).sort();
  const maxRows = Math.max(recKeys.length, depKeys.length, 1);

  let rows = '';
  for(let i=0;i<maxRows;i++){
    const rk = recKeys[i], dk = depKeys[i];
    rows += `<tr>
      <td style="border:1px solid #999;padding:4px 8px">${rk?escapeHtml(rk):''}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right">${rk?fmt(recettesByCat[rk]):''}</td>
      <td style="border:none"></td>
      <td style="border:1px solid #999;padding:4px 8px">${dk?escapeHtml(dk):''}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right">${dk?fmt(depensesByCat[dk]):''}</td>
    </tr>`;
  }

  const html = `<table style="border-collapse:collapse;font-family:Calibri,Arial,sans-serif;font-size:12px">
    <tr>
      <td colspan="2" style="background:#1f2937;color:#fff;font-weight:bold;padding:6px 8px;border:1px solid #999">Recettes ${exercice}</td>
      <td style="border:none"></td>
      <td colspan="2" style="background:#1f2937;color:#fff;font-weight:bold;padding:6px 8px;border:1px solid #999">Dépenses ${exercice}${periode==='intermediaire' ? ' (au '+escapeHtml(labelFin)+')' : ''}</td>
    </tr>
    ${rows}
    <tr>
      <td style="border:1px solid #999;padding:4px 8px;font-weight:bold;background:#d9d9d9">Total</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;font-weight:bold;background:#d9d9d9">${fmt(totalRecettes)}</td>
      <td style="border:none"></td>
      <td style="border:1px solid #999;padding:4px 8px;font-weight:bold;background:#d9d9d9"></td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;font-weight:bold;background:#d9d9d9">${fmt(totalDepenses)}</td>
    </tr>
    <tr><td colspan="5" style="border:none">&nbsp;</td></tr>
    <tr>
      <td style="border:1px solid #999;padding:4px 8px;background:#e6e6e6">Solde trésorerie ${escapeHtml(releveLabelN1)}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;background:#e6e6e6">${fmt(soldeN1)}</td>
      <td colspan="3" style="border:none"></td>
    </tr>
    <tr>
      <td style="border:1px solid #999;padding:4px 8px;background:#ffff00;font-weight:bold">Solde trésorerie ${escapeHtml(labelFin)}</td>
      <td style="border:1px solid #999;padding:4px 8px;text-align:right;background:#ffff00;font-weight:bold">${fmt(soldeFin)}</td>
      <td colspan="3" style="border:none"></td>
    </tr>
  </table>`;

  const fullHtml = `<html><head><meta charset="UTF-8"></head><body>${html}</body></html>`;
  const blob = new Blob(['\uFEFF'+fullHtml], {type:'application/vnd.ms-excel'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'recap-'+compte+'-'+exercice+'-'+dateFin+'.xls';
  a.click();
}

document.getElementById('btn-export-recap').addEventListener('click', ()=>{
  const compte = document.getElementById('recap-compte').value;
  const periode = document.getElementById('recap-periode').value;
  const dateInterm = document.getElementById('recap-date').value;
  buildAndDownloadRecap(compte, periode, dateInterm);
});

function buildAndDownloadCsv(){
  const rows = [['Date','Libelle','Categorie','Compte','Adherent','Montant','Pointee']];
  state.operations.forEach(o=> rows.push([o.date, o.libelle, o.categorie, o.compte, memberName(o.membre_id), o.montant, o.pointee?'Oui':'Non']));
  const csv = rows.map(r=>r.map(v=>`"${String(v??'').replace(/"/g,'""')}"`).join(';')).join('\n');
  const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'operations-cpchr-'+state.currentExercice+'-'+new Date().toISOString().slice(0,10)+'.csv';
  a.click();
}
document.getElementById('btn-export-csv').addEventListener('click', buildAndDownloadCsv);

/* ====================== CLOTURE D'EXERCICE ====================== */
document.getElementById('btn-cloture-exercice').addEventListener('click', async ()=>{
  if(!canWrite) return;
  const year = state.currentExercice;
  const nextYear = year + 1;
  if(state.availableExercices.includes(nextYear)){ alert("L'exercice "+nextYear+" existe déjà."); return; }
  if(!confirm(`Clôturer l'exercice ${year} ?\n\nUne sauvegarde complète va être téléchargée automatiquement (opérations CSV, récapitulatifs Excel des 3 comptes, situations Word de tous les adhérents), puis l'exercice ${nextYear} sera créé avec les soldes reportés.`)) return;

  const btn = document.getElementById('btn-cloture-exercice');
  btn.disabled = true; btn.textContent = 'Clôture en cours...';

  buildAndDownloadWord(state.membres.map(m=>m.id), 'situations-adherents-'+year+'.rtf');
  ['C.Courant','C.Hospit','Epargne'].forEach(c=> buildAndDownloadRecap(c, 'annee'));
  buildAndDownloadCsv();

  const nextMembres = state.membres.map(m=>({
    id: m.id, exercice: nextYear, nom: m.nom, statut: m.statut,
    report_n1: totalVerse(m) - totalDu(m),
    cotisation_override: m.cotisation_override,
    mensualise: m.mensualise, mensualite: m.mensualite,
  }));
  const nextReleves = ['C.Courant','C.Hospit','Epargne'].map(compte=>({
    exercice: nextYear, compte,
    date_debut: nextYear+'-01-01', date_fin: null,
    solde_debut: soldeCompte(compte), solde_fin: null,
  }));

  let error;
  if(nextMembres.length){
    ({ error } = await sb.from('membres').insert(nextMembres));
    if(error){ alert('Erreur lors de la création des adhérents '+nextYear+' : '+error.message); renderExerciceUI(); return; }
  }
  ({ error } = await sb.from('releves').insert(nextReleves));
  if(error){ alert('Erreur lors de la création des relevés '+nextYear+' : '+error.message); renderExerciceUI(); return; }
  ({ error } = await sb.from('parametres').insert({
    exercice: nextYear,
    cotisation_permanent: state.parametres.cotisation_permanent,
    cotisation_affilie: state.parametres.cotisation_affilie,
  }));
  if(error){ alert('Erreur lors de la création des paramètres '+nextYear+' : '+error.message); renderExerciceUI(); return; }

  state.availableExercices = [nextYear, ...state.availableExercices];
  state.currentExercice = nextYear;
  await refresh();
  alert('Exercice '+nextYear+' créé avec les soldes reportés. Les fichiers de sauvegarde de '+year+' ont été téléchargés.');
});

/* ====================== INIT ====================== */
function render(){
  renderExerciceUI();
  populateOpFilters();
  renderDashboard();
  renderOperations();
  renderMembres();
  renderReleves();
  renderParametres();
}

boot();
