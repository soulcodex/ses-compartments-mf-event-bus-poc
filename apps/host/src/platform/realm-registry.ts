// realm-registry.ts
//
// Host-owned registry of live realms. The host (not the realm) generates each
// realm-id, so a realm cannot choose or forge its own identity. The registry is
// the trusted directory a verifier consults: "is this realm-id currently a
// registered realm?" — step 2 of the attestation workflow.

export type RealmRecord = {
  realmId: string;
  role: string;
  origin: string;
};

export class RealmRegistry {
  private realms = new Map<string, RealmRecord>();

  /** Assign a fresh, unforgeable id to a realm and record it. */
  register(role: string, origin: string): string {
    const realmId = crypto.randomUUID();
    this.realms.set(realmId, { realmId, role, origin });
    return realmId;
  }

  get(realmId: string): RealmRecord | undefined {
    return this.realms.get(realmId);
  }

  has(realmId: string): boolean {
    return this.realms.has(realmId);
  }

  /** Frozen snapshot of the live realm-ids (the "browser exposes ids" view). */
  list(): readonly RealmRecord[] {
    return harden([...this.realms.values()].map((r) => ({ ...r })));
  }

  unregister(realmId: string): void {
    this.realms.delete(realmId);
  }

  clear(): void {
    this.realms.clear();
  }
}
