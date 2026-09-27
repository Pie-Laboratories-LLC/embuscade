// Byte-length limits shared between client and server so the two can never
// disagree about what's allowed. Lengths are UTF-8 bytes, not characters --
// a single accented letter, CJK character, or emoji can be 2-4 bytes.
export const CHAT_MAX_BYTES = 256;
export const GAME_NAME_MAX_BYTES = 64;
export const PASSWORD_MAX_BYTES = 64;
export const PLAYER_NAME_MAX_BYTES = 32;

export function byteLength(str) {
    return new TextEncoder().encode(str).length;
}

// Truncates to at most maxBytes UTF-8 bytes without ever splitting a
// multi-byte character or a surrogate pair -- Array.from() walks by Unicode
// code point, not UTF-16 code unit, so this is safe for any input.
export function truncateToBytes(str, maxBytes) {
    if (byteLength(str) <= maxBytes) return str;

    let result = '';
    let bytes = 0;
    for (const ch of Array.from(str)) {
        const chBytes = byteLength(ch);
        if (bytes + chBytes > maxBytes) break;
        result += ch;
        bytes += chBytes;
    }
    return result;
}
