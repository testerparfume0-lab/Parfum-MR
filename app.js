/* =========================================================
   Souvenirs de Paris — Catalogue App (v2, Supabase)
   ========================================================= */

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  global: { headers: { 'Cache-Control': 'no-cache' } }
});

if (typeof emailjs !== 'undefined' && EMAILJS_PUBLIC_KEY && !EMAILJS_PUBLIC_KEY.startsWith('REMPLACER')) {
  emailjs.init({ publicKey: EMAILJS_PUBLIC_KEY });
}

/* ---------- Constantes ---------- */
const TVA_RATE = 0.20; // 20% — appliqué uniquement au moment de la confirmation de commande

/* Calcule la commission de Fuaad sur une commande. Décision explicite :
   la commission se calcule sur le "Total à payer" (TTC, TVA incluse),
   PAS sur le sous-total HT — c'est un choix délibéré de Fuaad, pas une
   erreur de calcul comptable.
   Les magasins de la liste reducedCommissionShops bénéficient d'un taux
   réduit (0,05% au lieu de 5% par défaut). La comparaison de noms est
   insensible à la casse et aux espaces superflus pour éviter qu'une
   différence de saisie ("Eva souvenirs" vs "Eva Souvenirs") fasse
   rater l'exception. */
/* Distance de Levenshtein simple — nombre minimal de modifications
   (ajout/suppression/changement d'une lettre) pour passer d'un mot à
   l'autre. Utilisée pour tolérer une petite faute de frappe dans le
   nom d'un magasin sans pour autant rater le taux spécial auquel il a
   droit. */
function levenshteinDistance(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

function getCommissionRateForShop(shopName) {
  const normalized = (shopName || '').trim().toLowerCase();
  if (!normalized) return DEFAULT_COMMISSION_RATE;

  // Correspondance exacte (cas normal, le nom est saisi correctement).
  if (reducedCommissionShops.some(s => s.trim().toLowerCase() === normalized)) {
    return SPECIAL_COMMISSION_RATE;
  }

  // Tolérance à une petite faute de frappe : autorise jusqu'à 1
  // caractère de différence pour les noms courts, jusqu'à 2 pour les
  // noms plus longs — évite qu'une faute de frappe fasse rater le taux
  // spécial, sans pour autant faire correspondre des noms réellement
  // différents entre eux.
  const isFuzzyMatch = reducedCommissionShops.some(s => {
    const candidate = s.trim().toLowerCase();
    const maxAllowedDistance = candidate.length > 10 ? 2 : 1;
    return levenshteinDistance(candidate, normalized) <= maxAllowedDistance;
  });
  return isFuzzyMatch ? SPECIAL_COMMISSION_RATE : DEFAULT_COMMISSION_RATE;
}

/* Calcule les bornes exactes (début et fin) d'un mois calendaire donné.
   Utilise l'arithmétique native des dates JavaScript — qui connaît déjà
   le nombre de jours de chaque mois, y compris février lors d'une année
   bissextile — plutôt qu'un nombre de jours codé en dur, pour ne jamais
   se tromper quel que soit le mois ou l'année. */
/* Calcule les bornes exactes (lundi 00:00 à dimanche 23:59) de la
   semaine calendaire contenant une date donnée. Gère correctement les
   semaines à cheval sur deux mois ou deux années, en se basant sur
   l'arithmétique native des dates plutôt qu'un calcul de jours fixe. */
function getWeekBoundaries(referenceDate) {
  const d = new Date(referenceDate);
  const dayOfWeek = d.getDay(); // 0 = dimanche, 1 = lundi, ...
  const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const start = new Date(d);
  start.setDate(d.getDate() + diffToMonday);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);
  return { start, end };
}

function getMonthBoundaries(year, monthIndex /* 0-11 */) {
  const start = new Date(year, monthIndex, 1, 0, 0, 0, 0);
  // Le jour 0 du mois suivant est toujours le dernier jour du mois
  // demandé — fonctionne pour tous les mois, 28/29/30/31 jours inclus.
  const end = new Date(year, monthIndex + 1, 0, 23, 59, 59, 999);
  return { start, end };
}

function calculateOrderCommission(order) {
  const rate = getCommissionRateForShop(order.shop_name);
  // Base de calcul = Sous-total HT (hors taxes), PAS le Total TTC —
  // conforme aux conditions du contrat de Fuaad : la TVA collectée
  // n'est pas un revenu sur lequel une commission est due.
  const montantHT = order.total != null ? order.total : order.total_with_tva;
  return { amount: +(montantHT * rate / 100).toFixed(2), rate };
}

/* ---------- État ---------- */
let categories = [];
let products = [];
let settings = { shop_name: 'Souvenirs de Paris', whatsapp: '', email: '', admin_pin: '1234', next_order_number: 1 };
/* Taux de commission de Fuaad sur chaque commande, calculé sur le
   Total à payer (TVA incluse), comme décidé explicitement — voir
   calculateOrderCommission(). Certains magasins (liste personnalisable
   depuis l'admin) ont un taux réduit spécial. */
const DEFAULT_COMMISSION_RATE = 2;      // % — appliqué à tous les magasins NON listés ci-dessous
const SPECIAL_COMMISSION_RATE = 0.5;    // % — uniquement pour les magasins de la liste reducedCommissionShops
let reducedCommissionShops = [
  'NK STEINKERQUE', 'MONDIAL SOUVENIRS', 'ANVERS TISSUS', 'BM SOUVENIRS',
  'AU PARIS MONTMARTRE', 'SACRE SOUVENIRS', 'CHARMRS SOUVENIRS', 'LE CHAT NOIR',
  'ART TABLEAUX', 'ART ATAK', 'WORLD SOUVENIRS', 'PARIS FOR EVER'
]; // noms de magasins (insensible à la casse) bénéficiant du taux spécial 0,5%

/* Réglages d'apparence personnalisables depuis l'admin (onglet Réglages
   → Thème). Stockés en JSON dans settings.theme_settings et appliqués
   dynamiquement via des variables CSS sur :root. */
const DEFAULT_THEME = {
  glassOpacity: 50,       // 0-100 : opacité des panneaux en verre
  glassBlur: 28,          // 0-40px : intensité du flou
  cardOpacity: 62,        // 0-100 : opacité des cartes produit
  cardRadius: 16,         // 0-30px : arrondi des cartes
  cardShadow: 18,         // 0-40 : intensité de l'ombre des cartes (%)
  cardGap: 8,             // 2-24px : espace entre les cartes
  priceSize: 21,          // 14-30px : taille du prix sur les cartes
  nameSize: 13.5,         // 11-18px : taille du nom de produit
  fontHeading: "'Fraunces', serif",
  fontBody: "'Jost', sans-serif",
  chipRadius: 18,         // 0-30px : arrondi des chips de catégorie
  buttonRadius: 24,       // 0-34px : arrondi des boutons principaux
  addBtnSize: 34,         // 26-46px : taille du bouton rond "+"
  imagePadding: 14,       // 0-30px : marge intérieure des photos produit
  animSpeed: 100,         // 40-200% : multiplicateur de vitesse d'animation
  showPromoSection: true,
  showNewSection: true,
  promoLabel: '🔥 Promos',
  newLabel: '✨ Nouveauté',

  // ===== Transparence & flou (8 réglages supplémentaires) =====
  topbarOpacity: 92,      // 0-100 : opacité du bandeau du haut (logo + recherche)
  topbarBlur: 28,         // 0-40px : flou du bandeau du haut
  catStripOpacity: 38,    // 0-100 : opacité des chips de catégorie au repos
  drawerOpacity: 68,      // 0-100 : opacité des tiroirs (panier, admin...)
  drawerBlur: 28,         // 0-40px : flou des tiroirs
  cartFabOpacity: 55,     // 0-100 : opacité du bandeau panier flottant
  overlayOpacity: 55,     // 0-100 : opacité du voile sombre derrière un tiroir ouvert
  toastOpacity: 100,      // 0-100 : opacité des petits messages de confirmation

  // ===== 17 réglages additionnels =====
  shopNameSize: 21,        // 16-28px : taille du nom de la boutique dans l'en-tête
  logoSize: 38,            // 28-60px : taille du logo
  searchBarHeight: 45,     // 36-60px : hauteur de la barre de recherche
  searchFontSize: 14.5,    // 12-18px : taille du texte de recherche
  imageAspectRatio: 100,   // 80-130% : proportion des photos produit (100 = carré)
  lineHeight: 132,         // 110-160% : interligne du nom de produit
  refSize: 10,             // 8-14px : taille du texte "Réf. ..."
  headerShadow: 6,         // 0-20 : intensité de l'ombre sous l'en-tête (%)
  toastSpeed: 100,         // 40-200% : vitesse d'apparition des messages
  drawerCloseSize: 32,     // 26-44px : taille du bouton de fermeture des tiroirs
  catStripPadding: 14,     // 6-24px : hauteur de la bande de catégories
  chipGap: 9,              // 4-18px : espace entre les chips de catégorie
  cartIconSize: 48,        // 38-60px : taille de l'icône panier
  lotLabelSize: 11.5,      // 9-15px : taille du texte "Lot de X"
  sizeBadgeDiameter: 30,    // 22-44px : diamètre du badge rond de taille (XS/S/M/L/XL)
  sizeBadgeFontSize: 13,    // 9-18px : taille du texte dans le badge de taille
  sizeBadgeBg: '#1B2A45',   // couleur de fond du badge de taille
  sizeBadgeText: '#D89A2C', // couleur du texte du badge de taille
  sizeBadgeBorder: '#D89A2C', // couleur de la bordure du badge de taille
  imageRadius: 0,          // 0-20px : arrondi des photos produit elles-mêmes
  pressScale: 8,           // 0-20 : intensité de l'effet d'appui (% de réduction)
  bgImageOpacity: 100,      // 0-100 : opacité de la photo de fond (Paris ou personnalisée)
  bgOverlayOpacity: 55,     // 0-100 : opacité du voile crème posé sur la photo de fond
  emptyHint: 'Essayez une autre recherche ou catégorie.'
};
let theme = Object.assign({}, DEFAULT_THEME);
/* Copie du thème tel qu'enregistré en base, utilisée pour annuler un
   aperçu en direct non sauvegardé (bouton "Annuler / revenir à
   l'enregistré"). */
let savedTheme = Object.assign({}, DEFAULT_THEME);
let cart = {}; // { productId: qty }  (qty déjà en unités réelles, multiples de unit_step)
/* Références produit les plus vendues du mois en cours, calculées une
   fois au chargement (et reste en cache pour le reste de la session) à
   partir des commandes du mois — section catalogue automatique
   "🔥 Top des ventes ce mois", entièrement distincte du "Meilleures
   ventes" manuel (qui reste basé sur la case "featured" cochée par
   Fuaad et n'est jamais touché par ce calcul). */
let topSellerRefs = [];
/* Nom du client et du magasin saisis par Fuaad lui-même dans la fenêtre
   d'accueil de l'admin, avant que le client ne parcoure le catalogue.
   Quand ces valeurs sont renseignées, l'étape "Votre nom" du tunnel de
   commande est sautée — la commande se confirme directement avec ces
   informations déjà connues. */
let prefilledClientName = null;
let prefilledClientShop = null;

/* Persistance locale du panier : permet de retrouver le panier tel qu'il
   était si la page se recharge (perte de connexion, fermeture accidentelle
   de l'onglet, etc.). Le panier n'est jamais perdu tant que le client
   utilise le même navigateur sur le même appareil. */
const CART_STORAGE_KEY = 'souvenirs_paris_cart_v1';
function saveCartToStorage() {
  try {
    localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(cart));
  } catch (e) {
    console.warn('Impossible de sauvegarder le panier localement', e);
  }
}
function loadCartFromStorage() {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') cart = parsed;
    }
  } catch (e) {
    console.warn('Impossible de charger le panier sauvegardé', e);
  }
}
let activeCategory = 'all';
let searchTerm = '';
let editingProductId = null;
let adminUnlocked = false;

/* Logo SVG par défaut (Tour Eiffel dessinée), utilisé tant qu'aucun
   logo personnalisé n'a été téléchargé, et pour le bouton "revenir au
   logo par défaut". */
const DEFAULT_LOGO_SVG = `<svg viewBox="0 0 100 130" fill="none" xmlns="http://www.w3.org/2000/svg">
  <circle cx="50" cy="64" r="46" fill="none" stroke="#D89A2C" stroke-width="2" opacity="0.55"/>
  <g fill="#1B2A45">
    <rect x="49.3" y="2" width="1.4" height="12"/>
    <path d="M47.5 14 L52.5 14 L51.3 24 L48.7 24 Z"/>
    <path d="M48.7 24 L51.3 24 L52.5 34 L47.5 34 Z"/>
    <path d="M48.2 26.5 L51.8 26.5 L50 30 Z" fill="#D89A2C" opacity="0.5"/>
    <rect x="46.5" y="34" width="7" height="1.6" fill="#D89A2C"/>
    <path d="M46.5 35.6 L53.5 35.6 L56.5 54 L43.5 54 Z"/>
    <path d="M45.5 39 L54.5 39 L48 46 Z" fill="#D89A2C" opacity="0.45"/>
    <path d="M54.5 39 L45.5 39 L52 46 Z" fill="#D89A2C" opacity="0.45"/>
    <path d="M44.7 47.5 L55.3 47.5 L50 53 Z" fill="#D89A2C" opacity="0.45"/>
    <rect x="41" y="54" width="18" height="2.2" fill="#D89A2C"/>
    <path d="M41.5 56.2 L58.5 56.2 L63 80 L37 80 Z"/>
    <path d="M40 62 L60 62 L52 70 L48 70 Z" fill="#D89A2C" opacity="0.4"/>
    <path d="M38.5 70 L61.5 70 L54 78 L46 78 Z" fill="#D89A2C" opacity="0.4"/>
    <rect x="35" y="80" width="30" height="2.4" fill="#D89A2C"/>
    <path d="M37 82.4 L43 82.4 L34 122 L25 122 Z"/>
    <path d="M63 82.4 L57 82.4 L66 122 L75 122 Z"/>
    <path d="M34 122 L25 122 L25 118 Q25 104 50 104 Q75 104 75 118 L75 122 L66 122 L66 119 Q66 110 50 110 Q34 110 34 119 Z"/>
    <rect x="20" y="122" width="60" height="2" fill="#D89A2C"/>
  </g>
</svg>`;
let pendingImageData = null;
let currentUnitMode = 'unit'; // 'unit' | 'bulk'

/* ---------- Toast ---------- */
let toastTimer = null;
function showToast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
}

function fmtPrice(n) {
  return n.toFixed(2).replace('.', ',') + ' €';
}
function uid(prefix) {
  return prefix + '-' + Math.random().toString(36).slice(2, 9);
}
function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/* Un produit est visible dans la boutique publique seulement si :
   - il n'est pas masqué individuellement, ET
   - sa catégorie n'est pas masquée. */
function isProductVisible(p) {
  if (p.hidden) return false;
  const cat = categories.find(c => c.id === p.categoryId);
  if (cat && cat.hidden) return false;
  return true;
}

/* ---------- Drawers ---------- */
function openDrawer(id) {
  document.getElementById('overlay').classList.add('show');
  document.getElementById(id).classList.add('show');
}
function closeDrawer(id) {
  document.getElementById(id).classList.remove('show');
  const anyOpen = Array.from(document.querySelectorAll('.drawer')).some(d => d.classList.contains('show'));
  if (!anyOpen) document.getElementById('overlay').classList.remove('show');
}
function closeAllDrawers() {
  document.querySelectorAll('.drawer').forEach(d => d.classList.remove('show'));
  document.getElementById('overlay').classList.remove('show');
}

/* =========================================================
   CHARGEMENT DES DONNÉES (Supabase)
   ========================================================= */
/* Récupère tous les produits depuis Supabase, par petits lots, pour
   éviter un timeout côté base de données (la table contient 900+ lignes,
   certaines avec des images encodées en base64 assez lourdes). Réutilisée
   au chargement initial et lors du rafraîchissement manuel de l'admin. */
async function fetchAllProductsFromDB(onProgress) {
  // Récupère d'abord le nombre total de produits (requête légère, sans
  // les données elles-mêmes) pour pouvoir calculer une vraie progression
  // en pourcentage au fur et à mesure des pages suivantes.
  let totalCount = null;
  try {
    const { count, error: countError } = await supabaseClient
      .from('products')
      .select('*', { count: 'exact', head: true });
    if (!countError && typeof count === 'number') totalCount = count;
  } catch (e) {
    // Si le comptage échoue, on continue sans pourcentage exact (la barre
    // avancera quand même de façon approximative, voir plus bas).
  }

  let allProducts = [];
  let from = 0;
  let pageSize = 40;
  while (true) {
    let data, error;
    try {
      const res = await supabaseClient
        .from('products')
        .select('*')
        .range(from, from + pageSize - 1);
      data = res.data; error = res.error;
    } catch (e) {
      error = e;
    }
    if (error) {
      if (pageSize > 10) {
        pageSize = Math.max(10, Math.floor(pageSize / 2));
        continue;
      }
      throw error;
    }
    if (!data || data.length === 0) break;
    allProducts = allProducts.concat(data);
    if (onProgress) {
      const percent = totalCount
        ? Math.min(99, Math.round((allProducts.length / totalCount) * 100))
        : null; // pas de total connu : l'appelant peut afficher un état indéterminé
      onProgress(allProducts.length, totalCount, percent);
    }
    if (data.length < pageSize) break;
    from += data.length;
  }
  allProducts.sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0));
  if (onProgress) onProgress(allProducts.length, totalCount || allProducts.length, 100);
  return allProducts;
}

function mapDbProductToLocal(p) {
  return {
    id: p.id, ref: p.ref, name: p.name, price: Number(p.price),
    categoryId: p.category_id, image: p.image, sortOrder: p.sort_order || 0,
    unitStep: p.unit_step || 1, unitLabel: p.unit_label || '', size: p.size || '',
    outOfStock: !!p.out_of_stock, featured: !!p.featured,
    hidden: !!p.hidden, isNew: !!p.is_new, isPromo: !!p.is_promo
  };
}

/* Met à jour la barre de progression visible pendant le chargement
   initial du catalogue (pourcentage réel basé sur le nombre total de
   produits, récupéré au début de fetchAllProductsFromDB). */
function updateLoadingProgress(loaded, total, percent) {
  const bar = document.getElementById('loadingProgressBar');
  const label = document.getElementById('loadingProgressLabel');
  if (!bar || !label) return;
  if (percent == null) {
    // Total inconnu (la requête de comptage a échoué) : on affiche une
    // progression indéterminée, sans jamais montrer de nombre brut de
    // produits — seulement un pourcentage (même approximatif).
    label.textContent = '…';
    bar.style.width = '40%';
    bar.classList.add('indeterminate');
  } else {
    bar.classList.remove('indeterminate');
    bar.style.width = percent + '%';
    label.textContent = `${percent}%`;
  }
}

async function loadAllData() {
  try {
    const [catRes, settRes] = await Promise.all([
      supabaseClient.from('categories').select('*').order('sort_order'),
      supabaseClient.from('settings').select('*').eq('id', 1).single()
    ]);
    if (catRes.error) throw catRes.error;
    if (settRes.error) throw settRes.error;

    categories = (catRes.data || []).map(c => ({
      id: c.id, name: c.name, sort_order: c.sort_order,
      bulkGroupId: c.bulk_group_id || null,
      bulkThresholdQty: c.bulk_threshold_qty || null,
      bulkPrice: c.bulk_price != null ? Number(c.bulk_price) : null,
      hidden: !!c.hidden,
      coverImage: c.cover_image || null
    }));
    settings = settRes.data || settings;
    if (settings.reduced_commission_shops && settings.reduced_commission_shops.length > 0) {
      reducedCommissionShops = settings.reduced_commission_shops;
    } else {
      // Première utilisation (ou liste vide en base) : on initialise
      // avec la liste exacte donnée par Fuaad et on la sauvegarde tout
      // de suite, pour que le bon taux s'applique dès cette session.
      persistReducedShops();
    }
    dismissedNotifications = new Set((settings.dismissed_notifications || []).map(String));
    shopMapPoints = settings.shop_map_points || [];
    commissionLedger = settings.commission_ledger || [];
    theme = Object.assign({}, DEFAULT_THEME, settings.theme_settings || {});
    savedTheme = Object.assign({}, theme);
    applyThemeToPage();

    const allProducts = await fetchAllProductsFromDB((loaded, total, percent) => {
      updateLoadingProgress(loaded, total, percent);
    });
    products = allProducts.map(mapDbProductToLocal);

    loadCartFromStorage();
    if (wasAdminPreviouslyUnlocked()) {
      unlockAdminPanel();
    }

    applyBrandingToPage();
    document.getElementById('loadingState').style.display = 'none';
    renderCategoryStrip();
    renderGrid();
    renderHomeTiles();
    updateCartUI();
    startOrderPolling();
    computeTopSellersForCatalogue();
  } catch (e) {
    console.error('Erreur de chargement', e);
    document.getElementById('loadingState').innerHTML =
      `<div style="opacity:0.85;">⚠️ Impossible de charger le catalogue.<br><small>${escapeHtml(e.message || '')}</small></div>`;
  }
}

/* =========================================================
   RENDU — Catégories
   ========================================================= */
function renderCategoryStrip() {
  const strip = document.getElementById('catStrip');
  const visibleProducts = products.filter(isProductVisible);
  const allCount = visibleProducts.length;
  let html = `<button class="cat-chip catalogue-chip" data-action="open-catalogue">🗂️ Catalogue</button>`;
  html += `<button class="cat-chip ${activeCategory === 'all' ? 'active' : ''}" data-cat="all">Tout <span class="count">${allCount}</span></button>`;
  const featuredCount = visibleProducts.filter(p => p.featured).length;
  if (featuredCount > 0) {
    html += `<button class="cat-chip featured-chip ${activeCategory === 'featured' ? 'active' : ''}" data-cat="featured">⭐ Meilleures ventes <span class="count">${featuredCount}</span></button>`;
  }
  const promoCount = visibleProducts.filter(p => p.isPromo).length;
  if (promoCount > 0 && theme.showPromoSection) {
    html += `<button class="cat-chip promo-chip ${activeCategory === 'promo' ? 'active' : ''}" data-cat="promo">${escapeHtml(theme.promoLabel || '🔥 Promos')} <span class="count">${promoCount}</span></button>`;
  }
  const newCount = visibleProducts.filter(p => p.isNew).length;
  if (newCount > 0 && theme.showNewSection) {
    html += `<button class="cat-chip new-chip ${activeCategory === 'new' ? 'active' : ''}" data-cat="new">${escapeHtml(theme.newLabel || '✨ Nouveauté')} <span class="count">${newCount}</span></button>`;
  }
  categories.filter(c => !c.hidden).forEach(c => {
    const count = visibleProducts.filter(p => p.categoryId === c.id).length;
    html += `<button class="cat-chip ${activeCategory === c.id ? 'active' : ''}" data-cat="${c.id}">${escapeHtml(c.name)} <span class="count">${count}</span></button>`;
  });
  strip.innerHTML = html;
  strip.querySelectorAll('.cat-chip[data-cat]').forEach(btn => {
    btn.addEventListener('click', () => {
      activeCategory = btn.dataset.cat;
      window.scrollTo({ top: 0, behavior: 'instant' });
      // requestAnimationFrame laisse le navigateur terminer le scroll et
      // la mise à jour visuelle des chips avant de lancer le rendu de la
      // grille, ce qui évite l'impression de saccade quand on bascule
      // rapidement entre plusieurs catégories à la suite.
      renderCategoryStrip();
      requestAnimationFrame(() => renderGrid());
    });
  });
  const catalogueBtn = strip.querySelector('[data-action="open-catalogue"]');
  if (catalogueBtn) {
    catalogueBtn.addEventListener('click', () => {
      renderHomeTiles();
      openDrawer('catalogueDrawer');
    });
  }
}

/* =========================================================
   Notifications — nouvelle commande (son + alerte interne)
   ========================================================= */
let knownOrderIds = new Set();
/* Journal permanent des commandes pour l'onglet Notifications — distinct
   de knownOrderIds (qui sert uniquement à détecter les nouvelles
   commandes pour le son/bandeau). Une entrée y reste tant qu'elle n'est
   pas explicitement supprimée par Fuaad. */
let knownOrdersLog = [];
let dismissedNotifications = new Set();
let shopMapPoints = []; // [{ name, lat, lng }]
/* Registre permanent des commissions : chaque commande confirmée y
   inscrit sa commission UNE FOIS, de façon définitive — même si la
   commande d'origine est ensuite supprimée définitivement de la table
   "orders", sa commission reste comptée ici. C'est la correction
   demandée explicitement : la commission se fige au moment de la
   confirmation, pas recalculée à la volée en relisant les commandes. */
let commissionLedger = [];
/* Mois actuellement affiché dans les onglets Commissions / Ventes —
   indépendant l'un de l'autre pour que naviguer dans l'un ne déplace
   pas l'autre par surprise. */
let commissionsViewYear, commissionsViewMonth;
let commissionsPeriodMode = 'week'; // 'week' | 'month' | 'total'
let commissionsWeekOffset = 0; // 0 = semaine en cours, -1 = semaine précédente, etc.
let ventesViewYear, ventesViewMonth;
(() => {
  const now = new Date();
  commissionsViewYear = ventesViewYear = now.getFullYear();
  commissionsViewMonth = ventesViewMonth = now.getMonth();
})();
let orderPollingStarted = false;

/* Nettement plus doux que playNotificationSound (qui signale une
   nouvelle commande, donc volontairement plus marquant) : un petit
   arpège ascendant à 3 notes, joué une fois à l'ouverture de l'admin —
   une touche d'élégance discrète plutôt qu'une alerte. */
function playAdminEntranceChime() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, startTime, duration, peakGain) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(peakGain, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    const now = ctx.currentTime;
    playTone(523.25, now, 0.26, 0.12);         // Do
    playTone(659.25, now + 0.18, 0.28, 0.12);  // Mi
    playTone(783.99, now + 0.36, 0.30, 0.13);  // Sol
    playTone(880.00, now + 0.54, 0.32, 0.13);  // La
    playTone(1046.5, now + 0.74, 0.42, 0.14);  // Do (octave)
  } catch (e) {
    console.warn('Son indisponible', e);
  }
}

function playNotificationSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const playTone = (freq, startTime, duration) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(0.3, startTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration);
    };
    const now = ctx.currentTime;
    playTone(880, now, 0.18);
    playTone(1175, now + 0.16, 0.22);
  } catch (e) {
    console.warn('Son indisponible', e);
  }
}

