export function permissionPatterns(urls) {
  return [...new Set(urls.map((value) => {
    const url = new URL(value);
    return `https://${url.hostname}/*`;
  }))];
}
