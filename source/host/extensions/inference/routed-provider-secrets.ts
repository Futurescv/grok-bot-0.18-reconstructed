/**
 * Where a routed provider's credentials come from.
 *
 * Routed providers (codex / openrouter / anthropic / claude-code) run inside the
 * desktop coordinator process, but a key typed into Settings → Router is pushed
 * to the *box* (`setBoxSecrets`), which never runs routed inference. Those
 * secrets travel through the coordinator on their way there, so the coordinator
 * adopts a copy in memory — never on disk, and never in a child's environment
 * where `ps eww` would show it.
 *
 * Resolution order is env → adopted → the box's on-disk store, so an operator's
 * explicit environment still wins over whatever the UI last saved.
 */
let adopted: Record<string, string> = {};

function stringEntries(value: unknown): Record<string, string> {
  if (typeof value !== "object" || value == null || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}

/** Accepts either the `setBoxSecrets` argument (`{secrets}`) or a bare map. */
export function adoptRoutedProviderSecrets(value: unknown): void {
  const record = typeof value === "object" && value != null && !Array.isArray(value) ? value as Record<string, unknown> : {};
  adopted = stringEntries(Object.hasOwn(record, "secrets") ? record.secrets : record);
}

export function routedProviderSecret(name: string, persisted: () => Record<string, string>): string | undefined {
  const candidates = [process.env[name], adopted[name], persisted()[name]];
  for (const candidate of candidates) {
    const value = candidate?.trim();
    if (value != null && value.length > 0) return value;
  }
  return undefined;
}
