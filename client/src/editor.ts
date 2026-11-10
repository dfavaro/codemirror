import { EditorView, basicSetup } from "codemirror";
import { Annotation, Compartment, EditorState, Extension } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { indentWithTab } from "@codemirror/commands";
import { indentUnit, StreamLanguage } from "@codemirror/language";
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
      keymap.of([indentWithTab]),
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
