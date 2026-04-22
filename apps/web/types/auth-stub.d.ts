// Temporary stub: the real @/auth module lands in Batch 4 (apps/web/auth.ts).
// rbac.ts loads it via a dynamic import guarded at runtime; this declaration
// just keeps `tsc --noEmit` green in the interim. Delete once auth.ts exists.
declare module "@/auth" {
  export function auth(): Promise<{ user?: { role?: string } } | null>;
}
