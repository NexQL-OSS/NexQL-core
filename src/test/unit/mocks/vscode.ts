// Comprehensive mock of a subset of the `vscode` API used by tests
// This mock focuses on types and members referenced in the codebase and tests.

export type Thenable<T> = Promise<T>;
declare global { type Thenable<T> = Promise<T>; }

export interface Memento {
  get<T>(key: string, defaultValue?: T): T;
  update(key: string, value: any): Thenable<void>;
}

export interface ExtensionContext {
  subscriptions: { dispose(): void }[];
  workspaceState: Memento;
  globalState: Memento;
  extensionPath?: string;
  extensionUri: Uri;
  extension: { packageJSON: { version?: string } };
  secrets: {
    get(key: string): Promise<string | undefined>;
    store(key: string, value: string): Promise<void>;
    delete(key: string): Promise<void>;
  };
}

export class OutputChannel { appendLine(_s: string) { } show() { } dispose() { } }

export const ProgressLocation = { Notification: 1, Window: 2, SourceControl: 3 } as const;

export const workspace: {
  getConfiguration(section?: string): WorkspaceConfiguration;
  onDidChangeConfiguration(cb?: any): { dispose(): void };
  fs: {
    readFile(uri: any): Thenable<Uint8Array>;
    writeFile(uri: any, b: Uint8Array): Thenable<void>;
    stat(uri: any): Thenable<any>;
    createDirectory(uri: any): Thenable<void>;
    rename(source: any, target: any, options?: any): Thenable<void>;
    delete(uri: any, options?: any): Thenable<void>;
  };
  notebookDocuments: any[];
  onDidOpenNotebookDocument(cb?: any): { dispose(): void };
  onDidSaveNotebookDocument(cb?: any): { dispose(): void };
  onDidChangeNotebookDocument(cb?: any): { dispose(): void };
  onDidCloseNotebookDocument(cb?: any): { dispose(): void };
  applyEdit(edit: any): Thenable<boolean>;
  openTextDocument(pathOrOptions?: any): Thenable<TextDocument>;
  openNotebookDocument(viewTypeOrUri?: any, data?: any): Thenable<NotebookDocument>;
  registerNotebookSerializer(type: string, serializer: any): Disposable;
} = {
  getConfiguration: (_section?: string) => ({ get: <T>(_k: string, _d?: T) => _d as T, update: async () => { } }),
  onDidChangeConfiguration: (_cb?: any) => ({ dispose: () => { } }),
  fs: {
    readFile: async (_uri: any) => new Uint8Array(),
    writeFile: async (_uri: any, _b: Uint8Array) => { },
    stat: async (_uri: any) => { throw new Error('FileNotFound'); },
    createDirectory: async (_uri: any) => { },
    rename: async (_s: any, _t: any, _o?: any) => { },
    delete: async (_uri: any, _o?: any) => { }
  },
  notebookDocuments: [] as any[],
  onDidOpenNotebookDocument: (_cb?: any) => ({ dispose: () => { } }),
  onDidSaveNotebookDocument: (_cb?: any) => ({ dispose: () => { } }),
  onDidChangeNotebookDocument: (_cb?: any) => ({ dispose: () => { } }),
  onDidCloseNotebookDocument: (_cb?: any) => ({ dispose: () => { } }),
  openTextDocument: async (_p?: any) => new TextDocument(''),
  openNotebookDocument: async (_viewTypeOrUri?: any, _data?: any) => new NotebookDocument(),
  registerNotebookSerializer: (_type: string, _serializer: any) => ({ dispose: () => { } }),
  applyEdit: async (_edit: any) => true
};

export class ThemeColor { constructor(public id: string) { } }
export class ThemeIcon { constructor(public id: string, public color?: ThemeColor) { } }

export class EventEmitter<T = any> {
  private listeners: ((e: T) => any)[] = [];
  event = (listener: (e: T) => any) => { this.listeners.push(listener); return { dispose: () => { } }; };
  fire = (e?: T) => { this.listeners.forEach(l => l(e as T)); };
  dispose() { this.listeners = []; }
}

export class Disposable { dispose() { } }

export const env = { clipboard: { writeText: async (_s: string) => { } } } as any;

