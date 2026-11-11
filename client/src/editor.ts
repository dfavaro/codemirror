import { EditorView, basicSetup } from "codemirror";
import {
  Annotation,
  Compartment,
  EditorSelection,
  EditorState,
  Extension,
  Prec
} from "@codemirror/state";
import { KeyBinding, keymap } from "@codemirror/view";
import {
  addCursorAbove,
  addCursorBelow,
  copyLineDown,
  copyLineUp,
  cursorMatchingBracket,
  deleteLine,
  indentLess,
  indentMore,
  indentSelection,
  insertBlankLine,
  moveLineDown,
  moveLineUp,
  redo,
  redoSelection,
  selectLine,
  selectParentSyntax,
  simplifySelection,
  toggleBlockComment,
  toggleComment,
  undoSelection
} from "@codemirror/commands";
import {
  acceptCompletion,
  nextSnippetField,
  prevSnippetField,
  startCompletion
} from "@codemirror/autocomplete";
import {
  foldAll,
  foldCode,
  indentUnit,
  StreamLanguage,
  unfoldAll,
  unfoldCode
} from "@codemirror/language";
import {
  gotoLine,
  openSearchPanel,
  selectNextOccurrence,
  selectSelectionMatches
} from "@codemirror/search";
import { kotlin } from "@codemirror/legacy-modes/mode/clike";
import { swift } from "@codemirror/legacy-modes/mode/swift";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  kotlinAutocompletionExtension,
  kotlinCompletionSource,
  swiftAutocompletionExtension,
  swiftCompletionSource,
  universalWordCompletionExtension
} from "./completions";
import { javascript } from "@codemirror/lang-javascript";
import { python } from "@codemirror/lang-python";
import { go } from "@codemirror/lang-go";
import { java } from "@codemirror/lang-java";
import { sql } from "@codemirror/lang-sql";
import { rust } from "@codemirror/lang-rust";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import * as Y from "yjs";

export type SupportedLanguage =
  | "css"
  | "go"
  | "html"
  | "java"
  | "javascript"
  | "json"
  | "kotlin"
  | "markdown"
  | "plaintext"
  | "python"
  | "rust"
  | "sql"
  | "swift"
  | "typescript";

export interface LanguageOption {
  id: SupportedLanguage;
  label: string;
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  { id: "css", label: "CSS" },
  { id: "go", label: "Go" },
  { id: "html", label: "HTML" },
  { id: "java", label: "Java" },
  { id: "javascript", label: "JavaScript" },
  { id: "json", label: "JSON" },
  { id: "kotlin", label: "Kotlin" },
  { id: "markdown", label: "Markdown" },
  { id: "plaintext", label: "Plain Text" },
  { id: "python", label: "Python" },
  { id: "rust", label: "Rust" },
  { id: "sql", label: "SQL" },
  { id: "swift", label: "Swift" },
  { id: "typescript", label: "TypeScript" }
];

const kotlinStreamLanguage = StreamLanguage.define({
  ...kotlin,
  languageData: {
    ...kotlin.languageData,
    autocomplete: kotlinCompletionSource
  }
});

const swiftStreamLanguage = StreamLanguage.define({
  ...swift,
  languageData: {
    ...swift.languageData,
    autocomplete: swiftCompletionSource
  }
});

function getLanguageExtension(lang: SupportedLanguage): Extension {
  switch (lang) {
    case "typescript":
      return javascript({ typescript: true, jsx: true });
    case "javascript":
      return javascript({ jsx: true });
    case "kotlin":
      return [kotlinStreamLanguage, kotlinAutocompletionExtension()];
    case "swift":
      return [swiftStreamLanguage, swiftAutocompletionExtension()];
    case "python":
      return python();
    case "go":
      return go();
    case "java":
      return java();
    case "rust":
      return rust();
    case "sql":
      return sql();
    case "json":
      return json();
    case "html":
      return html();
    case "css":
      return css();
    case "markdown":
      return markdown();
    case "plaintext":
    default:
      return [];
  }
}

const remoteYjsAnnotation = Annotation.define<boolean>();
const LOCAL_CM_ORIGIN = "cm-local";

/**
 * Custom VS Code-style Tab handler:
 * 1. If an autocomplete suggestion is active, accept it.
 * 2. Else if inside an active snippet template, advance to the next placeholder.
 * 3. Else if multiple lines are selected, indent the selected lines.
 * 4. Otherwise, insert spaces directly at the cursor position (never indenting the whole row).
 */
