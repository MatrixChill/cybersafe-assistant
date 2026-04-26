export function encodeMessage(message) {
    return `${JSON.stringify(message)}\n`;
}
export function decodeMessages(buffer) {
    const parts = buffer.split("\n");
    const rest = parts.pop() ?? "";
    const messages = parts
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => JSON.parse(line));
    return { messages, rest };
}
