/** Path components excluded from remote file reads, including supplemental diff context. */
export function privateFilePathPart(part: string): boolean {
  return (
    part.startsWith(".") ||
    /^(?:node_modules|vendor|target|credentials?|secrets?|id_rsa|id_ed25519)$/i.test(part) ||
    /(?:^|[._-])(?:secret|credentials?|private[-_]?key)(?:[._-]|$)/i.test(part) ||
    /^(?:auth|oauth|tokens?|access[_-]?token|refresh[_-]?token)(?:\.[^.]+)?$/i.test(part) ||
    /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i.test(part) ||
    part.includes(":")
  );
}