export const window = {
  createOutputChannel: (_name?: string) => new OutputChannel(),
  showErrorMessage: async (_msg?: string) => undefined,
  showInformationMessage: async (_msg?: string) => undefined,
  showWarningMessage: async (_msg?: string) => undefined,
  showInputBox: async (_options?: any) => undefined,
  showQuickPick: async (_items?: any[], _opts?: any) => undefined,
  createQuickPick: () => ({
    title: '',
    placeholder: '',
    matchOnDescription: false,
    matchOnDetail: false,
    value: '',
    items: [],
    selectedItems: [],
    onDidChangeValue: (_cb?: any) => ({ dispose: () => { } }),
    onDidAccept: (_cb?: any) => ({ dispose: () => { } }),
    onDidHide: (_cb?: any) => ({ dispose: () => { } }),
    show: () => { },
    hide: () => { },
    dispose: () => { }
  }),
  showSaveDialog: async (_opts?: any) => undefined,
  showNotebookDocument: async (_doc?: any, _opts?: any) => new NotebookEditor(),
  createTerminal: (_name?: string) => ({ show: (_preserveFocus?: boolean) => { }, sendText: (_text: string, _addNewLine?: boolean) => { }, dispose: () => { } }),
  onDidChangeActiveNotebookEditor: (_cb?: any) => ({ dispose: () => { } }),
  createTreeView: (_id: string, _opts?: any) => ({ reveal: async (_item?: any, _opts?: any) => { } }),
  withProgress: async (_opt: any, _cb: any) => { return await _cb({ report: (_: any) => { } }); }
} as any;

// (Status bar helpers declared later)

export const commands = { registerCommand: (_name: string, _cb?: any) => ({ dispose: () => { } }), executeCommand: async (_cmd: string, ..._args: any[]) => undefined } as any;

export const languages = {
  registerCompletionItemProvider: (_selector: any, _provider: any) => ({ dispose: () => { } }),
  registerSignatureHelpProvider: (_selector: any, _provider: any, ..._chars: string[]) => ({ dispose: () => { } })
} as any;

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 } as const;
export type TreeItemCollapsibleState = typeof TreeItemCollapsibleState[keyof typeof TreeItemCollapsibleState];
export class TreeItem { constructor(public label: string, public collapsibleState?: TreeItemCollapsibleState) { } }
// Add common TreeItem fields used by code
export interface TreeItem {
  contextValue?: string;
  iconPath?: any;
  tooltip?: any;
  description?: string;
  command?: any;
}

export const NotebookCellKind = { Markup: 1, Code: 2 } as const;
export type NotebookCellKind = typeof NotebookCellKind[keyof typeof NotebookCellKind];

export class NotebookCellData { constructor(public kind: NotebookCellKind, public value: string, public language?: string) { } }
export class NotebookRange { constructor(public start: number, public end: number) { } }
export const NotebookEditorRevealType = { Default: 0, InCenter: 1, InCenterIfOutsideViewport: 2, AtTop: 3 } as const;
export type NotebookEditorRevealType = typeof NotebookEditorRevealType[keyof typeof NotebookEditorRevealType];
export class NotebookEdit {
  constructor(public range: NotebookRange | number, public cells: NotebookCellData[]) { }
  static insertCells(rangeOrIndex: any, cells: NotebookCellData[]) { return new NotebookEdit(rangeOrIndex, cells); }
  static replaceCells(rangeOrIndex: any, cells: NotebookCellData[]) { return new NotebookEdit(rangeOrIndex, cells); }
  static updateNotebookMetadata(meta: any) { const edit = new NotebookEdit(0, []); (edit as any).metadata = meta; return edit; }
}
export class NotebookData { constructor(public cells: NotebookCellData[]) { } public metadata?: any; }
export interface NotebookSerializer { serializeNotebook(data: NotebookData, _token?: CancellationToken): Uint8Array | Thenable<Uint8Array>; deserializeNotebook(content: Uint8Array, _token?: CancellationToken): NotebookData | Thenable<NotebookData>; }
export class WorkspaceEdit { private map = new Map<any, any[]>(); set(uri: Uri, edits: any[]) { this.map.set(uri.toString(), edits); } replace(_uri: Uri, _range: any, _newText: string) { this.map.set(_uri.toString(), [{ range: _range, newText: _newText }]); } }

export interface Disposable { dispose(): void }

