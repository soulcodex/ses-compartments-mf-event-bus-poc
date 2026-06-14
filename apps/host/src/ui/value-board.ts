// value-board.ts
//
// A small DOM renderer for the shared-variable demo. It draws one card per
// plugin (modifiers, the reader, and the two malicious plugins) and lets the
// host push live state into each card. Modifier cards carry an editable number
// input plus a "Set" button. Styled by the .value-* classes in index.html.

export type BadgeKind = "ok" | "blocked" | "sniff";

export type CardControl = {
  label: string;
  /** Receives the card's current input value (empty string if no input). */
  onClick: (inputValue: string) => void;
};

export type CardOptions = {
  id: string;
  title: string;
  /** Drives the accent color: modifier | reader | malicious. */
  role: "modifier" | "reader" | "malicious";
  subtitle?: string;
  /** When present, renders an editable number input on the card. */
  input?: { initial: number };
  controls?: CardControl[];
};

export type CardState = {
  /** Large primary readout (e.g. the local replica value). */
  big?: string | null;
  /** Status pill in the header. */
  badge?: { text: string; kind: BadgeKind } | null;
  /** Secondary lines (e.g. sniffed entries). */
  rows?: string[];
};

type CardRefs = {
  big: HTMLDivElement;
  badge: HTMLSpanElement;
  rows: HTMLDivElement;
};

export function createValueBoard(containerId: string) {
  const found = document.getElementById(containerId);
  if (!found) throw new Error(`Value board #${containerId} not found`);
  const container: HTMLElement = found;

  const cards = new Map<string, CardRefs>();

  function addCard(opts: CardOptions) {
    const card = document.createElement("div");
    card.className = `value-card role-${opts.role}`;
    card.dataset.cardId = opts.id;

    const header = document.createElement("div");
    header.className = "value-card-header";

    const title = document.createElement("span");
    title.className = "value-title";
    title.textContent = opts.title;

    const badge = document.createElement("span");
    badge.className = "value-badge";

    header.appendChild(title);
    header.appendChild(badge);
    card.appendChild(header);

    if (opts.subtitle) {
      const sub = document.createElement("div");
      sub.className = "value-subtitle";
      sub.textContent = opts.subtitle;
      card.appendChild(sub);
    }

    const big = document.createElement("div");
    big.className = "value-big";
    card.appendChild(big);

    const rows = document.createElement("div");
    rows.className = "value-rows";
    card.appendChild(rows);

    let inputEl: HTMLInputElement | null = null;
    if (opts.input) {
      inputEl = document.createElement("input");
      inputEl.type = "number";
      inputEl.className = "value-input";
      inputEl.value = String(opts.input.initial);
      card.appendChild(inputEl);
    }

    if (opts.controls && opts.controls.length > 0) {
      const controls = document.createElement("div");
      controls.className = "value-controls";
      for (const control of opts.controls) {
        const button = document.createElement("button");
        button.textContent = control.label;
        button.addEventListener("click", () => control.onClick(inputEl?.value ?? ""));
        controls.appendChild(button);
      }
      card.appendChild(controls);
    }

    container.appendChild(card);
    cards.set(opts.id, { big, badge, rows });
  }

  function updateCard(id: string, state: CardState) {
    const refs = cards.get(id);
    if (!refs) return;

    if (state.big !== undefined) {
      refs.big.textContent = state.big ?? "";
    }

    if (state.badge !== undefined) {
      if (state.badge === null) {
        refs.badge.textContent = "";
        refs.badge.className = "value-badge";
      } else {
        refs.badge.textContent = state.badge.text;
        refs.badge.className = `value-badge badge-${state.badge.kind}`;
      }
    }

    if (state.rows !== undefined) {
      refs.rows.replaceChildren();
      for (const line of state.rows) {
        const row = document.createElement("div");
        row.className = "value-row";
        row.textContent = line;
        refs.rows.appendChild(row);
      }
    }
  }

  function clear() {
    container.replaceChildren();
    cards.clear();
  }

  return { addCard, updateCard, clear };
}