export function handleTabKey(view: EditorView): boolean {
  if (acceptCompletion(view)) {
    return true;
  }
  if (nextSnippetField(view)) {
    return true;
  }
  const hasMultiLineSelection = view.state.selection.ranges.some((range) => {
    if (range.empty) return false;
    return view.state.doc.lineAt(range.from).number !== view.state.doc.lineAt(range.to).number;
  });
  if (hasMultiLineSelection) {
    return indentMore(view);
  }
  view.dispatch({
    ...view.state.replaceSelection("  "),
    scrollIntoView: true,
    userEvent: "input"
  });
  return true;
}

export function handleShiftTabKey(view: EditorView): boolean {
  if (prevSnippetField(view)) {
    return true;
  }
  return indentLess(view);
}

/**
 * VS Code `Cmd+Shift+Enter` / `Ctrl+Shift+Enter`: Insert a blank line above the current line
 * preserving the current line's leading indentation.
 */
export function insertBlankLineAbove(view: EditorView): boolean {
  const { state } = view;
  const changes = state.changeByRange((range) => {
    const line = state.doc.lineAt(range.head);
    const indentMatch = /^[\t ]*/.exec(line.text);
    const indent = indentMatch ? indentMatch[0] : "";
    return {
      changes: { from: line.from, insert: `${indent}\n` },
      range: EditorSelection.cursor(line.from + indent.length)
    };
  });
  view.dispatch(changes, { scrollIntoView: true, userEvent: "input" });
  return true;
}

/**
 * VS Code `Shift+Alt+I`: Add a cursor at the end of every line in the current selection.
 */
export function addCursorsToLineEnds(view: EditorView): boolean {
  const { state } = view;
  const cursors: { anchor: number; head: number }[] = [];
  for (const range of state.selection.ranges) {
    const startLine = state.doc.lineAt(range.from).number;
    const endLine = state.doc.lineAt(range.to).number;
    for (let lineNum = startLine; lineNum <= endLine; lineNum++) {
      const line = state.doc.line(lineNum);
      cursors.push({ anchor: line.to, head: line.to });
    }
  }
  if (cursors.length === 0) return false;
  view.dispatch({
    selection: EditorSelection.create(
      cursors.map((c) => EditorSelection.cursor(c.head))
    )
  });
  return true;
}

/**
 * Keybindings replicating VS Code's core editing, multi-cursor, line manipulation,
 * commenting, folding, and search shortcuts in the browser.
 */
export const VSCODE_KEYBINDINGS: readonly KeyBinding[] = [
  // Autocomplete, snippets, & cursor-position Tab spacing
  { key: "Tab", run: handleTabKey },
  { key: "Shift-Tab", run: handleShiftTabKey },
  { key: "Ctrl-Space", run: startCompletion },
  { key: "Mod-i", run: startCompletion, preventDefault: true },

  // Line manipulation (Move, Copy, Delete, Insert Above/Below, Select Line)
  { key: "Alt-ArrowUp", run: moveLineUp },
  { key: "Alt-ArrowDown", run: moveLineDown },
  { key: "Shift-Alt-ArrowUp", run: copyLineUp },
  { key: "Shift-Alt-ArrowDown", run: copyLineDown },
  { key: "Shift-Mod-k", run: deleteLine, preventDefault: true },
  { key: "Mod-Enter", run: insertBlankLine, preventDefault: true },
  { key: "Shift-Mod-Enter", run: insertBlankLineAbove, preventDefault: true },
  { key: "Mod-l", run: selectLine, preventDefault: true },

  // Multi-cursor & occurrences (VS Code signature shortcuts)
  { key: "Mod-d", run: selectNextOccurrence, preventDefault: true },
  { key: "Shift-Mod-l", run: selectSelectionMatches, preventDefault: true },
  { key: "Mod-Alt-ArrowUp", run: addCursorAbove, preventDefault: true },
  { key: "Mod-Alt-ArrowDown", run: addCursorBelow, preventDefault: true },
  { key: "Shift-Alt-i", run: addCursorsToLineEnds, preventDefault: true },
  { key: "Mod-u", run: undoSelection, preventDefault: true },
  { key: "Shift-Mod-u", run: redoSelection, preventDefault: true },

  // Comments, indentation & formatting
  { key: "Mod-/", run: toggleComment, preventDefault: true },
  { key: "Shift-Alt-a", run: toggleBlockComment, preventDefault: true },
  { key: "Mod-[", run: indentLess, preventDefault: true },
  { key: "Mod-]", run: indentMore, preventDefault: true },
  { key: "Shift-Alt-f", run: indentSelection, preventDefault: true },

  // Bracket jump, smart AST selection, folding & search/go-to-line
  { key: "Shift-Mod-\\", run: cursorMatchingBracket, preventDefault: true },
  {
    key: "Shift-Alt-ArrowRight",
    mac: "Ctrl-Shift-ArrowRight",
    run: selectParentSyntax,
    preventDefault: true
  },
  {
    key: "Shift-Alt-ArrowLeft",
    mac: "Ctrl-Shift-ArrowLeft",
    run: simplifySelection,
    preventDefault: true
  },
  { key: "Ctrl-g", run: gotoLine, preventDefault: true },
  { key: "Mod-f", run: openSearchPanel, preventDefault: true },
  { key: "Mod-h", mac: "Mod-Alt-f", run: openSearchPanel, preventDefault: true },
  { key: "Shift-Mod-z", run: redo, preventDefault: true },
  { key: "Mod-y", run: redo, preventDefault: true },
  { key: "Ctrl-Shift-[", mac: "Mod-Alt-[", run: foldCode, preventDefault: true },
  { key: "Ctrl-Shift-]", mac: "Mod-Alt-]", run: unfoldCode, preventDefault: true },
  { key: "Mod-k Mod-0", run: foldAll, preventDefault: true },
  { key: "Mod-k Mod-j", run: unfoldAll, preventDefault: true }
];

