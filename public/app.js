// ============================================================================
// Trésorerie CPCHR — starter SaaS (Supabase)
// ============================================================================

const sb = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const fmt = n => (n < 0 ? '-' : '') + Math.abs(n || 0).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
const compteLabel = c => ({ 'C.Courant': 'Compte Courant', 'C.Hospit': 'Compte Hospitalier', 'Epargne': 'Épargne' }[c] || c);

let currentProfile = null;

document.getElementById('btn-login').addEventListener('click', async () => {
  const email = document.getElementById('login-email').value.trim();
  const msg = document.getElementById('login-msg');
  if (!email) { msg.textContent = 'Merci de renseigner votre email.'; return; }
  msg.textContent = 'Envoi en cours...';
  const { error } = await sb.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.href }
  });
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

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app').style.display = 'block';
  document.getElementById('user-info').textContent = session.user.email;
  document.getElementById('role-badge').textContent = profile ? roleLabel(profile.role) : 'rôle non défini';

  const canWrite = profile && ['tresorier', 'tresorier_adjoint'].includes(profile.role);
  document.getElementById('btn-new-op').style.display = canWrite ? 'inline-block' : 'none';
  document.getElementById('new-op-panel').style.display = 'none';

  await loadDashboard();
  await loadOperations();
  await loadMembres();
  if (canWrite) await populateOpForm();
}

function roleLabel(r) {
  return { tresorier: 'Trésorier', tresorier_adjoint: 'Trésorier adjoint', bureau: 'Bureau (lecture seule)', membre: 'Accès personnel' }[r] || r;
}

sb.auth.onAuthStateChange((_event, _session) => { boot(); });

async function loadDashboard() {
  const { data: releves } = await sb.from('releves').select('*');
  const { data: ops } = await sb.from('operations').select('compte, montant');
  const soldeParCompte = { 'C.Courant': 0, 'C.Hospit': 0, 'Epargne': 0 };
  (releves || []).forEach(r => { soldeParCompte[r.compte] = (soldeParCompte[r.compte] || 0) + (r.solde_debut || 0); });
  (ops || []).forEach(o => { soldeParCompte[o.compte] = (soldeParCompte[o.compte] || 0) + (o.montant || 0); });
  document.getElementById('kpi-courant').textContent = fmt(soldeParCompte['C.Courant']);
  document.getElementById('kpi-hosp').textContent = fmt(soldeParCompte['C.Hospit']);
  document.getElementById('kpi-epargne').textContent = fmt(soldeParCompte['Epargne']);
}

async function loadOperations() {
  const { data: ops, error } = await sb.from('operations').select('*').order('date', { ascending: false }).limit(50);
  const { data: membres } = await sb.from('membres').select('id, nom');
  const nameOf = id => (membres || []).find(m => m.id === id)?.nom || '—';
  const tbody = document.getElementById('tbody-ops');
  if (error) { tbody.innerHTML = `<tr><td colspan="6" class="small">Erreur de lecture : ${error.message}</td></tr>`; return; }
  tbody.innerHTML = (ops || []).map(o => `
    <tr>
      <td>${o.date || ''}</td>
      <td>${o.libelle}</td>
      <td><span class="tag">${o.categorie || ''}</span></td>
      <td><span class="tag">${compteLabel(o.compte)}</span></td>
      <td>${o.membre_id ? nameOf(o.membre_id) : '—'}</td>
      <td style="text-align:right" class="${o.montant >= 0 ? 'amt-pos' : 'amt-neg'}">${fmt(o.montant)}</td>
    </tr>`).join('') || '<tr><td colspan="6" class="small">Aucune opération visible avec votre rôle.</td></tr>';
}

async function loadMembres() {
  const { data: membres, error } = await sb.from('membres').select('*').order('nom');
  const tbody = document.getElementById('tbody-membres');
  if (error) { tbody.innerHTML = `<tr><td colspan="3" class="small">Erreur de lecture : ${error.message}</td></tr>`; return; }
  tbody.innerHTML = (membres || []).map(m => `
    <tr><td>${m.nom}</td><td><span class="tag">${m.statut}</span></td><td>${fmt(m.report_n1)}</td></tr>
  `).join('') || '<tr><td colspan="3" class="small">Aucun adhérent visible avec votre rôle.</td></tr>';
}

async function populateOpForm() {
  document.getElementById('btn-new-op').onclick = () => {
    document.getElementById('new-op-panel').style.display = 'block';
    document.getElementById('op-date').value = new Date().toISOString().slice(0, 10);
  };
  const { data: categories } = await sb.from('categories').select('label').order('label');
  document.getElementById('op-categorie').innerHTML = (categories || []).map(c => `<option value="${c.label}">${c.label}</option>`).join('');
  const { data: membres } = await sb.from('membres').select('id, nom').order('nom');
  document.getElementById('op-membre').innerHTML = '<option value="">—</option>' + (membres || []).map(m => `<option value="${m.id}">${m.nom}</option>`).join('');

  document.getElementById('btn-save-op').onclick = async () => {
    const payload = {
      date: document.getElementById('op-date').value,
      libelle: document.getElementById('op-libelle').value.trim(),
      montant: parseFloat(document.getElementById('op-montant').value),
      compte: document.getElementById('op-compte').value,
      categorie: document.getElementById('op-categorie').value,
      membre_id: document.getElementById('op-membre').value || null,
      pointee: false,
    };
    if (!payload.libelle || isNaN(payload.montant)) { alert('Merci de renseigner le libellé et le montant.'); return; }
    const { error } = await sb.from('operations').insert(payload);
    if (error) { alert('Erreur : ' + error.message + "\n\n(Vérifiez que votre rôle autorise l'écriture.)"); return; }
    document.getElementById('op-libelle').value = '';
    document.getElementById('op-montant').value = '';
    await loadOperations();
    await loadDashboard();
  };
}

boot();