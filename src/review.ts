import { EditorState, Prec, StateEffect, StateField, type Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, WidgetType, keymap, type DecorationSet } from "@codemirror/view";
import { editorInfoField, type Editor } from "obsidian";
import diff from "fast-diff";
import type { Revision } from "./history";

class Addition extends WidgetType {
  constructor(readonly text: string) { super(); }
  eq(other: Addition) { return this.text === other.text; }
  get lineBreaks() { return this.text.split("\n").length - 1; }
  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "minimal-text-ai-added";
    span.textContent = this.text;
    return span;
  }
}

interface Session {
  decorations: DecorationSet;
  panel: (view: EditorView) => {dom: HTMLElement};
  pending: boolean;
  finish: (accept: boolean) => void;
}
const toggle = StateEffect.define<Session | null>();
const reviewField = StateField.define<Session | null>({
  create: () => null,
  update(value, tr) {
    if (tr.docChanged) return null;
    for (const e of tr.effects) if (e.is(toggle)) return e.value;
    return value;
  },
  provide: field => [
    EditorView.decorations.from(field, s => s?.decorations ?? Decoration.none),
    Prec.highest(EditorState.readOnly.computeN([field], state => state.field(field)?.pending ? [true] : []))
  ]
});

function controls(view: EditorView, label: string) {
  const dom = view.dom.ownerDocument.createElement("div");
  dom.className = "minimal-text-ai-toolbar";
  dom.setAttribute("role", "region");
  dom.setAttribute("aria-label", label);
  dom.createSpan({text: label});
  return dom;
}

function decide(view: EditorView, accepted: boolean) {
  const s = view.state.field(reviewField, false);
  if (!s || (accepted && !s.pending) || view.composing) return false;
  s.finish(accepted);
  view.dispatch({effects: toggle.of(null)});
  view.focus();
  return true;
}

function decorations(parts: diff.Diff[], start: number) {
  let pos = start;
  const spans: Range<Decoration>[] = [];
  for (const [op, text] of parts) {
    if (op === 1) {
      spans.push(Decoration.widget({widget: new Addition(text), side: 1}).range(pos));
    } else {
      if (op === -1) {
        spans.push(Decoration.mark({class: "minimal-text-ai-removed"}).range(pos, pos + text.length));
        // Newline-only removals need a visible glyph, too.
        for (let i = text.indexOf("\n"); i >= 0; i = text.indexOf("\n", i + 1))
          spans.push(Decoration.widget({widget: new DeletedBreak(), side: -1}).range(pos + i));
      }
      pos += text.length;
    }
  }
  return Decoration.set(spans, true);
}

class DeletedBreak extends WidgetType {
  toDOM(view: EditorView) {
    const span = view.dom.ownerDocument.createElement("span");
    span.className = "minimal-text-ai-removed";
    span.textContent = "↵";
    return span;
  }
}

export class InlineReview {
  private views = new Set<EditorView>();
  readonly extension = [
    reviewField,
    Prec.highest(keymap.of([
      {key: "Enter", run: view => decide(view, true)},
      {key: "Escape", run: view => decide(view, false)}
    ])),
    ViewPlugin.define(view => {
      this.views.add(view);
      let session = view.state.field(reviewField);
      let capsule: HTMLElement | undefined;
      function mountCapsule() {
        if (!session) return;
        capsule = session.panel(view).dom;
        capsule.classList.add("minimal-text-ai-capsule");
        // The CM root belongs to this source pane; its scroller is a sibling of the capsule.
        view.dom.appendChild(capsule);
      }
      mountCapsule();
      return {
        update(update) {
          const next = update.state.field(reviewField);
          // Document changes, including sync edits, invalidate all original offsets.
          if (session === next) return;
          capsule?.remove();
          capsule = undefined;
          session?.finish(false);
          session = next;
          mountCapsule();
        },
        destroy: () => { capsule?.remove(); this.views.delete(view); session?.finish(false); }
      };
    })
  ];

  private viewFor(editor: Editor) {
    for (const view of this.views) if (view.state.field(editorInfoField, false)?.editor === editor) return view;
    throw new Error("请在 Markdown 编辑视图中查看 AI 改动");
  }

  cancel() {
    for (const view of this.views) if (view.state.field(reviewField, false))
      view.dispatch({effects: toggle.of(null)});
  }

  preview(editor: Editor, r: Revision, parts: diff.Diff[]) {
    const view = this.viewFor(editor);
    return new Promise<boolean>(resolve => {
      const stops: number[] = [];
      let pos = r.start, inChange = false;
      for (const [op, value] of parts) {
        if (op && !inChange) stops.push(pos);
        inChange = op !== 0;
        if (op !== 1) pos += value.length;
      }
      let index = 0;
      const jump = () => EditorView.scrollIntoView(stops[index], {y: "center"});
      let decided = false;
      const finish = (accepted: boolean) => { if (!decided) { decided = true; resolve(accepted); } };
      const session: Session = {
        decorations: decorations(parts, r.start), pending: true, finish,
        panel: () => {
          const dom = controls(view, r.action + " · 待确认");
          if (stops.length > 1) {
            const counter = dom.createSpan({text: "1 / " + stops.length});
            for (const [step, label] of [[-1, "上一处"], [1, "下一处"]] as const)
              dom.createEl("button", {text: label}).onclick = () => {
                index = (index + step + stops.length) % stops.length;
                counter.textContent = (index + 1) + " / " + stops.length;
                view.dispatch({effects: jump()});
                view.focus();
              };
          }
          dom.createEl("button", {text: "放弃 Esc"}).onclick = () => decide(view, false);
          dom.createEl("button", {text: "接受 Enter", cls: "mod-cta"}).onclick = () => decide(view, true);
          return {dom};
        }
      };
      view.dispatch({selection: {anchor: stops[0]}, effects: [toggle.of(session), jump()]});
      view.focus();
    });
  }

  history(editor: Editor, r: Revision, parts: diff.Diff[], undo: () => void) {
    const view = this.viewFor(editor);
    if (view.state.field(reviewField)?.pending) throw new Error("请先接受或放弃当前改动");
    view.dispatch({effects: toggle.of({
      pending: false, finish() {}, decorations: Decoration.none,
      panel: () => {
        const dom = controls(view, r.action + " · " + new Date(r.time).toLocaleString());
        dom.classList.add("minimal-text-ai-history-panel");
        const text = dom.createEl("pre", {cls: "minimal-text-ai-history"});
        for (const [op, value] of parts) {
          if (op) text.createSpan({text: value, cls: op < 0 ? "minimal-text-ai-removed" : "minimal-text-ai-added"});
          else text.appendText(value);
        }
        const actions = dom.createEl("div", {cls: "minimal-text-ai-history-actions"});
        actions.createEl("button", {text: "复制修改前全文"}).onclick = async () => {
          try { await navigator.clipboard.writeText(r.before); }
          catch { text.empty(); const box = text.createEl("textarea"); box.value = r.before; box.select(); }
        };
        actions.createEl("button", {text: "撤回本次修改"}).onclick = () => { decide(view, false); undo(); };
        actions.createEl("button", {text: "关闭"}).onclick = () => decide(view, false);
        return {dom};
      }
    })});
  }
}

export function differences(record: Revision) {
  return diff(record.before.slice(record.start, record.end), record.output);
}