function showNewOrderBanner(order) {
  const banner = document.createElement('div');
  banner.className = 'new-order-banner';
  banner.innerHTML = `
    <div class="nob-icon">🎫</div>
    <div class="nob-text">
      <strong>Nouvelle commande n°${escapeHtml(order.order_number)}</strong>
      <span>${escapeHtml(order.client_name || 'Client')}${order.shop_name ? ' — ' + escapeHtml(order.shop_name) : ''}</span>
    </div>
    <button class="nob-close">✕</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector('.nob-close').addEventListener('click', () => banner.remove());
  setTimeout(() => banner.classList.add('show'), 50);
  setTimeout(() => {
    banner.classList.remove('show');
    setTimeout(() => banner.remove(), 400);
  }, 8000);
}

async function checkForNewOrders() {
  try {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('id, order_number, client_name, shop_name, created_at')
      .order('created_at', { ascending: false })
      .limit(20);
    if (error || !data) return;

    if (knownOrderIds.size === 0) {
      // premier chargement : juste mémoriser, ne pas notifier rétroactivement
      data.forEach(o => knownOrderIds.add(o.id));
      knownOrdersLog = data.slice();
      return;
    }

    const newOnes = data.filter(o => !knownOrderIds.has(o.id));
    newOnes.forEach(o => knownOrderIds.add(o.id));

    // La notification (son + bandeau + entrée permanente dans l'onglet
    // Notifications) ne doit apparaître que côté administrateur — un
    // client en train de parcourir le catalogue ne doit jamais voir ni
    // entendre l'arrivée d'une commande d'un autre client. C'est aussi
    // ce qui couvre le cas demandé : si quelqu'un d'autre (un collègue)
    // passe une commande pendant que l'admin est ouvert sur la
    // tablette, Fuaad en est notifié comme s'il l'avait reçue lui-même.
    if (newOnes.length > 0 && adminUnlocked) {
      playNotificationSound();
      newOnes.forEach(o => showNewOrderBanner(o));
      knownOrdersLog = newOnes.concat(knownOrdersLog);
      renderAdminOrderList();
      renderAdminNotifications();
    }
  } catch (e) {
    console.warn('Vérification des commandes échouée', e);
  }
}

function startOrderPolling() {
  if (orderPollingStarted) return;
  orderPollingStarted = true;
  checkForNewOrders(); // initialise knownOrderIds sans notifier
  setInterval(checkForNewOrders, 30000);
}

/* =========================================================
   CATALOGUE PAR CATÉGORIE — mosaïque dans un tiroir
   ========================================================= */
function renderHomeTiles() {
  const container = document.getElementById('homeTilesContainer');
  const visibleProducts = products.filter(isProductVisible);
  let html = '';
  const featuredCount = visibleProducts.filter(p => p.featured).length;
  if (featuredCount > 0) {
    const sample = visibleProducts.find(p => p.featured);
    html += `
    <div class="home-tile featured-tile" data-cat="featured">
      <img src="${sample.image || ''}" alt="">
      <div class="tile-label">⭐ Meilleures ventes<span class="tile-count">${featuredCount} article${featuredCount > 1 ? 's' : ''}</span></div>
    </div>`;
  }
  categories.filter(cat => !cat.hidden).forEach(cat => {
    const items = visibleProducts.filter(p => p.categoryId === cat.id);
    if (items.length === 0) return;
    // Utilise la photo de couverture personnalisée si l'admin en a défini
    // une pour cette catégorie ; sinon, retombe sur la photo du premier
    // produit du rayon, comme avant.
    const coverImage = cat.coverImage || items[0].image;
    html += `
    <div class="home-tile" data-cat="${cat.id}">
      <img src="${coverImage || ''}" alt="">
      <div class="tile-label">${escapeHtml(cat.name)}<span class="tile-count">${items.length} article${items.length > 1 ? 's' : ''}</span></div>
    </div>`;
  });
  container.innerHTML = html;
  observeCardsForScrollReveal('.home-tile');
  container.querySelectorAll('.home-tile').forEach(tile => {
    tile.addEventListener('click', () => {
      activeCategory = tile.dataset.cat;
      renderCategoryStrip();
      renderGrid();
      closeDrawer('catalogueDrawer');
    });
  });
}

/* =========================================================
   RENDU — Grille produits
   ========================================================= */
function getFilteredProducts() {
  let list = products.filter(isProductVisible);
  if (activeCategory === 'featured') {
    list = list.filter(p => p.featured);
  } else if (activeCategory === 'promo') {
    list = list.filter(p => p.isPromo);
  } else if (activeCategory === 'new') {
    list = list.filter(p => p.isNew);
  } else if (activeCategory !== 'all') {
    list = list.filter(p => p.categoryId === activeCategory);
  }
  if (searchTerm.trim()) {
    const q = searchTerm.trim().toLowerCase();
    list = list.filter(p => p.name.toLowerCase().includes(q) || p.ref.toLowerCase().includes(q));
  }
  return list;
}

function renderGrid() {
  const container = document.getElementById('gridContainer');
  const empty = document.getElementById('emptyState');
  const list = getFilteredProducts();
  const visibleProducts = products.filter(isProductVisible);
  // Calculé UNE SEULE fois par rendu (et non une fois par produit, comme
  // c'était le cas avant) : c'est ce qui causait le ralentissement
  // ressenti dans "Tout", où ce calcul tournait jusqu'à 900 fois.
  const bulkEligible = getBulkEligibleCategories();

  if (list.length === 0) {
    container.innerHTML = '';
    empty.style.display = 'block';
    return;
  }
  empty.style.display = 'none';

  let html = '';
  if (activeCategory === 'all' && !searchTerm.trim()) {
    const featured = visibleProducts.filter(p => p.featured);
    if (featured.length) {
      html += `<div class="section-title featured-title">⭐ Meilleures ventes</div><div class="grid">`;
      featured.forEach(p => html += productCardHtml(p, bulkEligible));
      html += `</div>`;
    }
    if (topSellerRefs.length > 0) {
      const topSellers = topSellerRefs
        .map(ref => visibleProducts.find(p => p.ref === ref))
        .filter(Boolean);
      if (topSellers.length > 0) {
        html += `<div class="section-title top-sellers-title">🔥 Top des ventes ce mois</div><div class="grid">`;
        topSellers.forEach(p => html += productCardHtml(p, bulkEligible));
        html += `</div>`;
      }
    }
    const promoItems = visibleProducts.filter(p => p.isPromo);
    if (promoItems.length && theme.showPromoSection) {
      html += `<div class="section-title promo-title">${escapeHtml(theme.promoLabel || '🔥 Promos')}</div><div class="grid">`;
      promoItems.forEach(p => html += productCardHtml(p, bulkEligible));
      html += `</div>`;
    }
    const newOnes = visibleProducts.filter(p => p.isNew);
    if (newOnes.length && theme.showNewSection) {
      html += `<div class="section-title new-title">${escapeHtml(theme.newLabel || '✨ Nouveauté')}</div><div class="grid">`;
      newOnes.forEach(p => html += productCardHtml(p, bulkEligible));
      html += `</div>`;
    }
    categories.filter(cat => !cat.hidden).forEach(cat => {
      const items = visibleProducts.filter(p => p.categoryId === cat.id);
      if (items.length === 0) return;
      html += `<div class="section-title">${escapeHtml(cat.name)}</div><div class="grid">`;
      items.forEach(p => html += productCardHtml(p, bulkEligible));
      html += `</div>`;
    });
    const orphan = visibleProducts.filter(p => !categories.some(c => c.id === p.categoryId));
    if (orphan.length) {
      html += `<div class="section-title">Autres</div><div class="grid">`;
      orphan.forEach(p => html += productCardHtml(p, bulkEligible));
      html += `</div>`;
    }
  } else if (activeCategory === 'featured') {
    html += `<div class="grid">`;
    visibleProducts.filter(p => p.featured).forEach(p => html += productCardHtml(p, bulkEligible));
    html += `</div>`;
  } else {
    html += `<div class="grid">`;
    list.forEach(p => html += productCardHtml(p, bulkEligible));
    html += `</div>`;
  }

  container.innerHTML = html;
  attachCardListeners();
}

function productCardHtml(p, bulkEligible) {
  const qty = cart[p.id] || 0; // en unités réelles
  const lots = p.unitStep > 1 ? Math.round(qty / p.unitStep) : qty;
  const img = p.image || '';
  const unitTag = p.unitStep > 1 ? `<span class="t-unit">📦 Lot de ${p.unitStep}</span>` : '';
  const sizeCornerBadge = p.size ? `<div class="size-corner-badge">${escapeHtml(p.size)}</div>` : '';
  bulkEligible = bulkEligible || getBulkEligibleCategories();
  const effectivePrice = getEffectivePrice(p, bulkEligible);
  const isBulk = effectivePrice !== p.price;
  const priceDisplay = isBulk
    ? `<span class="price bulk">${fmtPrice(effectivePrice).replace(' €','').split(',')[0]}<span class="cents">,${fmtPrice(effectivePrice).split(',')[1]}</span></span>`
    : `<span class="price">${fmtPrice(p.price).replace(' €','').split(',')[0]}<span class="cents">,${fmtPrice(p.price).split(',')[1]}</span></span>`;

  if (p.outOfStock) {
    return `
    <div class="ticket out-of-stock" data-id="${p.id}">
      <div class="ticket-main">
        <div class="ticket-img-wrap" data-detailid="${p.id}">
          <img src="${img}" alt="${escapeHtml(p.name)}" loading="lazy">
          <span class="stamp">RÉF<br>${escapeHtml(p.ref)}</span>
          ${sizeCornerBadge}
          <div class="stock-banner">Rupture de stock</div>
        </div>
        <div class="ticket-body">
          <div class="t-name">${escapeHtml(p.name)}</div>
          <div class="t-ref">Réf. ${escapeHtml(p.ref)}</div>
          ${unitTag}
        </div>
      </div>
      <div class="perf-seam"></div>
      <div class="ticket-stub">
        ${priceDisplay}
        <span class="stock-label">Indisponible</span>
      </div>
    </div>`;
  }

  return `
  <div class="ticket" data-id="${p.id}">
    <div class="ticket-main">
      <div class="ticket-img-wrap" data-detailid="${p.id}">
        <img src="${img}" alt="${escapeHtml(p.name)}" loading="lazy">
        <span class="stamp">RÉF<br>${escapeHtml(p.ref)}</span>
        ${sizeCornerBadge}
      </div>
      <div class="ticket-body">
        <div class="t-name">${escapeHtml(p.name)}</div>
        <div class="t-ref">Réf. ${escapeHtml(p.ref)}</div>
        ${unitTag}
      </div>
    </div>
    <div class="perf-seam"></div>
    <div class="ticket-stub">
      ${priceDisplay}
      ${lots > 0 ? `
        <div class="qty-control">
          <button class="qty-minus" data-id="${p.id}">−</button>
          <input type="number" class="qty-input" data-id="${p.id}" value="${qty}" min="0" inputmode="numeric">
          <button class="qty-plus" data-id="${p.id}">+</button>
        </div>
      ` : `
        <button class="add-btn" data-id="${p.id}">+</button>
      `}
    </div>
  </div>`;
}

/* Ajuste dynamiquement la largeur d'un champ de quantité selon le
   nombre de caractères affichés, pour que les nombres à 3+ chiffres
   (ex. 120, 1000) restent toujours entièrement visibles au lieu d'être
   coupés par la largeur fixe d'origine. */
function resizeQtyInput(input) {
  const len = String(input.value || '0').length;
  const fontSize = parseFloat(getComputedStyle(input).fontSize) || 12.5;
  const charWidth = fontSize * 0.62;
  input.style.width = Math.max(24, Math.ceil(len * charWidth + 8)) + 'px';
}

function attachCardListeners() {
  document.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, 1, btn));
  });
  document.querySelectorAll('.qty-plus').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, 1));
  });
  document.querySelectorAll('.qty-minus').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, -1));
  });
  document.querySelectorAll('.qty-input').forEach(inp => {
    resizeQtyInput(inp);
    inp.addEventListener('input', () => resizeQtyInput(inp));
    inp.addEventListener('change', () => setCartQtyLots(inp.dataset.id, inp.value));
    inp.addEventListener('click', (e) => e.target.select());
  });
  // Le clic sur la photo n'ouvre plus le tiroir de détail produit (retiré
  // sur demande) : on reste simplement sur la grille du catalogue.
  observeCardsForScrollReveal();
}

/* Observateur unique et réutilisé (plutôt qu'une instance par carte,
   trop coûteuse) qui ajoute la classe "in-view" à chaque carte au
   moment où elle entre dans l'écran pendant le défilement, déclenchant
   un fondu + léger glissement vers le haut défini en CSS. Rend le
   défilement du catalogue plus agréable visuellement sans aucun coût de
   performance notable (l'observation est passive, gérée par le
   navigateur). */
let scrollRevealObserver = null;
function observeCardsForScrollReveal(selector) {
  selector = selector || '.ticket';
  if (!('IntersectionObserver' in window)) {
    document.querySelectorAll(selector).forEach(el => el.classList.add('in-view'));
    return;
  }
  if (!scrollRevealObserver) {
    scrollRevealObserver = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const el = entry.target;
          el.classList.add('animating');
          // requestAnimationFrame garantit que will-change est bien
          // appliqué par le navigateur avant le changement d'état qui
          // déclenche la transition (sinon le navigateur peut "rater"
          // l'optimisation sur certains appareils).
          requestAnimationFrame(() => {
            el.classList.add('in-view');
            setTimeout(() => el.classList.remove('animating'), 170);
          });
          scrollRevealObserver.unobserve(el);
        }
      });
    }, { rootMargin: '150px 0px 0px 0px', threshold: 0 });
  }
  document.querySelectorAll(`${selector}:not(.in-view)`).forEach(el => {
    scrollRevealObserver.observe(el);
  });
}

/* Construit uniquement le contenu du "ticket-stub" (prix + bouton/qty)
   pour un produit donné, identique à ce que produit productCardHtml(). */
function ticketStubInnerHtml(p) {
  const qty = cart[p.id] || 0;
  const lots = p.unitStep > 1 ? Math.round(qty / p.unitStep) : qty;
  const bulkEligible = getBulkEligibleCategories();
  const effectivePrice = getEffectivePrice(p, bulkEligible);
  const isBulk = effectivePrice !== p.price;
  const priceDisplay = isBulk
    ? `<span class="price bulk">${fmtPrice(effectivePrice).replace(' €','').split(',')[0]}<span class="cents">,${fmtPrice(effectivePrice).split(',')[1]}</span></span>`
    : `<span class="price">${fmtPrice(p.price).replace(' €','').split(',')[0]}<span class="cents">,${fmtPrice(p.price).split(',')[1]}</span></span>`;

  if (p.outOfStock) {
    return `${priceDisplay}<span class="stock-label">Indisponible</span>`;
  }

  return `
    ${priceDisplay}
    ${lots > 0 ? `
      <div class="qty-control">
        <button class="qty-minus" data-id="${p.id}">−</button>
        <input type="number" class="qty-input" data-id="${p.id}" value="${qty}" min="0" inputmode="numeric">
        <button class="qty-plus" data-id="${p.id}">+</button>
      </div>
    ` : `
      <button class="add-btn" data-id="${p.id}">+</button>
    `}`;
}

/* Met à jour, dans toute la page, uniquement les cartes correspondant à
   ce produit (prix + zone quantité), sans reconstruire toute la grille.
   C'est ce qui évite le ralentissement perceptible dans "Tout" : avant,
   chaque clic +/- déclenchait un renderGrid() complet sur ~900 produits ;
   maintenant, seules les quelques cartes de CE produit sont retouchées. */
function patchProductCardsInPlace(productId) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  document.querySelectorAll(`.ticket[data-id="${productId}"] .ticket-stub`).forEach(stub => {
    stub.innerHTML = ticketStubInnerHtml(p);
    attachStubListeners(stub);
  });
}

/* Réattache les écouteurs +/- et l'input quantité juste après un patch
   ciblé (le innerHTML précédent a été remplacé, donc les anciens
   écouteurs ont disparu avec lui). */
function attachStubListeners(stub) {
  stub.querySelectorAll('.add-btn').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, 1, btn));
  });
  stub.querySelectorAll('.qty-plus').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, 1));
  });
  stub.querySelectorAll('.qty-minus').forEach(btn => {
    btn.addEventListener('click', () => addToCart(btn.dataset.id, -1));
  });
  stub.querySelectorAll('.qty-input').forEach(inp => {
    resizeQtyInput(inp);
    inp.addEventListener('input', () => resizeQtyInput(inp));
    inp.addEventListener('change', () => setCartQtyLots(inp.dataset.id, inp.value));
    inp.addEventListener('click', (e) => e.target.select());
  });
}

/* Joue une petite animation de "pop" + halo sur le bouton +, pour un
   retour visuel agréable à l'ajout (appelée juste après le patch ciblé,
   donc sur le nouveau bouton qui vient d'être inséré). */
function playAddPulse(productId) {
  document.querySelectorAll(`.ticket[data-id="${productId}"] .add-btn, .ticket[data-id="${productId}"] .qty-plus`).forEach(btn => {
    btn.classList.remove('pop');
    // force un reflow pour pouvoir relancer l'animation si cliqué plusieurs fois vite
    void btn.offsetWidth;
    btn.classList.add('pop');
  });
  const badge = document.getElementById('cartBadge');
  if (badge) {
    badge.classList.remove('bump');
    void badge.offsetWidth;
    badge.classList.add('bump');
  }
}

/* =========================================================
   DÉTAIL PRODUIT (drawer affiché au clic sur la photo d'un produit)
   ========================================================= */
function openProductDetail(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;

  const qty = cart[p.id] || 0;
  const lots = p.unitStep > 1 ? Math.round(qty / p.unitStep) : qty;
  const bulkEligible = getBulkEligibleCategories();
  const effectivePrice = getEffectivePrice(p, bulkEligible);
  const isBulk = effectivePrice !== p.price;
  const unitTag = p.unitStep > 1 ? `<span class="t-unit">📦 Lot de ${p.unitStep}</span>` : '';

  const body = document.getElementById('productDetailBody');
  body.innerHTML = `
    <div class="ticket-img-wrap" style="aspect-ratio:1/1;border-radius:14px;margin-bottom:16px;">
      <img src="${p.image || ''}" alt="${escapeHtml(p.name)}">
    </div>
    <div class="t-name" style="font-size:18px;-webkit-line-clamp:none;min-height:auto;margin-bottom:6px;">${escapeHtml(p.name)}</div>
    <div class="t-ref" style="font-size:11px;">Réf. ${escapeHtml(p.ref)}</div>
    ${unitTag}
    <div style="margin-top:14px;font-family:'Fraunces',serif;font-weight:700;font-size:24px;color:var(--ink, #1A1814);">
      ${isBulk ? `<span class="old-price">${fmtPrice(p.price)}</span> ` : ''}${fmtPrice(effectivePrice)}
    </div>
    ${p.outOfStock ? `<div class="stock-label" style="margin-top:8px;">Rupture de stock — indisponible</div>` : ''}
  `;

  const footer = document.getElementById('productDetailFooter');
  if (p.outOfStock) {
    footer.innerHTML = `<button class="btn-secondary" disabled style="opacity:0.5;">Indisponible</button>`;
  } else {
    footer.innerHTML = `
      <div class="qty-control" style="justify-content:center;margin-bottom:12px;background:var(--paper-dim, #F7F4EE);">
        <button class="qty-minus" data-id="${p.id}" style="width:38px;height:38px;font-size:18px;">−</button>
        <input type="number" class="qty-input" data-id="${p.id}" value="${qty}" min="0" inputmode="numeric" style="font-size:16px;">
        <button class="qty-plus" data-id="${p.id}" style="width:38px;height:38px;font-size:18px;">+</button>
      </div>
      <button class="btn-primary" id="detailAddToCartBtn" data-id="${p.id}">Ajouter au panier</button>
    `;
    footer.querySelector('.qty-minus').addEventListener('click', () => { addToCart(p.id, -1); openProductDetail(p.id); });
    footer.querySelector('.qty-plus').addEventListener('click', () => { addToCart(p.id, 1); openProductDetail(p.id); });
    resizeQtyInput(footer.querySelector('.qty-input'));
    footer.querySelector('.qty-input').addEventListener('input', (e) => resizeQtyInput(e.target));
    footer.querySelector('.qty-input').addEventListener('change', (e) => { setCartQtyLots(p.id, e.target.value); openProductDetail(p.id); });
    footer.querySelector('#detailAddToCartBtn').addEventListener('click', () => {
      addToCart(p.id, 1);
      showToast(`✓ ${p.ref} ajouté au panier`);
    });
  }

  openDrawer('productDetailDrawer');
}

/* =========================================================
   PANIER (les deltas sont en "lots", convertis en unités réelles)
   ========================================================= */
function addToCart(id, deltaLots, btnEl) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  if (p.outOfStock && deltaLots > 0) {
    showToast('Ce produit est en rupture de stock');
    return;
  }
  const step = p.unitStep || 1;
  const currentQty = cart[id] || 0;
  const newQty = currentQty + deltaLots * step;
  if (newQty <= 0) {
    delete cart[id];
  } else {
    cart[id] = newQty;
  }
  updateCartUI();
  // Ne retouche QUE les cartes de ce produit (pas tout renderGrid()) :
  // c'est ce qui élimine le ralentissement ressenti dans "Tout" où des
  // centaines de cartes étaient reconstruites à chaque clic +/-.
  patchProductCardsInPlace(id);
  if (deltaLots > 0) playAddPulse(id);
}

/* Permet au client de taper directement un nombre de lots dans le champ
   de quantité (au lieu de cliquer +/- plusieurs fois). La valeur saisie
   reste exprimée en lots ; elle est convertie en unités réelles via
   unitStep, comme pour les boutons +/-. */
/* Permet à l'admin de taper directement le nombre d'unités RÉELLES
   souhaité dans le champ de quantité (ex. 57 = exactement 57 unités),
   même pour un produit vendu par lot. Le chiffre tapé n'est PAS
   multiplié par la taille du lot. */
function setCartQtyLots(id, typedValue) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  let units = parseInt(typedValue, 10);
  if (isNaN(units) || units < 0) units = 0;
  if (p.outOfStock && units > 0) {
    showToast('Ce produit est en rupture de stock');
    units = 0;
  }
  if (units <= 0) {
    delete cart[id];
  } else {
    cart[id] = units;
  }
  updateCartUI();
  patchProductCardsInPlace(id);
}
function getBulkEligibleCategories() {
  const categoryQty = {};
  Object.entries(cart).forEach(([id, qty]) => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    categoryQty[p.categoryId] = (categoryQty[p.categoryId] || 0) + qty;
  });

  // Regrouper les catégories par bulkGroupId (catégories sans groupe = groupe solo)
  const groups = {}; // groupKey -> { threshold, price, categoryIds: [] }
  categories.forEach(c => {
    if (!c.bulkThresholdQty || c.bulkPrice == null) return;
    const groupKey = c.bulkGroupId || ('solo:' + c.id);
    if (!groups[groupKey]) {
      groups[groupKey] = { threshold: c.bulkThresholdQty, price: c.bulkPrice, categoryIds: [] };
    }
    groups[groupKey].categoryIds.push(c.id);
  });

  const eligible = {};
  Object.values(groups).forEach(g => {
    const totalQty = g.categoryIds.reduce((sum, cid) => sum + (categoryQty[cid] || 0), 0);
    const isEligible = totalQty >= g.threshold;
    g.categoryIds.forEach(cid => { eligible[cid] = isEligible; });
  });
  return eligible;
}

/* Prix unitaire effectif d'un produit, en tenant compte d'un éventuel
   prix de gros déclenché par la catégorie. */
function getEffectivePrice(product, bulkEligible) {
  const cat = categories.find(c => c.id === product.categoryId);
  if (cat && cat.bulkThresholdQty && cat.bulkPrice != null) {
    const isEligible = bulkEligible ? bulkEligible[cat.id] : getBulkEligibleCategories()[cat.id];
    if (isEligible) return cat.bulkPrice;
  }
  return product.price;
}

function cartTotal() {
  let total = 0, count = 0;
  const bulkEligible = getBulkEligibleCategories();
  Object.entries(cart).forEach(([id, qty]) => {
    const p = products.find(x => x.id === id);
    if (p) {
      const price = getEffectivePrice(p, bulkEligible);
      total += price * qty;
      // Le compteur "articles" affiché au client compte le nombre de
      // lots/sélections, pas les unités réelles à l'intérieur des lots.
      // Ex. 1 lot de 12 ajouté = 1 article (pas 12), pour que le total
      // affiché corresponde à "combien de produits différents tu as
      // pris", et non à la quantité physique totale.
      const step = p.unitStep || 1;
      count += step > 1 ? Math.round(qty / step) : qty;
    }
  });
  return { total, count, bulkEligible };
}

function updateCartUI() {
  saveCartToStorage();
  const { total, count } = cartTotal();
  const badge = document.getElementById('cartBadge');
  const fab = document.getElementById('cartFab');
  if (count > 0) {
    badge.style.display = 'flex';
    badge.textContent = count;
    fab.classList.add('show');
  } else {
    badge.style.display = 'none';
    fab.classList.remove('show');
  }
  document.getElementById('cartFabCount').textContent = count + (count === 1 ? ' article' : ' articles');
  document.getElementById('cartFabTotal').textContent = fmtPrice(total);
  renderCartDrawer();
}

function renderCartDrawer() {
  const body = document.getElementById('cartBody');
  const footer = document.getElementById('cartFooter');
  const ids = Object.keys(cart);

  if (ids.length === 0) {
    body.innerHTML = `<div class="empty-state"><span class="glyph">🧺</span><h3>Votre panier est vide</h3><p>Ajoutez des souvenirs depuis le catalogue.</p></div>`;
    footer.style.display = 'none';
    return;
  }
  footer.style.display = 'block';

  const { bulkEligible } = cartTotal();

  // Regroupe les avertissements de prix de gros par groupe (catégories combinées)
  const bulkGroups = {};
  categories.forEach(c => {
    if (!c.bulkThresholdQty || c.bulkPrice == null) return;
    const groupKey = c.bulkGroupId || ('solo:' + c.id);
    if (!bulkGroups[groupKey]) {
      bulkGroups[groupKey] = { threshold: c.bulkThresholdQty, price: c.bulkPrice, names: [], categoryIds: [] };
    }
    bulkGroups[groupKey].names.push(c.name);
    bulkGroups[groupKey].categoryIds.push(c.id);
  });

  const bulkNotices = [];
  Object.values(bulkGroups).forEach(g => {
    const qtyInGroup = Object.entries(cart).reduce((sum, [id, qty]) => {
      const p = products.find(x => x.id === id);
      return p && g.categoryIds.includes(p.categoryId) ? sum + qty : sum;
    }, 0);
    if (qtyInGroup === 0) return;
    const label = g.names.join(' + ');
    if (qtyInGroup >= g.threshold) {
      bulkNotices.push(`<div class="bulk-notice active">🎉 Tarif de gros activé pour « ${escapeHtml(label)} » : ${fmtPrice(g.price)} / article (${qtyInGroup} articles)</div>`);
    } else {
      const remaining = g.threshold - qtyInGroup;
      bulkNotices.push(`<div class="bulk-notice">Ajoutez encore ${remaining} article(s) « ${escapeHtml(label)} » pour débloquer le tarif de gros à ${fmtPrice(g.price)}/article</div>`);
    }
  });

  let html = bulkNotices.join('');
  ids.forEach(id => {
    const p = products.find(x => x.id === id);
    if (!p) return;
    const qty = cart[id];
    const step = p.unitStep || 1;
    const lots = step > 1 ? Math.round(qty / step) : qty;
    const lotLabel = step > 1 ? `${lots} lot${lots > 1 ? 's' : ''} de ${step} (${qty} unités)` : `${qty}`;
    const effectivePrice = getEffectivePrice(p, bulkEligible);
    const isBulk = effectivePrice !== p.price;
    html += `
    <div class="cart-line" data-id="${id}">
      <img src="${p.image || ''}" alt="">
      <div class="cart-line-info">
        <div class="nm">${escapeHtml(p.name)}</div>
        <div class="rf">Réf. ${escapeHtml(p.ref)} ${step > 1 ? '· ' + lotLabel : ''}</div>
        <div class="cart-line-bottom">
          <div class="qty-control">
            <button class="cl-minus" data-id="${id}">−</button>
            <input type="number" class="qty-input cl-input" data-id="${id}" value="${qty}" min="0" inputmode="numeric">
            <button class="cl-plus" data-id="${id}">+</button>
          </div>
          <span class="cart-line-price">${isBulk ? `<span class="old-price">${fmtPrice(p.price * qty)}</span> ` : ''}${fmtPrice(effectivePrice * qty)}</span>
        </div>
      </div>
    </div>`;
  });
  body.innerHTML = html;

  body.querySelectorAll('.cl-plus').forEach(b => b.addEventListener('click', () => addToCart(b.dataset.id, 1)));
  body.querySelectorAll('.cl-minus').forEach(b => b.addEventListener('click', () => addToCart(b.dataset.id, -1)));
  body.querySelectorAll('.cl-input').forEach(inp => {
    resizeQtyInput(inp);
    inp.addEventListener('input', () => resizeQtyInput(inp));
    inp.addEventListener('change', () => setCartQtyLots(inp.dataset.id, inp.value));
    inp.addEventListener('click', (e) => e.target.select());
  });

  const { total, count } = cartTotal();
  document.getElementById('sumCount').textContent = count;
  document.getElementById('sumTotal').textContent = fmtPrice(total);
}

/* =========================================================
   RECHERCHE
   ========================================================= */
function setupSearch() {
  const input = document.getElementById('searchInput');
  const clearBtn = document.getElementById('searchClear');
  let searchDebounceTimer = null;
  input.addEventListener('input', () => {
    searchTerm = input.value;
    clearBtn.style.display = searchTerm ? 'block' : 'none';
    clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => {
      renderGrid();
    }, 180);
  });
  clearBtn.addEventListener('click', () => {
    input.value = '';
    searchTerm = '';
    clearBtn.style.display = 'none';
    clearTimeout(searchDebounceTimer);
    renderGrid();
    input.focus();
  });
}

/* =========================================================
   COMMANDE — création + stockage dans Supabase
   ========================================================= */
/* Pavé de signature tactile — purement visuel : il sert seulement à
   activer le bouton de confirmation une fois qu'un trait a été dessiné
   ("le client signe pour valider"), pour donner une impression de
   commande soignée et professionnelle. Le dessin lui-même n'est JAMAIS
   converti en image, enregistré, ni envoyé où que ce soit — seul le
   booléen "a signé / pas signé" compte côté code, exactement comme
   demandé. */
let signatureHasDrawn = false;
let signatureDrawing = false;
let signatureCtx = null;
let resizeSignatureCanvas = null; // exposée pour être rappelée à l'ouverture du panneau

function setupSignaturePad() {
  const canvas = document.getElementById('signatureCanvas');
  const clearBtn = document.getElementById('signatureClearBtn');
  const confirmBtn = document.getElementById('confirmSignatureBtn');

  function resizeCanvasToDisplaySize() {
    const rect = canvas.getBoundingClientRect();
    // Le pavé est caché (display:none) à l'initialisation de la page :
    // getBoundingClientRect() renverrait alors 0×0, ce qui casserait
    // tout calcul de position de dessin. On ignore donc silencieusement
    // un appel qui tomberait sur des dimensions nulles — la fonction
    // est rappelée explicitement au moment où le pavé devient visible.
    if (rect.width === 0 || rect.height === 0) return;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = rect.width * ratio;
    canvas.height = rect.height * ratio;
    signatureCtx = canvas.getContext('2d');
    signatureCtx.scale(ratio, ratio);
    signatureCtx.lineWidth = 2.4;
    signatureCtx.lineCap = 'round';
    signatureCtx.lineJoin = 'round';
    signatureCtx.strokeStyle = '#1B2A45';
  }
  resizeSignatureCanvas = resizeCanvasToDisplaySize;
  resizeCanvasToDisplaySize();
  window.addEventListener('resize', resizeCanvasToDisplaySize);

  function getPoint(e) {
    const rect = canvas.getBoundingClientRect();
    const evt = e.touches ? e.touches[0] : e;
    return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
  }
  function startDraw(e) {
    e.preventDefault();
    signatureDrawing = true;
    const p = getPoint(e);
    signatureCtx.beginPath();
    signatureCtx.moveTo(p.x, p.y);
  }
  function moveDraw(e) {
    if (!signatureDrawing) return;
    e.preventDefault();
    const p = getPoint(e);
    signatureCtx.lineTo(p.x, p.y);
    signatureCtx.stroke();
    if (!signatureHasDrawn) {
      signatureHasDrawn = true;
      confirmBtn.disabled = false;
    }
  }
  function endDraw() { signatureDrawing = false; }

  canvas.addEventListener('mousedown', startDraw);
  canvas.addEventListener('mousemove', moveDraw);
  canvas.addEventListener('mouseup', endDraw);
  canvas.addEventListener('mouseleave', endDraw);
  canvas.addEventListener('touchstart', startDraw, { passive: false });
  canvas.addEventListener('touchmove', moveDraw, { passive: false });
  canvas.addEventListener('touchend', endDraw);

  clearBtn.addEventListener('click', () => resetSignaturePad());
}

/* Efface visuellement le pavé et désactive à nouveau le bouton —
   appelée à l'ouverture de chaque nouvelle commande, pour qu'une
   signature précédente ne "traîne" jamais sur la commande suivante. */
function resetSignaturePad() {
  signatureHasDrawn = false;
  const confirmBtn = document.getElementById('confirmSignatureBtn');
  if (confirmBtn) confirmBtn.disabled = true;
  if (signatureCtx) {
    const canvas = document.getElementById('signatureCanvas');
    signatureCtx.clearRect(0, 0, canvas.width, canvas.height);
  }
}

function setupCheckout() {
  document.getElementById('checkoutBtn').addEventListener('click', () => {
    if (Object.keys(cart).length === 0) return;
    closeDrawer('cartDrawer');
    setTimeout(() => {
      openDrawer('checkoutDrawer');
      renderInvoiceSummary();
      // Si Fuaad a déjà renseigné le client dans la fenêtre d'accueil de
      // l'admin, on saute entièrement les champs "Votre nom" / "Nom du
      // magasin" — la confirmation se fait alors par signature tactile
      // plutôt que par un simple bouton, puisque c'est le client qui a
      // la tablette en main en magasin.
      const nameFieldsWrap = document.getElementById('checkoutNameFieldsWrap');
      const prefilledNotice = document.getElementById('checkoutPrefilledNotice');
      const signaturePadWrap = document.getElementById('signaturePadWrap');
      const regularConfirmBtn = document.getElementById('confirmOrderBtn');
      if (prefilledClientName && prefilledClientShop) {
        nameFieldsWrap.style.display = 'none';
        prefilledNotice.style.display = 'block';
        prefilledNotice.textContent = `Commande pour ${prefilledClientName} — ${prefilledClientShop}`;
        signaturePadWrap.style.display = 'block';
        regularConfirmBtn.style.display = 'none';
        resetSignaturePad();
        // Le pavé vient juste de devenir visible : on (re)calcule
        // maintenant ses dimensions réelles pour que le dessin tactile
        // fonctionne correctement (voir le commentaire dans
        // resizeCanvasToDisplaySize plus haut).
        if (resizeSignatureCanvas) resizeSignatureCanvas();
      } else {
        nameFieldsWrap.style.display = 'block';
        prefilledNotice.style.display = 'none';
        signaturePadWrap.style.display = 'none';
        regularConfirmBtn.style.display = 'flex';
      }
    }, 200);
  });

  document.getElementById('confirmOrderBtn').addEventListener('click', async () => {
    // Cas 1 : informations déjà saisies par l'admin — on les utilise
    // directement, sans toucher aux champs (masqués) du formulaire.
    if (prefilledClientName && prefilledClientShop) {
      await submitOrder(prefilledClientName, prefilledClientShop);
      return;
    }

    const nameInput = document.getElementById('clientNameInput');
    const shopInput = document.getElementById('clientShopInput');
    const name = nameInput.value.trim();
    const shopName = shopInput.value.trim();
    const nameError = document.getElementById('clientNameError');
    const shopError = document.getElementById('clientShopError');
    if (!name) {
      nameInput.classList.add('input-error');
      nameError.style.display = 'block';
      nameInput.focus();
      showToast('⚠️ Merci d\'indiquer votre nom');
      return;
    }
    nameInput.classList.remove('input-error');
    nameError.style.display = 'none';
    if (!shopName) {
      shopInput.classList.add('input-error');
      shopError.style.display = 'block';
      shopInput.focus();
      showToast('⚠️ Merci d\'indiquer le nom du magasin');
      return;
    }
    shopInput.classList.remove('input-error');
    shopError.style.display = 'none';
    await submitOrder(name, shopName);
  });

  document.getElementById('confirmSignatureBtn').addEventListener('click', async () => {
    if (!signatureHasDrawn) {
      showToast('✍️ Merci de signer pour confirmer');
      return;
    }
    await submitOrder(prefilledClientName, prefilledClientShop);
  });

  document.getElementById('clientNameInput').addEventListener('input', (e) => {
    if (e.target.value.trim()) {
      e.target.classList.remove('input-error');
      document.getElementById('clientNameError').style.display = 'none';
    }
  });
  document.getElementById('clientShopInput').addEventListener('input', (e) => {
    if (e.target.value.trim()) {
      e.target.classList.remove('input-error');
      document.getElementById('clientShopError').style.display = 'none';
    }
  });

  document.getElementById('clearCartBtn').addEventListener('click', () => {
    if (Object.keys(cart).length === 0) return;
    if (!confirm('Vider le panier ?')) return;
    cart = {};
    updateCartUI();
    renderGrid();
  });
}

function renderInvoiceSummary() {
  const { total, count } = cartTotal();
  const tva = total * TVA_RATE;
  const totalWithTva = total + tva;
  const box = document.getElementById('checkoutInvoiceSummary');
  box.innerHTML = `
    <div class="ln"><span>Sous-total (${count} article${count > 1 ? 's' : ''})</span><span>${fmtPrice(total)}</span></div>
    <div class="ln"><span>TVA (20%)</span><span>${fmtPrice(tva)}</span></div>
    <div class="ln total"><span>Total à payer</span><span>${fmtPrice(totalWithTva)}</span></div>
  `;
}

function sendOrderNotificationEmail(orderNumber, clientName, shopName, items, totalWithTva) {
  if (typeof emailjs === 'undefined') return;
  if (!EMAILJS_SERVICE_ID || EMAILJS_SERVICE_ID.startsWith('REMPLACER')) return;

  const itemsText = items.map(it => `${it.ref} x${it.qty} — ${it.name}`).join('\n');
  const params = {
    to_email: EMAILJS_NOTIFY_EMAIL,
    order_number: orderNumber,
    client_name: clientName,
    shop_name: shopName || '—',
    items_list: itemsText,
    total: fmtPrice(totalWithTva)
  };
  emailjs.send(EMAILJS_SERVICE_ID, EMAILJS_TEMPLATE_ID, params).catch(e => {
    console.warn('Envoi e-mail échoué', e);
  });
}

/* Seuils de chiffre d'affaires mensuel (TTC) qui déclenchent une
   célébration la première fois qu'ils sont dépassés dans le mois.
   Suivi en mémoire (pas persisté) : si la page est rechargée, le seuil
   peut se redéclencher une fois — c'est un compromis volontaire pour
   rester simple, l'effet recherché est ponctuel et sans conséquence. */
const REVENUE_MILESTONES = [500, 1000, 2000, 5000, 10000];
let milestonesHitThisSession = new Set();
let monthRevenueRunningTotal = 0; // approximation locale, voir checkForCelebrationTriggers

/* Célèbre, uniquement côté admin, deux types d'évènements après la
   confirmation d'une commande : (1) la toute première commande du jour
   calendaire, et (2) le franchissement d'un palier de chiffre
   d'affaires mensuel (calculé en cumulant localement les commandes
   confirmées pendant cette session — une approximation volontairement
   simple plutôt qu'un aller-retour serveur, car l'effet est cosmétique
   et non critique). N'est jamais visible côté client. */
function checkForCelebrationTriggers(totalWithTva) {
  if (!adminUnlocked) return;

  const todayStr = new Date().toDateString();
  const ordersToday = knownOrdersLog.filter(o => new Date(o.created_at).toDateString() === todayStr);
  if (ordersToday.length === 1) {
    // Cette commande qu'on vient d'ajouter EST la première du jour.
    showCelebrationModal('🌅', 'Première commande du jour !', 'Bonne journée de ventes qui commence.');
    return; // évite d'empiler deux célébrations sur la même commande
  }

  const now = new Date();
  monthRevenueRunningTotal += totalWithTva;
  for (const milestone of REVENUE_MILESTONES) {
    const key = `${now.getFullYear()}-${now.getMonth()}-${milestone}`;
    if (milestonesHitThisSession.has(key)) continue;
    if (monthRevenueRunningTotal >= milestone) {
      milestonesHitThisSession.add(key);
      showCelebrationModal('🎉', `${milestone}€ ce mois-ci !`, 'Un nouveau palier vient d\'être franchi.');
      break;
    }
  }
}

function showCelebrationModal(emoji, title, subtitle) {
  const modal = document.getElementById('celebrationModal');
  if (!modal) return;
  document.getElementById('celebrationEmoji').textContent = emoji;
  document.getElementById('celebrationTitle').textContent = title;
  document.getElementById('celebrationSubtitle').textContent = subtitle;
  modal.classList.add('show');
  document.getElementById('celebrationOverlay').classList.add('show');
  setTimeout(() => hideCelebrationModal(), 3200);
}
function hideCelebrationModal() {
  const modal = document.getElementById('celebrationModal');
  if (!modal) return;
  modal.classList.remove('show');
  document.getElementById('celebrationOverlay').classList.remove('show');
}

async function submitOrder(clientName, shopName) {
  const { total, count, bulkEligible } = cartTotal();
  const tva = total * TVA_RATE;
  const totalWithTva = total + tva;
  const items = Object.keys(cart).map(id => {
    const p = products.find(x => x.id === id);
    const qty = cart[id];
    const price = getEffectivePrice(p, bulkEligible);
    return { ref: p.ref, name: p.name, qty, price: price, lineTotal: +(price * qty).toFixed(2) };
  });

  const btn = document.getElementById('confirmOrderBtn');
  btn.style.opacity = '0.6';

  try {
    // numéro de commande séquentiel atomique
    const orderNumber = String(settings.next_order_number || 1);

    const { data: insertedOrder, error: insertError } = await supabaseClient.from('orders').insert({
      order_number: orderNumber,
      client_name: clientName,
      shop_name: shopName || null,
      items: items,
      total: total,
      tva: +tva.toFixed(2),
      total_with_tva: +totalWithTva.toFixed(2),
      status: 'nouvelle'
    }).select().single();
    if (insertError) throw insertError;

    const { error: updateError } = await supabaseClient
      .from('settings')
      .update({ next_order_number: (settings.next_order_number || 1) + 1 })
      .eq('id', 1);
    if (updateError) throw updateError;
    settings.next_order_number = (settings.next_order_number || 1) + 1;

    sendOrderNotificationEmail(orderNumber, clientName, shopName, items, totalWithTva);

    // Inscrit cette commande dans le journal permanent des
    // notifications, qu'elle vienne d'un client en ligne ou de
    // quelqu'un (Fuaad, un collègue) utilisant directement la tablette
    // admin — c'est précisément le scénario demandé : être notifié
    // même quand quelqu'un d'autre passe une commande à sa place.
    const nowIso = new Date().toISOString();
    knownOrdersLog = [{ id: insertedOrder.id, order_number: orderNumber, client_name: clientName, shop_name: shopName, created_at: nowIso }].concat(knownOrdersLog);
    knownOrderIds.add(insertedOrder.id);
    renderAdminNotifications();

    // Fige la commission de cette commande dans le registre permanent,
    // AVANT toute possibilité d'archivage ou de suppression future de
    // la commande elle-même — la commission, une fois gagnée, ne doit
    // jamais disparaître même si la commande est supprimée plus tard.
    const commissionInfo = calculateOrderCommission({ shop_name: shopName, total_with_tva: totalWithTva });
    commissionLedger.push({
      orderId: insertedOrder.id,
      orderNumber,
      clientName,
      shopName,
      amount: commissionInfo.amount,
      rate: commissionInfo.rate,
      createdAt: nowIso
    });
    try {
      await supabaseClient.from('settings').update({ commission_ledger: commissionLedger }).eq('id', 1);
    } catch (e) {
      console.error('Enregistrement de la commission échoué', e);
    }

    checkForCelebrationTriggers(totalWithTva);
    if (adminUnlocked) playAdminEntranceChime();

    document.getElementById('successOrderNum').textContent = `Commande n°${orderNumber}`;
    cart = {};
    updateCartUI();
    renderGrid();
    document.getElementById('clientNameInput').value = '';
    document.getElementById('clientShopInput').value = '';
    // Une commande confirmée "consomme" le client pré-rempli : on ne
    // veut surtout pas que le client suivant hérite silencieusement du
    // même nom si Fuaad oublie de relancer la fenêtre d'accueil.
    prefilledClientName = null;
    prefilledClientShop = null;
    sessionStorage.removeItem('prefilled_client_name');
    sessionStorage.removeItem('prefilled_client_shop');
    closeDrawer('checkoutDrawer');
    setTimeout(() => openDrawer('orderSuccessDrawer'), 200);
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de l\'envoi de la commande');
  } finally {
    btn.style.opacity = '1';
  }
}

/* =========================================================
   ADMIN — PIN
   ========================================================= */
/* Persistance du déverrouillage admin : une fois le code entré
   correctement, l'accès reste ouvert même après un rechargement de la
   page, jusqu'à ce que l'utilisateur clique sur "Verrouiller". */
const ADMIN_UNLOCK_KEY = 'souvenirs_paris_admin_unlocked_v1';
function saveAdminUnlockState(unlocked) {
  try {
    if (unlocked) localStorage.setItem(ADMIN_UNLOCK_KEY, '1');
    else localStorage.removeItem(ADMIN_UNLOCK_KEY);
  } catch (e) {
    console.warn('Impossible de sauvegarder l\'état admin', e);
  }
}
function wasAdminPreviouslyUnlocked() {
  try {
    return localStorage.getItem(ADMIN_UNLOCK_KEY) === '1';
  } catch (e) {
    return false;
  }
}
/* Affiche la fenêtre "Pour qui la commande d'aujourd'hui ?" — appelée à
   chaque déverrouillage de l'admin (manuel ou automatique au
   rechargement, ce qui couvre le cas de la tablette qui reste connectée
   en continu). Pré-remplit les champs si un nom/magasin avait déjà été
   saisi plus tôt dans la session, pour ne pas avoir à retaper si Fuaad
   ferme et rouvre la fenêtre sans changer de client. */
function showClientPromptModal() {
  const searchInput = document.getElementById('modalClientSearch');
  const selectedEl = document.getElementById('modalSelectedClient');
  const confirmBtn = document.getElementById('modalConfirmClientBtn');
  if (searchInput) {
    searchInput.value = '';
    selectedEl.style.display = 'none';
    confirmBtn.disabled = true;
  }
  document.getElementById('clientPromptOverlay').classList.add('show');
  document.getElementById('clientPromptModal').classList.add('show');
}

function hideClientPromptModal() {
  document.getElementById('clientPromptOverlay').classList.remove('show');
  document.getElementById('clientPromptModal').classList.remove('show');
}

function setupClientPromptModal() {
  const searchInput = document.getElementById('modalClientSearch');
  const resultsBox = document.getElementById('modalClientResults');
  const selectedEl = document.getElementById('modalSelectedClient');
  const confirmBtn = document.getElementById('modalConfirmClientBtn');
  let searchTimer = null;
  let selectedName = '', selectedShop = '';

  function selectClient(name, shop) {
    selectedName = name;
    selectedShop = shop || '';
    searchInput.value = name;
    selectedEl.textContent = shop ? name + ' — ' + shop : name;
    selectedEl.style.display = 'block';
    resultsBox.classList.remove('show');
    confirmBtn.disabled = false;
  }

  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    selectedEl.style.display = 'none';
    confirmBtn.disabled = true;
    const q = searchInput.value.trim();
    if (q.length < 2) { resultsBox.classList.remove('show'); return; }
    searchTimer = setTimeout(() => {
      const local = allKnownClients.filter(c =>
        c.name.toLowerCase().includes(q.toLowerCase()) ||
        (c.shop || '').toLowerCase().includes(q.toLowerCase())
      ).slice(0, 6);
      const items = local.length > 0 ? local : [{ name: q, shop: '', isNew: true }];
      resultsBox.innerHTML = items.map(c => `
        <div class="address-suggestion-item" data-name="${escapeHtml(c.name)}" data-shop="${escapeHtml(c.shop || '')}">
          ${c.isNew ? '<span style="color:var(--brass);">+ Nouveau : </span>' : ''}
          <strong>${escapeHtml(c.name)}</strong>
          ${c.shop ? '<span style="color:var(--brass);font-size:11px;"> — ' + escapeHtml(c.shop) + '</span>' : ''}
        </div>`).join('');
      resultsBox.classList.add('show');
      resultsBox.querySelectorAll('[data-name]').forEach(el => {
        el.addEventListener('click', () => selectClient(el.dataset.name, el.dataset.shop));
      });
    }, 300);
  });

  document.addEventListener('click', e => {
    if (e.target !== searchInput) resultsBox.classList.remove('show');
  });

  confirmBtn.addEventListener('click', () => {
    prefilledClientName = selectedName;
    prefilledClientShop = selectedShop;
    sessionStorage.setItem('prefilled_client_name', selectedName);
    sessionStorage.setItem('prefilled_client_shop', selectedShop || '');
    hideClientPromptModal();
    showToast('✓ Commande pour ' + selectedName);
  });

  document.getElementById('modalSkipBtn').addEventListener('click', () => {
    prefilledClientName = null;
    prefilledClientShop = null;
    sessionStorage.removeItem('prefilled_client_name');
    sessionStorage.removeItem('prefilled_client_shop');
    hideClientPromptModal();
  });
}

/* Affiche le "Wosam du mois" (certificat de fin de mois) une seule
   fois, juste après le changement de mois calendaire — détecté en
   comparant le mois actuel à settings.last_award_month, persisté côté
   serveur pour ne jamais réapparaître deux fois pour le même mois. */
async function checkMonthlyAward() {
  const now = new Date();
  const currentMonthKey = `${now.getFullYear()}-${now.getMonth()}`;
  if (settings.last_award_month === currentMonthKey) return;

  // On célèbre le mois qui vient de se terminer (le mois précédent),
  // pas le mois en cours qui vient juste de commencer.
  let prevMonth = now.getMonth() - 1, prevYear = now.getFullYear();
  if (prevMonth < 0) { prevMonth = 11; prevYear--; }

  // Si c'est la toute première fois qu'on ouvre l'admin (pas de valeur
  // précédente), on ne célèbre rien rétroactivement — on mémorise juste
  // le mois actuel pour que la prochaine transition de mois déclenche
  // normalement le certificat.
  if (settings.last_award_month) {
    try {
      const orders = await fetchOrdersForMonth(prevYear, prevMonth);
      if (orders.length > 0) {
        let totalRevenue = 0, totalCommission = 0;
        const salesByRef = new Map();
        orders.forEach(o => {
          totalRevenue += o.total_with_tva || 0;
          totalCommission += calculateOrderCommission(o).amount;
          (o.items || []).forEach(item => {
            if (!item.ref) return;
            const existing = salesByRef.get(item.ref) || { name: item.name, qty: 0 };
            existing.qty += item.qty || 0;
            salesByRef.set(item.ref, existing);
          });
        });
        const topProduct = Array.from(salesByRef.values()).sort((a, b) => b.qty - a.qty)[0];
        showMonthlyAwardModal(MONTH_NAMES_FR[prevMonth], prevYear, totalRevenue, totalCommission, topProduct);
      }
    } catch (e) {
      console.warn('Calcul du wosam du mois échoué', e);
    }
  }

  settings.last_award_month = currentMonthKey;
  try {
    await supabaseClient.from('settings').update({ last_award_month: currentMonthKey }).eq('id', 1);
  } catch (e) {
    console.warn('Enregistrement du mois du wosam échoué', e);
  }
}

function showMonthlyAwardModal(monthName, year, revenue, commission, topProduct) {
  document.getElementById('awardMonthLabel').textContent = `${monthName} ${year}`;
  document.getElementById('awardRevenue').textContent = fmtPrice(revenue);
  document.getElementById('awardCommission').textContent = fmtPrice(commission);
  document.getElementById('awardTopProduct').textContent = topProduct ? `${topProduct.name} (${topProduct.qty} vendus)` : '—';
  document.getElementById('monthlyAwardModal').classList.add('show');
  document.getElementById('awardOverlay').classList.add('show');
}
function hideMonthlyAwardModal() {
  document.getElementById('monthlyAwardModal').classList.remove('show');
  document.getElementById('awardOverlay').classList.remove('show');
}

function unlockAdminPanel() {
  adminUnlocked = true;
  saveAdminUnlockState(true);
  document.getElementById('adminLockScreen').style.display = 'none';
  document.getElementById('adminPanel').style.display = 'block';
  playAdminEntranceChime();
  renderAdminProductList();
  renderAdminCatList();
  renderAdminOrderList();
  renderAdminNotifications();
  prefillSettings();
  prefillThemeControls();
  const dateEl = document.getElementById('adminSignatureDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  checkMonthlyAward();
  loadAllClients().then(() => {
    // Si un client a déjà été sélectionné dans cette session (le
    // commerçant a rafraîchi la page par erreur), on le restaure
    // silencieusement sans rouvrir la fenêtre de sélection.
    const savedName = sessionStorage.getItem('prefilled_client_name');
    const savedShop = sessionStorage.getItem('prefilled_client_shop');
    if (savedName) {
      prefilledClientName = savedName;
      prefilledClientShop = savedShop || '';
      showToast(`✓ Client restauré : ${savedName}`);
    } else {
      showClientPromptModal();
    }
  });
}

function setupAdminLock() {
  const inputs = Array.from(document.querySelectorAll('.pin-input input'));
  inputs.forEach((inp, idx) => {
    inp.addEventListener('input', () => {
      inp.value = inp.value.replace(/\D/g, '').slice(0, 1);
      if (inp.value && idx < inputs.length - 1) inputs[idx + 1].focus();
    });
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && !inp.value && idx > 0) inputs[idx - 1].focus();
    });
  });
  document.getElementById('pinSubmit').addEventListener('click', () => {
    const code = inputs.map(i => i.value).join('');
    if (code.length < 4) {
      document.getElementById('pinError').textContent = 'Entrez les 4 chiffres.';
      return;
    }
    if (code === (settings.admin_pin || '1234')) {
      document.getElementById('pinError').textContent = '';
      inputs.forEach(i => i.value = '');
      unlockAdminPanel();
    } else {
      document.getElementById('pinError').textContent = 'Code incorrect, réessayez.';
      inputs.forEach(i => i.value = '');
      inputs[0].focus();
    }
  });
}

function setupAdminTabs() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      ['orders', 'products', 'categories', 'notifications', 'commissions', 'ventes', 'vip', 'carte', 'reorganiser', 'clients', 'settings'].forEach(t => {
        const panel = document.getElementById('tab' + capitalize(t));
        if (t === btn.dataset.tab) {
          panel.style.display = 'block';
          panel.classList.remove('tab-fade-in');
          // Force un reflow pour pouvoir relancer l'animation à chaque clic.
          void panel.offsetWidth;
          panel.classList.add('tab-fade-in');
        } else {
          panel.style.display = 'none';
          panel.classList.remove('tab-fade-in');
        }
      });
      // Toujours repartir des données les plus récentes de la base avant
      // d'afficher la liste des produits : évite qu'un autre appareil
      // resté ouvert (tablette, téléphone) n'écrase un changement récent
      // avec une copie locale obsolète.
      if (btn.dataset.tab === 'products') {
        await refreshAdminProducts();
      }
      if (btn.dataset.tab === 'notifications') {
        renderAdminNotifications();
      }
      if (btn.dataset.tab === 'commissions') {
        renderCommissionsTab();
      }
      if (btn.dataset.tab === 'ventes') {
        renderVentesTab();
      }
      if (btn.dataset.tab === 'vip') {
        renderVipTab();
      }
      if (btn.dataset.tab === 'carte') {
        renderCarteTab();
      }
      if (btn.dataset.tab === 'reorganiser') {
        renderReorganiserCategoryOptions();
        renderReorganiserGrid();
      }
      if (btn.dataset.tab === 'clients') {
        showClientsList();
        loadAllClients().then(() => renderClientsList());
      }
    });
  });
}
function capitalize(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* Recharge uniquement les produits depuis la base (sans toucher au
   panier ni aux catégories) et redessine la liste admin + le catalogue
   public, pour que l'admin voie toujours l'état réel le plus récent. */
async function refreshAdminProducts() {
  const list = document.getElementById('adminProductList');
  const previousHtml = list.innerHTML;
  list.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  try {
    const allProducts = await fetchAllProductsFromDB();
    products = allProducts.map(mapDbProductToLocal);
    renderAdminProductList();
    renderGrid();
    renderHomeTiles();
    renderCategoryStrip();
  } catch (e) {
    console.error('Erreur de rafraîchissement des produits', e);
    list.innerHTML = previousHtml;
    showToast('⚠️ Impossible de rafraîchir les produits');
  }
}

/* =========================================================
   ADMIN — Commandes
   ========================================================= */
/* Texte affiché sur le bouton de commission d'une commande : reflète
   le taux réellement figé dans le registre permanent s'il existe déjà
   une entrée pour cette commande, sinon le taux qui serait appliqué
   automatiquement par défaut (avant toute bascule manuelle). */
function getCommissionBadgeText(order) {
  const entry = commissionLedger.find(e => String(e.orderId) === String(order.id));
  if (entry) return `${entry.rate}% — ${fmtPrice(entry.amount)} (toucher pour changer)`;
  const { rate } = calculateOrderCommission(order);
  return `${rate}% (taux par défaut — toucher pour fixer)`;
}

/* Bascule manuellement le taux de commission d'UNE commande précise
   entre 2% et 0,5%, indépendamment du nom du magasin — exactement la
   fonctionnalité demandée : Fuaad choisit lui-même le taux d'une
   commande en particulier d'un simple geste. Met à jour (ou crée s'il
   n'existait pas encore) l'entrée correspondante dans le registre
   permanent des commissions, recalculée sur le Sous-total HT. */
async function toggleOrderCommissionRate(orderId, montantHT, shopName) {
  const existingIdx = commissionLedger.findIndex(e => String(e.orderId) === String(orderId));
  const currentRate = existingIdx >= 0 ? commissionLedger[existingIdx].rate : calculateOrderCommission({ shop_name: shopName, total: montantHT }).rate;
  const newRate = currentRate === 2 ? 0.5 : 2;
  const newAmount = +(montantHT * newRate / 100).toFixed(2);

  if (existingIdx >= 0) {
    commissionLedger[existingIdx].rate = newRate;
    commissionLedger[existingIdx].amount = newAmount;
  } else {
    // Commande passée avant la mise en place du registre permanent :
    // on crée son entrée maintenant, avec le taux choisi ici.
    commissionLedger.push({
      orderId, orderNumber: '?', clientName: '', shopName,
      amount: newAmount, rate: newRate, createdAt: new Date().toISOString()
    });
  }

  try {
    await supabaseClient.from('settings').update({ commission_ledger: commissionLedger }).eq('id', 1);
    showToast(`✓ Commission fixée à ${newRate}% (${fmtPrice(newAmount)})`);
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de l\'enregistrement');
  }
  // Mise à jour ciblée du seul bouton concerné — jamais un
  // ré-affichage complet de la liste, qui ferait sauter le défilement
  // en haut de page et donnerait l'impression que rien ne change.
  const btn = document.querySelector(`[data-commission-order-id="${orderId}"]`);
  if (btn) btn.textContent = `${newRate}% — ${fmtPrice(newAmount)} (toucher pour changer)`;
}

async function renderAdminOrderList() {
  const list = document.getElementById('adminOrderList');
  list.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  try {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('*')
      .eq('archived', false)
      .order('created_at', { ascending: false })
      .limit(100);
    if (error) throw error;
    if (!data || data.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="glyph">🎫</span><h3>Aucune commande</h3><p>Les commandes des clients apparaîtront ici.</p></div>`;
      return;
    }
    let html = '';
    data.forEach(o => {
      const date = new Date(o.created_at);
      const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const itemsLines = (o.items || []).map(it => `<strong>${escapeHtml(it.ref)}</strong> x${it.qty} — ${escapeHtml(it.name)}`).join('<br>');
      const clientLine = o.shop_name
        ? `${escapeHtml(o.client_name || 'Client')} <span style="opacity:0.6;font-weight:500;">— ${escapeHtml(o.shop_name)}</span>`
        : escapeHtml(o.client_name || 'Client');
      const totalWithTva = o.total_with_tva != null ? Number(o.total_with_tva) : Number(o.total);
      const tvaLine = o.tva != null
        ? `<div style="font-size:11px;color:#7a6f5c;margin-top:4px;">Sous-total ${fmtPrice(Number(o.total))} + TVA 20% (${fmtPrice(Number(o.tva))})</div>`
        : '';
      html += `
      <div class="order-card" data-order-id="${o.id}">
        <div class="oc-top">
          <span class="oc-num">Commande n°${escapeHtml(o.order_number)}</span>
          <span class="oc-date">${dateStr}</span>
        </div>
        <div class="oc-client">${clientLine}</div>
        <div class="oc-items">${itemsLines}</div>
        ${tvaLine}
        <div class="oc-bottom">
          <span class="oc-total">${fmtPrice(totalWithTva)}</span>
          <select class="status-select" data-order-id="${o.id}">
            <option value="nouvelle" ${o.status === 'nouvelle' ? 'selected' : ''}><svg class="ic" style="width:13px;height:13px;vertical-align:middle;margin-right:3px;stroke:#D89A2C;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><use href="#ic-plus"/></svg> Nouvelle</option>
            <option value="en_cours" ${o.status === 'en_cours' ? 'selected' : ''}> En cours</option>
            <option value="terminee" ${o.status === 'terminee' ? 'selected' : ''}> Terminée</option>
          </select>
        </div>
        <div class="oc-commission-row">
          <span class="oc-commission-label">💰 Commission appliquée :</span>
          <button class="oc-commission-toggle" data-commission-order-id="${o.id}" data-order-ht="${o.total}" data-order-shop="${escapeHtml(o.shop_name || '')}">
            ${getCommissionBadgeText(o)}
          </button>
        </div>
        <div class="oc-notes-wrap">
          <label class="oc-notes-label">📝 Note interne</label>
          <textarea class="oc-notes-input" data-order-id="${o.id}" placeholder="Ex. Appeler le client avant livraison…">${escapeHtml(o.notes || '')}</textarea>
        </div>
        <button class="copy-order-btn" data-copyitems='${escapeHtml(JSON.stringify(o.items || []))}'><svg class="ic"><use href="#ic-copy"/></svg> Copier</button>
        <div class="assign-client-wrap" data-order-id="${o.id}">
          <button class="assign-client-btn" data-assign-order-id="${o.id}" data-assign-order-num="${escapeHtml(o.order_number)}"><svg class="ic"><use href="#ic-send"/></svg> Envoyer au client</button>
          <div class="assign-client-results address-suggestions-box"></div>
        </div>
        <div class="oc-action-row">
          <button class="oc-archive-btn" data-archiveorder="${o.id}"><svg class="ic"><use href="#ic-archive"/></svg> Archiver</button>
          <button class="oc-delete-btn" data-delorder-active="${o.id}"><svg class="ic"><use href="#ic-trash"/></svg> Supprimer</button>
        </div>
      </div>`;
    });
    list.innerHTML = html;
    observeCardsForScrollReveal('.order-card');
    list.querySelectorAll('[data-commission-order-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        toggleOrderCommissionRate(btn.dataset.commissionOrderId, parseFloat(btn.dataset.orderHt), btn.dataset.orderShop);
      });
    });
    list.querySelectorAll('.copy-order-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        let items = [];
        try { items = JSON.parse(btn.dataset.copyitems); } catch (e) { items = []; }
        const text = items.map(it => `${it.ref} x${it.qty}`).join('\n');
        try {
          await navigator.clipboard.writeText(text);
          showToast('✓ Copié dans le presse-papiers');
        } catch (e) {
          showToast('⚠️ Copie impossible sur cet appareil');
        }
      });
    });
    list.querySelectorAll('[data-delorder-active]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer DÉFINITIVEMENT cette commande ? Cette action est irréversible.')) return;
        const { error } = await supabaseClient.from('orders').delete().eq('id', btn.dataset.delorderActive);
        if (error) { showToast('⚠️ Erreur lors de la suppression'); return; }
        showToast('Commande supprimée définitivement');
        renderAdminOrderList();
      });
    });
    list.querySelectorAll('.oc-notes-input').forEach(textarea => {
      let noteSaveTimer = null;
      textarea.addEventListener('input', () => {
        clearTimeout(noteSaveTimer);
        noteSaveTimer = setTimeout(async () => {
          const { error } = await supabaseClient.from('orders').update({ notes: textarea.value }).eq('id', textarea.dataset.orderId);
          if (!error) showToast('✓ Note enregistrée');
        }, 600);
      });
    });
    list.querySelectorAll('.status-select').forEach(sel => {
      sel.addEventListener('change', async () => {
        sel.parentElement.parentElement.classList.add('status-just-changed');
        const { error } = await supabaseClient.from('orders').update({ status: sel.value }).eq('id', sel.dataset.orderId);
        if (error) showToast('Erreur de mise à jour');
        else showToast('Statut mis à jour');
        setTimeout(() => sel.parentElement.parentElement.classList.remove('status-just-changed'), 600);
      });
    });

    // Bouton "Envoyer au client" — ouvre la modale de sélection
    list.querySelectorAll('[data-assign-order-id]').forEach(btn => {
      btn.addEventListener('click', () => openAssignClientModal(btn.dataset.assignOrderId, btn.dataset.assignOrderNum));
    });

    list.querySelectorAll('[data-archiveorder]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Archiver cette commande ? Elle disparaîtra de cette liste mais restera consultable dans l\'onglet "Archivées".')) return;
        const { error } = await supabaseClient.from('orders').update({ archived: true }).eq('id', btn.dataset.archiveorder);
        if (error) { showToast('⚠️ Erreur lors de l\'archivage'); return; }
        showToast('Commande archivée');
        renderAdminOrderList();
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message || '')}</p></div>`;
  }
}

/* Liste des commandes archivées : permet de les consulter, les
   désarchiver (retour à la liste normale), ou de les supprimer
   définitivement si besoin. */
async function renderArchivedOrderList() {
  const list = document.getElementById('adminArchivedOrderList');
  if (!list) return;
  list.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  try {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('*')
      .eq('archived', true)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    if (!data || data.length === 0) {
      list.innerHTML = `<div class="empty-state"><span class="glyph">🗂</span><h3>Aucune commande archivée</h3></div>`;
      return;
    }
    let html = '';
    data.forEach(o => {
      const date = new Date(o.created_at);
      const dateStr = date.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' }) + ' ' + date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
      const itemsLines = (o.items || []).map(it => `<strong>${escapeHtml(it.ref)}</strong> x${it.qty} — ${escapeHtml(it.name)}`).join('<br>');
      const clientLine = o.shop_name
        ? `${escapeHtml(o.client_name || 'Client')} <span style="opacity:0.6;font-weight:500;">— ${escapeHtml(o.shop_name)}</span>`
        : escapeHtml(o.client_name || 'Client');
      const totalWithTva = o.total_with_tva != null ? Number(o.total_with_tva) : Number(o.total);
      const notesLine = o.notes && o.notes.trim()
        ? `<div class="oc-notes-display">📝 ${escapeHtml(o.notes)}</div>`
        : '';
      html += `
      <div class="order-card" data-order-id="${o.id}">
        <div class="oc-top">
          <span class="oc-num">Commande n°${escapeHtml(o.order_number)}</span>
          <span class="oc-date">${dateStr}</span>
        </div>
        <div class="oc-client">${clientLine}</div>
        <div class="oc-items">${itemsLines}</div>
        ${notesLine}
        <div class="oc-bottom">
          <span class="oc-total">${fmtPrice(totalWithTva)}</span>
          <span class="status-pill ${o.status}">${o.status === 'nouvelle' ? 'Nouvelle' : o.status === 'en_cours' ? 'En cours' : 'Terminée'}</span>
        </div>
        <div class="oc-commission-row">
          <span class="oc-commission-label">💰 Commission appliquée :</span>
          <button class="oc-commission-toggle" data-commission-order-id="${o.id}" data-order-ht="${o.total}" data-order-shop="${escapeHtml(o.shop_name || '')}">
            ${getCommissionBadgeText(o)}
          </button>
        </div>
        <button class="copy-order-btn" data-unarchiveorder="${o.id}" style="background:var(--mustard-deep, var(--mustard));"><svg class="ic"><use href="#ic-back"/></svg> Désarchiver</button>
        <button class="delete-order-btn" data-delorder="${o.id}"><svg class="ic"><use href="#ic-trash"/></svg> Suppr. définitivement</button>
      </div>`;
    });
    list.innerHTML = html;
    observeCardsForScrollReveal('.order-card');
    list.querySelectorAll('[data-commission-order-id]').forEach(btn => {
      btn.addEventListener('click', () => {
        toggleOrderCommissionRate(btn.dataset.commissionOrderId, parseFloat(btn.dataset.orderHt), btn.dataset.orderShop);
      });
    });
    list.querySelectorAll('[data-unarchiveorder]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const { error } = await supabaseClient.from('orders').update({ archived: false }).eq('id', btn.dataset.unarchiveorder);
        if (error) { showToast('⚠️ Erreur'); return; }
        showToast('✓ Commande désarchivée');
        renderArchivedOrderList();
        renderAdminOrderList();
      });
    });
    list.querySelectorAll('[data-delorder]').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Supprimer DÉFINITIVEMENT cette commande ? Cette action est irréversible.')) return;
        const { error } = await supabaseClient.from('orders').delete().eq('id', btn.dataset.delorder);
        if (error) { showToast('⚠️ Erreur lors de la suppression'); return; }
        showToast('Commande supprimée définitivement');
        renderArchivedOrderList();
      });
    });
  } catch (e) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message || '')}</p></div>`;
  }
}

