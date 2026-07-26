# Trésorerie CPCHR — starter SaaS (Supabase + GitHub)

Ceci est le point de départ d'une vraie version en ligne, multi-utilisateurs, du prototype de trésorerie. Contrairement au prototype (`treso-cpchr-prototype.html`) qui stocke tout dans votre navigateur, cette version stocke les données dans une base partagée : tout le monde voit les mêmes chiffres, avec des droits différents selon le rôle (trésorier, trésorier adjoint, bureau en lecture seule, adhérent en accès personnel).

**Ce qui est déjà fonctionnel** : connexion par lien magique (sans mot de passe), tableau de bord (soldes par compte), liste des opérations, liste des adhérents, ajout d'opération (réservé au trésorier/trésorier adjoint), sécurité par rôle appliquée directement dans la base de données (RLS).

**Ce qui reste à porter** depuis le prototype local : la fiche adhérent détaillée, les achats/forfaits, la mensualisation, le pointage des relevés, l'édition des catégories. La logique est la même que dans `treso-cpchr-prototype.html` — il s'agit de la relier à Supabase au lieu du stockage local, table par table.

## Installation (30 minutes, gratuit)

### 1. Créer votre projet Supabase

Allez sur [supabase.com](https://supabase.com), créez un compte gratuit, puis « New project ». Notez le mot de passe de base de données que vous choisissez.

Une fois le projet créé, ouvrez **SQL Editor** (menu de gauche) → **New query**, collez le contenu de `sql/schema.sql`, cliquez sur **Run**. Répétez l'opération avec `sql/seed.sql` pour charger vos 32 adhérents et vos 83 écritures réelles.

### 2. Récupérer vos clés d'API

Dans **Project Settings → API**, copiez la **Project URL** et la clé **anon public**. Ouvrez `public/config.js` et collez-les à la place de `VOTRE-PROJET` et `VOTRE_CLE_ANON_PUBLIQUE`.

### 3. Devenir « trésorier »

Le site fonctionne par connexion via lien magique envoyé par email — aucun mot de passe. Ouvrez `public/index.html` dans votre navigateur (double-clic), entrez votre email, cliquez sur le lien reçu. Vous êtes connecté, mais avec le rôle par défaut « membre » (lecture seule sur votre propre fiche).

Retournez dans **SQL Editor** de Supabase et exécutez, en remplaçant par votre email :

```sql
update profiles set role = 'tresorier'
where id = (select id from auth.users where email = 'votre-email@exemple.com');
```

Rafraîchissez la page : vous avez maintenant l'accès complet.

### 4. Publier le code sur GitHub

Ce dossier contient déjà un dépôt git avec un premier commit. Créez d'abord un dépôt vide sur GitHub (bouton « New repository », sans README ni .gitignore), puis depuis un terminal, dans ce dossier :

```bash
git remote add origin https://github.com/VOTRE-COMPTE/treso-cpchr.git
git branch -M main
git push -u origin main
```

Si `git status` indique que le dépôt n'est pas initialisé (selon comment vous avez récupéré ce dossier), lancez d'abord `git init && git add . && git commit -m "Version initiale"`.

### 5. Mettre le site en ligne

Sur [vercel.com](https://vercel.com) (gratuit), connectez-vous avec votre compte GitHub, « Add New Project », sélectionnez le dépôt `treso-cpchr`, indiquez `public` comme dossier racine (« Root Directory »), puis déployez. Vous obtenez une adresse du type `treso-cpchr.vercel.app` que vous pouvez partager avec le bureau.

## Ajouter les autres personnes

Chaque personne se connecte une première fois avec son email (lien magique) pour créer automatiquement son profil, avec le rôle « membre » par défaut. Vous (trésorier) changez ensuite son rôle dans Supabase, table `profiles` (onglet **Table Editor**) : `tresorier_adjoint` pour un second trésorier, `bureau` pour une lecture seule complète, `membre` avec le champ `membre_id` renseigné pour qu'un adhérent voie sa propre situation.

## Sécurité des données

Les règles d'accès (qui peut lire/modifier quoi) sont appliquées directement dans la base de données PostgreSQL (Row Level Security), pas seulement dans le code du site : même si quelqu'un inspectait le code, il ne pourrait pas voir ou modifier des données hors de son rôle.

## Prochaines étapes suggérées

Porter les fonctionnalités restantes (fiche adhérent, achats, mensualisation, relevés) une par une, en suivant le même schéma que les opérations : lecture avec `supabase.from('table').select()`, écriture avec `.insert()` / `.update()`, sécurité déjà posée par `schema.sql`. Ajouter une page d'administration pour que le trésorier change les rôles directement depuis le site plutôt que dans Supabase. Ajouter une sauvegarde automatique quotidienne (export CSV programmé).