export interface EditorController {
  view: EditorView;
  setLanguage: (lang: SupportedLanguage) => void;
  getLanguage: () => SupportedLanguage;
  destroy: () => void;
}

/**
 * Initializes the CodeMirror 6 editor bound to a Yjs document (`Y.Text("codemirror")`)
 * using incremental CRDT delta updates for sub-50ms keystroke synchronization
 * without cursor reset or presence overhead.
 */
export function initializeEditor(
  container: HTMLElement,
  doc: Y.Doc,
  onLanguageChange?: (lang: SupportedLanguage) => void
): EditorController {
  const ytext = doc.getText("codemirror");
  const ymeta = doc.getMap<string>("meta");
  const languageCompartment = new Compartment();

  const initialLang = (ymeta.get("language") as SupportedLanguage) || "kotlin";

  const state = EditorState.create({
    doc: ytext.toString(),
    extensions: [
      basicSetup,
      oneDark,
      EditorView.lineWrapping,
      EditorState.tabSize.of(2),
      indentUnit.of("  "),
      Prec.highest(keymap.of(VSCODE_KEYBINDINGS)),
      universalWordCompletionExtension(),
      languageCompartment.of(getLanguageExtension(initialLang)),
      EditorView.updateListener.of((update) => {
        if (!update.docChanged) return;
        if (update.transactions.some((tr) => tr.annotation(remoteYjsAnnotation))) {
          return;
        }

        doc.transact(() => {
          update.changes.iterChanges((fromA, toA, fromB, _toB, inserted) => {
            const deleteLength = toA - fromA;
            if (deleteLength > 0) {
              ytext.delete(fromB, deleteLength);
            }
            const insertText = inserted.toString();
            if (insertText.length > 0) {
              ytext.insert(fromB, insertText);
            }
          });
        }, LOCAL_CM_ORIGIN);
      })
    ]
  });

  const view = new EditorView({ state, parent: container });

  const handleYTextObserve = (event: Y.YTextEvent, transaction: Y.Transaction) => {
    if (transaction.origin === LOCAL_CM_ORIGIN) {
      return;
    }

    const changes: { from: number; to: number; insert: string }[] = [];
    let pos = 0;

    for (const op of event.delta) {
      if (typeof op.retain === "number") {
        pos += op.retain;
      } else if (typeof op.delete === "number") {
        changes.push({ from: pos, to: pos + op.delete, insert: "" });
        pos += op.delete;
      } else if (typeof op.insert === "string") {
        changes.push({ from: pos, to: pos, insert: op.insert });
      }
    }

    if (changes.length > 0) {
      view.dispatch({
        changes,
        annotations: remoteYjsAnnotation.of(true)
      });
    }
  };

  const handleYMetaObserve = () => {
    const remoteLang = ymeta.get("language") as SupportedLanguage | undefined;
    if (remoteLang && LANGUAGE_OPTIONS.some((opt) => opt.id === remoteLang)) {
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(remoteLang))
      });
      onLanguageChange?.(remoteLang);
    }
  };

  ytext.observe(handleYTextObserve);
  ymeta.observe(handleYMetaObserve);

  return {
    view,
    setLanguage(lang: SupportedLanguage) {
      if (ymeta.get("language") !== lang) {
        doc.transact(() => {
          ymeta.set("language", lang);
        }, LOCAL_CM_ORIGIN);
      }
      view.dispatch({
        effects: languageCompartment.reconfigure(getLanguageExtension(lang))
      });
      onLanguageChange?.(lang);
    },
    getLanguage(): SupportedLanguage {
      return (ymeta.get("language") as SupportedLanguage) || initialLang;
    },
    destroy() {
      ytext.unobserve(handleYTextObserve);
      ymeta.unobserve(handleYMetaObserve);
      view.destroy();
    }
  };
}
