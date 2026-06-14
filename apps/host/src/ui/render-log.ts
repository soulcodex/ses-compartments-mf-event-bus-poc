export function createLogRenderer(panelId: string) {
  const panel = document.getElementById(panelId);
  if (!panel) throw new Error(`Log panel #${panelId} not found`);

  function getClass(source: string): string {
    if (source === "host") return "log-host";
    if (source === "catalog") return "log-catalog";
    if (source === "cart") return "log-cart";
    if (source === "malicious") return "log-malicious";
    if (source === "mutation") return "log-mutation";
    if (source.startsWith("worker:catalog")) return "log-worker-catalog";
    if (source.startsWith("worker:cart")) return "log-worker-cart";
    if (source.startsWith("worker:")) return "log-worker";
    if (source.startsWith("mf:catalog")) return "log-mf-catalog";
    if (source.startsWith("mf:cart")) return "log-mf-cart";
    if (source === "malicious-value-modifier") return "log-malicious-value-modifier";
    if (source === "malicious-value-reader") return "log-malicious-value-reader";
    if (source === "value-modifier") return "log-value-modifier";
    if (source === "value-reader") return "log-value-reader";
    return "";
  }

  return {
    append(source: string, message: string) {
      const div = document.createElement("div");
      div.className = `log-entry ${getClass(source)}`;
      div.textContent = `[${source}] ${message}`;
      panel.appendChild(div);
      panel.scrollTop = panel.scrollHeight;
    },
    clear() {
      panel.innerHTML = "";
    },
  };
}