/* =========================================================
   ADMIN — Produits
   ========================================================= */
let adminProductSearchTerm = '';

function renderAdminProductList() {
  const list = document.getElementById('adminProductList');
  const q = adminProductSearchTerm.trim().toLowerCase();

  // Tant qu'aucune recherche n'est tapée, on n'affiche rien : avec ~900
  // produits, construire toute la liste (des milliers d'éléments DOM)
  // à chaque ouverture de l'onglet rendait le défilement de l'admin très
  // lourd. La liste ne se construit donc plus qu'à partir des résultats
  // de recherche réels, ce qui élimine ce poids inutile.
  if (!q) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">🔎</span><h3>Tapez une référence ou un nom</h3><p>Les produits correspondants s'afficheront ici.</p></div>`;
    return;
  }

  const displayProducts = products.filter(p => p.ref.toLowerCase().includes(q) || p.name.toLowerCase().includes(q));
  if (displayProducts.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">📦</span><h3>Aucun résultat</h3><p>Essayez une autre référence.</p></div>`;
    return;
  }
  let html = '';
  displayProducts.forEach(p => {
    const cat = categories.find(c => c.id === p.categoryId);
    const unitInfo = p.unitStep > 1 ? ` · lot de ${p.unitStep}` : '';
    const badges = `${p.outOfStock ? ' <span style="color:var(--brick);font-weight:700;">· Rupture</span>' : ''}${p.featured ? ' <span style="color:var(--mustard);font-weight:700;">· ⭐</span>' : ''}${p.hidden ? ' <span style="color:var(--brass);font-weight:700;">· Masqué</span>' : ''}`;
    html += `
    <div class="admin-product-row-wrap">
      <div class="admin-product-row${p.hidden ? ' hidden-product-row' : ''}">
        <img src="${p.image || ''}" alt="">
        <div class="info">
          <div class="nm">${escapeHtml(p.name)}</div>
          <div class="meta">Réf. ${escapeHtml(p.ref)} · ${fmtPrice(p.price)} · ${cat ? escapeHtml(cat.name) : '—'}${unitInfo}${badges}</div>
        </div>
        <div class="admin-row-actions">
          <button class="admin-icon-btn ${p.hidden ? 'active-hide' : ''}" data-hide="${p.id}" title="${p.hidden ? 'Réafficher ce produit' : 'Masquer ce produit'}">${p.hidden ? '👁️‍🗨️' : '👁️'}</button>
          <button class="admin-icon-btn" data-quickphoto="${p.id}" title="Changer la photo rapidement">📷</button>
          <button class="admin-icon-btn" data-lotmenu="${p.id}" title="Définir un lot">📦</button>
          <button class="admin-icon-btn" data-edit="${p.id}">✎</button>
          <button class="admin-icon-btn danger" data-del="${p.id}">🗑</button>
        </div>
      </div>
      <input type="file" accept="image/*" class="quickphoto-input" data-quickphoto-input="${p.id}" style="display:none;">
      <div class="lot-quickpicker" id="lotpicker-${p.id}" style="display:none;">
        <span class="lqp-label">Vente par lot de :</span>
        <button class="lqp-btn ${p.unitStep === 6 ? 'active' : ''}" data-quicklot="${p.id}" data-qty="6">6</button>
        <button class="lqp-btn ${p.unitStep === 10 ? 'active' : ''}" data-quicklot="${p.id}" data-qty="10">10</button>
        <button class="lqp-btn ${p.unitStep === 12 ? 'active' : ''}" data-quicklot="${p.id}" data-qty="12">12</button>
        <button class="lqp-btn unit ${p.unitStep === 1 ? 'active' : ''}" data-quicklot="${p.id}" data-qty="1">À l'unité</button>
      </div>
    </div>`;
  });
  list.innerHTML = html;
  observeCardsForScrollReveal('.admin-product-row-wrap');
  list.querySelectorAll('[data-edit]').forEach(b => b.addEventListener('click', () => openProductForm(b.dataset.edit)));
  list.querySelectorAll('[data-hide]').forEach(b => b.addEventListener('click', () => toggleHideProduct(b.dataset.hide)));
  list.querySelectorAll('[data-quickphoto]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.quickphoto;
    const fileInput = list.querySelector(`[data-quickphoto-input="${id}"]`);
    if (fileInput) fileInput.click();
  }));
  list.querySelectorAll('[data-quickphoto-input]').forEach(input => input.addEventListener('change', (e) => {
    const id = input.dataset.quickphotoInput;
    const file = e.target.files[0];
    if (file) quickSetProductImage(id, file);
    input.value = '';
  }));
  list.querySelectorAll('[data-lotmenu]').forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.lotmenu;
    const picker = document.getElementById('lotpicker-' + id);
    const isOpen = picker.style.display !== 'none';
    list.querySelectorAll('.lot-quickpicker').forEach(p => p.style.display = 'none');
    picker.style.display = isOpen ? 'none' : 'flex';
  }));
  list.querySelectorAll('[data-quicklot]').forEach(b => b.addEventListener('click', async () => {
    const id = b.dataset.quicklot;
    const qty = parseInt(b.dataset.qty, 10);
    await quickSetUnitStep(id, qty);
  }));
  list.querySelectorAll('[data-del]').forEach(b => b.addEventListener('click', () => deleteProduct(b.dataset.del)));
}

