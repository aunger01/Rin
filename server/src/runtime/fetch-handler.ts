import { getApp } from "./app-instance";
import { DISGUISE_HTML } from "../services/disguise-page";
import { getValidPaths, isKnownFeedPath } from "../services/valid-paths";

const ROOT_FEED_PATTERN = /^\/(rss\.xml|atom\.xml|rss\.json|feed\.json|feed\.xml)$/;
const APP_PUBLIC_ROUTE_PATTERN = /^\/(favicon|favicon\.ico)(?:\/|$)/;
// 由 Worker 直接处理的元数据路由（sitemap / robots），需在静态资源分支之前路由到 Hono 应用
const APP_META_ROUTE_PATTERN = /^\/(sitemap\.xml|robots\.txt)$/;

// —— 乱路径掩饰：服务端在发出 SPA 外壳之前判断路径合法性 ——
// 精确菜单路由（与 client/src/app/routes.tsx 的 AppRoute/TocRoute 对齐）
const SPA_EXACT_ROUTES = new Set([
  "/",
  "/timeline",
  "/moments",
  "/friends",
  "/hashtags",
  "/callback",
  "/login",
  "/profile",
  "/user/github",
  "/user/github/callback",
]);
// 带参数的正常路由前缀（参数段任意，一律放行给 SPA）
const SPA_PREFIX_ROUTES = [
  "/hashtag/",
  "/search/",
  "/feed/",
  "/admin/",
  "/user/",
];

/** 返回掩饰页响应：真 404 + noindex，博客源码一个字节不外泄 */
function disguiseResponse(): Response {
  return new Response(DISGUISE_HTML, {
    status: 404,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "x-robots-tag": "noindex, nofollow, noarchive, nosnippet",
      "cache-control": "no-store",
    },
  });
}

/** 路径是否为单段（/:alias 文章形态）——不含斜杠、非空 */
function isSingleSegment(pathname: string): boolean {
  return /^\/[^/]+$/.test(pathname);
}

/**
 * 判断路径是否应放行到 SPA（发 index.html）。
 * 合法：精确菜单路由 / 已知前缀路由 / 清单中的文章 alias 或 id。
 * 其余（含多段乱路径、不在清单的单段）一律掩饰。
 */
async function isAllowedSpaPath(pathname: string, env: Env): Promise<boolean> {
  if (SPA_EXACT_ROUTES.has(pathname)) return true;
  if (SPA_PREFIX_ROUTES.some((prefix) => pathname.startsWith(prefix))) return true;
  // 匹配 routes.tsx 的 /*/user/github（api_url_slash 提示路由），避免多段误伤
  if (/\/user\/github$/.test(pathname)) return true;
  if (isSingleSegment(pathname)) {
    const segment = decodeURIComponent(pathname.slice(1));
    const paths = await getValidPaths(env);
    // fail-safe：清单不可用（R2 抖动 / cron 尚未生成）时保守放行，
    // 宁可暂时退回「前端自判 Not found」的旧行为，也绝不能误伤真文章。
    if (paths === null) return true;
    return isKnownFeedPath(paths, segment);
  }
  return false;
}

function isApiRequest(pathname: string) {
  return pathname.startsWith("/api/");
}

function rewriteApiRequest(request: Request) {
  const url = new URL(request.url);
  url.pathname = url.pathname.replace(/^\/api(?=\/|$)/, "") || "/";
  return new Request(url, request);
}

function isRootFeedRequest(pathname: string) {
  return ROOT_FEED_PATTERN.test(pathname);
}

function isAppPublicRoute(pathname: string) {
  return APP_PUBLIC_ROUTE_PATTERN.test(pathname);
}

function isMetaRoute(pathname: string) {
  return APP_META_ROUTE_PATTERN.test(pathname);
}

function isStaticAssetRequest(pathname: string) {
  return /\.\w+$/.test(pathname);
}

async function tryServeAsset(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const asset = await env.ASSETS.fetch(request);
    if (asset.status === 200 || (asset.status >= 300 && asset.status < 400)) {
      return asset;
    }
  } catch {}

  return null;
}

async function serveSpaEntry(request: Request, env: Env) {
  if (!env.ASSETS) {
    return null;
  }

  try {
    const url = new URL(request.url);
    const indexRequest = new Request(new URL("/", url.origin), request);
    const indexResponse = await env.ASSETS.fetch(indexRequest);
    if (indexResponse.status === 200 || (indexResponse.status >= 300 && indexResponse.status < 400)) {
      return indexResponse;
    }
  } catch {}

  return null;
}

export async function handleFetch(
  request: Request,
  env: Env,
  executionContext?: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  const pathname = url.pathname;

  // 个人博客不欢迎抓取：/sitemap.xml 直接吐掩饰页（真 404）。
  // 注意：这是对外 HTTP 端点拦截，不影响 cron 写 R2 的内部清单读取。
  if (pathname === "/sitemap.xml") {
    return disguiseResponse();
  }

  if (isRootFeedRequest(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isApiRequest(pathname)) {
    return getApp().fetch(rewriteApiRequest(request), env, executionContext);
  }

  if (isAppPublicRoute(pathname)) {
    return getApp().fetch(request, env, executionContext);
  }

  if (isMetaRoute(pathname)) {
    return getApp().fetch(request, env);
  }

  if (isStaticAssetRequest(pathname)) {
    const asset = await tryServeAsset(request, env);
    if (asset) {
      return asset;
    }
  }

  // 乱路径根治：发出 SPA 外壳之前先判断路径合法性。
  // 合法才发 index.html；乱路径直接吐掩饰页，博客源码零外泄。
  if (!(await isAllowedSpaPath(pathname, env))) {
    return disguiseResponse();
  }

  const indexResponse = await serveSpaEntry(request, env);
  if (indexResponse) {
    return indexResponse;
  }

  return new Response("Hi", { status: 200 });
}
