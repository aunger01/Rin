/**
 * 图床地址归一。
 *
 * 多域名部署时，正文里若存的是上传那一刻的绝对地址（如
 * https://aunger.eu.org/api/blob/images/a.webp），从另一个域名打开就会变成
 * 跨站子资源请求 —— 既过不了 Cloudflare 的挑战，也过不了热链规则。
 *
 * 归一成 /api/blob/images/a.webp 后，浏览器按当前页面域名补全，天然同源，
 * 三个域名各取各的图，且不依赖任何 Cloudflare 规则。
 *
 * 非 /api/blob/ 的外链图片原样返回，不受影响。
 * 放在独立小文件里，避免引入 image-upload 的其它依赖（防止循环引用）。
 */
export function toSameOriginBlobUrl(url: string) {
  const match = url.match(/^https?:\/\/[^/?#]+(\/api\/blob\/.*)$/i);
  return match ? match[1] : url;
}