export class NotebookCellOutput { constructor(public items: any[], public metadata?: any) { } }
export class NotebookCellOutputItem { constructor(public data: any, public mime: string) { } static text(v: string, m?: string) { return new NotebookCellOutputItem(v, m || 'text/plain'); } static json(o: any, m?: string) { return new NotebookCellOutputItem(JSON.stringify(o), m || 'application/json'); } static error(e: any) { return new NotebookCellOutputItem(String(e), 'application/vnd.code.notebook.error'); } }

export class NotebookDocument { uri: Uri; metadata?: any; isClosed: boolean = false; cellCount: number = 0; constructor(uri?: Uri, metadata?: any) { this.uri = uri || new Uri('/tmp/mock'); this.metadata = metadata || {}; } getText(_r?: any) { return ''; } getCells(): NotebookCell[] { return []; } }
// notebookType is used throughout the codebase to distinguish notebook flavors
export interface NotebookDocumentLike { notebookType?: string; }
Object.assign(NotebookDocument.prototype, { notebookType: undefined });
// ensure TypeScript knows about notebookType on the class
declare module './vscode' { interface NotebookDocument { notebookType?: string } }
export class NotebookEditor { notebook: NotebookDocument = new NotebookDocument(new Uri('/tmp/mock')); selection?: NotebookRange; revealRange(_range: NotebookRange, _revealType?: any) { } }

export class CompletionItem { detail?: string; documentation?: string | MarkdownString; insertText?: string | SnippetString; sortText?: string; filterText?: string; constructor(public label: string, public kind?: number) { } }
export const CompletionItemKind = { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9, Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14, Color: 15, File: 16, Reference: 17, Folder: 18, EnumMember: 19, Constant: 20, Struct: 21, Event: 22, Operator: 23, TypeParameter: 24 } as const;
export type CompletionItemKind = typeof CompletionItemKind[keyof typeof CompletionItemKind];

export class MarkdownString { constructor(public value?: string) { } appendCodeblock(_v: string, _lang?: string) { return this; } appendMarkdown(_v: string) { return this; } appendText(_v: string) { return this; } }
export class SnippetString { constructor(public value?: string) { } appendText(_v: string) { return this; } appendTabstop(_n?: number) { return this; } appendPlaceholder(_v: string, _n?: number) { return this; } appendVariable(_n: string, _d?: string) { return this; } }

export class TextDocument { uri?: Uri; languageId?: string; constructor(public text: string = '', uri?: Uri, languageId?: string) { this.uri = uri; this.languageId = languageId; } getText(_r?: any) { return this.text; } lineAt(_pos: any) { return { text: this.text }; } getWordRangeAtPosition(_pos: any) { return undefined; } }
export class Position { constructor(public line: number, public character: number) { } }
export interface CancellationToken { readonly isCancellationRequested?: boolean; }
export interface CompletionContext { triggerKind?: number; triggerCharacter?: string; }
export interface CompletionItemProvider { provideCompletionItems(document: TextDocument, position: Position, token?: CancellationToken, context?: CompletionContext): Thenable<any> | any }

export class NotebookCell { outputs: NotebookCellOutput[] = []; notebook?: any; constructor(public document: any, public index: number, public kind?: NotebookCellKind) { } }
export class NotebookController {
  supportedLanguages?: string[];
  supportsExecutionOrder?: boolean;
  executeHandler?: (...args: any[]) => any;
  id?: string;
  createNotebookCellExecution(_cell: NotebookCell) {
    const exec: any = {
      executionOrder: 0,
      start: (_startTime?: number) => { },
      replaceOutput: (_outputs?: any[]) => { },
      clearOutput: () => { },
      end: (_success?: boolean, _endTime?: number) => { }
    };
    return exec;
  }
  dispose() { }
}

// Notebooks namespace and controller runtime helpers
export const notebooks = {
  createNotebookController: (_id: string, _viewType: string, _label: string) => new NotebookController(),
  createNotebookDocument: async (_uri: Uri) => new NotebookDocument(_uri)
} as any;

// active editor helpers used by status bar and other features
export interface StatusBarItem { text?: string; tooltip?: string; command?: string; backgroundColor?: any; show(): void; hide(): void; dispose(): void }
export const StatusBarAlignment = { Left: 1, Right: 2 } as const;
(window as any).createStatusBarItem = (_alignment?: number, _priority?: number) => ({ show: () => { }, hide: () => { }, dispose: () => { } }) as StatusBarItem;
(window as any).activeNotebookEditor = undefined as NotebookEditor | undefined;

