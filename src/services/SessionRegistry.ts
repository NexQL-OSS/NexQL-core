import * as vscode from 'vscode';

/**
 * Singleton registry mapping connectionId to the currently open NotebookDocument.
 * Satisfies Requirements 2.4 and 4.1 — tracks at most one open scratch notebook per connection.
 */
class SessionRegistryClass {
  private static instance: SessionRegistryClass;
  private readonly map = new Map<string, vscode.NotebookDocument>();

  private constructor() {}

  static getInstance(): SessionRegistryClass {
    if (!SessionRegistryClass.instance) {
      SessionRegistryClass.instance = new SessionRegistryClass();
    }
    return SessionRegistryClass.instance;
  }

  get(connectionId: string): vscode.NotebookDocument | undefined {
    return this.map.get(connectionId);
  }

  set(connectionId: string, doc: vscode.NotebookDocument): void {
    this.map.set(connectionId, doc);
  }

  delete(connectionId: string): void {
    this.map.delete(connectionId);
  }

  has(connectionId: string): boolean {
    return this.map.has(connectionId);
  }

  entries(): IterableIterator<[string, vscode.NotebookDocument]> {
    return this.map.entries();
  }
}

export const SessionRegistry = SessionRegistryClass.getInstance();

/**
 * Returns the URI for the persistent scratch notebook file for a given connection + database.
 * Path: `{globalStorageUri}/{connectionName}/{databaseName}/scratch.pgsql`
 */
export function getScratchUri(globalStorageUri: vscode.Uri, connectionId: string, databaseName: string, connectionName?: string): vscode.Uri {
  const safeName = (connectionName ?? connectionId).replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDb = databaseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  return vscode.Uri.joinPath(globalStorageUri, safeName, safeDb, 'scratch.pgsql');
}

const _ADJECTIVES = [
  'admiring', 'adoring', 'affectionate', 'agitated', 'amazing', 'angry', 'awesome',
  'blissful', 'bold', 'boring', 'brave', 'busy', 'charming', 'clever', 'cool',
  'compassionate', 'competent', 'condescending', 'confident', 'cranky', 'crazy',
  'dazzling', 'determined', 'distracted', 'dreamy', 'eager', 'ecstatic', 'elastic',
  'elated', 'elegant', 'eloquent', 'epic', 'exciting', 'fervent', 'festive',
  'flamboyant', 'focused', 'friendly', 'frosty', 'funny', 'gallant', 'gifted',
  'goofy', 'gracious', 'happy', 'hardcore', 'heuristic', 'hopeful', 'hungry',
  'infallible', 'inspiring', 'jolly', 'jovial', 'keen', 'kind', 'laughing',
  'loving', 'lucid', 'magical', 'modest', 'mystifying', 'naughty', 'nervous',
  'nifty', 'nostalgic', 'objective', 'optimistic', 'peaceful', 'pedantic',
  'pensive', 'practical', 'priceless', 'quirky', 'quizzical', 'recursing',
  'relaxed', 'reverent', 'romantic', 'sad', 'serene', 'sharp', 'silly',
  'sleepy', 'stoic', 'strange', 'stupefied', 'suspicious', 'sweet', 'tender',
  'thirsty', 'trusting', 'unruffled', 'upbeat', 'vibrant', 'vigilant',
  'vigorous', 'wizardly', 'wonderful', 'xenodochial', 'youthful', 'zealous',
];

