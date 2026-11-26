import { eq } from "drizzle-orm";
import type { DB } from "../core/hono-types";
import { feeds } from "../db/schema";
import { path_join } from "../utils/path";
import { getStorageObject, putStorageObjectAtKey } from "../utils/storage";

/**
 * 有效路径清单服务。
 *
 * 用途：服务端在发出 SPA index.html 之前，判断请求路径是否为合法页面。
 * - 合法 → 照发 index.html（React 接管渲染）
 * - 非法（乱敲）→ 由 fetch-handler 直接吐掩饰页，博客源码一个字节不外泄
 *
 * 设计要点（防爆额度）：
 * 1. 清单由 cron 预生成写入 R2/S3 存储对象 —— 判断时只读现成对象，绝不查 D1。
 * 2. 读取走三层缓存：模块内存 → CF caches.default(边缘) → 存储对象。
 * 3. 缓存未命中且存储读取失败 → 返回 null，调用方按「空清单/保守放行」处理，
 *    绝不 fallback 实时查库（否则刷乱路径即可刷爆 D1）。
 */

const VALID_PATHS_CACHE_FOLDER = "cache/";
const VALID_PATHS_OBJECT = "valid-paths.json";
const CACHE_TTL_SECONDS = 3600; // 与 cron 周期对齐

/** 规范化后的合法路径集合：alias 与 id 都收，统一去掉首尾斜杠 */
export type ValidPaths = {
  aliases: Set<string>;
  ids: Set<string>;
};

const EMPTY_PATHS: ValidPaths = { aliases: new Set(), ids: new Set() };

// 模块级内存缓存：同一 Worker isolate 存活期内复用，冷启动回落到边缘缓存
let memoryPaths: ValidPaths | null = null;
let memoryExpiresAt = 0;

function storageKey(env: Env): string {
  return path_join(env.S3_CACHE_FOLDER || VALID_PATHS_CACHE_FOLDER, VALID_PATHS_OBJECT);
}

function parsePaths(json: string): ValidPaths {
  const data = JSON.parse(json) as { aliases?: unknown; ids?: unknown };
  const aliases = new Set<string>();
  const ids = new Set<string>();
  if (Array.isArray(data.aliases)) {
    for (const a of data.aliases) if (typeof a === "string") aliases.add(a);
  }
  if (Array.isArray(data.ids)) {
    for (const i of data.ids) if (typeof i === "string" || typeof i === "number") ids.add(String(i));
  }
  return { aliases, ids };
}

/** 生成完整合法清单 JSON：draft=0 的全部文章（含 unlisted），与「匿名可访问」范围严格对齐 */
export async function generateValidPathsJson(db: DB): Promise<string> {
  const rows = await db
    .select({ id: feeds.id, alias: feeds.alias })
    .from(feeds)
    .where(eq(feeds.draft, 0));

  const aliases: string[] = [];
  const ids: string[] = [];
  for (const row of rows) {
    ids.push(String(row.id));
    if (row.alias) aliases.push(row.alias);
  }
  return JSON.stringify({ aliases, ids });
}

/** cron：预生成完整清单写入存储对象 */
export async function validPathsCrontab(env: Env, db: DB): Promise<void> {
  try {
    const json = await generateValidPathsJson(db);
    await putStorageObjectAtKey(env, storageKey(env), json, "application/json");
    console.log("[ValidPaths] Saved valid-paths.json to storage");
  } catch (e: any) {
    console.error(`[ValidPaths] Failed to save valid-paths.json: ${e?.message}`);
  }
}

/**
 * 读取合法清单：内存 → CF 边缘缓存 → 存储对象。
 * 任何失败都返回 null（调用方保守处理），绝不实时查 D1。
 */
export async function getValidPaths(env: Env): Promise<ValidPaths | null> {
  const now = Date.now();

  // ① 模块内存
  if (memoryPaths && now < memoryExpiresAt) {
    return memoryPaths;
  }

  const cacheUrl = "https://valid-paths.local/" + storageKey(env);
  const cacheKey = new Request(cacheUrl);

  // ② CF 边缘缓存（Cache API 在 Worker 内免费、不计 R2 额度）
  try {
    const cache = (globalThis as any).caches?.default;
    if (cache) {
      const hit = await cache.match(cacheKey);
      if (hit) {
        const paths = parsePaths(await hit.text());
        memoryPaths = paths;
        memoryExpiresAt = now + CACHE_TTL_SECONDS * 1000;
        return paths;
      }
    }
  } catch {}

  // ③ 存储对象（R2/S3）—— 只读预生成缓存，不查 D1
  try {
    const object = await getStorageObject(env, storageKey(env));
    if (object) {
      const json = await object.text();
      const paths = parsePaths(json);
      memoryPaths = paths;
      memoryExpiresAt = now + CACHE_TTL_SECONDS * 1000;

      try {
        const cache = (globalThis as any).caches?.default;
        if (cache) {
          await cache.put(
            cacheKey,
            new Response(json, {
              status: 200,
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": `public, max-age=${CACHE_TTL_SECONDS}`,
              },
            }),
          );
        }
      } catch {}

      return paths;
    }
  } catch {}

  return null;
}

/** 判断单段 alias/id 是否为合法文章路径 */
export function isKnownFeedPath(paths: ValidPaths | null, segment: string): boolean {
  if (!paths) return false;
  return paths.aliases.has(segment) || paths.ids.has(segment);
}

export { EMPTY_PATHS };
