import { TokenIndex } from './types';

/**
 * Tokenizes a string by splitting camelCase boundaries, snake_case, underscores,
 * converting to lowercase, and performing a basic English stemmer reduction.
 */
export function tokenize(text: string): string[] {
  if (!text) {
    return [];
  }
  // Split camelCase boundaries
  const camelSplit = text.replace(/([a-z])([A-Z])/g, '$1 $2');
  // Replace non-alphanumeric with spaces
  const normalized = camelSplit.replace(/[^a-zA-Z0-9]/g, ' ');
  const words = normalized.toLowerCase().split(/\s+/).filter(w => w.length > 1);

  return words.map(stemWord);
}

/**
 * A basic suffix stemmer for English database identifiers (s/es/ies).
 */
function stemWord(word: string): string {
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('es') && !word.endsWith('sses') && !word.endsWith('shes') && !word.endsWith('ches')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s') && !word.endsWith('ss') && !word.endsWith('us') && !word.endsWith('as')) {
    return word.slice(0, -1);
  }
  return word;
}

/**
 * Synonym mapping mined from typical database patterns and direct hints.
 */
export const SYNONYMS: Record<string, string[]> = {
  customer: ['user', 'client', 'buyer', 'member'],
  user: ['customer', 'client', 'member', 'account'],
  order: ['purchase', 'transaction', 'sale', 'deal'],
  purchase: ['order', 'transaction', 'sale'],
  revenue: ['amount', 'price', 'sales', 'payment', 'income'],
  payment: ['revenue', 'charge', 'invoice'],
  product: ['item', 'goods', 'sku'],
  item: ['product', 'goods'],
  auth: ['login', 'credential', 'user'],
  config: ['setting', 'preference', 'option'],
};

/**
 * Compute the score of an object reference against query tokens using the TF-IDF postings list.
 */
export function scoreObject(
  objectRef: string,
  queryTokens: string[],
  tokenIndex: TokenIndex,
  counts: { tables: number }
): number {
  let score = 0;
  const N = counts.tables || 100;

  for (const token of queryTokens) {
    // 1. Lexical match in posting list
    const postings = tokenIndex.postings[token];
    if (postings) {
      const match = postings.find(p => p[0] === objectRef);
      if (match) {
        const weight = match[1];
        const df = tokenIndex.df[token] || 1;
        const idf = Math.log(1 + N / df);
        score += weight * idf;
      }
    }

    // 2. Synonym match
    const syns = SYNONYMS[token];
    if (syns) {
      for (const syn of syns) {
        const synPostings = tokenIndex.postings[syn];
        if (synPostings) {
          const match = synPostings.find(p => p[0] === objectRef);
          if (match) {
            const weight = match[1] * 0.7; // Synonym penalty multiplier
            const df = tokenIndex.df[syn] || 1;
            const idf = Math.log(1 + N / df);
            score += weight * idf;
          }
        }
      }
    }
  }

  // penalize system or backup tables
  if (objectRef.includes('audit') || objectRef.includes('_bak') || objectRef.includes('_tmp') || objectRef.includes('backup')) {
    score -= 1.0;
  }

  return Math.max(0, score);
}
