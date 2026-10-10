// Plans and pricing rules. Mirrors the Reseller Dashboard so the prices a seller
// sees in the dashboard are the prices that land in their store.

export const PLANS = {
  free: { name: 'Free', discount: 0, perPush: 3, totalProducts: 3 },
  starter: { name: 'Starter', discount: 0, perPush: 50, totalProducts: null },
  growth: { name: 'Growth', discount: 5, perPush: 500, totalProducts: null },
  pro: { name: 'Pro', discount: 10, perPush: null, totalProducts: null },
};

// Customer tags on the Nexra store decide the plan, same as the theme.
export function planFromTags(tags = []) {
  const t = tags.map((x) => String(x).trim().toLowerCase());
  if (t.includes('nexra-pro')) return 'pro';
  if (t.includes('nexra-growth')) return 'growth';
  if (t.includes('nexra-starter') || t.includes('nexra-reseller')) return 'starter';
  return 'free';
}

export function normalizeRule(rule = {}) {
  const mtype = rule.mtype === 'fixed' ? 'fixed' : 'pct';
  const markup = Math.max(0, Number(rule.markup) || 0);
  const round = ['99', '95', '00', 'none'].includes(String(rule.round)) ? String(rule.round) : '99';
  const brand = String(rule.brand || '').slice(0, 120);
  return { mtype, markup, round, brand };
}

export function roundPrice(value, round) {
  if (round === 'none') return Math.round(value * 100) / 100;
  if (round === '00') return Math.max(Math.ceil(value - 1e-9), 1);
  const end = round === '95' ? 0.95 : 0.99;
  let r = Math.floor(value) + end;
  if (r < value - 1e-4) r += 1;
  return Math.max(Math.round(r * 100) / 100, 0.99);
}

// Price the seller lists the product at in their own store.
// customMarkup (percent) overrides the rule for one product when set.
export function sellPrice(ourPrice, discountPct, rule, customMarkup) {
  const r = normalizeRule(rule);
  const cost = Number(ourPrice) * (1 - (Number(discountPct) || 0) / 100);
  const hasCustom = customMarkup !== '' && customMarkup != null && !Number.isNaN(Number(customMarkup));
  const raw = hasCustom ? cost * (1 + Number(customMarkup) / 100) : r.mtype === 'fixed' ? cost + r.markup : cost * (1 + r.markup / 100);
  return roundPrice(raw, r.round);
}

export function money(value) {
  return (Math.round(Number(value) * 100) / 100).toFixed(2);
}
