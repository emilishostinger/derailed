import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { languages } from '@codemirror/language-data';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { useEffect, useRef } from 'react';

/**
 * A real editor, not a textarea wearing one's clothes.
 *
 * CodeMirror, with its language registry loaded on demand: the highlighter for
 * whatever file is open is fetched when that kind of file is first opened, so a
 * person editing one HTML page never downloads a Python grammar.
 */
export function CodeEditor({
  value,
  filename,
  onChange,
  onSave,
}: {
  value: string;
  /** Used to pick the highlighter. */
  filename: string;
  onChange: (next: string) => void;
  /** Cmd/Ctrl-S. Browsers grab it otherwise, and the muscle memory is universal. */
  onSave?: () => void;
}) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const language = useRef(new Compartment());
  const latest = useRef({ onChange, onSave });
  latest.current = { onChange, onSave };

  // biome-ignore lint/correctness/useExhaustiveDependencies: the view is created once; value changes flow through the transaction below.
  useEffect(() => {
    if (!host.current) return;
    const state = EditorState.create({
      doc: value,
      extensions: [
        lineNumbers(),
        history(),
        indentOnInput(),
        bracketMatching(),
        syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
        language.current.of([]),
        keymap.of([
          {
            key: 'Mod-s',
            run: () => {
              latest.current.onSave?.();
              return true;
            },
          },
          indentWithTab,
          ...defaultKeymap,
          ...historyKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString());
        }),
        // Themed with the app's own CSS variables, so the editor follows dark and
        // light automatically. Without this CodeMirror keeps its light defaults: on
        // the dark dashboard the gutter was a bright stripe and the caret was black
        // on near-black, invisible while typing.
        EditorView.theme({
          '&': {
            fontSize: '13px',
            height: '100%',
            color: 'var(--color-ink)',
            backgroundColor: 'var(--color-sunken)',
          },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
          '.cm-content': { caretColor: 'var(--color-ink)' },
          // The caret itself is a bordered element, not the text caret-color, so it
          // needs its own visible colour or it disappears against a dark background.
          '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--color-accent)' },
          '&.cm-focused .cm-cursor': { borderLeftColor: 'var(--color-accent)' },
          // The line-number sidebar: a recessed panel colour, faint numbers, a hair
          // line down its right edge, matching every other sidebar in the app.
          '.cm-gutters': {
            backgroundColor: 'var(--color-surface-2)',
            color: 'var(--color-ink-faint)',
            borderRight: '1px solid var(--color-line)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'var(--color-elevated)',
            color: 'var(--color-ink-muted)',
          },
          '.cm-activeLine': {
            backgroundColor: 'color-mix(in srgb, var(--color-ink) 5%, transparent)',
          },
          '.cm-selectionBackground, &.cm-focused .cm-selectionBackground, ::selection': {
            backgroundColor: 'var(--color-accent-soft)',
          },
          '.cm-matchingBracket, &.cm-focused .cm-matchingBracket': {
            backgroundColor: 'var(--color-accent-soft)',
            outline: '1px solid var(--color-accent)',
          },
        }),
      ],
    });
    view.current = new EditorView({ state, parent: host.current });
    return () => {
      view.current?.destroy();
      view.current = null;
    };
  }, []);

  // A new file arriving replaces the document without recreating the editor.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    if (current.state.doc.toString() !== value) {
      current.dispatch({
        changes: { from: 0, to: current.state.doc.length, insert: value },
      });
    }
  }, [value]);

  // The highlighter follows the file name, loaded on demand.
  useEffect(() => {
    const current = view.current;
    if (!current) return;
    const description =
      languages.find((entry) => entry.extensions.some((ext) => filename.endsWith(`.${ext}`))) ??
      null;
    if (!description) {
      current.dispatch({ effects: language.current.reconfigure([]) });
      return;
    }
    let cancelled = false;
    void description.load().then((support) => {
      if (!cancelled && view.current) {
        view.current.dispatch({ effects: language.current.reconfigure(support) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [filename]);

  return <div ref={host} className="h-full min-h-0 overflow-hidden" />;
}
