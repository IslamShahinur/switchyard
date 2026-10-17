#!/usr/bin/env bash
# Creates ../demo-env: an "acme" git repo with 4 worktrees seeded with real tsc/eslint issues.
set -euo pipefail
ROOT="${1:-$(cd "$(dirname "$0")/../.." && pwd)/demo-env}"
mkdir -p "$ROOT/tools" && cd "$ROOT/tools"
[ -f package.json ] || npm init -y >/dev/null
npm install --silent --legacy-peer-deps eslint@9 typescript@5 typescript-eslint@8 @eslint/js@9
cd "$ROOT" && ln -sfn tools/node_modules node_modules
rm -rf acme worktrees && mkdir -p acme/src && cd acme
git init -q -b main && git config user.email agent@switchyard.dev && git config user.name Switchyard
cat > tsconfig.json <<'EOF'
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "noEmit": true, "skipLibCheck": true }, "include": ["src"] }
EOF
cat > eslint.config.mjs <<'EOF'
import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(js.configs.recommended, ...tseslint.configs.recommended, {
  files: ["src/**/*.ts"],
  rules: { "no-console": "warn", "prefer-const": "error", "@typescript-eslint/no-explicit-any": "warn" }
});
EOF
printf 'export type Cents = number;\nexport function formatCents(value: Cents, currency = "USD"): string {\n  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value / 100);\n}\n' > src/money.ts
printf 'import { Cents } from "./money";\nexport interface LineItem { sku: string; qty: number; unit: Cents }\nexport function subtotal(items: LineItem[]): Cents {\n  return items.reduce((sum, i) => sum + i.qty * i.unit, 0);\n}\n' > src/cart.ts
printf 'export interface Session { userId: string; expiresAt: number }\nexport function isExpired(s: Session, now = Date.now()): boolean {\n  return s.expiresAt <= now;\n}\n' > src/auth.ts
printf 'export function tokenize(q: string): string[] {\n  return q.toLowerCase().split(/\\s+/).filter(Boolean);\n}\n' > src/search.ts
printf 'export interface Invoice { id: string; amount: number; paid: boolean }\nexport function outstanding(invoices: Invoice[]): number {\n  return invoices.filter((i) => !i.paid).reduce((a, i) => a + i.amount, 0);\n}\n' > src/billing.ts
printf 'node_modules\n' > .gitignore
git add -A && git commit -qm "chore: initial acme platform"
for b in feat/checkout-v2 feat/auth-passkeys feat/search-ranking fix/billing-webhooks; do git worktree add -q -b "$b" "../worktrees/${b#*/}"; done
printf 'export function applyDiscount(total: Cents, pct: number): Cents {\n  let result = total - total * pct;\n  return result.toFixed(0);\n}\n' >> ../worktrees/checkout-v2/src/cart.ts
printf 'export function score(doc: any, terms: string[]): number {\n  console.log("scoring", doc.id);\n  return terms.filter((t) => doc.body.includes(t)).length;\n}\n' >> ../worktrees/search-ranking/src/search.ts
for w in checkout-v2 auth-passkeys search-ranking billing-webhooks; do (cd "../worktrees/$w" && git add -A && git commit -qm "wip: $w seed" --allow-empty && git tag -f "seed/$w" >/dev/null); done
echo "demo env ready at $ROOT"
