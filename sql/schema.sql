-- ============================================================================
-- Trésorerie CPCHR — schéma de base de données Supabase (Postgres)
-- À exécuter dans : Supabase > SQL Editor > New query > coller > Run
-- ============================================================================

-- ---------- TABLES ----------

create table if not exists membres (
  id text primary key,
  nom text not null,
  statut text not null default 'Permanent' check (statut in ('Permanent','Affilié')),
  report_n1 numeric not null default 0,
  cotisation_override numeric,
  mensualise boolean not null default false,
  mensualite numeric not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists echeances (
  id bigint generated always as identity primary key,
  membre_id text not null references membres(id) on delete cascade,
  mois int not null check (mois between 1 and 12),
  valide boolean not null default false,
  date_paiement date,
  montant numeric,
  unique (membre_id, mois)
);

create table if not exists achats (
  id bigint generated always as identity primary key,
  membre_id text not null references membres(id) on delete cascade,
  nom text not null,
  montant numeric not null default 0,
  date date not null default current_date
);

create table if not exists forfaits (
  id bigint generated always as identity primary key,
  nom text not null,
  montant numeric not null default 0
);

create table if not exists categories (
  id bigint generated always as identity primary key,
  label text not null unique
);

create table if not exists operations (
  id bigint generated always as identity primary key,
  date date,
  libelle text not null,
  categorie text,
  montant numeric not null default 0,
  compte text not null default 'C.Courant' check (compte in ('C.Courant','C.Hospit','Epargne')),
  membre_id text references membres(id) on delete set null,
  pointee boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists releves (
  id bigint generated always as identity primary key,
  compte text not null check (compte in ('C.Courant','C.Hospit','Epargne')),
  date_debut date,
  date_fin date,
  solde_debut numeric not null default 0,
  solde_fin numeric
);

create table if not exists parametres (
  id int primary key default 1,
  cotisation_permanent numeric not null default 400,
  cotisation_affilie numeric not null default 219.50,
  constraint singleton check (id = 1)
);
insert into parametres (id) values (1) on conflict (id) do nothing;

-- Table des profils utilisateurs : relie chaque compte de connexion (auth.users)
-- à un rôle et, le cas échéant, à un adhérent (pour l'accès "membre").
create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  nom text,
  role text not null default 'membre' check (role in ('tresorier','tresorier_adjoint','bureau','membre')),
  membre_id text references membres(id) on delete set null,
  created_at timestamptz not null default now()
);

-- ---------- CRÉATION AUTOMATIQUE DU PROFIL À LA PREMIÈRE CONNEXION ----------
-- Dès qu'un nouveau compte se connecte (magic link), une ligne "profiles"
-- est créée automatiquement avec le rôle "membre" par défaut.
-- Le trésorier doit ensuite élever les rôles nécessaires (voir README).

create or replace function handle_new_user()
returns trigger
language plpgsql
security definer
as $$
begin
  insert into public.profiles (id, nom, role)
  values (new.id, new.email, 'membre')
  on conflict (id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ---------- FONCTION UTILITAIRE : rôle de l'utilisateur connecté ----------

create or replace function auth_role()
returns text
language sql
security definer
stable
as $$
  select role from profiles where id = auth.uid();
$$;

create or replace function auth_membre_id()
returns text
language sql
security definer
stable
as $$
  select membre_id from profiles where id = auth.uid();
$$;

-- ---------- ROW LEVEL SECURITY ----------

alter table membres enable row level security;
alter table echeances enable row level security;
alter table achats enable row level security;
alter table forfaits enable row level security;
alter table categories enable row level security;
alter table operations enable row level security;
alter table releves enable row level security;
alter table parametres enable row level security;
alter table profiles enable row level security;

-- Lecture : trésorier / trésorier adjoint / bureau voient tout.
-- Un "membre" ne voit que ses propres lignes (adhérent, échéances, achats, opérations).
create policy "lecture staff" on membres for select
  using (auth_role() in ('tresorier','tresorier_adjoint','bureau'));
create policy "lecture soi-meme" on membres for select
  using (auth_role() = 'membre' and id = auth_membre_id());

create policy "lecture staff" on operations for select
  using (auth_role() in ('tresorier','tresorier_adjoint','bureau'));
create policy "lecture soi-meme" on operations for select
  using (auth_role() = 'membre' and membre_id = auth_membre_id());

create policy "lecture staff" on echeances for select
  using (auth_role() in ('tresorier','tresorier_adjoint','bureau'));
create policy "lecture soi-meme" on echeances for select
  using (auth_role() = 'membre' and membre_id = auth_membre_id());

create policy "lecture staff" on achats for select
  using (auth_role() in ('tresorier','tresorier_adjoint','bureau'));
create policy "lecture soi-meme" on achats for select
  using (auth_role() = 'membre' and membre_id = auth_membre_id());

create policy "lecture tous connectes" on forfaits for select using (auth.role() = 'authenticated');
create policy "lecture tous connectes" on categories for select using (auth.role() = 'authenticated');
create policy "lecture tous connectes" on releves for select using (auth_role() in ('tresorier','tresorier_adjoint','bureau'));
create policy "lecture tous connectes" on parametres for select using (auth.role() = 'authenticated');
create policy "lecture de son profil" on profiles for select using (id = auth.uid() or auth_role() in ('tresorier','tresorier_adjoint'));

-- Écriture : réservée au trésorier et au trésorier adjoint.
create policy "ecriture tresorier" on membres for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on operations for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on echeances for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on achats for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on forfaits for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on categories for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on releves for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));
create policy "ecriture tresorier" on parametres for all
  using (auth_role() in ('tresorier','tresorier_adjoint')) with check (auth_role() in ('tresorier','tresorier_adjoint'));

-- Seul le trésorier peut gérer les profils / rôles des autres utilisateurs.
create policy "gestion profils par tresorier" on profiles for all
  using (auth_role() = 'tresorier') with check (auth_role() = 'tresorier');

-- ============================================================================
-- ÉTAPE MANUELLE APRÈS CRÉATION DE VOTRE COMPTE (voir README) :
-- Une fois que vous vous êtes connecté une première fois (magic link),
-- exécutez la requête suivante en remplaçant l'email par le vôtre pour
-- devenir "trésorier" (accès complet) :
--
-- update profiles set role = 'tresorier'
-- where id = (select id from auth.users where email = 'votre-email@exemple.com');
-- ============================================================================
