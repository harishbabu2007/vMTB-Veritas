import data from './cancerTypes.json';

// The cancer types a case can have: 418 entries in 32 categories, each with a
// standard abbreviation (`cancerTypes.json`, supplied by the clinical team —
// replace that file to change the list). The abbreviation is what a new
// case's name is built from (see `buildCaseName` below), so every entry needs
// one and they must stay unique.

export interface CancerType {
  id: string;
  name: string;
  abbreviation: string;
  category: string;
  notes: string;
}

interface RawItem {
  id: string;
  cancer_type: string;
  abbreviation: string;
  abbreviation_basis?: string;
  notes?: string;
}

interface RawFile {
  version: string;
  total: number;
  categories: { category: string; items: RawItem[] }[];
}

const file = data as RawFile;

export const CANCER_TYPES: CancerType[] = file.categories.flatMap(category =>
  category.items.map(item => ({
    id: item.id,
    name: item.cancer_type,
    abbreviation: item.abbreviation,
    category: category.category,
    notes: item.notes ?? '',
  }))
);

export const CANCER_CATEGORIES: string[] = file.categories.map(c => c.category);

// "Other Cancer Type (Not Listed)": chosen when nothing else fits, and paired
// with a free-text description on the form.
export const OTHER_CANCER_TYPE_ID = 'CT0417';

const byName = new Map(CANCER_TYPES.map(t => [t.name.toLowerCase(), t]));
const byAbbreviation = new Map(CANCER_TYPES.map(t => [t.abbreviation.toLowerCase(), t]));

export const findCancerTypeByName = (name: string): CancerType | undefined =>
  byName.get(name.trim().toLowerCase());

export const findCancerTypeByAbbreviation = (abbreviation: string): CancerType | undefined =>
  byAbbreviation.get(abbreviation.trim().toLowerCase());

/** How a type reads wherever it's offered: "Invasive Lobular Carcinoma (ILC)". */
export const cancerTypeLabel = (type: CancerType): string => `${type.name} (${type.abbreviation})`;

// Matches on name, abbreviation, category and notes. Best matches first:
// an exact abbreviation, then names that start with the query, then the rest.
export function searchCancerTypes(query: string): CancerType[] {
  const q = query.trim().toLowerCase();
  if (!q) return CANCER_TYPES;
  const scored: { type: CancerType; score: number }[] = [];
  for (const type of CANCER_TYPES) {
    const name = type.name.toLowerCase();
    const abbreviation = type.abbreviation.toLowerCase();
    let score = -1;
    if (abbreviation === q) score = 0;
    else if (name === q) score = 1;
    else if (abbreviation.startsWith(q)) score = 2;
    else if (name.startsWith(q)) score = 3;
    else if (name.includes(q)) score = 4;
    else if (abbreviation.includes(q)) score = 5;
    else if (type.category.toLowerCase().includes(q)) score = 6;
    else if (type.notes.toLowerCase().includes(q)) score = 7;
    if (score >= 0) scored.push({ type, score });
  }
  return scored.sort((a, b) => a.score - b.score || a.type.name.localeCompare(b.type.name)).map(s => s.type);
}

/**
 * A case's name: the type's abbreviation plus 5 random digits, e.g.
 * "ILC80981". Names must be unique across `cases.case_name`, so callers
 * generate a few and keep the first free one.
 */
export const buildCaseName = (abbreviation: string): string =>
  // The abbreviation is kept exactly as published, so the standard forms
  // survive: "ILC80981", but also "ccRCC80981" and "BR-PAGET80981".
  `${abbreviation.trim()}${Math.floor(10000 + Math.random() * 90000)}`;