/* Bascule l'état masqué/visible d'un produit. Un produit masqué reste
   en base de données (donc récupérable instantanément) mais disparaît
   complètement de la boutique publique (recherche, catégories, tiroir
   catalogue) tant qu'il n'est pas réaffiché depuis l'administration. */
async function toggleHideProduct(id) {
  const p = products.find(x => x.id === id);
  if (!p) return;
  const newHidden = !p.hidden;
  try {
    const { error } = await supabaseClient.from('products').update({ hidden: newHidden }).eq('id', id);
    if (error) throw error;
    p.hidden = newHidden;
    showToast(newHidden ? `✓ ${p.ref} masqué de la boutique` : `✓ ${p.ref} de nouveau visible`);
    renderAdminProductList();
    renderCategoryStrip();
    renderGrid();
    renderHomeTiles();
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la mise à jour');
  }
}

/* Remplace rapidement la photo d'un produit depuis la liste admin,
   sans passer par le formulaire complet. Aucun traitement (pas de
   détourage) : la photo est juste redimensionnée puis enregistrée
   immédiatement. */
/* Envoie un fichier image vers le bucket Storage "Product-images" et
   retourne son adresse publique. Le nom de fichier inclut toujours un
   horodatage unique : ainsi, à chaque nouvelle photo, l'adresse change
   complètement — c'est ce qui garantit qu'un client voit la nouvelle
   photo dès son prochain rafraîchissement, sans jamais rester bloqué
   sur une ancienne version mise en cache par son navigateur (un cache
   ne peut "se souvenir" que d'une adresse qu'il a déjà vue ; une
   adresse neuve est toujours redemandée). */
async function uploadImageToStorage(blob, idHint) {
  const ext = blob.type && blob.type.includes('png') ? 'png' : 'jpg';
  const fileName = `${idHint || 'img'}-v${Date.now()}.${ext}`;
  const { error } = await supabaseClient.storage
    .from('Product-images')
    .upload(fileName, blob, { contentType: blob.type || 'image/jpeg', cacheControl: '31536000' });
  if (error) throw error;
  const { data } = supabaseClient.storage.from('Product-images').getPublicUrl(fileName);
  return data.publicUrl;
}

function quickSetProductImage(productId, file) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  if (file.size > 6 * 1024 * 1024) {
    showToast('Image trop lourde (max 6 Mo)');
    return;
  }
  showToast('⏳ Envoi de la photo…');

  (async () => {
    try {
      const publicUrl = await uploadImageToStorage(file, productId);
      const { error } = await supabaseClient.from('products').update({ image: publicUrl }).eq('id', productId);
      if (error) throw error;
      p.image = publicUrl;
      showToast(`✓ Photo de ${p.ref} mise à jour`);
      renderAdminProductList();
      renderGrid();
      renderHomeTiles();
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de l\'enregistrement de la photo');
    }
  })();
}

/* Définit une photo de couverture personnalisée pour une catégorie,
   utilisée dans la mosaïque du tiroir "Catalogue" à la place de la
   première photo de produit prise automatiquement. Même traitement
   (redimensionnement, compression) que pour les photos de produit. */
function setCategoryCoverImage(categoryId, file) {
  const cat = categories.find(c => c.id === categoryId);
  if (!cat) return;
  if (file.size > 6 * 1024 * 1024) {
    showToast('Image trop lourde (max 6 Mo)');
    return;
  }
  showToast('⏳ Envoi de la photo…');
  (async () => {
    try {
      const publicUrl = await uploadImageToStorage(file, 'cat-' + categoryId);
      const { error } = await supabaseClient.from('categories').update({ cover_image: publicUrl }).eq('id', categoryId);
      if (error) throw error;
      cat.coverImage = publicUrl;
      showToast(`✓ Photo de « ${cat.name} » mise à jour`);
      renderAdminCatList();
      renderHomeTiles();
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de l\'enregistrement de la photo');
    }
  })();
}

async function resetCategoryCoverImage(categoryId) {
  const cat = categories.find(c => c.id === categoryId);
  if (!cat) return;
  try {
    const { error } = await supabaseClient.from('categories').update({ cover_image: null }).eq('id', categoryId);
    if (error) throw error;
    cat.coverImage = null;
    showToast(`✓ Photo de « ${cat.name} » réinitialisée`);
    renderAdminCatList();
    renderHomeTiles();
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la réinitialisation');
  }
}

async function quickSetUnitStep(productId, qty) {
  const p = products.find(x => x.id === productId);
  if (!p) return;
  const unitStep = qty;
  const unitLabel = qty > 1 ? `Lot de ${qty}` : '';
  try {
    const { error } = await supabaseClient.from('products').update({
      unit_step: unitStep, unit_label: unitLabel
    }).eq('id', productId);
    if (error) throw error;
    p.unitStep = unitStep;
    p.unitLabel = unitLabel;
    showToast(qty > 1 ? `✓ ${p.ref} vendu par lot de ${qty}` : `✓ ${p.ref} vendu à l'unité`);
    renderAdminProductList();
    renderGrid();
  } catch (e) {
    showToast('⚠️ Erreur lors de la mise à jour');
  }
}


async function deleteProduct(id) {
  if (!confirm('Supprimer ce produit définitivement ?')) return;
  try {
    const { error } = await supabaseClient.from('products').delete().eq('id', id);
    if (error) throw error;
    products = products.filter(p => p.id !== id);
    delete cart[id];
    renderAdminProductList();
    renderCategoryStrip();
    renderGrid();
    updateCartUI();
    showToast('Produit supprimé');
  } catch (e) {
    showToast('⚠️ Erreur lors de la suppression');
  }
}

/* =========================================================
   ADMIN — Catégories
   ========================================================= */
/* Réordonne les catégories (haut/bas/début/fin), met à jour sort_order
   pour TOUTES les catégories en conséquence, et sauvegarde le nouvel
   ordre dans Supabase. Le catalogue public et la liste admin sont
   redessinés immédiatement après. */
async function moveCategory(categoryId, action) {
  const idx = categories.findIndex(c => c.id === categoryId);
  if (idx === -1) return;

  let newIdx = idx;
  if (action === 'up') newIdx = Math.max(0, idx - 1);
  else if (action === 'down') newIdx = Math.min(categories.length - 1, idx + 1);
  else if (action === 'totop') newIdx = 0;
  else if (action === 'tobottom') newIdx = categories.length - 1;

  if (newIdx === idx) return;

  const [moved] = categories.splice(idx, 1);
  categories.splice(newIdx, 0, moved);

  // Réassigne un sort_order séquentiel propre à toutes les catégories
  categories.forEach((c, i) => { c.sort_order = i + 1; });

  renderAdminCatList();
  renderCategoryStrip();
  renderGrid();
  renderHomeTiles();

  try {
    const updates = categories.map(c => supabaseClient.from('categories').update({ sort_order: c.sort_order }).eq('id', c.id));
    const results = await Promise.all(updates);
    const failed = results.find(r => r.error);
    if (failed) throw failed.error;
    showToast('✓ Ordre des catégories mis à jour');
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de l\'enregistrement de l\'ordre');
  }
}

/* Construit la liste des notifications de nouvelles commandes, les
   plus récentes en premier. Une commande apparaît ici dès sa
   confirmation et y reste — même après que la commande elle-même soit
   archivée ou supprimée dans l'onglet Commandes — jusqu'à ce que Fuaad
   supprime explicitement la notification elle-même avec le ✕. */
function getOrderNotifications() {
  return knownOrdersLog
    .filter(o => !dismissedNotifications.has(String(o.id)))
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
}

