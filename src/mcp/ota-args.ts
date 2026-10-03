/** curl argv for the OTA upload. No shell is involved, so values stay single argv elements. */
export function otaCurlArgs(
  port: number,
  f: { slug: string; name: string; bundleId: string; version: string; platform: string; filePath: string },
): string[] {
  return [
    "-sf", "-X", "POST",
    `http://127.0.0.1:${port}/api/apps`,
    // --form-string: a leading '@' or '<' in a value is not a file reference
    "--form-string", `slug=${f.slug}`,
    "--form-string", `name=${f.name}`,
    "--form-string", `bundleId=${f.bundleId}`,
    "--form-string", `version=${f.version}`,
    "--form-string", `platform=${f.platform}`,
    "-F", `file=@${f.filePath}`,
  ];
}