const _NAMES = [
  'albattani', 'allen', 'almeida', 'antonelli', 'archimedes', 'ardinghelli',
  'aryabhata', 'austin', 'babbage', 'banach', 'banzai', 'bardeen', 'bartik',
  'bassi', 'beaver', 'bell', 'benz', 'bhabha', 'bhaskara', 'black', 'blackburn',
  'blackwell', 'bohr', 'booth', 'borg', 'bose', 'bouman', 'boyd', 'brahmagupta',
  'brattain', 'brown', 'buck', 'burnell', 'cannon', 'carson', 'cartwright',
  'cerf', 'chandrasekhar', 'chaplygin', 'chatelet', 'chatterjee', 'chebyshev',
  'cohen', 'colden', 'cori', 'cray', 'curie', 'darwin', 'davinci', 'dewdney',
  'dhawan', 'diffie', 'dijkstra', 'dirac', 'driscoll', 'dubinsky', 'easley',
  'edison', 'einstein', 'elbakyan', 'elion', 'ellis', 'engelbart', 'euclid',
  'euler', 'faraday', 'feistel', 'fermat', 'fermi', 'feynman', 'franklin',
  'gagarin', 'galileo', 'galois', 'gates', 'gauss', 'germain', 'goldberg',
  'goldstine', 'goldwasser', 'golick', 'goodall', 'gould', 'greider', 'grothendieck',
  'haibt', 'hamilton', 'haslett', 'hawking', 'heisenberg', 'hellman', 'hertz',
  'heyrovsky', 'hodgkin', 'hofstadter', 'hoover', 'hopper', 'hugle', 'hypatia',
  'ishizaka', 'jackson', 'jang', 'jennings', 'jepsen', 'johnson', 'joliot',
  'jones', 'kalam', 'kapitsa', 'kare', 'keldysh', 'keller', 'kepler', 'khayyam',
  'khorana', 'kilby', 'kirch', 'knuth', 'kowalevski', 'lalande', 'lamarr',
  'lamport', 'leakey', 'leavitt', 'lederberg', 'lehmann', 'lewin', 'lichterman',
  'liskov', 'lovelace', 'lumiere', 'mahavira', 'margulis', 'matsumoto', 'maxwell',
  'mccarthy', 'mcclintock', 'mclaren', 'mclean', 'mcnulty', 'mendel', 'mendeleev',
  'minsky', 'mirzakhani', 'morse', 'moser', 'murdock', 'napier', 'nash', 'neumann',
  'newton', 'nightingale', 'nobel', 'noether', 'northcutt', 'noyce', 'panini',
  'pare', 'pascal', 'pasteur', 'payne', 'perlman', 'pike', 'poincare', 'poitras',
  'proskuriakova', 'ptolemy', 'raman', 'ramanujan', 'ride', 'ritchie', 'robinson',
  'roentgen', 'rosalind', 'rubin', 'saha', 'sammet', 'sanderson', 'satoshi',
  'shamir', 'shannon', 'shaw', 'shirley', 'shockley', 'shtern', 'sinoussi',
  'snyder', 'solomon', 'spence', 'stonebraker', 'sutherland', 'swanson', 'swartz',
  'swirles', 'taussig', 'tesla', 'tharp', 'thompson', 'torvalds', 'tu', 'turing',
  'varahamihira', 'vaughan', 'villani', 'visvesvaraya', 'volhard', 'wescoff',
  'wilbur', 'wiles', 'williams', 'williamson', 'wilson', 'wing', 'wozniak',
  'wright', 'wu', 'yalow', 'yonath', 'zhukovsky',
];

function _randomNotebookName(): string {
  const adj = _ADJECTIVES[Math.floor(Math.random() * _ADJECTIVES.length)];
  const name = _NAMES[Math.floor(Math.random() * _NAMES.length)];
  return `${adj}_${name}`;
}

/**
 * Returns the URI for a new notebook file with a unique random name.
 * Pattern: `{globalStorageUri}/{connectionName}/{databaseName}/{adjective}_{name}.pgsql`
 */
export async function getNewNotebookUri(globalStorageUri: vscode.Uri, databaseName: string, connectionName?: string): Promise<vscode.Uri> {
  const safeName = (connectionName ?? 'notebook').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDb = databaseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  while (true) {
    const filename = _randomNotebookName();
    const uri = vscode.Uri.joinPath(globalStorageUri, safeName, safeDb, `${filename}.pgsql`);
    try {
      await vscode.workspace.fs.stat(uri);
      // Name already exists, try another
    } catch {
      return uri;
    }
  }
}

/**
 * Returns the URI of the most recently modified non-scratch notebook for this connection+db,
 * or undefined if none exist yet.
 */
export async function getLatestNumberedUri(globalStorageUri: vscode.Uri, databaseName: string, connectionName?: string): Promise<vscode.Uri | undefined> {
  const safeName = (connectionName ?? 'notebook').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDb = databaseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  const dir = vscode.Uri.joinPath(globalStorageUri, safeName, safeDb);
  let entries: [string, vscode.FileType][];
  try {
    entries = await vscode.workspace.fs.readDirectory(dir);
  } catch {
    return undefined;
  }
  let latestUri: vscode.Uri | undefined;
  let latestMtime = -1;
  for (const [name, type] of entries) {
    if (type !== vscode.FileType.File || !name.endsWith('.pgsql') || name === 'scratch.pgsql') {
      continue;
    }
    const uri = vscode.Uri.joinPath(dir, name);
    try {
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.mtime > latestMtime) {
        latestMtime = stat.mtime;
        latestUri = uri;
      }
    } catch {
      // skip unreadable files
    }
  }
  return latestUri;
}

/**
 * Returns true if the given notebook URI belongs to the connection+db folder.
 */
export function isNotebookForSession(uri: vscode.Uri, databaseName: string, connectionName?: string, connectionId?: string): boolean {
  const safeName = (connectionName ?? connectionId ?? 'notebook').replace(/[^a-zA-Z0-9_-]/g, '_');
  const safeDb = databaseName.replace(/[^a-zA-Z0-9_-]/g, '_');
  // URI path must contain /{safeName}/{safeDb}/ as a segment
  const segment = `/${safeName}/${safeDb}/`;
  return uri.path.includes(segment);
}
