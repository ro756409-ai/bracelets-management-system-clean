/**
 * بيئة النشر — مصدر واحد صريح للقرارات التي تختلف بين «محلي» و«منشور».
 *
 * المتغير: `DEPLOY_ENV` بقيم: `production` | `staging` | `preview` | `development` | `test`.
 * بلا تخمين من اسم الدومين: لو غير مضبوط نشتق من `NODE_ENV` فقط (test → test، production →
 * production، غير ذلك development). **بيئة Staging لا تُستنتج أبدًا** — يجب ضبط
 * `DEPLOY_ENV=staging` صراحةً وإلا عُوملت كـproduction (وهو السلوك الحالي قبل هذا المتغير).
 * قيمة غير معروفة → `preview` (أكثر البيئات تحفظًا: فشل مغلق في كل قرار).
 *
 * «محلي» = development أو test: يُسمح فيهما بالقرص المحلي وبالـMock. أي بيئة أخرى منشورة.
 */
export type DeployEnv = "production" | "staging" | "preview" | "development" | "test";

const KNOWN: readonly DeployEnv[] = ["production", "staging", "preview", "development", "test"];

export function resolveDeployEnv(env: NodeJS.ProcessEnv = process.env): DeployEnv {
  const explicit = env.DEPLOY_ENV?.trim().toLowerCase();
  if (explicit) return (KNOWN as readonly string[]).includes(explicit) ? (explicit as DeployEnv) : "preview";
  if (env.NODE_ENV === "test" || env.VITEST) return "test";
  if (env.NODE_ENV === "production") return "production";
  return "development";
}

/** development/test فقط — القرص المحلي والـMock مسموحان هنا بس. */
export function isLocalDeployEnv(env: NodeJS.ProcessEnv = process.env): boolean {
  const d = resolveDeployEnv(env);
  return d === "development" || d === "test";
}

export function isDeployEnvExplicit(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.DEPLOY_ENV?.trim());
}