function renderAdminNotifications() {
  const list = document.getElementById('adminNotificationsList');
  if (!list) return;
  const notifs = getOrderNotifications();
  const badge = document.getElementById('notificationsTabBadge');
  if (badge) {
    if (notifs.length > 0) { badge.textContent = notifs.length; badge.style.display = 'inline-block'; }
    else badge.style.display = 'none';
  }

  if (notifs.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">🔔</span><h3>Aucune notification</h3><p>Les nouvelles commandes apparaîtront ici, même si quelqu'un d'autre les passe à votre place.</p></div>`;
    return;
  }

  let html = '';
  notifs.forEach(o => {
    const dateStr = new Date(o.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    html += `
    <div class="order-notif-card">
      <div class="order-notif-icon">🛍️</div>
      <div class="order-notif-info">
        <div class="order-notif-title">Commande n°${escapeHtml(o.order_number)} — ${escapeHtml(o.client_name)}</div>
        <div class="order-notif-sub">${o.shop_name ? escapeHtml(o.shop_name) + ' · ' : ''}${dateStr}</div>
      </div>
      <button class="stock-alert-dismiss" data-dismiss-notif-id="${o.id}">✕</button>
    </div>`;
  });

  list.innerHTML = html;
  list.querySelectorAll('[data-dismiss-notif-id]').forEach(btn => {
    btn.addEventListener('click', () => dismissOrderNotification(btn.dataset.dismissNotifId));
  });
}

/* Supprime définitivement une notification de commande — persisté
   côté serveur pour ne jamais réapparaître après un rechargement. */
async function dismissOrderNotification(orderId) {
  dismissedNotifications.add(String(orderId));
  try {
    const { error } = await supabaseClient
      .from('settings')
      .update({ dismissed_notifications: Array.from(dismissedNotifications) })
      .eq('id', 1);
    if (error) throw error;
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la suppression de la notification');
  }
  renderAdminNotifications();
}

/* Récupère TOUTES les commandes (page par page, pour ne jamais
   plafonner silencieusement si un mois est très chargé) dont la date de
   création tombe dans les bornes exactes du mois demandé. Utilisé à la
   fois par l'onglet Commissions et l'onglet Ventes. */
async function fetchOrdersForMonth(year, monthIndex) {
  const { start, end } = getMonthBoundaries(year, monthIndex);
  let all = [];
  let from = 0;
  const pageSize = 200;
  while (true) {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('*')
      .gte('created_at', start.toISOString())
      .lte('created_at', end.toISOString())
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += data.length;
  }
  return all;
}

const MONTH_NAMES_FR = ['Janvier', 'Février', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Août', 'Septembre', 'Octobre', 'Novembre', 'Décembre'];

async function renderCommissionsTab() {
  const monthNav = document.querySelector('#tabCommissions .month-nav');
  const comparisonEl = document.getElementById('commissionComparison');
  const listEl = document.getElementById('commissionOrdersList');

  let entries, periodLabel, comparisonPrevLabel, prevTotal = null;

  if (commissionsPeriodMode === 'total') {
    monthNav.style.display = 'none';
    periodLabel = 'Total général';
    entries = commissionLedger.slice();
  } else if (commissionsPeriodMode === 'week') {
    monthNav.style.display = 'flex';
    const refDate = new Date();
    refDate.setDate(refDate.getDate() + commissionsWeekOffset * 7);
    const { start, end } = getWeekBoundaries(refDate);
    periodLabel = `${start.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })} – ${end.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' })}`;
    entries = commissionLedger.filter(e => { const d = new Date(e.createdAt); return d >= start && d <= end; });
    const prevRef = new Date(refDate); prevRef.setDate(prevRef.getDate() - 7);
    const { start: pStart, end: pEnd } = getWeekBoundaries(prevRef);
    prevTotal = commissionLedger.filter(e => { const d = new Date(e.createdAt); return d >= pStart && d <= pEnd; }).reduce((s, e) => s + e.amount, 0);
    comparisonPrevLabel = 'la semaine précédente';
  } else { // 'month'
    monthNav.style.display = 'flex';
    periodLabel = `${MONTH_NAMES_FR[commissionsViewMonth]} ${commissionsViewYear}`;
    const { start, end } = getMonthBoundaries(commissionsViewYear, commissionsViewMonth);
    entries = commissionLedger.filter(e => { const d = new Date(e.createdAt); return d >= start && d <= end; });
    let prevMonth = commissionsViewMonth - 1, prevYear = commissionsViewYear;
    if (prevMonth < 0) { prevMonth = 11; prevYear--; }
    const { start: pStart, end: pEnd } = getMonthBoundaries(prevYear, prevMonth);
    prevTotal = commissionLedger.filter(e => { const d = new Date(e.createdAt); return d >= pStart && d <= pEnd; }).reduce((s, e) => s + e.amount, 0);
    comparisonPrevLabel = MONTH_NAMES_FR[prevMonth];
  }

  document.getElementById('commissionsMonthLabel').textContent = periodLabel;
  entries = entries.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const totalCommission = entries.reduce((sum, e) => sum + e.amount, 0);

  document.getElementById('commissionTotalAmount').textContent = fmtPrice(totalCommission);
  const periodWord = commissionsPeriodMode === 'total' ? 'au total' : commissionsPeriodMode === 'week' ? 'cette semaine' : 'ce mois-ci';
  document.getElementById('commissionTotalSub').textContent = `${entries.length} commande${entries.length !== 1 ? 's' : ''} ${periodWord}`;

  if (prevTotal != null && prevTotal > 0) {
    const pctChange = ((totalCommission - prevTotal) / prevTotal) * 100;
    const isUp = pctChange >= 0;
    comparisonEl.style.display = 'flex';
    comparisonEl.className = `commission-comparison ${isUp ? 'up' : 'down'}`;
    comparisonEl.innerHTML = `<span>${isUp ? '📈' : '📉'} ${isUp ? '+' : ''}${pctChange.toFixed(0)}%</span><span class="commission-comparison-sub">vs ${comparisonPrevLabel} (${fmtPrice(prevTotal)})</span>`;
  } else {
    comparisonEl.style.display = 'none';
  }

  if (entries.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><span class="glyph">💶</span><h3>Aucune commande</h3><p>Aucune commission enregistrée pour cette période.</p></div>`;
  } else {
    listEl.innerHTML = entries.map(e => {
      const dateStr = new Date(e.createdAt).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      const isReduced = e.rate !== DEFAULT_COMMISSION_RATE;
      return `
      <div class="commission-order-row">
        <div class="commission-order-info">
          <div class="commission-order-name">Commande n°${escapeHtml(e.orderNumber)} — ${escapeHtml(e.clientName)}</div>
          <div class="commission-order-sub">${e.shopName ? escapeHtml(e.shopName) + ' · ' : ''}${dateStr} ${isReduced ? `· taux spécial (${e.rate}%)` : ''}</div>
        </div>
        <div class="commission-order-amount">${fmtPrice(e.amount)}</div>
        <button class="stock-alert-dismiss" data-delete-commission-id="${e.orderId}" title="Supprimer cette commission">✕</button>
      </div>`;
    }).join('');
    listEl.querySelectorAll('[data-delete-commission-id]').forEach(btn => {
      btn.addEventListener('click', () => deleteCommissionEntry(btn.dataset.deleteCommissionId));
    });
  }

  renderReducedShopsList();
}

/* Supprime définitivement l'entrée de commission d'une commande
   précise dans le registre permanent — demandé explicitement par
   Fuaad pour pouvoir corriger une commission erronée sans devoir
   toucher à la commande elle-même. */
async function deleteCommissionEntry(orderId) {
  commissionLedger = commissionLedger.filter(e => String(e.orderId) !== String(orderId));
  try {
    await supabaseClient.from('settings').update({ commission_ledger: commissionLedger }).eq('id', 1);
    showToast('✓ Commission supprimée');
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la suppression');
  }
  renderCommissionsTab();
}

function renderReducedShopsList() {
  const el = document.getElementById('reducedShopsList');
  if (!el) return;
  if (reducedCommissionShops.length === 0) {
    el.innerHTML = `<p class="notifications-intro">Aucun magasin à taux réduit pour le moment.</p>`;
    return;
  }
  el.innerHTML = reducedCommissionShops.map((shop, idx) => `
    <div class="reduced-shop-row">
      <span>${escapeHtml(shop)}</span>
      <button class="stock-alert-dismiss" data-remove-reduced-idx="${idx}">✕</button>
    </div>
  `).join('');
  el.querySelectorAll('[data-remove-reduced-idx]').forEach(btn => {
    btn.addEventListener('click', () => removeReducedShop(parseInt(btn.dataset.removeReducedIdx, 10)));
  });
}

async function persistReducedShops() {
  try {
    const { error } = await supabaseClient.from('settings').update({ reduced_commission_shops: reducedCommissionShops }).eq('id', 1);
    if (error) throw error;
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de l\'enregistrement');
  }
}

async function addReducedShop(name) {
  name = name.trim();
  if (!name) return;
  if (reducedCommissionShops.some(s => s.trim().toLowerCase() === name.toLowerCase())) {
    showToast('Ce magasin est déjà dans la liste');
    return;
  }
  reducedCommissionShops.push(name);
  await persistReducedShops();
  renderReducedShopsList();
  renderCommissionsTab();
  showToast(`✓ ${name} ajouté au taux réduit`);
}

async function removeReducedShop(idx) {
  reducedCommissionShops.splice(idx, 1);
  await persistReducedShops();
  renderReducedShopsList();
  renderCommissionsTab();
}

function setupCommissionsTab() {
  document.getElementById('commissionsPrevMonthBtn').addEventListener('click', () => {
    if (commissionsPeriodMode === 'week') {
      commissionsWeekOffset--;
    } else if (commissionsPeriodMode === 'month') {
      commissionsViewMonth--;
      if (commissionsViewMonth < 0) { commissionsViewMonth = 11; commissionsViewYear--; }
    }
    renderCommissionsTab();
  });
  document.getElementById('commissionsNextMonthBtn').addEventListener('click', () => {
    if (commissionsPeriodMode === 'week') {
      commissionsWeekOffset++;
    } else if (commissionsPeriodMode === 'month') {
      commissionsViewMonth++;
      if (commissionsViewMonth > 11) { commissionsViewMonth = 0; commissionsViewYear++; }
    }
    renderCommissionsTab();
  });
  document.querySelectorAll('#periodSwitch .period-switch-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      commissionsPeriodMode = btn.dataset.period;
      document.querySelectorAll('#periodSwitch .period-switch-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderCommissionsTab();
    });
  });
  document.getElementById('addReducedShopBtn').addEventListener('click', () => {
    const input = document.getElementById('newReducedShopInput');
    addReducedShop(input.value);
    input.value = '';
  });
}

/* Agrège, pour le mois sélectionné, le nombre total d'unités vendues
   par référence produit. items[].qty est déjà en unités réelles (pas en
   nombre de lots) — cart/submitOrder stocke toujours la quantité réelle,
   donc un lot de 12 vendu une fois compte bien pour 12 ici, comme
   demandé explicitement ("le nombre de pièces même si c'était un lot"). */
/* Calcule automatiquement les références les plus vendues du mois en
   cours, pour la section catalogue "🔥 Top des ventes ce mois". Tourne
   en arrière-plan après l'affichage initial (ne bloque jamais le
   premier rendu) et redessine la grille une fois le calcul terminé. */
async function computeTopSellersForCatalogue() {
  try {
    const now = new Date();
    const orders = await fetchOrdersForMonth(now.getFullYear(), now.getMonth());
    const salesByRef = new Map();
    orders.forEach(o => {
      (o.items || []).forEach(item => {
        if (!item.ref) return;
        salesByRef.set(item.ref, (salesByRef.get(item.ref) || 0) + (item.qty || 0));
      });
    });
    topSellerRefs = Array.from(salesByRef.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([ref]) => ref);
    if (topSellerRefs.length > 0) {
      renderGrid();
    }
  } catch (e) {
    console.warn('Calcul du top des ventes échoué', e);
  }
}

async function renderVentesTab() {
  document.getElementById('ventesMonthLabel').textContent = `${MONTH_NAMES_FR[ventesViewMonth]} ${ventesViewYear}`;
  const listEl = document.getElementById('ventesProductsList');
  listEl.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  let orders;
  try {
    orders = await fetchOrdersForMonth(ventesViewYear, ventesViewMonth);
  } catch (e) {
    console.error(e);
    listEl.innerHTML = `<div class="empty-state"><span class="glyph">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message || '')}</p></div>`;
    return;
  }

  const salesByRef = new Map(); // ref -> { name, qty }
  orders.forEach(o => {
    (o.items || []).forEach(item => {
      const key = item.ref || item.name;
      const existing = salesByRef.get(key) || { name: item.name, ref: item.ref, qty: 0 };
      existing.qty += item.qty || 0;
      salesByRef.set(key, existing);
    });
  });

  const rows = Array.from(salesByRef.values()).sort((a, b) => b.qty - a.qty);

  if (rows.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><span class="glyph">📦</span><h3>Aucune vente</h3><p>Aucune commande sur ce mois pour le moment.</p></div>`;
    return;
  }

  listEl.innerHTML = rows.map(r => `
    <div class="ventes-product-row">
      <div class="ventes-product-name">${escapeHtml(r.name)}<span class="ventes-product-ref">Réf. ${escapeHtml(r.ref || '—')}</span></div>
      <div class="ventes-product-qty">${r.qty}</div>
    </div>
  `).join('');
}

/* Récupère TOUTES les commandes existantes (pas seulement un mois),
   page par page pour éviter le même problème de requête trop lourde
   rencontré précédemment avec fetchAllProductsFromDB. */
/* Comme fetchAllOrdersEver, mais récupère toutes les colonnes (pas
   seulement shop_name/total) — nécessaire pour le mode "Total général"
   de l'onglet Commissions, qui affiche le détail de chaque commande. */
async function fetchAllOrdersFullForCommissions() {
  let all = [];
  let from = 0;
  const pageSize = 200;
  while (true) {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('*')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += data.length;
  }
  return all;
}

async function fetchAllOrdersEver() {
  let all = [];
  let from = 0;
  const pageSize = 200;
  while (true) {
    const { data, error } = await supabaseClient
      .from('orders')
      .select('shop_name, total_with_tva, created_at')
      .range(from, from + pageSize - 1);
    if (error) throw error;
    if (!data || data.length === 0) break;
    all = all.concat(data);
    if (data.length < pageSize) break;
    from += data.length;
  }
  return all;
}

const INACTIVE_SHOP_DAYS = 30;

function renderInactiveShops(orders) {
  const list = document.getElementById('inactiveShopsList');
  if (!list) return;

  const lastOrderByShop = new Map();
  orders.forEach(o => {
    if (!o.shop_name) return;
    const key = o.shop_name.trim().toLowerCase();
    const date = new Date(o.created_at);
    const existing = lastOrderByShop.get(key);
    if (!existing || date > existing.date) {
      lastOrderByShop.set(key, { displayName: o.shop_name.trim(), date });
    }
  });

  const now = new Date();
  const inactive = Array.from(lastOrderByShop.values())
    .map(s => ({ ...s, daysSince: Math.floor((now - s.date) / (1000 * 60 * 60 * 24)) }))
    .filter(s => s.daysSince > INACTIVE_SHOP_DAYS)
    .sort((a, b) => b.daysSince - a.daysSince);

  if (inactive.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">✨</span><h3>Tout va bien</h3><p>Tous vos magasins ont commandé récemment.</p></div>`;
    return;
  }

  list.innerHTML = inactive.map(s => `
    <div class="inactive-shop-row">
      <div class="inactive-shop-name">${escapeHtml(s.displayName)}</div>
      <div class="inactive-shop-days">${s.daysSince} jours</div>
    </div>
  `).join('');
}

async function renderVipTab() {
  const list = document.getElementById('vipShopsList');
  list.innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;
  let orders;
  try {
    orders = await fetchAllOrdersEver();
  } catch (e) {
    console.error(e);
    list.innerHTML = `<div class="empty-state"><span class="glyph">⚠️</span><h3>Erreur</h3><p>${escapeHtml(e.message || '')}</p></div>`;
    return;
  }

  const totalsByShop = new Map(); // clé normalisée -> { displayName, total, count }
  orders.forEach(o => {
    if (!o.shop_name) return;
    const key = o.shop_name.trim().toLowerCase();
    const existing = totalsByShop.get(key) || { displayName: o.shop_name.trim(), total: 0, count: 0 };
    existing.total += o.total_with_tva || 0;
    existing.count += 1;
    totalsByShop.set(key, existing);
  });

  const ranked = Array.from(totalsByShop.values()).sort((a, b) => b.total - a.total);
  renderInactiveShops(orders);

  if (ranked.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">🏆</span><h3>Aucun classement</h3><p>Dès qu'un magasin aura passé une commande, il apparaîtra ici.</p></div>`;
    return;
  }

  const medals = ['🥇', '🥈', '🥉'];
  list.innerHTML = ranked.map((shop, idx) => `
    <div class="vip-shop-row ${idx < 3 ? 'top3' : ''}">
      <div class="vip-shop-medal">${medals[idx] || (idx + 1)}</div>
      <div class="vip-shop-info">
        <div class="vip-shop-name">${escapeHtml(shop.displayName)}</div>
        <div class="vip-shop-sub">${shop.count} commande${shop.count !== 1 ? 's' : ''}</div>
      </div>
      <div class="vip-shop-total">${fmtPrice(shop.total)}</div>
    </div>
  `).join('');
}

let shopMapInstance = null; // instance Leaflet réutilisée (la créer deux fois sur le même <div> lève une erreur)
let shopMapMarkersLayer = null;

async function renderCarteTab() {
  if (typeof L === 'undefined') {
    document.getElementById('shopMapContainer').innerHTML = `<div class="empty-state"><span class="glyph">📡</span><h3>Carte indisponible</h3><p>Vérifiez votre connexion internet et rouvrez cet onglet.</p></div>`;
    renderMapShopsList();
    return;
  }
  // Initialise la carte une seule fois ; les appels suivants se
  // contentent de mettre à jour les marqueurs.
  if (!shopMapInstance) {
    shopMapInstance = L.map('shopMapContainer').setView([48.8566, 2.3522], 12); // Paris
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap',
      maxZoom: 19
    }).addTo(shopMapInstance);
    shopMapMarkersLayer = L.layerGroup().addTo(shopMapInstance);
    // Leaflet a besoin d'un recalcul de taille après l'ouverture du
    // tiroir (la carte est créée alors que son conteneur était caché,
    // donc sa taille n'était pas connue) — sinon la carte reste coupée
    // ou mal centrée.
    setTimeout(() => shopMapInstance.invalidateSize(), 200);
  } else {
    setTimeout(() => shopMapInstance.invalidateSize(), 50);
  }

  shopMapMarkersLayer.clearLayers();

  let totalsByShop = new Map();
  try {
    const orders = await fetchAllOrdersEver();
    orders.forEach(o => {
      if (!o.shop_name) return;
      const key = o.shop_name.trim().toLowerCase();
      totalsByShop.set(key, (totalsByShop.get(key) || 0) + (o.total_with_tva || 0));
    });
  } catch (e) {
    console.warn('Chargement des totaux pour la carte échoué', e);
  }

  shopMapPoints.forEach(point => {
    const key = point.name.trim().toLowerCase();
    const total = totalsByShop.get(key) || 0;
    // Rayon entre 8 et 28px selon le total dépensé — purement visuel,
    // plafonné pour qu'un très gros total ne déborde pas de la carte.
    const radius = Math.min(28, 8 + Math.sqrt(total) * 0.8);
    const marker = L.circleMarker([point.lat, point.lng], {
      radius,
      color: '#D89A2C',
      fillColor: '#D89A2C',
      fillOpacity: 0.65,
      weight: 2
    }).bindPopup(`<strong>${point.name}</strong><br>${fmtPrice(total)} au total`);
    shopMapMarkersLayer.addLayer(marker);
  });

  renderMapShopsList();
}

function renderMapShopsList() {
  const list = document.getElementById('mapShopsList');
  if (!list) return;
  if (shopMapPoints.length === 0) {
    list.innerHTML = `<p class="notifications-intro">Aucun magasin positionné pour le moment.</p>`;
    return;
  }
  list.innerHTML = shopMapPoints.map((p, idx) => `
    <div class="map-shop-row">
      <div>
        <div class="map-shop-row-name">${escapeHtml(p.name)}</div>
        <div class="map-shop-row-coords">${escapeHtml(p.address || `${p.lat}, ${p.lng}`)}</div>
      </div>
      <button class="stock-alert-dismiss" data-remove-map-idx="${idx}">✕</button>
    </div>
  `).join('');
  list.querySelectorAll('[data-remove-map-idx]').forEach(btn => {
    btn.addEventListener('click', () => removeMapShop(parseInt(btn.dataset.removeMapIdx, 10)));
  });
}

async function persistMapPoints() {
  try {
    const { error } = await supabaseClient.from('settings').update({ shop_map_points: shopMapPoints }).eq('id', 1);
    if (error) throw error;
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de l\'enregistrement');
  }
}

async function removeMapShop(idx) {
  shopMapPoints.splice(idx, 1);
  await persistMapPoints();
  renderCarteTab();
}

let addressAutocompleteTimer = null;
let selectedAddressCoords = null; // { lat, lng } rempli quand une suggestion est cliquée

function setupAddressAutocomplete() {
  const input = document.getElementById('mapShopAddressInput');
  const box = document.getElementById('addressSuggestionsBox');

  input.addEventListener('input', () => {
    selectedAddressCoords = null; // l'utilisateur retape, l'ancienne sélection n'est plus valide
    const query = input.value.trim();
    clearTimeout(addressAutocompleteTimer);
    if (query.length < 3) {
      box.classList.remove('show');
      box.innerHTML = '';
      return;
    }
    // Attend une courte pause dans la frappe avant d'interroger
    // Nominatim — évite une requête à chaque lettre tapée.
    addressAutocompleteTimer = setTimeout(async () => {
      try {
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
        const results = await res.json();
        if (!results || results.length === 0) {
          box.innerHTML = `<div class="address-suggestion-item" style="opacity:0.6;">Aucun résultat</div>`;
          box.classList.add('show');
          return;
        }
        box.innerHTML = results.map((r, idx) => `<div class="address-suggestion-item" data-suggestion-idx="${idx}">${escapeHtml(r.display_name)}</div>`).join('');
        box.classList.add('show');
        box.querySelectorAll('[data-suggestion-idx]').forEach((el, idx) => {
          el.addEventListener('click', () => {
            input.value = results[idx].display_name;
            selectedAddressCoords = { lat: parseFloat(results[idx].lat), lng: parseFloat(results[idx].lon) };
            box.classList.remove('show');
          });
        });
      } catch (e) {
        console.warn('Autocomplete adresse échoué', e);
      }
    }, 450);
  });

  // Cache la liste si on clique ailleurs sur la page.
  document.addEventListener('click', (e) => {
    if (e.target !== input) box.classList.remove('show');
  });
}

/* Remplit le sélecteur de catégorie de l'onglet Réorganiser et affiche
   les produits de la catégorie choisie, sous forme de vraies cartes du
   catalogue (productCardHtml), juste rétrécies par CSS — pour que
   Fuaad voie exactement à quoi ressemblera le catalogue, pas une liste
   abstraite. */
function renderReorganiserCategoryOptions() {
  const select = document.getElementById('reorganiserCategorySelect');
  select.innerHTML = categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function renderReorganiserGrid() {
  const select = document.getElementById('reorganiserCategorySelect');
  const grid = document.getElementById('reorganiserGrid');
  const catId = select.value;
  if (!catId) { grid.innerHTML = ''; return; }

  const catProducts = products
    .filter(p => p.categoryId === catId)
    .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));

  if (catProducts.length === 0) {
    grid.innerHTML = `<div class="empty-state"><span class="glyph">📦</span><h3>Aucun produit</h3><p>Cette catégorie est vide.</p></div>`;
    return;
  }

  const bulkEligible = getBulkEligibleCategories();
  grid.innerHTML = catProducts.map(p => productCardHtml(p, bulkEligible)).join('');
  observeCardsForScrollReveal('.ticket');
  setupReorganiserDragAndDrop(grid);
}

/* Glisser-déposer fonctionnant à la fois à la souris (HTML5 Drag and
   Drop natif) ET au toucher (tablette/mobile) — l'API HTML5 native ne
   répond pas du tout aux gestes tactiles sans implémentation
   spécifique, ce qui empêchait Fuaad de réorganiser ses produits sur
   sa tablette. La version tactile recrée manuellement le même
   comportement : suit le doigt, détecte la carte survolée, et
   persiste le nouvel ordre de la même façon que la version souris. */
function setupReorganiserDragAndDrop(grid) {
  let touchDraggedCard = null;
  let touchGhost = null;

  async function persistNewOrder() {
    const newOrderIds = Array.from(grid.querySelectorAll('.ticket')).map(c => c.dataset.id);
    for (let i = 0; i < newOrderIds.length; i++) {
      const p = products.find(x => x.id === newOrderIds[i]);
      if (p) p.sortOrder = i;
      try {
        await supabaseClient.from('products').update({ sort_order: i }).eq('id', newOrderIds[i]);
      } catch (err) {
        console.error('Échec de l\'enregistrement de l\'ordre', err);
      }
    }
    showToast('✓ Ordre mis à jour');
  }

  function cardUnderPoint(x, y, exclude) {
    const cards = Array.from(grid.querySelectorAll('.ticket')).filter(c => c !== exclude);
    return cards.find(c => {
      const r = c.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    });
  }

  grid.querySelectorAll('.ticket').forEach(card => {
    card.draggable = true;

    // --- Souris (HTML5 Drag and Drop natif, fonctionne déjà bien) ---
    card.addEventListener('dragstart', () => card.classList.add('dragging'));
    card.addEventListener('dragend', () => {
      card.classList.remove('dragging');
      grid.querySelectorAll('.ticket').forEach(c => c.classList.remove('drag-over'));
    });
    card.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (!card.classList.contains('dragging')) card.classList.add('drag-over');
    });
    card.addEventListener('dragleave', () => card.classList.remove('drag-over'));
    card.addEventListener('drop', async (e) => {
      e.preventDefault();
      card.classList.remove('drag-over');
      const draggedCard = grid.querySelector('.ticket.dragging');
      if (!draggedCard || draggedCard === card) return;
      const allCards = Array.from(grid.querySelectorAll('.ticket'));
      const draggedIdx = allCards.indexOf(draggedCard);
      const targetIdx = allCards.indexOf(card);
      if (draggedIdx < targetIdx) card.after(draggedCard);
      else card.before(draggedCard);
      await persistNewOrder();
    });

    // --- Toucher (tablette/mobile) — implémentation manuelle ---
    let touchStartTimer = null;
    card.addEventListener('touchstart', (e) => {
      // Un petit délai avant d'activer le mode "glisser" évite de
      // capturer un simple scroll vertical de la page comme un début
      // de glissé.
      touchStartTimer = setTimeout(() => {
        touchDraggedCard = card;
        card.classList.add('dragging');
      }, 150);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
      if (!touchDraggedCard) { clearTimeout(touchStartTimer); return; }
      e.preventDefault(); // empêche le scroll de la page une fois le glissé engagé
      const touch = e.touches[0];
      grid.querySelectorAll('.ticket').forEach(c => c.classList.remove('drag-over'));
      const target = cardUnderPoint(touch.clientX, touch.clientY, touchDraggedCard);
      if (target) target.classList.add('drag-over');
    }, { passive: false });

    card.addEventListener('touchend', async (e) => {
      clearTimeout(touchStartTimer);
      if (!touchDraggedCard) return;
      const touch = e.changedTouches[0];
      const target = cardUnderPoint(touch.clientX, touch.clientY, touchDraggedCard);
      touchDraggedCard.classList.remove('dragging');
      grid.querySelectorAll('.ticket').forEach(c => c.classList.remove('drag-over'));
      if (target && target !== touchDraggedCard) {
        const allCards = Array.from(grid.querySelectorAll('.ticket'));
        const draggedIdx = allCards.indexOf(touchDraggedCard);
        const targetIdx = allCards.indexOf(target);
        if (draggedIdx < targetIdx) target.after(touchDraggedCard);
        else target.before(touchDraggedCard);
        await persistNewOrder();
      }
      touchDraggedCard = null;
    });
  });
}

/* ── Onglet Clients ──────────────────────────────────────────────────
   Combine deux sources :
   1. Table "clients" : clients ajoutés manuellement (sans commande)
   2. Table "orders" : clients détectés automatiquement à partir des
      commandes passées
   Les deux sont fusionnés par nom (insensible à la casse) pour afficher
   un profil unique par client. */
let clientSearchTimer = null;
let allKnownClients = []; // cache local pour la liste et la recherche

async function loadAllClients() {
  // 1. Clients manuels
  const { data: manualClients } = await supabaseClient
    .from('clients').select('*').order('name');
  // 2. Noms uniques depuis les commandes
  const { data: orderClients } = await supabaseClient
    .from('orders').select('client_name, shop_name, created_at')
    .order('created_at', { ascending: false });

  const map = new Map();
  // Noms masqués (supprimés par l'utilisateur) — on les exclut partout
  const hiddenNames = new Set(
    (manualClients || []).filter(c => c.hidden).map(c => c.name.trim().toLowerCase())
  );
  // Clients manuels non masqués en priorité
  (manualClients || []).filter(c => !c.hidden).forEach(c => {
    map.set(c.name.trim().toLowerCase(), {
      name: c.name, shop: c.shop_name || '', phone: c.phone || '',
      notes: c.notes || '', source: 'manual', id: c.id
    });
  });
  // Complète avec clients des commandes (sauf masqués)
  (orderClients || []).forEach(o => {
    const key = (o.client_name || '').trim().toLowerCase();
    if (!key || hiddenNames.has(key)) return;
    if (!map.has(key)) {
      map.set(key, { name: o.client_name, shop: o.shop_name || '', source: 'order' });
    }
  });
  allKnownClients = Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  return allKnownClients;
}

