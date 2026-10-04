const enc = new TextEncoder()
const b64 = (b: ArrayBuffer | Uint8Array) => btoa(String.fromCharCode(...new Uint8Array(b)))
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0))

const key = async (secret: string) =>
  crypto.subtle.importKey("raw", await crypto.subtle.digest("SHA-256", enc.encode(`slack-mirror:${secret}`)), "AES-GCM", false, ["encrypt", "decrypt"])

/** AES-GCM with a key derived from a Worker secret. */
export const encryptJson = async (value: unknown, secret: string): Promise<string> => {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(secret), enc.encode(JSON.stringify(value)))
  return `v1.${b64(iv)}.${b64(ct)}`
}

export const decryptJson = async <T>(blob: string, secret: string): Promise<T | undefined> => {
  const [v, iv, ct] = blob.split(".")
  if (v !== "v1" || !iv || !ct) return undefined
  try {
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(iv) }, await key(secret), unb64(ct))
    return JSON.parse(new TextDecoder().decode(pt)) as T
  } catch {
    return undefined
  }
}