// Extend NotebookController with common runtime properties used by code
export interface NotebookController {
  supportsExecutionOrder?: boolean;
  executeHandler?: (...args: any[]) => any;
  dispose(): void;
}

// (no-op) ensure single NotebookCellOutputItem definition above

export class Uri {
  public path: string;
  constructor(public fsPath: string, public scheme: string = 'file') { this.path = fsPath; }
  toString() { return this.fsPath; }
  static file(path: string) { return new Uri(path); }
  static parse(s: string) { const scheme = s.includes(':') ? s.split(':')[0] : 'file'; return new Uri(s, scheme); }
  static joinPath(base: Uri, ...segments: string[]) { return new Uri([base.fsPath, ...segments].join('/'), base.scheme); }
}
Object.assign(Uri.prototype, { with: function (opts: any) { const scheme = opts && opts.scheme ? opts.scheme : this.scheme; const path = opts && opts.path ? opts.path : this.fsPath; return new Uri(path, scheme); } });

// Augment module types used during tests so `with` and `resourceUri` are recognized by the compiler
declare module 'vscode' {
  interface Uri { with(opts: any): Uri }
  interface TreeItem { resourceUri?: Uri }
  export const extensions: { getExtension(id: string): { activate?: () => Promise<any>; isActive?: boolean } | undefined };
}

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 } as const;
export type ConfigurationTarget = typeof ConfigurationTarget[keyof typeof ConfigurationTarget];

// Range and CodeLens used by providers
export class Range { constructor(public startLine: number, public startChar: number, public endLine: number, public endChar: number) { } }
export class CodeLens { constructor(public range: Range, public command?: any) { } }

export type ProviderResult<T> = T | Thenable<T> | null | undefined;
export type Event<T> = (listener: (e: T) => any) => { dispose(): void };

export interface TreeDataProvider<T> {
  onDidChangeTreeData?: Event<T | undefined | null | void>;
  getChildren(element?: any): ProviderResult<T[]>;
  getTreeItem(element: T): any;
}

export interface TreeView<T> { reveal(item: T, options?: any): Thenable<void>; }
export interface TreeViewExpansionEvent<T> { element: T }

export interface CodeLensProvider {
  onDidChangeCodeLenses?: Event<void>;
  provideCodeLenses(document: TextDocument, token?: CancellationToken): CodeLens[] | Thenable<CodeLens[]>;
  resolveCodeLens?(codeLens: CodeLens, token?: CancellationToken): CodeLens | Thenable<CodeLens>;
}

export class CancellationTokenSource {
  token: CancellationToken = { isCancellationRequested: false };
  cancel() {
    (this.token as any).isCancellationRequested = true;
  }
  dispose() { }
}

// Language model / chat stubs for `vscode.lm` usage in tests
export interface LanguageModelChat { id?: string; name?: string; family?: string; sendRequest?(messages: any[], opts?: any, token?: any): Promise<any>; }
export interface LanguageModelChatSelector { family?: string }
export interface LanguageModelChatMessage { }
export const lm = {
  selectChatModels: async (_opts?: any) => [] as LanguageModelChat[],
  registerMcpServerDefinitionProvider: (_id: string, _provider: any) => ({ dispose: () => {} })
} as any;
export class McpHttpServerDefinition {
  constructor(public label: string, public uri: Uri, public headers?: Record<string, string>) {}
}
export const LanguageModelChatMessage = { User: (s: string) => ({ role: 'user', content: s }), Assistant: (s: string) => ({ role: 'assistant', content: s }) } as any;

export const ViewColumn = { One: 1, Two: 2, Three: 3, Beside: 4 } as const;
export interface Webview { html?: string; options?: any; onDidReceiveMessage(cb: (m: any) => any, thisArg?: any, disposables?: any[]): { dispose(): void }; postMessage(m: any): Thenable<boolean>; asWebviewUri(uri: Uri): Uri; cspSource?: string }
export interface WebviewPanel { webview: Webview; title?: string; reveal(column?: any): void; onDidDispose(cb: () => any, thisArg?: any, disposables?: any[]): { dispose(): void }; dispose(): void }
export interface WebviewView { webview: Webview; reveal(): void; show?(preserveFocus?: boolean): void }
export interface WebviewOptions { enableScripts?: boolean; localResourceRoots?: Uri[] }
export interface WebviewViewResolveContext { }
export interface WebviewViewProvider { resolveWebviewView(webviewView: WebviewView, context: WebviewViewResolveContext, token?: CancellationToken): void }
export const QuickPickItemKind = { Separator: -1, Default: 0 } as const;
export interface QuickPickItem { label?: string; description?: string; detail?: string; original?: any; kind?: number }