function renderClientsList(filter = '') {
  const list = document.getElementById('clientsList');
  const filtered = filter
    ? allKnownClients.filter(c => c.name.toLowerCase().includes(filter.toLowerCase()) || (c.shop || '').toLowerCase().includes(filter.toLowerCase()))
    : allKnownClients;

  if (filtered.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">👤</span><h3>Aucun client</h3><p>Ajoutez votre premier client ou passez une commande.</p></div>`;
    return;
  }
  list.innerHTML = filtered.map(c => `
    <div class="client-list-row" data-client-name="${escapeHtml(c.name)}">
      <div style="flex:1;">
        <div class="client-list-name">${escapeHtml(c.name)}</div>
        ${c.shop ? `<div class="client-list-sub">${escapeHtml(c.shop)}</div>` : ''}
      </div>
      <button class="stock-alert-dismiss" data-delete-client-name="${escapeHtml(c.name)}" data-delete-client-id="${escapeHtml(c.id || '')}" title="Supprimer">✕</button>
      <span class="client-list-arrow" style="margin-left:6px;">›</span>
    </div>
  `).join('');
  list.querySelectorAll('[data-client-name]').forEach(row => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('[data-delete-client-name]')) return;
      showClientProfile(row.dataset.clientName);
    });
  });
  list.querySelectorAll('[data-delete-client-name]').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const name = btn.dataset.deleteClientName;
      if (!confirm(`Supprimer "${name}" de la liste ?`)) return;
      if (btn.dataset.deleteClientId) {
        // Client manuel → suppression directe
        await supabaseClient.from('clients').delete().eq('id', btn.dataset.deleteClientId);
      } else {
        // Client issu des commandes → on l'insère comme "masqué" pour
        // qu'il ne réapparaisse pas au prochain chargement
        await supabaseClient.from('clients').insert({
          id: uid('client'), name, hidden: true
        }).select();
      }
      allKnownClients = allKnownClients.filter(c => c.name.toLowerCase() !== name.toLowerCase());
      renderClientsList(document.getElementById('clientSearchInput').value);
      showToast('✓ Client supprimé');
    });
  });
}

async function showClientProfile(clientName) {
  document.getElementById('clientsList').style.display = 'none';
  document.getElementById('addClientForm').style.display = 'none';
  document.getElementById('clientSearchInput').parentElement.style.display = 'none';
  const profile = document.getElementById('clientProfile');
  profile.style.display = 'block';
  document.getElementById('clientProfileOrders').innerHTML = `<div class="empty-state"><div class="spinner"></div></div>`;

  const { data, error } = await supabaseClient
    .from('orders').select('*')
    .ilike('client_name', clientName)
    .order('created_at', { ascending: false });

  const client = allKnownClients.find(c => c.name.toLowerCase() === clientName.toLowerCase());
  const orderCount = (data || []).length;
  const totalSpent = (data || []).reduce((s, o) => s + (o.total_with_tva || 0), 0);
  const clientCommission = (data || []).reduce((s, o) => s + calculateOrderCommission(o).amount, 0);

  document.getElementById('clientProfileName').textContent = clientName;
  setupMergeUI(clientName);

  document.getElementById('editClientBtn').onclick = () => {
    const clientData = allKnownClients.find(c => c.name.toLowerCase() === clientName.toLowerCase()) || {};
    openEditClientModal(clientName, clientData);
  };
  document.getElementById('clientProfileSub').textContent =
    `${client?.shop ? client.shop + ' · ' : ''}${orderCount} commande${orderCount !== 1 ? 's' : ''}`;
  document.getElementById('clientProfileTotal').textContent = fmtPrice(totalSpent);

  // Badge commission
  let commBadge = document.getElementById('clientCommissionBadge');
  if (!commBadge) {
    commBadge = document.createElement('div');
    commBadge.id = 'clientCommissionBadge';
    commBadge.style.cssText = 'margin-bottom:12px;background:rgba(216,154,44,0.12);border:1px solid var(--mustard);border-radius:10px;padding:10px 14px;font-size:13px;display:flex;justify-content:space-between;';
    document.getElementById('clientProfileOrders').before(commBadge);
  }
  commBadge.innerHTML = `<span style="color:var(--brass);font-weight:600;">💰 Commission totale</span><span style="font-weight:800;color:var(--mustard-deep);">${fmtPrice(clientCommission)}</span>`;

  if (!data || data.length === 0) {
    document.getElementById('clientProfileOrders').innerHTML =
      `<div class="empty-state"><span class="glyph">📋</span><h3>Aucune commande</h3><p>Ce client n'a pas encore passé de commande.</p></div>`;
    return;
  }
  const ordersEl = document.getElementById('clientProfileOrders');
  ordersEl.innerHTML = data.map(o => {
    const dateStr = new Date(o.created_at).toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    const items = (o.items || []).map(i => `${i.ref} ×${i.qty}`).join(', ') || '—';
    const stIcon = o.status === 'nouvelle'
      ? '<svg class="ic" style="width:13px;height:13px;stroke:var(--mustard);fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;"><use href="#ic-plus"/></svg>'
      : o.status === 'en_cours'
      ? '<svg class="ic" style="width:13px;height:13px;stroke:#8BC4A8;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;"><use href="#ic-check"/></svg>'
      : '<svg class="ic" style="width:13px;height:13px;stroke:#5E7A5E;fill:none;stroke-width:2.5;stroke-linecap:round;stroke-linejoin:round;vertical-align:middle;"><use href="#ic-check"/></svg>';
    const st = stIcon;
    return `
    <div class="client-order-card" style="cursor:pointer;">
      <div class="client-order-summary" style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div class="client-order-num">${st} Commande n°${escapeHtml(o.order_number)}</div>
          <div class="client-order-date">${dateStr}</div>
        </div>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="client-order-total">${fmtPrice(o.total_with_tva)}</span>
          <span class="client-order-chevron" style="color:var(--brass);font-size:16px;transition:transform .2s;">›</span>
        </div>
      </div>
      <div class="client-order-detail" style="display:none;margin-top:8px;border-top:1px solid rgba(0,0,0,0.06);padding-top:8px;">
        <div class="client-order-items">${escapeHtml(items)}</div>
        <div style="margin-top:4px;font-size:12px;color:var(--brass);">
          ${o.shop_name ? escapeHtml(o.shop_name) + ' · ' : ''}Total HT: ${fmtPrice(o.total)} · TVA: ${fmtPrice(o.tva)}
        </div>
      </div>
    </div>`;
  }).join('');
  ordersEl.querySelectorAll('.client-order-card').forEach(card => {
    card.querySelector('.client-order-summary').addEventListener('click', () => {
      const detail = card.querySelector('.client-order-detail');
      const chevron = card.querySelector('.client-order-chevron');
      const isOpen = detail.style.display !== 'none';
      detail.style.display = isOpen ? 'none' : 'block';
      chevron.style.transform = isOpen ? '' : 'rotate(90deg)';
    });
  });
}

function showClientsList() {
  document.getElementById('clientProfile').style.display = 'none';
  document.getElementById('addClientForm').style.display = 'none';
  document.getElementById('clientsList').style.display = 'block';
  document.getElementById('clientSearchInput').parentElement.style.display = 'flex';
}

/* Fusionne deux profils clients : réattribue toutes les commandes du
   "doublon" au nom du client principal, puis supprime le doublon de
   la table clients s'il y était. C'est la solution au problème des
   noms légèrement différents ("Eva Souvenir" vs "Eva Souvenirs"). */
async function mergeClientInto(targetName, duplicateName) {
  if (!duplicateName || duplicateName.toLowerCase() === targetName.toLowerCase()) return;
  try {
    // Réattribue toutes les commandes du doublon au nom cible
    const { error } = await supabaseClient
      .from('orders')
      .update({ client_name: targetName })
      .ilike('client_name', duplicateName);
    if (error) throw error;

    await supabaseClient.from('clients').delete().ilike('name', duplicateName);
    // Supprime immédiatement du cache local — pas besoin de recharger
    allKnownClients = allKnownClients.filter(c => c.name.toLowerCase() !== duplicateName.toLowerCase());
    showToast(`✓ "${duplicateName}" fusionné dans "${targetName}"`);
    showClientProfile(targetName);
    document.getElementById('mergeZone').style.display = 'none';
    document.getElementById('mergeSearchInput').value = '';
  } catch (e) {
    showToast('⚠️ Erreur: ' + e.message);
  }
}

function setupMergeUI(currentClientName) {
  const mergeBtn = document.getElementById('mergeClientBtn');
  const mergeZone = document.getElementById('mergeZone');
  const mergeInput = document.getElementById('mergeSearchInput');
  const mergeResults = document.getElementById('mergeResults');

  mergeBtn.onclick = () => {
    mergeZone.style.display = mergeZone.style.display === 'none' ? 'block' : 'none';
    if (mergeZone.style.display === 'block') mergeInput.focus();
  };

  let mergeTimer = null;
  mergeInput.oninput = () => {
    clearTimeout(mergeTimer);
    const q = mergeInput.value.trim();
    if (q.length < 2) { mergeResults.innerHTML = ''; return; }
    mergeTimer = setTimeout(() => {
      const matches = allKnownClients.filter(c =>
        c.name.toLowerCase() !== currentClientName.toLowerCase() &&
        (c.name.toLowerCase().includes(q.toLowerCase()) || (c.shop||'').toLowerCase().includes(q.toLowerCase()))
      ).slice(0, 6);
      if (matches.length === 0) {
        mergeResults.innerHTML = `<div class="address-suggestion-item" style="opacity:0.6;">Aucun doublon trouvé</div>`;
        return;
      }
      mergeResults.innerHTML = matches.map(c => `
        <div class="address-suggestion-item" data-merge-name="${escapeHtml(c.name)}">
          <strong>${escapeHtml(c.name)}</strong>
          ${c.shop ? `<span style="color:var(--brass);font-size:11px;"> — ${escapeHtml(c.shop)}</span>` : ''}
        </div>`).join('');
      mergeResults.querySelectorAll('[data-merge-name]').forEach(el => {
        el.addEventListener('click', async () => {
          const dup = el.dataset.mergeName;
          if (confirm(`Fusionner "${dup}" dans "${currentClientName}" ?\n\nToutes les commandes de "${dup}" seront rattachées à "${currentClientName}".`)) {
            await mergeClientInto(currentClientName, dup);
          }
        });
      });
    }, 300);
  };
}

/* ── Modale : assigner une commande à un client ───────────────────── */
let currentAssignOrderId = null;

function openAssignClientModal(orderId, orderNum) {
  currentAssignOrderId = orderId;
  document.getElementById('assignClientOrderLabel').textContent = `Commande n°${orderNum}`;
  document.getElementById('assignClientSearchInput').value = '';
  document.getElementById('assignClientSelected').style.display = 'none';
  document.getElementById('assignClientConfirmBtn').disabled = true;
  document.getElementById('assignClientResults').innerHTML = '';
  renderAssignClientList('');
  document.getElementById('assignClientOverlay').classList.add('show');
  document.getElementById('assignClientModal').classList.add('show');
  setTimeout(() => document.getElementById('assignClientSearchInput').focus(), 200);
}

function closeAssignClientModal() {
  document.getElementById('assignClientOverlay').classList.remove('show');
  document.getElementById('assignClientModal').classList.remove('show');
  currentAssignOrderId = null;
}

function renderAssignClientList(query) {
  const resultsBox = document.getElementById('assignClientResults');
  const filtered = query
    ? allKnownClients.filter(c =>
        c.name.toLowerCase().includes(query.toLowerCase()) ||
        (c.shop || '').toLowerCase().includes(query.toLowerCase()))
    : allKnownClients;

  resultsBox.innerHTML = filtered.slice(0, 10).map(c => `
    <div class="address-suggestion-item" data-assign-name="${escapeHtml(c.name)}" data-assign-shop="${escapeHtml(c.shop||'')}">
      <strong>${escapeHtml(c.name)}</strong>
      ${c.shop ? `<span style="color:var(--brass);font-size:11px;"> — ${escapeHtml(c.shop)}</span>` : ''}
    </div>`).join('') || `<div class="address-suggestion-item" style="opacity:0.6;">Aucun client trouvé</div>`;

  resultsBox.classList.add('show');
  resultsBox.querySelectorAll('[data-assign-name]').forEach(el => {
    el.addEventListener('click', () => {
      document.getElementById('assignClientSearchInput').value = el.dataset.assignName;
      document.getElementById('assignClientSelected').textContent =
        el.dataset.assignShop ? `${el.dataset.assignName} — ${el.dataset.assignShop}` : el.dataset.assignName;
      document.getElementById('assignClientSelected').style.display = 'block';
      document.getElementById('assignClientSelected').dataset.name = el.dataset.assignName;
      document.getElementById('assignClientSelected').dataset.shop = el.dataset.assignShop;
      document.getElementById('assignClientConfirmBtn').disabled = false;
      resultsBox.classList.remove('show');
    });
  });
}

function setupAssignClientModal() {
  document.getElementById('assignClientSearchInput').addEventListener('input', e => {
    renderAssignClientList(e.target.value);
  });
  document.getElementById('assignClientConfirmBtn').addEventListener('click', async () => {
    const sel = document.getElementById('assignClientSelected');
    const clientName = sel.dataset.name;
    const clientShop = sel.dataset.shop || '';
    if (!clientName || !currentAssignOrderId) return;
    const btn = document.getElementById('assignClientConfirmBtn');
    btn.disabled = true;
    try {
      const { error } = await supabaseClient.from('orders').update({
        client_name: clientName,
        shop_name: clientShop || null,
        archived: true
      }).eq('id', currentAssignOrderId);
      if (error) throw error;
      showToast(`✓ Envoyé à ${clientName} et archivé`);
      closeAssignClientModal();
      renderAdminOrderList();
    } catch (e) {
      showToast('⚠️ Erreur: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('assignClientCancelBtn').addEventListener('click', closeAssignClientModal);
  document.getElementById('assignClientOverlay').addEventListener('click', closeAssignClientModal);
}

/* ── Modale : modifier le nom/magasin d'un client ─────────────────── */
let currentEditClientName = null;

function openEditClientModal(clientName, clientData) {
  currentEditClientName = clientName;
  document.getElementById('editClientNameInput').value = clientData.name || clientName;
  document.getElementById('editClientShopInput').value = clientData.shop || '';
  document.getElementById('editClientPhoneInput').value = clientData.phone || '';
  document.getElementById('editClientOverlay').classList.add('show');
  document.getElementById('editClientModal').classList.add('show');
}

function closeEditClientModal() {
  document.getElementById('editClientOverlay').classList.remove('show');
  document.getElementById('editClientModal').classList.remove('show');
}

function setupEditClientModal() {
  document.getElementById('editClientSaveBtn').addEventListener('click', async () => {
    const newName = document.getElementById('editClientNameInput').value.trim();
    const newShop = document.getElementById('editClientShopInput').value.trim();
    const newPhone = document.getElementById('editClientPhoneInput').value.trim();
    if (!newName) { showToast('⚠️ Le nom est obligatoire'); return; }
    const btn = document.getElementById('editClientSaveBtn');
    btn.disabled = true;
    try {
      // Met à jour toutes les commandes avec l'ancien nom
      if (newName !== currentEditClientName) {
        await supabaseClient.from('orders').update({ client_name: newName })
          .ilike('client_name', currentEditClientName);
      }
      // Met à jour dans la table clients si existe
      const existing = allKnownClients.find(c => c.name.toLowerCase() === currentEditClientName.toLowerCase());
      if (existing && existing.id) {
        await supabaseClient.from('clients').update({
          name: newName, shop_name: newShop || null, phone: newPhone || null
        }).eq('id', existing.id);
      }
      await loadAllClients();
      showToast(`✓ Client mis à jour`);
      closeEditClientModal();
      showClientProfile(newName);
    } catch (e) {
      showToast('⚠️ Erreur: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('editClientCancelBtn').addEventListener('click', closeEditClientModal);
  document.getElementById('editClientOverlay').addEventListener('click', closeEditClientModal);
}


function setupClientsTab() {
  const input = document.getElementById('clientSearchInput');

  input.addEventListener('input', () => {
    clearTimeout(clientSearchTimer);
    clientSearchTimer = setTimeout(() => renderClientsList(input.value), 300);
  });

  document.getElementById('backToClientsBtn').addEventListener('click', showClientsList);

  document.getElementById('showAddClientBtn').addEventListener('click', () => {
    document.getElementById('clientsList').style.display = 'none';
    document.getElementById('addClientForm').style.display = 'block';
    document.getElementById('newClientName').focus();
  });

  document.getElementById('cancelAddClientBtn').addEventListener('click', () => {
    document.getElementById('addClientForm').style.display = 'none';
    document.getElementById('clientsList').style.display = 'block';
  });

  document.getElementById('saveNewClientBtn').addEventListener('click', async () => {
    const name = document.getElementById('newClientName').value.trim();
    if (!name) { showToast('⚠️ Le nom est obligatoire'); return; }
    const btn = document.getElementById('saveNewClientBtn');
    btn.disabled = true;
    try {
      const { error } = await supabaseClient.from('clients').insert({
        id: uid('client'),
        name,
        shop_name: document.getElementById('newClientShop').value.trim() || null,
        phone: document.getElementById('newClientPhone').value.trim() || null,
        notes: document.getElementById('newClientNotes').value.trim() || null,
      });
      if (error) throw error;
      showToast('✓ Client ajouté');
      document.getElementById('newClientName').value = '';
      document.getElementById('newClientShop').value = '';
      document.getElementById('newClientPhone').value = '';
      document.getElementById('newClientNotes').value = '';
      await loadAllClients();
      renderClientsList();
      showClientsList();
    } catch (e) {
      showToast('⚠️ Erreur: ' + e.message);
    } finally {
      btn.disabled = false;
    }
  });
}

function setupReorganiserTab() {
  document.getElementById('reorganiserCategorySelect').addEventListener('change', renderReorganiserGrid);
}

function setupCarteTab() {
  document.getElementById('saveMapShopBtn').addEventListener('click', async () => {
    const name = document.getElementById('mapShopNameInput').value.trim();
    const address = document.getElementById('mapShopAddressInput').value.trim();
    if (!name) { showToast('Indiquez le nom du magasin'); return; }
    if (!address) { showToast('Indiquez une adresse'); return; }

    const btn = document.getElementById('saveMapShopBtn');
    const originalLabel = btn.textContent;
    btn.disabled = true;

    try {
      let lat, lng;
      if (selectedAddressCoords) {
        // L'utilisateur a cliqué une suggestion : les coordonnées sont
        // déjà connues, pas besoin de refaire un appel à Nominatim.
        lat = selectedAddressCoords.lat;
        lng = selectedAddressCoords.lng;
      } else {
        btn.textContent = '⏳ Recherche de l\'adresse…';
        const url = `https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(address)}&limit=1`;
        const res = await fetch(url, { headers: { 'Accept-Language': 'fr' } });
        const results = await res.json();
        if (!results || results.length === 0) {
          showToast('⚠️ Adresse introuvable, vérifiez l\'orthographe');
          return;
        }
        lat = parseFloat(results[0].lat);
        lng = parseFloat(results[0].lon);
      }

      const existingIdx = shopMapPoints.findIndex(p => p.name.trim().toLowerCase() === name.toLowerCase());
      const point = { name, lat, lng, address };
      if (existingIdx >= 0) shopMapPoints[existingIdx] = point;
      else shopMapPoints.push(point);

      await persistMapPoints();
      document.getElementById('mapShopNameInput').value = '';
      document.getElementById('mapShopAddressInput').value = '';
      selectedAddressCoords = null;
      showToast(`✓ ${name} localisé et ajouté à la carte`);
      renderCarteTab();
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de la recherche d\'adresse');
    } finally {
      btn.textContent = originalLabel;
      btn.disabled = false;
    }
  });
}

function setupAwardModal() {
  document.getElementById('closeAwardModalBtn').addEventListener('click', hideMonthlyAwardModal);
}

function setupVentesTab() {
  document.getElementById('ventesPrevMonthBtn').addEventListener('click', () => {
    ventesViewMonth--;
    if (ventesViewMonth < 0) { ventesViewMonth = 11; ventesViewYear--; }
    renderVentesTab();
  });
  document.getElementById('ventesNextMonthBtn').addEventListener('click', () => {
    ventesViewMonth++;
    if (ventesViewMonth > 11) { ventesViewMonth = 0; ventesViewYear++; }
    renderVentesTab();
  });
}

function renderAdminCatList() {
  const list = document.getElementById('adminCatList');
  if (categories.length === 0) {
    list.innerHTML = `<div class="empty-state"><span class="glyph">🏷️</span><h3>Aucune catégorie</h3></div>`;
    return;
  }
  let html = '';
  categories.forEach((c, idx) => {
    const count = products.filter(p => p.categoryId === c.id).length;
    const hasBulk = c.bulkThresholdQty && c.bulkPrice != null;
    const isFirst = idx === 0;
    const isLast = idx === categories.length - 1;
    html += `
    <div class="cat-manage-card${c.hidden ? ' hidden-product-row' : ''}">
      <div class="cat-manage-row">
        <div class="cat-reorder-buttons">
          <button class="admin-icon-btn" data-movecat="totop" data-cat-id="${c.id}" ${isFirst ? 'disabled' : ''} title="Déplacer en premier">⏫</button>
          <button class="admin-icon-btn" data-movecat="up" data-cat-id="${c.id}" ${isFirst ? 'disabled' : ''} title="Monter">⬆️</button>
          <button class="admin-icon-btn" data-movecat="down" data-cat-id="${c.id}" ${isLast ? 'disabled' : ''} title="Descendre">⬇️</button>
          <button class="admin-icon-btn" data-movecat="tobottom" data-cat-id="${c.id}" ${isLast ? 'disabled' : ''} title="Déplacer en dernier">⏬</button>
        </div>
        <input type="text" value="${escapeHtml(c.name)}" data-cat-id="${c.id}">
        <span style="font-size:11px;color:var(--brass);flex-shrink:0;">${count} art.</span>
        <button class="admin-icon-btn ${c.hidden ? 'active-hide' : ''}" data-hidecat="${c.id}" title="${c.hidden ? 'Réafficher cette catégorie' : 'Masquer cette catégorie'}">${c.hidden ? '👁️‍🗨️' : '👁️'}</button>
        <button class="admin-icon-btn danger" data-delcat="${c.id}">🗑</button>
      </div>
      <details class="cat-advanced">
        <summary>⚙️ Réglages avancés${hasBulk ? ' · tarif de gros actif' : ''}</summary>
        <div class="cat-cover-box">
          <div class="lqp-label" style="margin-bottom:8px;">🖼️ Photo de couverture (vignette « Catalogue »)</div>
          <div class="cat-cover-row">
            <div class="cat-cover-preview">
              <img src="${c.coverImage || (products.find(p => p.categoryId === c.id)?.image || '')}" alt="">
            </div>
            <div class="cat-cover-actions">
              <button class="btn-secondary cat-cover-choose-btn" data-cat-id="${c.id}" style="padding:9px;font-size:12.5px;margin-bottom:6px;">📷 Choisir une photo</button>
              ${c.coverImage ? `<button class="btn-secondary cat-cover-reset-btn" data-cat-id="${c.id}" style="padding:7px;font-size:11.5px;">↺ Revenir au produit</button>` : ''}
            </div>
            <input type="file" accept="image/*" class="cat-cover-input" data-cat-id="${c.id}" style="display:none;">
          </div>
        </div>
        <div class="bulk-pricing-box">
          <div class="bg-remove-toggle" style="margin:0;">
            <div class="lb">Tarif de gros par palier
              <small>Ex. dès 200 articles (toutes catégories liées), prix réduit</small>
            </div>
            <label class="switch">
              <input type="checkbox" class="bulk-toggle" data-cat-id="${c.id}" ${hasBulk ? 'checked' : ''}>
              <span class="track"></span>
            </label>
          </div>
          <div class="row bulk-fields" data-cat-id="${c.id}" style="display:${hasBulk ? 'flex' : 'none'};flex-wrap:wrap;">
            <div class="form-group">
              <label>Seuil (quantité)</label>
              <input type="number" class="bulk-threshold" data-cat-id="${c.id}" value="${c.bulkThresholdQty || ''}" placeholder="200">
            </div>
            <div class="form-group">
              <label>Prix de gros (€)</label>
              <input type="number" step="0.01" class="bulk-price" data-cat-id="${c.id}" value="${c.bulkPrice != null ? c.bulkPrice : ''}" placeholder="2.50">
            </div>
            <div class="form-group" style="flex-basis:100%;">
              <label>Groupe lié (optionnel)</label>
              <input type="text" class="bulk-group" data-cat-id="${c.id}" value="${escapeHtml(c.bulkGroupId || '')}" placeholder="ex. tshirts">
              <div class="form-hint">Donnez le même nom de groupe à plusieurs catégories (ex. "tshirts" pour Enfant et Adulte) pour que leurs quantités s'additionnent vers le même seuil.</div>
            </div>
          </div>
          <button class="btn-secondary save-bulk-btn" data-cat-id="${c.id}" style="margin-top:10px;padding:9px;font-size:13px;">Enregistrer le tarif de gros</button>
        </div>
        <div class="lot-bulk-box">
          <div class="lqp-label" style="margin-bottom:8px;">📦 Définir le lot pour tous les produits de cette catégorie (${count} article${count > 1 ? 's' : ''})</div>
          <div class="lot-bulk-buttons">
            <button class="lqp-btn" data-bulklot-cat="${c.id}" data-bulklot-qty="6">6</button>
            <button class="lqp-btn" data-bulklot-cat="${c.id}" data-bulklot-qty="10">10</button>
            <button class="lqp-btn" data-bulklot-cat="${c.id}" data-bulklot-qty="12">12</button>
            <button class="lqp-btn unit" data-bulklot-cat="${c.id}" data-bulklot-qty="1">À l'unité</button>
          </div>
        </div>
      </details>
    </div>`;
  });
  list.innerHTML = html;
  observeCardsForScrollReveal('.cat-manage-card');

  list.querySelectorAll('input[data-cat-id]:not(.bulk-toggle):not(.bulk-threshold):not(.bulk-price):not(.cat-cover-input)').forEach(inp => {
    inp.addEventListener('change', async () => {
      const cat = categories.find(c => c.id === inp.dataset.catId);
      if (cat && inp.value.trim()) {
        cat.name = inp.value.trim();
        const { error } = await supabaseClient.from('categories').update({ name: cat.name }).eq('id', cat.id);
        if (error) { showToast('⚠️ Erreur'); return; }
        renderCategoryStrip();
        renderGrid();
        showToast('Catégorie mise à jour');
      }
    });
  });
  list.querySelectorAll('[data-hidecat]').forEach(btn => {
    btn.addEventListener('click', () => toggleHideCategory(btn.dataset.hidecat));
  });
  list.querySelectorAll('[data-movecat]').forEach(btn => {
    btn.addEventListener('click', () => moveCategory(btn.dataset.catId, btn.dataset.movecat));
  });
  list.querySelectorAll('[data-delcat]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.delcat;
      const count = products.filter(p => p.categoryId === id).length;
      const msg = count > 0
        ? `Cette catégorie contient ${count} produit(s). Ils seront déplacés vers "Autres".`
        : 'Supprimer cette catégorie ?';
      if (!confirm(msg)) return;
      const { error } = await supabaseClient.from('categories').delete().eq('id', id);
      if (error) { showToast('⚠️ Erreur'); return; }
      categories = categories.filter(c => c.id !== id);
      renderAdminCatList();
      renderCategoryStrip();
      renderGrid();
      showToast('Catégorie supprimée');
    });
  });
  list.querySelectorAll('.cat-cover-choose-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = list.querySelector(`.cat-cover-input[data-cat-id="${btn.dataset.catId}"]`);
      if (input) input.click();
    });
  });
  list.querySelectorAll('.cat-cover-input').forEach(input => {
    input.addEventListener('change', (e) => {
      const file = e.target.files[0];
      if (file) setCategoryCoverImage(input.dataset.catId, file);
      input.value = '';
    });
  });
  list.querySelectorAll('.cat-cover-reset-btn').forEach(btn => {
    btn.addEventListener('click', () => resetCategoryCoverImage(btn.dataset.catId));
  });
  list.querySelectorAll('.bulk-toggle').forEach(toggle => {
    toggle.addEventListener('change', () => {
      const fieldsRow = list.querySelector(`.bulk-fields[data-cat-id="${toggle.dataset.catId}"]`);
      fieldsRow.style.display = toggle.checked ? 'flex' : 'none';
    });
  });
  list.querySelectorAll('.save-bulk-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const catId = btn.dataset.catId;
      const cat = categories.find(c => c.id === catId);
      const toggle = list.querySelector(`.bulk-toggle[data-cat-id="${catId}"]`);
      let bulk_threshold_qty = null, bulk_price = null, bulk_group_id = null;
      if (toggle.checked) {
        const thresholdInp = list.querySelector(`.bulk-threshold[data-cat-id="${catId}"]`);
        const priceInp = list.querySelector(`.bulk-price[data-cat-id="${catId}"]`);
        const groupInp = list.querySelector(`.bulk-group[data-cat-id="${catId}"]`);
        bulk_threshold_qty = parseInt(thresholdInp.value, 10);
        bulk_price = parseFloat(priceInp.value);
        bulk_group_id = groupInp.value.trim() || null;
        if (!bulk_threshold_qty || bulk_threshold_qty < 1 || isNaN(bulk_price) || bulk_price < 0) {
          showToast('Indiquez un seuil et un prix valides');
          return;
        }
      }
      try {
        const { error } = await supabaseClient.from('categories').update({
          bulk_threshold_qty, bulk_price, bulk_group_id
        }).eq('id', catId);
        if (error) throw error;
        cat.bulkThresholdQty = bulk_threshold_qty;
        cat.bulkPrice = bulk_price;
        cat.bulkGroupId = bulk_group_id;
        renderGrid();
        showToast(toggle.checked ? 'Tarif de gros activé' : 'Tarif de gros désactivé');
      } catch (e) {
        showToast('⚠️ Erreur lors de l\'enregistrement');
      }
    });
  });
  list.querySelectorAll('[data-bulklot-cat]').forEach(btn => {
    btn.addEventListener('click', () => bulkSetUnitStepForCategory(btn.dataset.bulklotCat, parseInt(btn.dataset.bulklotQty, 10)));
  });
}

/* Bascule l'état masqué/visible d'une catégorie entière. Masquer une
   catégorie cache TOUS ses produits de la boutique publique, qu'ils
   soient masqués individuellement ou non. Réafficher la catégorie fait
   réapparaître tous ses produits, y compris ceux qui avaient été
   masqués individuellement avant le masquage de la catégorie. */
async function toggleHideCategory(categoryId) {
  const cat = categories.find(c => c.id === categoryId);
  if (!cat) return;
  const newHidden = !cat.hidden;
  const catProducts = products.filter(p => p.categoryId === categoryId);

  try {
    const { error: catError } = await supabaseClient.from('categories').update({ hidden: newHidden }).eq('id', categoryId);
    if (catError) throw catError;
    cat.hidden = newHidden;

    if (!newHidden && catProducts.length > 0) {
      // Réaffichage de la catégorie : on réaffiche aussi tous ses produits
      const { error: prodError } = await supabaseClient
        .from('products')
        .update({ hidden: false })
        .eq('category_id', categoryId);
      if (prodError) throw prodError;
      catProducts.forEach(p => { p.hidden = false; });
    }

    showToast(newHidden
      ? `✓ Catégorie « ${cat.name} » masquée (${catProducts.length} produit${catProducts.length > 1 ? 's' : ''})`
      : `✓ Catégorie « ${cat.name} » de nouveau visible`);
    renderAdminCatList();
    renderAdminProductList();
    renderCategoryStrip();
    renderGrid();
    renderHomeTiles();
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la mise à jour de la catégorie');
  }
}


async function bulkSetUnitStepForCategory(categoryId, qty) {
  const cat = categories.find(c => c.id === categoryId);
  const catProducts = products.filter(p => p.categoryId === categoryId);
  if (catProducts.length === 0) {
    showToast('Aucun produit dans cette catégorie');
    return;
  }
  const label = qty > 1 ? `lot de ${qty}` : 'la vente à l\'unité';
  if (!confirm(`Appliquer "${label}" aux ${catProducts.length} produit(s) de « ${cat.name} » ?`)) return;

  const unitLabel = qty > 1 ? `Lot de ${qty}` : '';
  try {
    const { error } = await supabaseClient
      .from('products')
      .update({ unit_step: qty, unit_label: unitLabel })
      .eq('category_id', categoryId);
    if (error) throw error;
    catProducts.forEach(p => { p.unitStep = qty; p.unitLabel = unitLabel; });
    showToast(`✓ ${catProducts.length} produit(s) mis à jour`);
    renderAdminProductList();
    renderGrid();
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la mise à jour groupée');
  }
}

function setupAddCategory() {
  document.getElementById('addCatBtn').addEventListener('click', async () => {
    const input = document.getElementById('newCatInput');
    const name = input.value.trim();
    if (!name) return;
    const newCat = { id: uid('cat'), name, sort_order: categories.length + 1 };
    const { error } = await supabaseClient.from('categories').insert(newCat);
    if (error) { showToast('⚠️ Erreur'); return; }
    categories.push({ id: newCat.id, name: newCat.name });
    input.value = '';
    renderAdminCatList();
    renderCategoryStrip();
    showToast('Catégorie ajoutée');
  });
}

/* =========================================================
   ADMIN — Réglages
   ========================================================= */
/* Applique le nom, le sous-titre et le logo de la boutique sur la page
   publique. Si aucun logo personnalisé n'est défini, le logo SVG par
   défaut (Tour Eiffel dessinée) reste affiché. */
function applyBrandingToPage() {
  document.getElementById('shopNameDisplay').textContent = settings.shop_name || 'Souvenirs de Paris';
  const subtitleEl = document.getElementById('shopSubtitleDisplay');
  if (subtitleEl) subtitleEl.textContent = settings.subtitle || 'Souvenirs de Paris';

  const markEl = document.getElementById('brandMark');
  if (markEl) {
    if (settings.logo_image) {
      markEl.innerHTML = `<img src="${settings.logo_image}" alt="Logo">`;
    } else {
      markEl.innerHTML = DEFAULT_LOGO_SVG;
    }
  }
}

/* Convertit une couleur hex (#RRGGBB) en chaîne rgba(...) avec l'alpha
   donné (0-1), utilisé pour générer les variables de "verre". */
function hexToRgba(hex, alpha) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
  if (!m) return `rgba(255,255,255,${alpha})`;
  const r = parseInt(m[1], 16), g = parseInt(m[2], 16), b = parseInt(m[3], 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* Applique tous les réglages de thème (flou, tailles, espacements...) en
   tant que variables CSS sur :root, ce qui les fait immédiatement
   prendre effet partout dans la feuille de style sans avoir à dupliquer
   la logique CSS en JS. Appelée au chargement et en direct à chaque
   modification d'un curseur dans l'admin (aperçu live avant sauvegarde). */
function applyThemeToPage() {
  const r = document.documentElement.style;
  const t = theme;

  const glassAlpha = (t.glassOpacity != null ? t.glassOpacity : 50) / 100;
  const blurPx = t.glassBlur != null ? t.glassBlur : 28;
  r.setProperty('--glass-bg', hexToRgba('#ffffff', Math.max(0.1, glassAlpha - 0.12)));
  r.setProperty('--glass-bg-strong', hexToRgba('#ffffff', Math.min(0.95, glassAlpha + 0.18)));
  r.setProperty('--glass-bg-navy', hexToRgba('#1B2A45', glassAlpha + 0.05));
  r.setProperty('--glass-blur', `blur(${blurPx}px) saturate(180%)`);
  r.setProperty('--glass-blur-soft', `blur(${Math.max(0, blurPx - 10)}px) saturate(160%)`);

  r.setProperty('--card-radius', `${t.cardRadius != null ? t.cardRadius : 16}px`);
  r.setProperty('--chip-radius', `${t.chipRadius != null ? t.chipRadius : 18}px`);
  r.setProperty('--price-size', `${t.priceSize != null ? t.priceSize : 21}px`);
  r.setProperty('--name-size', `${t.nameSize != null ? t.nameSize : 13.5}px`);
  r.setProperty('--font-heading', t.fontHeading || "'Fraunces', serif");
  r.setProperty('--font-body', t.fontBody || "'Jost', sans-serif");
  r.setProperty('--button-radius', `${t.buttonRadius != null ? t.buttonRadius : 24}px`);
  r.setProperty('--add-btn-size', `${t.addBtnSize != null ? t.addBtnSize : 34}px`);
  r.setProperty('--image-padding', `${t.imagePadding != null ? t.imagePadding : 14}px`);
  r.setProperty('--card-gap', `${t.cardGap != null ? t.cardGap : 8}px`);

  const shadowAlpha = (t.cardShadow != null ? t.cardShadow : 18) / 100;
  r.setProperty('--glass-shadow', `0 8px 32px rgba(20,20,30,${shadowAlpha})`);

  const speedMultiplier = 100 / (t.animSpeed != null ? t.animSpeed : 100);
  r.setProperty('--anim-speed-fast', `${(0.12 * speedMultiplier).toFixed(3)}s`);
  r.setProperty('--anim-speed-normal', `${(0.3 * speedMultiplier).toFixed(3)}s`);
  r.setProperty('--anim-speed-slow', `${(0.45 * speedMultiplier).toFixed(3)}s`);

  // ===== Transparence & flou par zone =====
  r.setProperty('--topbar-bg', hexToRgba('#F7F4EE', (t.topbarOpacity != null ? t.topbarOpacity : 92) / 100));
  r.setProperty('--topbar-blur', `blur(${t.topbarBlur != null ? t.topbarBlur : 28}px) saturate(180%)`);
  r.setProperty('--catstrip-chip-bg', hexToRgba('#ffffff', (t.catStripOpacity != null ? t.catStripOpacity : 38) / 100));
  const drawerAlpha = (t.drawerOpacity != null ? t.drawerOpacity : 68) / 100;
  r.setProperty('--drawer-bg', hexToRgba('#ffffff', drawerAlpha));
  r.setProperty('--drawer-blur', `blur(${t.drawerBlur != null ? t.drawerBlur : 28}px) saturate(180%)`);
  r.setProperty('--cartfab-bg', hexToRgba('#1B2A45', (t.cartFabOpacity != null ? t.cartFabOpacity : 55) / 100));
  r.setProperty('--overlay-bg', hexToRgba('#080c16', (t.overlayOpacity != null ? t.overlayOpacity : 55) / 100));
  r.setProperty('--toast-opacity', String((t.toastOpacity != null ? t.toastOpacity : 100) / 100));

  // ===== 17 réglages additionnels =====
  r.setProperty('--shop-name-size', `${t.shopNameSize != null ? t.shopNameSize : 21}px`);
  r.setProperty('--logo-size', `${t.logoSize != null ? t.logoSize : 38}px`);
  r.setProperty('--search-bar-height', `${t.searchBarHeight != null ? t.searchBarHeight : 45}px`);
  r.setProperty('--search-font-size', `${t.searchFontSize != null ? t.searchFontSize : 14.5}px`);
  r.setProperty('--image-aspect', `${(t.imageAspectRatio != null ? t.imageAspectRatio : 100) / 100}`);
  r.setProperty('--name-line-height', `${(t.lineHeight != null ? t.lineHeight : 132) / 100}`);
  r.setProperty('--ref-size', `${t.refSize != null ? t.refSize : 10}px`);
  r.setProperty('--header-shadow', `0 6px 18px rgba(20,20,30,${(t.headerShadow != null ? t.headerShadow : 6) / 100})`);
  const toastSpeedMultiplier = 100 / (t.toastSpeed != null ? t.toastSpeed : 100);
  r.setProperty('--toast-speed', `${(0.3 * toastSpeedMultiplier).toFixed(3)}s`);
  r.setProperty('--drawer-close-size', `${t.drawerCloseSize != null ? t.drawerCloseSize : 32}px`);
  r.setProperty('--catstrip-padding', `${t.catStripPadding != null ? t.catStripPadding : 14}px`);
  r.setProperty('--chip-gap', `${t.chipGap != null ? t.chipGap : 9}px`);
  r.setProperty('--cart-icon-size', `${t.cartIconSize != null ? t.cartIconSize : 48}px`);
  r.setProperty('--lot-label-size', `${t.lotLabelSize != null ? t.lotLabelSize : 11.5}px`);
  r.setProperty('--size-badge-diameter', `${t.sizeBadgeDiameter != null ? t.sizeBadgeDiameter : 30}px`);
  r.setProperty('--size-badge-font-size', `${t.sizeBadgeFontSize != null ? t.sizeBadgeFontSize : 13}px`);
  r.setProperty('--size-badge-bg', t.sizeBadgeBg || '#1B2A45');
  r.setProperty('--size-badge-text', t.sizeBadgeText || '#D89A2C');
  r.setProperty('--size-badge-border', t.sizeBadgeBorder || '#D89A2C');
  r.setProperty('--image-radius', `${t.imageRadius != null ? t.imageRadius : 0}px`);
  r.setProperty('--press-scale', `${1 - (t.pressScale != null ? t.pressScale : 8) / 100}`);
  r.setProperty('--bg-image-opacity', String((t.bgImageOpacity != null ? t.bgImageOpacity : 100) / 100));
  r.setProperty('--bg-overlay-opacity', String((t.bgOverlayOpacity != null ? t.bgOverlayOpacity : 55) / 100));
  if (settings.background_image) {
    r.setProperty('--bg-image', `url('${settings.background_image}')`);
  } else {
    r.removeProperty('--bg-image');
  }

  // Les cartes utilisent directement une couleur rgba (pas backdrop-filter,
  // pour les raisons de performance vues plus haut) : on la recalcule ici.
  const cardAlpha = (t.cardOpacity != null ? t.cardOpacity : 62) / 100;
  document.querySelectorAll('.ticket').forEach(el => {
    el.style.background = `rgba(255,255,255,${cardAlpha})`;
    el.style.borderRadius = `${t.cardRadius != null ? t.cardRadius : 16}px`;
  });
}

function prefillSettings() {
  document.getElementById('settingWhatsapp').value = settings.whatsapp || '';
  document.getElementById('settingEmail').value = settings.email || '';
  document.getElementById('settingShopName').value = settings.shop_name || '';
  document.getElementById('settingSubtitle').value = settings.subtitle || '';
  const logoPreview = document.getElementById('logoPreview');
  const logoPlaceholder = document.getElementById('logoPlaceholder');
  if (settings.logo_image) {
    logoPreview.src = settings.logo_image;
    logoPreview.style.display = 'block';
    logoPlaceholder.style.display = 'none';
  } else {
    logoPreview.style.display = 'none';
    logoPlaceholder.style.display = 'block';
  }
}
function setupSettingsSave() {
  document.getElementById('saveSettingsBtn').addEventListener('click', async () => {
    const shop_name = document.getElementById('settingShopName').value.trim() || 'Souvenirs de Paris';
    const subtitle = document.getElementById('settingSubtitle').value.trim() || 'Souvenirs de Paris';
    const whatsapp = document.getElementById('settingWhatsapp').value.trim();
    const email = document.getElementById('settingEmail').value.trim();
    const { error } = await supabaseClient.from('settings').update({ shop_name, subtitle, whatsapp, email }).eq('id', 1);
    if (error) { showToast('⚠️ Erreur'); return; }
    settings.shop_name = shop_name; settings.subtitle = subtitle; settings.whatsapp = whatsapp; settings.email = email;
    applyBrandingToPage();
    showToast('Réglages enregistrés');
  });
  document.getElementById('savePinBtn').addEventListener('click', async () => {
    const val = document.getElementById('newPinInput').value.trim();
    if (!/^\d{4}$/.test(val)) {
      showToast('Le code doit comporter 4 chiffres');
      return;
    }
    const { error } = await supabaseClient.from('settings').update({ admin_pin: val }).eq('id', 1);
    if (error) { showToast('⚠️ Erreur'); return; }
    settings.admin_pin = val;
    document.getElementById('newPinInput').value = '';
    showToast('Code admin mis à jour');
  });
}

/* Remplit les contrôles du panneau "Thème & apparence" avec les valeurs
   actuelles (sauvegardées ou par défaut). */
function prefillThemeControls() {
  document.getElementById('themeGlassOpacity').value = theme.glassOpacity;
  document.getElementById('valGlassOpacity').textContent = theme.glassOpacity + '%';
  document.getElementById('themeGlassBlur').value = theme.glassBlur;
  document.getElementById('valGlassBlur').textContent = theme.glassBlur + 'px';
  document.getElementById('themeTopbarOpacity').value = theme.topbarOpacity;
  document.getElementById('valTopbarOpacity').textContent = theme.topbarOpacity + '%';
  document.getElementById('themeCatStripOpacity').value = theme.catStripOpacity;
  document.getElementById('valCatStripOpacity').textContent = theme.catStripOpacity + '%';
  document.getElementById('themeDrawerOpacity').value = theme.drawerOpacity;
  document.getElementById('valDrawerOpacity').textContent = theme.drawerOpacity + '%';
  document.getElementById('themeDrawerBlur').value = theme.drawerBlur;
  document.getElementById('valDrawerBlur').textContent = theme.drawerBlur + 'px';
  document.getElementById('themeCartFabOpacity').value = theme.cartFabOpacity;
  document.getElementById('valCartFabOpacity').textContent = theme.cartFabOpacity + '%';
  document.getElementById('themeOverlayOpacity').value = theme.overlayOpacity;
  document.getElementById('valOverlayOpacity').textContent = theme.overlayOpacity + '%';
  document.getElementById('themeToastOpacity').value = theme.toastOpacity;
  document.getElementById('valToastOpacity').textContent = theme.toastOpacity + '%';

  document.getElementById('themeShopNameSize').value = theme.shopNameSize;
  document.getElementById('valShopNameSize').textContent = theme.shopNameSize + 'px';
  document.getElementById('themeLogoSize').value = theme.logoSize;
  document.getElementById('valLogoSize').textContent = theme.logoSize + 'px';
  document.getElementById('themeSearchBarHeight').value = theme.searchBarHeight;
  document.getElementById('valSearchBarHeight').textContent = theme.searchBarHeight + 'px';
  document.getElementById('themeSearchFontSize').value = theme.searchFontSize;
  document.getElementById('valSearchFontSize').textContent = theme.searchFontSize + 'px';
  document.getElementById('themeCartIconSize').value = theme.cartIconSize;
  document.getElementById('valCartIconSize').textContent = theme.cartIconSize + 'px';
  document.getElementById('themeCatStripPadding').value = theme.catStripPadding;
  document.getElementById('valCatStripPadding').textContent = theme.catStripPadding + 'px';

  document.getElementById('themeCardOpacity').value = theme.cardOpacity;
  document.getElementById('valCardOpacity').textContent = theme.cardOpacity + '%';
  document.getElementById('themeCardRadius').value = theme.cardRadius;
  document.getElementById('valCardRadius').textContent = theme.cardRadius + 'px';
  document.getElementById('themeCardShadow').value = theme.cardShadow;
  document.getElementById('valCardShadow').textContent = theme.cardShadow + '%';
  document.getElementById('themeCardGap').value = theme.cardGap;
  document.getElementById('valCardGap').textContent = theme.cardGap + 'px';
  document.getElementById('themeHeaderShadow').value = theme.headerShadow;
  document.getElementById('valHeaderShadow').textContent = theme.headerShadow + '%';
  document.getElementById('themePressScale').value = theme.pressScale;
  document.getElementById('valPressScale').textContent = theme.pressScale + '%';
  document.getElementById('themeBgImageOpacity').value = theme.bgImageOpacity;
  document.getElementById('valBgImageOpacity').textContent = theme.bgImageOpacity + '%';
  document.getElementById('themeBgOverlayOpacity').value = theme.bgOverlayOpacity;
  document.getElementById('valBgOverlayOpacity').textContent = theme.bgOverlayOpacity + '%';
  const bgPreview = document.getElementById('bgImagePreview');
  if (settings.background_image) {
    bgPreview.src = settings.background_image;
    bgPreview.style.display = 'block';
  } else {
    bgPreview.style.display = 'none';
  }

  document.getElementById('themeChipRadius').value = theme.chipRadius;
  document.getElementById('valChipRadius').textContent = theme.chipRadius + 'px';
  document.getElementById('themeChipGap').value = theme.chipGap;
  document.getElementById('valChipGap').textContent = theme.chipGap + 'px';

  document.getElementById('themePriceSize').value = theme.priceSize;
  document.getElementById('valPriceSize').textContent = theme.priceSize + 'px';
  document.getElementById('themeNameSize').value = theme.nameSize;
  document.getElementById('valNameSize').textContent = theme.nameSize + 'px';
  document.getElementById('themeLineHeight').value = theme.lineHeight;
  document.getElementById('valLineHeight').textContent = theme.lineHeight + '%';
  document.getElementById('themeRefSize').value = theme.refSize;
  document.getElementById('valRefSize').textContent = theme.refSize + 'px';
  document.getElementById('themeLotLabelSize').value = theme.lotLabelSize;
  document.getElementById('valLotLabelSize').textContent = theme.lotLabelSize + 'px';
  document.getElementById('themeSizeBadgeDiameter').value = theme.sizeBadgeDiameter != null ? theme.sizeBadgeDiameter : 30;
  document.getElementById('valSizeBadgeDiameter').textContent = (theme.sizeBadgeDiameter != null ? theme.sizeBadgeDiameter : 30) + 'px';
  document.getElementById('themeSizeBadgeFontSize').value = theme.sizeBadgeFontSize != null ? theme.sizeBadgeFontSize : 13;
  document.getElementById('valSizeBadgeFontSize').textContent = (theme.sizeBadgeFontSize != null ? theme.sizeBadgeFontSize : 13) + 'px';
  document.getElementById('themeSizeBadgeBg').value = theme.sizeBadgeBg || '#1B2A45';
  document.getElementById('themeSizeBadgeText').value = theme.sizeBadgeText || '#D89A2C';
  document.getElementById('themeSizeBadgeBorder').value = theme.sizeBadgeBorder || '#D89A2C';
  document.getElementById('themeFontHeading').value = theme.fontHeading;
  document.getElementById('themeFontBody').value = theme.fontBody;

  document.getElementById('themeButtonRadius').value = theme.buttonRadius;
  document.getElementById('valButtonRadius').textContent = theme.buttonRadius + 'px';
  document.getElementById('themeAddBtnSize').value = theme.addBtnSize;
  document.getElementById('valAddBtnSize').textContent = theme.addBtnSize + 'px';
  document.getElementById('themeDrawerCloseSize').value = theme.drawerCloseSize;
  document.getElementById('valDrawerCloseSize').textContent = theme.drawerCloseSize + 'px';

  document.getElementById('themeImagePadding').value = theme.imagePadding;
  document.getElementById('valImagePadding').textContent = theme.imagePadding + 'px';
  document.getElementById('themeImageAspectRatio').value = theme.imageAspectRatio;
  document.getElementById('valImageAspectRatio').textContent = theme.imageAspectRatio + '%';
  document.getElementById('themeImageRadius').value = theme.imageRadius;
  document.getElementById('valImageRadius').textContent = theme.imageRadius + 'px';

  document.getElementById('themeAnimSpeed').value = theme.animSpeed;
  document.getElementById('valAnimSpeed').textContent = theme.animSpeed + '%';
  document.getElementById('themeToastSpeed').value = theme.toastSpeed;
  document.getElementById('valToastSpeed').textContent = theme.toastSpeed + '%';

  document.getElementById('themeShowPromo').checked = theme.showPromoSection;
  document.getElementById('themePromoLabel').value = theme.promoLabel;
  document.getElementById('themeShowNew').checked = theme.showNewSection;
  document.getElementById('themeNewLabel').value = theme.newLabel;
}

/* Lit l'état actuel de tous les contrôles du panneau et retourne l'objet
   thème correspondant (utilisé à la fois par l'aperçu live et par la
   sauvegarde, pour ne jamais avoir deux logiques de lecture différentes). */
function readThemeFromControls() {
  return {
    glassOpacity: parseInt(document.getElementById('themeGlassOpacity').value, 10),
    glassBlur: parseInt(document.getElementById('themeGlassBlur').value, 10),
    topbarOpacity: parseInt(document.getElementById('themeTopbarOpacity').value, 10),
    catStripOpacity: parseInt(document.getElementById('themeCatStripOpacity').value, 10),
    drawerOpacity: parseInt(document.getElementById('themeDrawerOpacity').value, 10),
    drawerBlur: parseInt(document.getElementById('themeDrawerBlur').value, 10),
    cartFabOpacity: parseInt(document.getElementById('themeCartFabOpacity').value, 10),
    overlayOpacity: parseInt(document.getElementById('themeOverlayOpacity').value, 10),
    toastOpacity: parseInt(document.getElementById('themeToastOpacity').value, 10),

    shopNameSize: parseInt(document.getElementById('themeShopNameSize').value, 10),
    logoSize: parseInt(document.getElementById('themeLogoSize').value, 10),
    searchBarHeight: parseInt(document.getElementById('themeSearchBarHeight').value, 10),
    searchFontSize: parseFloat(document.getElementById('themeSearchFontSize').value),
    cartIconSize: parseInt(document.getElementById('themeCartIconSize').value, 10),
    catStripPadding: parseInt(document.getElementById('themeCatStripPadding').value, 10),

    cardOpacity: parseInt(document.getElementById('themeCardOpacity').value, 10),
    cardRadius: parseInt(document.getElementById('themeCardRadius').value, 10),
    cardShadow: parseInt(document.getElementById('themeCardShadow').value, 10),
    cardGap: parseInt(document.getElementById('themeCardGap').value, 10),
    headerShadow: parseInt(document.getElementById('themeHeaderShadow').value, 10),
    pressScale: parseInt(document.getElementById('themePressScale').value, 10),
    bgImageOpacity: parseInt(document.getElementById('themeBgImageOpacity').value, 10),
    bgOverlayOpacity: parseInt(document.getElementById('themeBgOverlayOpacity').value, 10),

    chipRadius: parseInt(document.getElementById('themeChipRadius').value, 10),
    chipGap: parseInt(document.getElementById('themeChipGap').value, 10),

    priceSize: parseInt(document.getElementById('themePriceSize').value, 10),
    nameSize: parseFloat(document.getElementById('themeNameSize').value),
    lineHeight: parseInt(document.getElementById('themeLineHeight').value, 10),
    refSize: parseInt(document.getElementById('themeRefSize').value, 10),
    lotLabelSize: parseFloat(document.getElementById('themeLotLabelSize').value),
    sizeBadgeDiameter: parseFloat(document.getElementById('themeSizeBadgeDiameter').value),
    sizeBadgeFontSize: parseFloat(document.getElementById('themeSizeBadgeFontSize').value),
    sizeBadgeBg: document.getElementById('themeSizeBadgeBg').value,
    sizeBadgeText: document.getElementById('themeSizeBadgeText').value,
    sizeBadgeBorder: document.getElementById('themeSizeBadgeBorder').value,
    fontHeading: document.getElementById('themeFontHeading').value,
    fontBody: document.getElementById('themeFontBody').value,

    buttonRadius: parseInt(document.getElementById('themeButtonRadius').value, 10),
    addBtnSize: parseInt(document.getElementById('themeAddBtnSize').value, 10),
    drawerCloseSize: parseInt(document.getElementById('themeDrawerCloseSize').value, 10),

    imagePadding: parseInt(document.getElementById('themeImagePadding').value, 10),
    imageAspectRatio: parseInt(document.getElementById('themeImageAspectRatio').value, 10),
    imageRadius: parseInt(document.getElementById('themeImageRadius').value, 10),

    animSpeed: parseInt(document.getElementById('themeAnimSpeed').value, 10),
    toastSpeed: parseInt(document.getElementById('themeToastSpeed').value, 10),

    showPromoSection: document.getElementById('themeShowPromo').checked,
    showNewSection: document.getElementById('themeShowNew').checked,
    promoLabel: document.getElementById('themePromoLabel').value.trim() || DEFAULT_THEME.promoLabel,
    newLabel: document.getElementById('themeNewLabel').value.trim() || DEFAULT_THEME.newLabel
  };
}

/* Définit une photo de fond personnalisée pour tout le site, remplaçant
   la photo de Paris par défaut. Même traitement (redimensionnement,
   compression) que pour le logo et les photos de catégorie. */
function setBackgroundImage(file) {
  if (file.size > 6 * 1024 * 1024) {
    showToast('Image trop lourde (max 6 Mo)');
    return;
  }
  showToast('⏳ Envoi de la photo…');
  (async () => {
    try {
      const publicUrl = await uploadImageToStorage(file, 'background');
      const { error } = await supabaseClient.from('settings').update({ background_image: publicUrl }).eq('id', 1);
      if (error) throw error;
      settings.background_image = publicUrl;
      applyThemeToPage();
      prefillThemeControls();
      showToast('✓ Photo de fond mise à jour');
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de l\'enregistrement de la photo');
    }
  })();
}