// wire up helpers
(workspace as any).applyEdit = async (_e: any) => true;
(window as any).createWebviewPanel = (_vt: string, _title: string, _show: any, _opts?: any) => ({ webview: { html: undefined, onDidReceiveMessage: (_cb: any) => ({ dispose: () => { } }), postMessage: async (_m: any) => true, asWebviewUri: (u: Uri) => u }, reveal: (_c?: any) => { }, onDidDispose: (_cb: any) => ({ dispose: () => { } }) } as any);

// provide a createWebviewView helper used by some providers
(window as any).createWebviewView = (_id: string, _opts?: any) => ({ webview: { html: undefined, onDidReceiveMessage: (_cb: any) => ({ dispose: () => { } }), postMessage: async (_m: any) => true, asWebviewUri: (u: Uri) => u, options: {} }, reveal: () => { }, show: (_f?: boolean) => { } });

// Ensure createWebviewPanel returns an object shaped like WebviewPanel with dispose
(window as any).createWebviewPanel = (_vt: string, _title: string, _show: any, _opts?: any) => ({
  webview: { html: undefined, onDidReceiveMessage: (_cb: any) => ({ dispose: () => { } }), postMessage: async (_m: any) => true, asWebviewUri: (u: Uri) => u, cspSource: '' },
  reveal: (_c?: any) => { },
  onDidDispose: (_cb: any, _thisArg?: any, _disposables?: any[]) => ({ dispose: () => { } }),
  dispose: () => { }
} as any);

// Provide runtime placeholders for some types that are used as values in tests
const SecretStorage = { get: async (_k: string) => undefined, store: async (_k: string, _v: string) => { }, delete: async (_k: string) => { } } as any;
const Webview = { html: undefined, onDidReceiveMessage: (_cb: any) => ({ dispose: () => { } }), postMessage: async (_m: any) => true, asWebviewUri: (u: Uri) => u } as any;
const WebviewPanel = { webview: Webview, reveal: (_c?: any) => { }, onDidDispose: (_cb: any) => ({ dispose: () => { } }) } as any;
export interface WorkspaceConfiguration {
  get(key: string, defaultValue?: any): any;
  get<T = any>(key: string, defaultValue?: T): T;
  update?(key: string, value: any, target?: any): Thenable<void>;
}

export interface NotebookRendererMessaging { postMessage(message: any, editor?: any): Thenable<boolean>; onDidReceiveMessage?(cb: (e: any) => any): { dispose(): void } }

export interface Command { title: string; command: string; arguments?: any[] }

// Provide openTextDocument/openNotebookDocument helpers used by various commands
(workspace as any).openTextDocument = async (_p?: any) => new TextDocument('');
(workspace as any).openNotebookDocument = async (_viewTypeOrUri?: any, _data?: any) => new NotebookDocument();
(workspace as any).registerNotebookSerializer = (_type: string, _serializer: any) => ({ dispose: () => { } });

// Add a few convenience/runtime exports and ensure some properties exist for tests
const vscode = {
  Thenable: undefined,
  Memento: undefined,
  ExtensionContext: undefined,
  ProgressLocation,
  workspace,
  window,
  commands,
  languages,
  EventEmitter,
  Disposable,
  TreeItem,
  TreeItemCollapsibleState,
  NotebookCellKind,
  NotebookCellData,
  NotebookRange,
  NotebookEdit,
  NotebookData,
  WorkspaceEdit,
  NotebookCellOutput,
  NotebookCellOutputItem,
  NotebookDocument,
  NotebookEditor,
  CompletionItem,
  CompletionItemKind,
  MarkdownString,
  SnippetString,
  Uri,
  SecretStorage,
  ThemeColor,
  ThemeIcon,
  env,
  lm,
  McpHttpServerDefinition,
  ViewColumn: Object.assign({}, ViewColumn, { Beside: 4 }),
  Webview,
  WebviewPanel,
  // runtime `extensions` helper
  extensions: { getExtension(id: string) { return undefined; } },
  QuickPickItemKind
} as any;
export default vscode;