async function resetBackgroundImage() {
  try {
    const { error } = await supabaseClient.from('settings').update({ background_image: null }).eq('id', 1);
    if (error) throw error;
    settings.background_image = null;
    applyThemeToPage();
    prefillThemeControls();
    showToast('✓ Photo de Paris par défaut restaurée');
  } catch (e) {
    console.error(e);
    showToast('⚠️ Erreur lors de la réinitialisation');
  }
}

function setupThemeControls() {
  // Mise à jour en direct des étiquettes de valeur ET application
  // immédiate sur le site (aperçu live) à chaque glissement de curseur,
  // sans attendre la sauvegarde. Les curseurs n'affectent que des
  // variables CSS (déjà appliquées en direct à chaque élément par
  // applyThemeToPage) : on évite donc tout renderGrid()/renderCategoryStrip()
  // ici, sinon le glissement reconstruit tout le catalogue à chaque pixel
  // de déplacement et provoque un vrai ralentissement perceptible.
  const sliderMap = [
    ['themeGlassOpacity', 'valGlassOpacity', '%'],
    ['themeGlassBlur', 'valGlassBlur', 'px'],
    ['themeTopbarOpacity', 'valTopbarOpacity', '%'],
    ['themeCatStripOpacity', 'valCatStripOpacity', '%'],
    ['themeDrawerOpacity', 'valDrawerOpacity', '%'],
    ['themeDrawerBlur', 'valDrawerBlur', 'px'],
    ['themeCartFabOpacity', 'valCartFabOpacity', '%'],
    ['themeOverlayOpacity', 'valOverlayOpacity', '%'],
    ['themeToastOpacity', 'valToastOpacity', '%'],
    ['themeShopNameSize', 'valShopNameSize', 'px'],
    ['themeLogoSize', 'valLogoSize', 'px'],
    ['themeSearchBarHeight', 'valSearchBarHeight', 'px'],
    ['themeSearchFontSize', 'valSearchFontSize', 'px'],
    ['themeCartIconSize', 'valCartIconSize', 'px'],
    ['themeCatStripPadding', 'valCatStripPadding', 'px'],
    ['themeCardOpacity', 'valCardOpacity', '%'],
    ['themeCardRadius', 'valCardRadius', 'px'],
    ['themeCardShadow', 'valCardShadow', '%'],
    ['themeCardGap', 'valCardGap', 'px'],
    ['themeHeaderShadow', 'valHeaderShadow', '%'],
    ['themePressScale', 'valPressScale', '%'],
    ['themeBgImageOpacity', 'valBgImageOpacity', '%'],
    ['themeBgOverlayOpacity', 'valBgOverlayOpacity', '%'],
    ['themeChipRadius', 'valChipRadius', 'px'],
    ['themeChipGap', 'valChipGap', 'px'],
    ['themePriceSize', 'valPriceSize', 'px'],
    ['themeNameSize', 'valNameSize', 'px'],
    ['themeLineHeight', 'valLineHeight', '%'],
    ['themeRefSize', 'valRefSize', 'px'],
    ['themeLotLabelSize', 'valLotLabelSize', 'px'],
    ['themeSizeBadgeDiameter', 'valSizeBadgeDiameter', 'px'],
    ['themeSizeBadgeFontSize', 'valSizeBadgeFontSize', 'px'],
    ['themeButtonRadius', 'valButtonRadius', 'px'],
    ['themeAddBtnSize', 'valAddBtnSize', 'px'],
    ['themeDrawerCloseSize', 'valDrawerCloseSize', 'px'],
    ['themeImagePadding', 'valImagePadding', 'px'],
    ['themeImageAspectRatio', 'valImageAspectRatio', '%'],
    ['themeImageRadius', 'valImageRadius', 'px'],
    ['themeAnimSpeed', 'valAnimSpeed', '%'],
    ['themeToastSpeed', 'valToastSpeed', '%']
  ];
  function livePreviewStyleOnly() {
    theme = readThemeFromControls();
    applyThemeToPage();
  }
  sliderMap.forEach(([inputId, labelId, unit]) => {
    const input = document.getElementById(inputId);
    const label = document.getElementById(labelId);
    input.addEventListener('input', () => {
      label.textContent = input.value + unit;
      livePreviewStyleOnly();
    });
  });

  ['themeSizeBadgeBg', 'themeSizeBadgeText', 'themeSizeBadgeBorder'].forEach(id => {
    document.getElementById(id).addEventListener('input', livePreviewStyleOnly);
  });

  // Les bascules Promo/Nouveauté et leurs libellés changent du texte et
  // la présence de sections entières : elles ont réellement besoin de
  // renderGrid()/renderCategoryStrip(), mais ça reste rare (toggle/texte
  // tapé) donc sans impact sur la fluidité des curseurs ci-dessus.
  function livePreviewFull() {
    theme = readThemeFromControls();
    applyThemeToPage();
    renderGrid();
    renderCategoryStrip();
  }
  ['themeFontHeading', 'themeFontBody', 'themeShowPromo', 'themeShowNew'].forEach(id => {
    document.getElementById(id).addEventListener('change', livePreviewFull);
  });
  let labelDebounceTimer = null;
  ['themePromoLabel', 'themeNewLabel'].forEach(id => {
    document.getElementById(id).addEventListener('input', () => {
      clearTimeout(labelDebounceTimer);
      labelDebounceTimer = setTimeout(livePreviewFull, 250);
    });
  });

  document.getElementById('chooseBgImageBtn').addEventListener('click', () => {
    document.getElementById('bgImageInput').click();
  });
  document.getElementById('bgImageInput').addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) setBackgroundImage(file);
    e.target.value = '';
  });
  document.getElementById('resetBgImageBtn').addEventListener('click', () => resetBackgroundImage());

  document.getElementById('saveThemeBtn').addEventListener('click', async () => {
    const newTheme = readThemeFromControls();
    try {
      const { error } = await supabaseClient.from('settings').update({ theme_settings: newTheme }).eq('id', 1);
      if (error) throw error;
      theme = newTheme;
      savedTheme = Object.assign({}, newTheme);
      applyThemeToPage();
      renderGrid();
      renderCategoryStrip();
      showToast('✓ Apparence enregistrée');
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de l\'enregistrement de l\'apparence');
    }
  });

  document.getElementById('resetThemeBtn').addEventListener('click', () => {
    // Annule l'aperçu en cours et revient à la dernière version
    // effectivement enregistrée (pas forcément les valeurs par défaut).
    theme = Object.assign({}, savedTheme);
    applyThemeToPage();
    prefillThemeControls();
    renderGrid();
    renderCategoryStrip();
    showToast('Aperçu annulé');
  });
}

/* Téléchargement et réinitialisation du logo de la boutique, stocké
   directement (image légère redimensionnée) dans settings.logo_image,
   comme pour les photos de produits. */
function setupLogoUpload() {
  const fileInput = document.getElementById('logoFileInput');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      showToast('Image trop lourde (max 4 Mo)');
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = async () => {
        const maxDim = 300;
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = h * maxDim / w; w = maxDim; }
        else if (h > maxDim) { w = w * maxDim / h; h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const logoData = canvas.toDataURL('image/png');

        try {
          const { error } = await supabaseClient.from('settings').update({ logo_image: logoData }).eq('id', 1);
          if (error) throw error;
          settings.logo_image = logoData;
          applyBrandingToPage();
          prefillSettings();
          showToast('✓ Logo mis à jour');
        } catch (err) {
          console.error(err);
          showToast('⚠️ Erreur lors de l\'enregistrement du logo');
        }
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('resetLogoBtn').addEventListener('click', async () => {
    try {
      const { error } = await supabaseClient.from('settings').update({ logo_image: null }).eq('id', 1);
      if (error) throw error;
      settings.logo_image = null;
      applyBrandingToPage();
      prefillSettings();
      showToast('✓ Logo par défaut restauré');
    } catch (err) {
      console.error(err);
      showToast('⚠️ Erreur lors de la réinitialisation');
    }
  });
}

/* =========================================================
   ADMIN — Formulaire produit + détourage local
   ========================================================= */
function populateCategorySelect() {
  const sel = document.getElementById('formCategory');
  sel.innerHTML = categories.map(c => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join('');
}

function setupUnitToggle() {
  const unitBtn = document.getElementById('unitToggleUnit');
  const bulkBtn = document.getElementById('unitToggleBulk');
  const bulkWrap = document.getElementById('bulkSizeWrap');
  unitBtn.addEventListener('click', () => {
    currentUnitMode = 'unit';
    unitBtn.classList.add('active'); bulkBtn.classList.remove('active');
    bulkWrap.style.display = 'none';
  });
  bulkBtn.addEventListener('click', () => {
    currentUnitMode = 'bulk';
    bulkBtn.classList.add('active'); unitBtn.classList.remove('active');
    bulkWrap.style.display = 'block';
  });
}

function openProductForm(productId) {
  editingProductId = productId || null;
  populateCategorySelect();
  pendingImageData = null;

  const title = document.getElementById('productFormTitle');
  const imgPreview = document.getElementById('imagePreview');
  const imgPlaceholder = document.getElementById('imagePlaceholder');
  const delBtn = document.getElementById('deleteProductBtn');
  const cropBtn = document.getElementById('openCropBtn');

  if (editingProductId) {
    const p = products.find(x => x.id === editingProductId);
    title.textContent = 'Modifier le produit';
    document.getElementById('formName').value = p.name;
    document.getElementById('formRef').value = p.ref;
    document.getElementById('formPrice').value = p.price;
    document.getElementById('formCategory').value = p.categoryId;
    document.getElementById('formSize').value = p.size || '';
    document.getElementById('outOfStockToggle').checked = !!p.outOfStock;
    document.getElementById('featuredToggle').checked = !!p.featured;
    document.getElementById('newToggle').checked = !!p.isNew;
    document.getElementById('promoToggle').checked = !!p.isPromo;
    imgPreview.src = p.image || '';
    imgPreview.style.display = 'block';
    imgPlaceholder.style.display = 'none';
    pendingImageData = p.image;
    delBtn.style.display = 'block';
    cropBtn.style.display = p.image ? 'block' : 'none';

    if (p.unitStep > 1) {
      currentUnitMode = 'bulk';
      document.getElementById('unitToggleBulk').classList.add('active');
      document.getElementById('unitToggleUnit').classList.remove('active');
      document.getElementById('bulkSizeWrap').style.display = 'block';
      document.getElementById('formUnitStep').value = p.unitStep;
    } else {
      currentUnitMode = 'unit';
      document.getElementById('unitToggleUnit').classList.add('active');
      document.getElementById('unitToggleBulk').classList.remove('active');
      document.getElementById('bulkSizeWrap').style.display = 'none';
      document.getElementById('formUnitStep').value = '';
    }
  } else {
    title.textContent = 'Nouveau produit';
    document.getElementById('formName').value = '';
    document.getElementById('formRef').value = '';
    document.getElementById('formPrice').value = '';
    if (categories.length) document.getElementById('formCategory').value = categories[0].id;
    document.getElementById('formSize').value = '';
    document.getElementById('outOfStockToggle').checked = false;
    document.getElementById('featuredToggle').checked = false;
    document.getElementById('newToggle').checked = false;
    document.getElementById('promoToggle').checked = false;
    imgPreview.style.display = 'none';
    imgPlaceholder.style.display = 'block';
    delBtn.style.display = 'none';
    cropBtn.style.display = 'none';
    currentUnitMode = 'unit';
    document.getElementById('unitToggleUnit').classList.add('active');
    document.getElementById('unitToggleBulk').classList.remove('active');
    document.getElementById('bulkSizeWrap').style.display = 'none';
    document.getElementById('formUnitStep').value = '';
  }
  openDrawer('productFormDrawer');
}

function setupImageUpload() {
  const fileInput = document.getElementById('imageFileInput');
  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 6 * 1024 * 1024) {
      showToast('Image trop lourde (max 6 Mo)');
      return;
    }

    const reader = new FileReader();
    reader.onload = (ev) => {
      const img = new Image();
      img.onload = () => {
        const maxDim = 800;
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = h * maxDim / w; w = maxDim; }
        else if (h > maxDim) { w = w * maxDim / h; h = maxDim; }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);

        pendingImageData = canvas.toDataURL('image/jpeg', 0.85);
        document.getElementById('imagePreview').src = pendingImageData;
        document.getElementById('imagePreview').style.display = 'block';
        document.getElementById('imagePlaceholder').style.display = 'none';
        document.getElementById('openCropBtn').style.display = 'block';
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

/* ---------- Recadrage / ajustement manuel de la photo ----------
   Permet de zoomer et déplacer l'image existante dans un cadre carré,
   puis d'exporter le résultat comme nouvelle image du produit. */
let cropImageObj = null;
let cropState = { scale: 1, offsetX: 0, offsetY: 0, dragging: false, lastX: 0, lastY: 0 };

function setupImageCropper() {
  const canvas = document.getElementById('cropCanvas');
  const ctx = canvas.getContext('2d');
  const zoomSlider = document.getElementById('cropZoomSlider');

  function drawCrop() {
    if (!cropImageObj) return;
    const size = canvas.width; // carré
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, size, size);

    const iw = cropImageObj.naturalWidth, ih = cropImageObj.naturalHeight;
    const baseScale = Math.max(size / iw, size / ih); // couvre tout le cadre
    const scale = baseScale * cropState.scale;
    const drawW = iw * scale, drawH = ih * scale;
    const drawX = (size - drawW) / 2 + cropState.offsetX;
    const drawY = (size - drawH) / 2 + cropState.offsetY;
    ctx.drawImage(cropImageObj, drawX, drawY, drawW, drawH);
  }

  function clampOffsets() {
    if (!cropImageObj) return;
    const size = canvas.width;
    const iw = cropImageObj.naturalWidth, ih = cropImageObj.naturalHeight;
    const baseScale = Math.max(size / iw, size / ih);
    const scale = baseScale * cropState.scale;
    const drawW = iw * scale, drawH = ih * scale;
    const maxOffsetX = Math.max(0, (drawW - size) / 2);
    const maxOffsetY = Math.max(0, (drawH - size) / 2);
    cropState.offsetX = Math.max(-maxOffsetX, Math.min(maxOffsetX, cropState.offsetX));
    cropState.offsetY = Math.max(-maxOffsetY, Math.min(maxOffsetY, cropState.offsetY));
  }

  function pointerDown(x, y) {
    cropState.dragging = true;
    cropState.lastX = x;
    cropState.lastY = y;
  }
  function pointerMove(x, y) {
    if (!cropState.dragging) return;
    cropState.offsetX += (x - cropState.lastX);
    cropState.offsetY += (y - cropState.lastY);
    cropState.lastX = x;
    cropState.lastY = y;
    clampOffsets();
    drawCrop();
  }
  function pointerUp() { cropState.dragging = false; }

  canvas.addEventListener('mousedown', (e) => pointerDown(e.offsetX, e.offsetY));
  canvas.addEventListener('mousemove', (e) => pointerMove(e.offsetX, e.offsetY));
  window.addEventListener('mouseup', pointerUp);
  canvas.addEventListener('touchstart', (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches[0];
    pointerDown(t.clientX - r.left, t.clientY - r.top);
  }, { passive: true });
  canvas.addEventListener('touchmove', (e) => {
    const r = canvas.getBoundingClientRect();
    const t = e.touches[0];
    pointerMove(t.clientX - r.left, t.clientY - r.top);
    e.preventDefault();
  }, { passive: false });
  canvas.addEventListener('touchend', pointerUp);

  zoomSlider.addEventListener('input', () => {
    cropState.scale = zoomSlider.value / 100;
    clampOffsets();
    drawCrop();
  });

  document.getElementById('openCropBtn').addEventListener('click', () => {
    if (!pendingImageData) return;
    cropImageObj = new Image();
    cropImageObj.onload = () => {
      cropState = { scale: 1, offsetX: 0, offsetY: 0, dragging: false, lastX: 0, lastY: 0 };
      zoomSlider.value = 100;
      drawCrop();
    };
    cropImageObj.src = pendingImageData;
    openDrawer('cropDrawer');
  });

  document.getElementById('cancelCropBtn').addEventListener('click', () => {
    closeDrawer('cropDrawer');
  });

  document.getElementById('applyCropBtn').addEventListener('click', () => {
    const outSize = 1000;
    const outCanvas = document.createElement('canvas');
    outCanvas.width = outSize; outCanvas.height = outSize;
    const outCtx = outCanvas.getContext('2d');
    outCtx.fillStyle = '#ffffff';
    outCtx.fillRect(0, 0, outSize, outSize);

    const iw = cropImageObj.naturalWidth, ih = cropImageObj.naturalHeight;
    const baseScale = Math.max(outSize / iw, outSize / ih);
    const scale = baseScale * cropState.scale;
    const ratio = outSize / canvas.width;
    const drawW = iw * scale, drawH = ih * scale;
    const drawX = (outSize - drawW) / 2 + cropState.offsetX * ratio;
    const drawY = (outSize - drawH) / 2 + cropState.offsetY * ratio;
    outCtx.drawImage(cropImageObj, drawX, drawY, drawW, drawH);

    // Qualité élevée conservée : les photos sont maintenant envoyées
    // vers Storage (et non plus écrites directement dans la base), donc
    // le souci d'egress qui justifiait une compression forte est traité
    // structurellement par Storage + mise en cache navigateur, sans
    // sacrifier la netteté des photos.
    pendingImageData = outCanvas.toDataURL('image/jpeg', 0.92);
    document.getElementById('imagePreview').src = pendingImageData;
    document.getElementById('imagePreview').style.display = 'block';
    document.getElementById('imagePlaceholder').style.display = 'none';
    closeDrawer('cropDrawer');
    showToast('✓ Photo recadrée');
  });
}

function setupProductFormSave() {
  document.getElementById('saveProductBtn').addEventListener('click', async () => {
    const name = document.getElementById('formName').value.trim();
    const ref = document.getElementById('formRef').value.trim();
    const price = parseFloat(document.getElementById('formPrice').value);
    const categoryId = document.getElementById('formCategory').value;
    const size = document.getElementById('formSize').value;
    const outOfStock = document.getElementById('outOfStockToggle').checked;
    const featured = document.getElementById('featuredToggle').checked;
    const isNew = document.getElementById('newToggle').checked;
    const isPromo = document.getElementById('promoToggle').checked;
    let unitStep = 1, unitLabel = '';
    if (currentUnitMode === 'bulk') {
      unitStep = parseInt(document.getElementById('formUnitStep').value, 10);
      if (!unitStep || unitStep < 2) {
        showToast('Indiquez une taille de lot valide (ex. 12)');
        return;
      }
      unitLabel = `Lot de ${unitStep}`;
    }

    if (!name || !ref || isNaN(price) || price < 0) {
      showToast('Merci de remplir tous les champs correctement');
      return;
    }
    // La photo n'est obligatoire que pour un NOUVEAU produit. Modifier un
    // produit existant (même sans photo) — par ex. juste cocher "Rupture
    // de stock" — doit toujours fonctionner, sinon la mise à jour est
    // silencieusement bloquée et semble "revenir en arrière" plus tard.
    if (!editingProductId && !pendingImageData) {
      showToast('Ajoutez une photo du produit');
      return;
    }

    const btn = document.getElementById('saveProductBtn');
    btn.style.opacity = '0.6';

    try {
      // pendingImageData peut être soit une URL Storage déjà existante
      // (produit en cours d'édition, photo non changée), soit une image
      // locale en base64 fraîchement recadrée (nouvelle photo) : dans ce
      // second cas seulement, on l'envoie vers Storage maintenant, juste
      // avant l'enregistrement — jamais le base64 lui-même n'est écrit
      // dans la base.
      let finalImageUrl = pendingImageData;
      if (pendingImageData && pendingImageData.startsWith('data:image')) {
        showToast('⏳ Envoi de la photo…');
        const res = await fetch(pendingImageData);
        const blob = await res.blob();
        finalImageUrl = await uploadImageToStorage(blob, editingProductId || ref);
      }

      if (editingProductId) {
        const { error } = await supabaseClient.from('products').update({
          name, ref, price, category_id: categoryId, image: finalImageUrl,
          unit_step: unitStep, unit_label: unitLabel, size: size,
          out_of_stock: outOfStock, featured: featured, is_new: isNew, is_promo: isPromo
        }).eq('id', editingProductId);
        if (error) throw error;
        const p = products.find(x => x.id === editingProductId);
        p.name = name; p.ref = ref; p.price = price; p.categoryId = categoryId;
        p.image = finalImageUrl; p.unitStep = unitStep; p.unitLabel = unitLabel; p.size = size;
        p.outOfStock = outOfStock; p.featured = featured; p.isNew = isNew; p.isPromo = isPromo;
        showToast('Produit mis à jour');
      } else {
        const newId = uid('prod');
        const { error } = await supabaseClient.from('products').insert({
          id: newId, ref, name, price, category_id: categoryId, image: finalImageUrl,
          unit_step: unitStep, unit_label: unitLabel, size: size, sort_order: products.length + 1,
          out_of_stock: outOfStock, featured: featured, is_new: isNew, is_promo: isPromo
        });
        if (error) throw error;
        products.push({ id: newId, ref, name, price, categoryId, image: finalImageUrl, unitStep, unitLabel, size, outOfStock, featured, isNew, isPromo, hidden: false });
        showToast('Produit ajouté');
      }
      closeDrawer('productFormDrawer');
      renderAdminProductList();
      renderCategoryStrip();
      renderGrid();
    } catch (e) {
      console.error(e);
      showToast('⚠️ Erreur lors de l\'enregistrement');
    } finally {
      btn.style.opacity = '1';
    }
  });

  document.getElementById('deleteProductBtn').addEventListener('click', async () => {
    if (!editingProductId) return;
    if (!confirm('Supprimer ce produit définitivement ?')) return;
    try {
      const { error } = await supabaseClient.from('products').delete().eq('id', editingProductId);
      if (error) throw error;
      products = products.filter(p => p.id !== editingProductId);
      delete cart[editingProductId];
      closeDrawer('productFormDrawer');
      renderAdminProductList();
      renderCategoryStrip();
      renderGrid();
      updateCartUI();
      showToast('Produit supprimé');
    } catch (e) {
      showToast('⚠️ Erreur lors de la suppression');
    }
  });
}

/* =========================================================
   UI générale
   ========================================================= */
function setupGeneralUI() {
  document.getElementById('cartIconBtn').addEventListener('click', () => openDrawer('cartDrawer'));
  document.getElementById('cartFabBtn').addEventListener('click', () => openDrawer('cartDrawer'));
  document.getElementById('adminFabBtn').addEventListener('click', () => openDrawer('adminDrawer'));
  document.getElementById('newProductBtn').addEventListener('click', () => openProductForm(null));

  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', () => closeDrawer(btn.dataset.close));
  });
  document.getElementById('overlay').addEventListener('click', closeAllDrawers);

  document.getElementById('adminLogoutBtn').addEventListener('click', () => {
    adminUnlocked = false;
    saveAdminUnlockState(false);
    document.getElementById('adminLockScreen').style.display = 'flex';
    document.getElementById('adminPanel').style.display = 'none';
    closeDrawer('adminDrawer');
  });

  // rafraîchir la liste des commandes chaque fois qu'on rouvre l'onglet
  document.querySelector('[data-tab="orders"]').addEventListener('click', () => {
    if (adminUnlocked) renderAdminOrderList();
  });

  let adminSearchDebounceTimer = null;
  document.getElementById('adminProductSearch').addEventListener('input', (e) => {
    adminProductSearchTerm = e.target.value;
    clearTimeout(adminSearchDebounceTimer);
    adminSearchDebounceTimer = setTimeout(() => {
      renderAdminProductList();
    }, 200);
  });

  document.getElementById('toggleArchivedBtn').addEventListener('click', () => {
    const section = document.getElementById('archivedOrdersSection');
    const btn = document.getElementById('toggleArchivedBtn');
    const isHidden = section.style.display === 'none';
    section.style.display = isHidden ? 'block' : 'none';
    btn.textContent = isHidden ? '🗂 Masquer les commandes archivées' : '🗂 Voir les commandes archivées';
    if (isHidden) renderArchivedOrderList();
  });
}

/* ---------- Init ---------- */
/* ── Aperçu image produit ─────────────────────────────────────────────
   Double-clic (desktop) ou double-toucher (mobile/tablette) sur
   n'importe quelle image de produit dans le catalogue ouvre une
   modale plein-écran avec l'image en grand, le nom du produit, et
   sa référence. Simple clic sur l'overlay ou le bouton ✕ ferme. */

function openImagePreview(src, name, ref) {
  const overlay = document.getElementById('imagePreviewOverlay');
  document.getElementById('imagePreviewImg').src = src;
  document.getElementById('imagePreviewCaption').textContent = name + (ref ? ' · Réf. ' + ref : '');
  overlay.style.display = 'flex';
  requestAnimationFrame(() => overlay.classList.add('show'));
}

function closeImagePreview() {
  const overlay = document.getElementById('imagePreviewOverlay');
  overlay.classList.remove('show');
  setTimeout(() => { overlay.style.display = 'none'; }, 250);
}

function setupImagePreview() {
  // Délégation d'événement sur le conteneur principal — fonctionne
  // même quand la grille est reconstruite par renderGrid().
  const container = document.getElementById('gridContainer');
  let lastTap = 0;
  let lastTarget = null;

  // Double-toucher (mobile/tablette) — 300ms entre deux touchers
  container.addEventListener('touchend', (e) => {
    const img = e.target.closest('.ticket-img-wrap img');
    if (!img) return;
    const now = Date.now();
    if (now - lastTap < 300 && lastTarget === img) {
      e.preventDefault();
      const ticket = img.closest('.ticket');
      const name = ticket?.querySelector('.t-name')?.textContent || '';
      const ref = ticket?.querySelector('.t-ref')?.textContent?.replace('Réf. ', '') || '';
      openImagePreview(img.src, name, ref);
    }
    lastTap = now;
    lastTarget = img;
  }, { passive: false });

  // Double-clic (desktop)
  container.addEventListener('dblclick', (e) => {
    const img = e.target.closest('.ticket-img-wrap img');
    if (!img) return;
    const ticket = img.closest('.ticket');
    const name = ticket?.querySelector('.t-name')?.textContent || '';
    const ref = ticket?.querySelector('.t-ref')?.textContent?.replace('Réf. ', '') || '';
    openImagePreview(img.src, name, ref);
  });

  // Fermeture avec Escape
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeImagePreview();
  });
}

function init() {
  // Empêche un rafraîchissement accidentel de la page quand un client
  // est en train de parcourir le catalogue (panier non vide ou session
  // client active). Côté admin, aucune restriction car Fuaad a besoin
  // de pouvoir recharger librement.
  window.addEventListener('beforeunload', (e) => {
    if (adminUnlocked) return; // pas de blocage côté admin
    if (Object.keys(cart).length > 0 || prefilledClientName) {
      e.preventDefault();
      e.returnValue = ''; // requis par certains navigateurs
    }
  });

  setupSearch();
  setupImagePreview();
  setupAdminLock();
  setupAdminTabs();
  setupAddCategory();
  setupSettingsSave();
  setupThemeControls();
  setupClientPromptModal();
  setupCommissionsTab();
  setupVentesTab();
  setupCarteTab();
  setupReorganiserTab();
  setupClientsTab();
  setupAssignClientModal();
  setupEditClientModal();
  setupAddressAutocomplete();
  setupAwardModal();
  setupLogoUpload();
  setupImageUpload();
  setupImageCropper();
  setupProductFormSave();
  setupUnitToggle();
  setupCheckout();
  setupSignaturePad();
  setupGeneralUI();
  loadAllData();
}

document.addEventListener('DOMContentLoaded', init);
